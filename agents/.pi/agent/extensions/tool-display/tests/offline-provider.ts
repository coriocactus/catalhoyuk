// Local, deterministic test provider. No HTTP requests or credentials are used.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const root = process.env.DISPLAY_FIXTURE_DIR;
  if (!root) throw new Error("DISPLAY_FIXTURE_DIR must point to the isolated test directory.");
  pi.registerMarkdownTransformer((markdown) => {
    const marker = markdown.match(/\bARCHIVE_\d{3}\b/)?.[0];
    if (marker) appendFileSync(join(root, "history-rendered"), `${marker}\n`);
    return markdown;
  });
  pi.registerCommand("fixture-state", {
    description: "Record read-only test session state",
    handler: async (args, ctx) => {
      if (args !== "before" && args !== "after") throw new Error("Expected before or after.");
      writeFileSync(
        join(root, `${args}.state.json`),
        JSON.stringify({
          leaf: ctx.sessionManager.getLeafId(),
          entries: ctx.sessionManager.buildContextEntries(),
          count: ctx.sessionManager.getEntries().length,
        }),
      );
      ctx.ui.notify(`HISTORY_STATE_${args.toUpperCase()}`, "info");
    },
  });
  pi.registerProvider("display-fixture", {
    baseUrl: "http://127.0.0.1:1",
    apiKey: "unused-offline-fixture",
    api: "display-fixture-stream",
    models: [
      {
        id: "fixture",
        name: "Offline fixture",
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
        const completed = new Set(
          context.messages
            .filter((message) => message.role === "toolResult")
            .map((message) => message.toolCallId),
        );
        if (completed.has("live-5")) {
          output.content.push({ type: "text", text: "BACKGROUND_FINISHED" });
          stream.push({ type: "text_start", contentIndex: 0, partial: structuredClone(output) });
          stream.push({
            type: "text_delta",
            contentIndex: 0,
            delta: "BACKGROUND_FINISHED",
            partial: structuredClone(output),
          });
          output.stopReason = "stop";
          writeFileSync(join(root, "background-done"), "done");
        } else {
          if (!completed.has("live-0")) {
            output.content.push({ type: "text", text: "LIVE_WORK_STARTED" });
            stream.push({ type: "text_start", contentIndex: 0, partial: structuredClone(output) });
            stream.push({
              type: "text_delta",
              contentIndex: 0,
              delta: "LIVE_WORK_STARTED",
              partial: structuredClone(output),
            });
          }
          const calls = [
            { name: "read", arguments: { path: join(root, "a-日本語.ts") } },
            { name: "read", arguments: { path: join(root, "b.txt") } },
            { name: "read", arguments: { path: join(root, "picture.png") } },
            {
              name: "edit",
              arguments: {
                path: join(root, "edited.txt"),
                edits: [{ oldText: "before", newText: "after" }],
              },
            },
            {
              name: "bash",
              arguments: {
                command:
                  'printf \'%s/%s\\n\' "$DISPLAY_FIXTURE_PREFIX" "$DISPLAY_FIXTURE_SHELL"; printf \'STREAM_ONE\\n\'; i=0; while [ ! -f "$DISPLAY_FIXTURE_DIR/release-background" ] && [ $i -lt 600 ]; do sleep 0.05; i=$((i+1)); done; test -f "$DISPLAY_FIXTURE_DIR/release-background" || exit 124; printf \'STREAM_TWO\\n\'',
              },
            },
            {
              name: "bash",
              arguments: { command: "printf '%s\\n' \"$DISPLAY_FIXTURE_ERROR\" >&2; exit 1" },
            },
          ];
          // Reads arrive in separate tool-only turns to exercise cross-turn grouping.
          const indices = completed.has("live-1")
            ? [2, 3, 4, 5]
            : completed.has("live-0")
              ? [1]
              : [0];
          for (const index of indices) {
            const call = calls[index];
            const block = {
              type: "toolCall" as const,
              id: `live-${index}`,
              name: call.name,
              arguments: {},
            };
            const contentIndex = output.content.push(block) - 1;
            stream.push({ type: "toolcall_start", contentIndex, partial: structuredClone(output) });
            await delay(80);
            block.arguments = call.arguments;
            stream.push({
              type: "toolcall_end",
              contentIndex,
              toolCall: block,
              partial: structuredClone(output),
            });
          }
          output.stopReason = "toolUse";
        }
        stream.push({ type: "done", reason: output.stopReason, message: output });
        stream.end();
      })();
      return stream;
    },
  });
}
