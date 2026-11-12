// The model inside a real Pi run by a test: an offline provider whose only model answers with
// what reached it (the prompt's first line, its tools, attached files, and how long the
// conversation is), after one read when the prompt asks for it, and slowly if it says so. No
// HTTP requests are made.
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** What the fixture answers, as JSON. */
export interface Seen {
  /** The prompt's first line. */
  first: string;
  /** User messages in the conversation so far. */
  users: number;
  /** The tools the model was offered. */
  tools: string[];
  /** `<file name=...>` blocks in the prompt. */
  files: number;
  /** Tool results in the conversation. */
  read: number;
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("comrade-fixture", {
    baseUrl: "http://127.0.0.1:1",
    apiKey: "unused-offline-fixture",
    api: "comrade-fixture-stream",
    models: [
      {
        id: "fixture",
        name: "Comrade fixture",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 4096,
      },
    ],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const output: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "pending",
        timestamp: Date.now(),
      };
      void (async () => {
        stream.push({ type: "start", partial: structuredClone(output) });
        const users = context.messages.filter((message) => message.role === "user");
        const last = users.at(-1);
        const prompt =
          typeof last?.content === "string"
            ? last.content
            : (last?.content ?? [])
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("\n");
        const results = context.messages.filter((message) => message.role === "toolResult");
        // `#slow`: the first request takes a while, so a message can be sent while it runs.
        if (/^#slow$/m.test(prompt) && !results.length)
          await new Promise((wake) => setTimeout(wake, 500));
        // Tool declarations ride on the transcript's system messages.
        const tools = new Set<string>();
        for (const message of context.messages) {
          if (message.role !== "system") continue;
          for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
          for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
        }
        // `#read PATH` asks for a read, and `#bash COMMAND` for a command, before answering.
        const wanted = /^#read (.+)$/m.exec(prompt)?.[1];
        const command = /^#bash (.+)$/m.exec(prompt)?.[1];
        const call =
          wanted && tools.has("read") ? "read" : command && tools.has("bash") ? "bash" : "";
        if (call && !results.length) {
          const block = {
            type: "toolCall" as const,
            id: `fixture-${call}`,
            name: call,
            arguments: {} as Record<string, string>,
          };
          const contentIndex = output.content.push(block) - 1;
          stream.push({ type: "toolcall_start", contentIndex, partial: structuredClone(output) });
          block.arguments = call === "read" ? { path: wanted ?? "" } : { command: command ?? "" };
          stream.push({
            type: "toolcall_end",
            contentIndex,
            toolCall: block,
            partial: structuredClone(output),
          });
          output.stopReason = "toolUse";
        } else {
          const seen: Seen = {
            first: prompt.split("\n")[0] ?? "",
            users: users.length,
            tools: [...tools],
            files: (prompt.match(/<file name="/g) ?? []).length,
            read: results.length,
          };
          const text = JSON.stringify(seen);
          const contentIndex = output.content.push({ type: "text", text }) - 1;
          stream.push({ type: "text_start", contentIndex, partial: structuredClone(output) });
          stream.push({
            type: "text_delta",
            contentIndex,
            delta: text,
            partial: structuredClone(output),
          });
          output.stopReason = "stop";
        }
        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
      })();
      return stream;
    },
  });
}
