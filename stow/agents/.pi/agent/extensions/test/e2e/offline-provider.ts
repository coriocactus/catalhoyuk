// Local, deterministic test provider. No HTTP requests or credentials are used.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  type ExtensionAPI,
  InteractiveMode,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";

/**
 * The fixture's tool turns. A turn starts once the call named by `after` has a result.
 * Commentary (`text`) before a turn's calls separates groups, and hidden reasoning does not.
 */
const TURNS: { after?: string; text?: string; calls: number[] }[] = [
  { text: "LIVE_WORK_STARTED", calls: [0] },
  { after: "live-0", calls: [1] },
  { after: "live-1", text: "EDIT_WORK", calls: [2, 3] },
  { after: "live-3", text: "COMMAND_WORK", calls: [4, 5] },
  { after: "live-5", text: "MIXED_WORK", calls: [6, 7] },
  { after: "live-7", calls: [8] },
  { after: "live-8", text: "SCRIPT_WORK", calls: [9] },
  { after: "live-9", calls: [10] },
];

export default function (pi: ExtensionAPI) {
  const root = process.env.DISPLAY_FIXTURE_DIR;
  if (!root) throw new Error("DISPLAY_FIXTURE_DIR must point to the isolated test directory.");
  pi.on("session_start", (event, ctx) => {
    writeFileSync(
      join(root, "runtime-ready.json"),
      JSON.stringify({
        reason: event.reason,
        id: ctx.sessionManager.getSessionId(),
        time: Date.now(),
      }),
    );
  });
  pi.on("agent_end", (_event, ctx) => {
    if (!existsSync(join(root, "update-draft"))) return;
    ctx.ui.setEditorText("BUSY_DRAFT_UPDATED_WHILE_VIM_OPEN");
    writeFileSync(join(root, "draft-updated"), "done");
  });
  pi.registerCommand("fixture-owners", {
    description: "Inspect runtime adapter ownership in the isolated test",
    handler: async (label, ctx) => {
      const host = InteractiveMode.prototype;
      const history = Reflect.get(host, Symbol.for("rearview.patch.v1"));
      const images = Reflect.get(
        ToolExecutionComponent.prototype,
        Symbol.for("mirage.native-images.patch.v1"),
      );
      const thinking = Reflect.get(
        AssistantMessageComponent.prototype,
        Symbol.for("mirage.native-thinking.patch.v1"),
      );
      const restored =
        Reflect.get(host, "renderSessionEntries") ===
        Reflect.get(host, Symbol.for("fixture.original-history"));
      ctx.ui.notify(
        `OWNERS_${label}_H${history?.owners.size ?? 0}_I${images?.users ?? 0}_T${thinking?.owners.size ?? 0}_R${Number(restored)}`,
        "info",
      );
    },
  });
  pi.registerCommand("fixture-disable-history", {
    description: "Disable the isolated history wrapper on reload",
    handler: async (_args, ctx) => {
      writeFileSync(join(root, "disable-history"), "disabled");
      await ctx.reload();
    },
  });
  pi.registerCommand("fixture-resume", {
    description: "Exercise real session replacement without navigating the picker",
    handler: async (_args, ctx) => {
      await ctx.switchSession(join(root, "session.jsonl"));
    },
  });
  pi.registerCommand("fixture-fork", {
    description: "Exercise real fork replacement",
    handler: async (_args, ctx) => {
      const leaf = ctx.sessionManager.getLeafId();
      if (!leaf) throw new Error("Expected a saved fixture leaf.");
      await ctx.fork(leaf, { position: "at" });
    },
  });
  pi.registerCommand("fixture-replace", {
    description: "Gate a replacement until Vim owns the terminal",
    handler: async (_args, ctx) => {
      ctx.ui.setEditorText("OUTGOING_DRAFT");
      ctx.ui.notify("REPLACEMENT_ARMED", "info");
      for (let i = 0; !existsSync(join(root, "replace-now")); i++) {
        if (i === 400) throw new Error("Timed out waiting for replacement gate.");
        await delay(50);
      }
      await ctx.newSession({
        withSession: async (next) => {
          next.ui.setEditorText("REPLACEMENT_SESSION_DRAFT");
        },
      });
    },
  });
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
        if (completed.has("live-10")) {
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
          // The first turn has no `after`, so a turn always matches.
          const turn = TURNS.findLast(({ after }) => !after || completed.has(after)) ?? TURNS[0];
          const { text } = turn;
          if (text) {
            const contentIndex = output.content.push({ type: "text", text }) - 1;
            stream.push({ type: "text_start", contentIndex, partial: structuredClone(output) });
            stream.push({
              type: "text_delta",
              contentIndex,
              delta: text,
              partial: structuredClone(output),
            });
          }
          if (completed.has("live-5")) {
            const contentIndex =
              output.content.push({ type: "thinking", thinking: "FIXTURE_REASONING" }) - 1;
            stream.push({ type: "thinking_start", contentIndex, partial: structuredClone(output) });
            stream.push({
              type: "thinking_delta",
              contentIndex,
              delta: "FIXTURE_REASONING",
              partial: structuredClone(output),
            });
          }
          const calls = [
            { name: "read", arguments: { path: join(root, "a-日本語.ts") } },
            { name: "read", arguments: { path: join(root, "b.txt") } },
            {
              name: "edit",
              arguments: {
                path: join(root, "edited.txt"),
                edits: [{ oldText: "before", newText: "after" }],
              },
            },
            {
              name: "edit",
              arguments: {
                path: join(root, "edited-other.txt"),
                edits: [{ oldText: "before-second", newText: "after-second\nextra" }],
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
            {
              name: "write",
              arguments: { path: join(root, "mixed.txt"), content: "MIXED_BODY\n" },
            },
            { name: "read", arguments: { path: join(root, "picture.png") } },
            { name: "bash", arguments: { command: "printf MIXED_COMMAND" } },
            // Pi's codemode tool runs this script. Its calls go through Pi's nested tool
            // pipeline, and store() writes a session entry between the script's call and its
            // result.
            {
              name: "codemode",
              arguments: {
                code: [
                  'store("fixture", 1);',
                  `await tools.read({ path: ${JSON.stringify(join(root, "b.txt"))} });`,
                  'const run = await tools.bash({ command: "printf SCRIPT_COMMAND" });',
                  `await tools.edit({ path: ${JSON.stringify(join(root, "scripted.txt"))}, edits: [{ oldText: "one", newText: "two" }] });`,
                  'return "SCRIPT_RESULT " + run.output;',
                ].join("\n"),
              },
            },
            {
              name: "write",
              arguments: { path: join(root, "after-script.txt"), content: "AFTER_SCRIPT\n" },
            },
          ];
          for (const index of turn.calls) {
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
            // Hold one call's arguments open, so the test sees a loading call.
            for (let i = 0; index === 1 && !existsSync(join(root, "release-pending")); i++) {
              if (i === 400) throw new Error("Timed out waiting for the pending-call gate.");
              await delay(25);
            }
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
