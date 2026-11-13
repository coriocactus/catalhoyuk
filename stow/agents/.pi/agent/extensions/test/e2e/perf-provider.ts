// A local provider for test/e2e/perf.ts: no network, no credentials. It streams what a model
// streams, a delta every 10 ms, and Pi's own tools really run, in $PERF_DIR.
//
//   PERF_TOOLS    a Markdown answer, three reads of 400 lines, a write whose 400 lines stream
//                 in, and a command that prints for 3 s; then a short answer
//   PERF_COMRADE  a comrade in the foreground, then one in the background; their own Pi loads
//                 this provider too and, seeing $PI_COMRADE, works through a few short turns
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MARK } from "./perf-probe.ts";

const DELTA_MS = 10;
/** The turns a comrade works before it answers. */
const COMRADE_TURNS = 5;
const SENTENCE =
  "The renderer wraps every block of the reply to the terminal width, so a long answer is laid out again whenever any part of it changes. ";
const ANSWER = [
  "## Findings",
  "",
  SENTENCE.repeat(2),
  "",
  "- **First**: `render(width)` runs once per frame.",
  "- **Second**: wide characters such as 日本語 measure two columns each.",
  "",
  "```ts",
  ...Array.from({ length: 12 }, (_, i) => `export const value${i} = compute(${i});`),
  "```",
].join("\n");
const WRITTEN = Array.from(
  { length: 400 },
  (_, i) => `export function handler${i}(input: string): string { return input.padStart(${i}); }`,
).join("\n");

const mark = (name: string) => (globalThis as { [MARK]?: (name: string) => void })[MARK]?.(name);
const chunks = (text: string, size: number) =>
  Array.from({ length: Math.ceil(text.length / size) }, (_, i) =>
    text.slice(i * size, (i + 1) * size),
  );
const said = (message: Context["messages"][number]) =>
  typeof message.content === "string"
    ? message.content
    : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");

export default function (pi: ExtensionAPI) {
  const directory = process.env.PERF_DIR;
  if (!directory) throw new Error("PERF_DIR must point to the perf suite's directory.");
  pi.registerProvider("perf", {
    baseUrl: "http://127.0.0.1:1",
    apiKey: "unused-offline-fixture",
    api: "perf-stream",
    models: [
      {
        id: "stream",
        name: "Perf stream",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 64_000,
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
      // The prompt that chose the scenario: a comrade's delivered answer is a user message too.
      const prompts = context.messages.filter((message) => message.role === "user");
      const delivered =
        prompts.at(-1) !== undefined && said(prompts.at(-1) as never).startsWith("[comrade");
      const typed = prompts.findLast((message) => !said(message).startsWith("[comrade"));
      const prompt = typed ? said(typed) : "";
      const turn =
        context.messages
          .slice(typed ? context.messages.lastIndexOf(typed) + 1 : 0)
          .filter((message) => message.role === "assistant").length + 1;
      const text = async (source: string) => {
        const block = { type: "text" as const, text: "" };
        const contentIndex = output.content.push(block) - 1;
        stream.push({ type: "text_start", contentIndex, partial: output });
        for (const delta of chunks(source, 30)) {
          block.text += delta;
          stream.push({ type: "text_delta", contentIndex, delta, partial: output });
          await delay(DELTA_MS);
        }
        stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
      };
      /** A call whose arguments arrive in steps, as a provider's partial JSON does. */
      const call = async (id: string, name: string, steps: Record<string, unknown>[]) => {
        const block = { type: "toolCall" as const, id, name, arguments: {} };
        const contentIndex = output.content.push(block) - 1;
        stream.push({ type: "toolcall_start", contentIndex, partial: output });
        for (const step of steps) {
          block.arguments = step;
          stream.push({ type: "toolcall_delta", contentIndex, delta: "", partial: output });
          await delay(DELTA_MS);
        }
        stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: output });
      };
      const reads = async (prefix: string) => {
        for (let i = 0; i < 3; i++)
          await call(`${prefix}-${i}`, "read", [{ path: join(directory, `src/file-${i}.ts`) }]);
      };
      const reply = async (): Promise<"stop" | "toolUse"> => {
        if (process.env.PI_COMRADE !== undefined) {
          if (turn > COMRADE_TURNS) {
            await text(`${ANSWER}\n\nCOMRADE_DONE`);
            return "stop";
          }
          await text(`Step ${turn}. ${SENTENCE}`);
          await reads(`comrade-read-${turn}`);
          return "toolUse";
        }
        if (prompt.includes("PERF_COMRADE")) {
          if (delivered) {
            await text("The comrade answered. PERF_COMRADE_DONE");
            return "stop";
          }
          if (turn > 2) {
            await text("Started it in the background.");
            return "stop";
          }
          mark(turn === 1 ? "foreground" : "background");
          await call(`perf-comrade-${turn}`, "comrade", [
            {
              title: "Perf comrade",
              task: "Read the fixture files and report.",
              ...(turn === 2 ? { background: true } : {}),
            },
          ]);
          return "toolUse";
        }
        if (turn > 1) {
          mark("answered");
          await text("PERF_TOOLS_DONE");
          return "stop";
        }
        mark("text");
        await text(ANSWER);
        await reads("perf-read");
        mark("write");
        const path = join(directory, "written.ts");
        await call(
          "perf-write",
          "write",
          chunks(WRITTEN, 120).map((_, i, all) => ({
            path,
            content: all.slice(0, i + 1).join(""),
          })),
        );
        await call("perf-bash", "bash", [
          { command: "for i in $(seq 1 60); do echo PERF_LINE_$i; sleep 0.05; done" },
        ]);
        mark("tools");
        return "toolUse";
      };
      void (async () => {
        stream.push({ type: "start", partial: output });
        const reason = await reply();
        output.stopReason = reason;
        stream.push({ type: "done", reason, message: output });
        stream.end();
      })();
      return stream;
    },
  });
}
