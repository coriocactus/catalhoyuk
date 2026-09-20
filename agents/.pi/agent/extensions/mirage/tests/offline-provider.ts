// Local, deterministic test provider. No HTTP requests or credentials are used.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  type ExtensionAPI,
  InteractiveMode,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";

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
      const padding = Reflect.get(host, Symbol.for("mirage.native-padding.patch.v1"));
      const restored =
        Reflect.get(host, "renderSessionEntries") ===
        Reflect.get(host, Symbol.for("fixture.original-history"));
      ctx.ui.notify(
        `OWNERS_${label}_H${history?.owners.size ?? 0}_I${images?.users ?? 0}_P${padding?.users ?? 0}_R${Number(restored)}`,
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
        if (completed.has("live-6")) {
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
          ];
          // Reads arrive in separate tool-only turns to exercise cross-turn grouping.
          const indices = completed.has("live-1")
            ? [2, 3, 4, 5, 6]
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
