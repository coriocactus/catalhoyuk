// Interupt in a real Pi session, loaded by Pi's own loader: the events the unit tests emit by
// hand come from Pi here, in Pi's order, around a real response, its abort, and a retry. The
// editor is the one Interupt sets, built as Pi's terminal builds it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type {
  CustomEditor,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { type Fake, fake } from "../../test/fake-pi.ts";
import { piModule, themes } from "../../test/pi.ts";
import { ai, startSession, until } from "../../test/session.ts";

type Keybindings = typeof import("@earendil-works/pi-coding-agent/dist/core/keybindings.js");
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
const { KeybindingsManager } = await piModule<Keybindings>("dist/core/keybindings.js");

const HINT = "Press Esc again to stop";

/** A terminal's editor slot and working message, and what reached Pi's own Esc handler. */
function terminal(onEscape: () => void) {
  const host = fake<TUI>({ terminal: { rows: 40 } as Fake<TUI["terminal"]>, requestRender() {} });
  const state = {
    editor: undefined as CustomEditor | undefined,
    message: undefined as string | undefined,
  };
  let factory: EditorFactory | undefined;
  const ui: Partial<ExtensionUIContext> = {
    setWorkingMessage: (message) => {
      state.message = message;
    },
    getEditorComponent: () => factory,
    setEditorComponent: (next) => {
      factory = next;
      const editor = next?.(
        host,
        themes.getEditorTheme(),
        new KeybindingsManager(),
      ) as CustomEditor;
      // Pi wires its own interrupt handler into an editor that does not set one.
      editor.onEscape = onEscape;
      state.editor = editor;
    },
  };
  const esc = () => {
    assert(state.editor, "Interupt set the editor");
    state.editor.handleInput("\x1b");
  };
  return { ui, state, esc };
}

/** A reply that waits until the request is aborted, then answers too late. */
const held =
  (reached: () => void) => async (_context: unknown, options?: { signal?: AbortSignal }) => {
    reached();
    await new Promise<void>((resolve) => {
      if (options?.signal?.aborted) resolve();
      options?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return ai.fauxAssistantMessage("Too late.");
  };

const path = fileURLToPath(new URL("../index.ts", import.meta.url));

test("in a real response, the first Esc arms, the second stops it, and idle Esc stays native", async (t) => {
  let escapes = 0;
  let stop = () => {};
  const { ui, state, esc } = terminal(() => {
    escapes++;
    stop();
  });
  const { session, model } = await startSession(t, { paths: [path], ui });
  stop = () => void session.abort();
  let requests = 0;
  model.setResponses([held(() => requests++)]);
  const run = session.prompt("Work");
  await until(() => requests === 1, "the response starts");
  esc();
  assert.equal(state.message, HINT);
  assert.equal(escapes, 0);
  esc();
  assert.equal(escapes, 1);
  assert.equal(state.message, undefined);
  await run;
  const last = session.messages.at(-1);
  assert(last?.role === "assistant");
  assert.equal(last.stopReason, "aborted");
  esc();
  assert.equal(escapes, 2, "idle: Pi's own handler");
  assert.equal(state.message, undefined);
});

test("while Pi waits to retry a failed request Esc stays native; the retried response arms it", async (t) => {
  let escapes = 0;
  const { ui, state, esc } = terminal(() => escapes++);
  const { session, model } = await startSession(t, {
    paths: [path],
    ui,
    settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 200 } },
  });
  let retried = false;
  const waits: boolean[] = [];
  session.subscribe((event) => {
    if (event.type !== "auto_retry_start") return;
    // Pi is not idle, and its own countdown says that Esc cancels.
    esc();
    waits.push(state.message === undefined);
  });
  model.setResponses([
    ai.fauxAssistantMessage([], { stopReason: "error", errorMessage: "529 overloaded" }),
    held(() => {
      retried = true;
    }),
  ]);
  const run = session.prompt("Work");
  await until(() => retried, "the request is retried");
  assert.deepEqual(waits, [true]);
  assert.equal(escapes, 1);
  esc();
  assert.equal(state.message, HINT);
  assert.equal(escapes, 1);
  await session.abort();
  await run;
});
