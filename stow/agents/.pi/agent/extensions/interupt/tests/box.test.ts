// The prompt editor in a box: Pi's own editor between side borders, at least three rows tall,
// with the labels of Pi's footer on its borders, a statistic a click cycles, a top border that a
// drag resizes, and Pi's command menu below it.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { paint } from "../../shared/colours.ts";
import { formatTokens } from "../../shared/format.ts";
import { CONTENT_END, CONTENT_START, findMarker } from "../../shared/selection.ts";
import { type Fake, fake, fakePi } from "../../test/fake-pi.ts";
import { core, load, piModule, themes, tui } from "../../test/pi.ts";

type Keybindings = typeof import("@earendil-works/pi-coding-agent/dist/core/keybindings.js");
type Indicators =
  typeof import("@earendil-works/pi-coding-agent/dist/modes/interactive/components/status-indicator.js");

const { boxEditor, labelLine, MIN_ROWS } = await load<typeof import("../box.ts")>(
  "../box.ts",
  import.meta.url,
);
const { createLabels, footerPath } = await load<typeof import("../labels.ts")>(
  "../labels.ts",
  import.meta.url,
);
const { KeybindingsManager } = await piModule<Keybindings>("dist/core/keybindings.js");
const { trackActivity } = await load<typeof import("../activity.ts")>(
  "../activity.ts",
  import.meta.url,
);
type Status = import("../box.ts").Status;
const { WorkingStatusIndicator } = await piModule<Indicators>(
  "dist/modes/interactive/components/status-indicator.js",
);
const strip = (row: string) => tui.stripTerminalSequences(row).trimEnd();

/** Pi's editor, recording the mouse events that reach it. */
class Recorded extends core.CustomEditor {
  seen: TuiMouseEvent[] = [];
  override handleMouse(event: TuiMouseEvent) {
    this.seen.push(event);
    return super.handleMouse(event);
  }
}

const STATS = {
  tokens: "↑1.2k ↓300",
  cache: "R5.0k W1.0k CH80.0%",
  cost: "$0.120 (sub)",
  context: "12.5%/200k (auto)",
};

function boxed(t: TestContext, rows = 40) {
  let renders = 0;
  const listeners = new Set<(data: string) => unknown>();
  const host = fake<TUI>({
    terminal: { rows } as Fake<TUI["terminal"]>,
    requestRender() {
      renders++;
    },
    addInputListener(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const editor = new Recorded(host, themes.getEditorTheme(), new KeybindingsManager({}), {
    embedWorkingStatus: true,
  });
  const reports: string[] = [];
  let unboxed = 0;
  let status: Status | undefined;
  const handle = boxEditor(editor, {
    tui: host,
    theme: () => themes.theme,
    status: () => status,
    labels: () => ({
      pwd: "~/project (main)",
      model: "(anthropic) claude-opus-5-5 • xhigh",
      stat: (which) => STATS[which],
      statuses: [],
    }),
    report: (message) => reports.push(message),
    unboxed: () => {
      unboxed++;
    },
  });
  const indicator = new WorkingStatusIndicator(host, "Working", { frames: ["⠋"] });
  t.after(() => indicator.dispose());
  /** A mouse event on the box's row `y`, at screen row `top + y`. */
  const mouse = (type: TuiMouseEvent["type"], x: number, y: number, top = 20): TuiMouseEvent => ({
    type,
    button: "left",
    x,
    y,
    screenX: x,
    screenY: top + y,
    width: 80,
    height: 10,
    shift: false,
    alt: false,
    ctrl: false,
  });
  return {
    editor,
    host,
    handle,
    listeners,
    /** Terminal input, as Pi's TUI hands it to its listeners first. */
    input(data: string) {
      for (const listener of [...listeners]) listener(data);
    },
    indicator,
    reports,
    mouse,
    get renders() {
      return renders;
    },
    get unboxed() {
      return unboxed;
    },
    plain: (width = 80) => editor.render(width).map(strip),
    /** What Pi is doing, as interupt's activity says. */
    set status(value: Status | undefined) {
      status = value;
    },
    /** Pi's gesture for a click: a press, its release, then the click. */
    click(x: number, y: number) {
      for (const type of ["press", "release", "click"] as const)
        editor.handleMouse?.(mouse(type, x, y));
    },
  };
}

test("the editor is a box in the text colour, at least three rows, with Pi's labels on it", (t) => {
  const b = boxed(t);
  b.editor.setText("hello");
  const lines = b.editor.render(80);
  const shown = lines.map(strip);
  assert.equal(shown.length, 2 + MIN_ROWS);
  for (const row of lines) assert.equal(tui.visibleWidth(row), 80, "every row is the box's width");
  // Top: the statistic and the model on its right.
  assert.match(shown[0], /^╭─+ ↑1\.2k ↓300 ─ \(anthropic\) claude-opus-5-5 • xhigh ─╮$/);
  assert(lines[0].startsWith(themes.theme.getFgAnsi("text")), "borders in the text colour");
  // Pi's text between side borders, then blank rows to three.
  // Pi pads it by its `editorPaddingX` setting, none here.
  assert.match(shown[1], /^│hello +│$/);
  assert.match(shown[2], /^│ +│$/);
  assert.match(shown[3], /^│ +│$/);
  // Bottom: nothing on the left while Pi is idle, the directory on the right.
  assert.match(shown[4], /^╰─+ ~\/project \(main\) ─╯$/);
  // The text is marked for prose's selection, which then leaves the borders out.
  assert(lines[1].includes(CONTENT_START), "the text's start is marked");
  assert(lines[1].indexOf(CONTENT_END) > lines[1].indexOf(CONTENT_START), "and its end");
  // Its end before the spaces Pi pads it with; a blank row marks nothing to select.
  assert(lines[1].slice(lines[1].indexOf(CONTENT_END)).startsWith(`${CONTENT_END} `));
  assert.equal(findMarker(lines[2])?.marker, CONTENT_START);
  assert(lines[2].includes(`${CONTENT_START}${CONTENT_END}`), "a blank row selects nothing");
  // Working: Pi's status, on the bottom border's left.
  b.editor.setWorkingStatusIndicator(b.indicator);
  assert.match(b.plain()[4], /^╰─ ⠋ Working ─+ ~\/project \(main\) ─╯$/);
  // More text than three rows: the box grows with it.
  b.editor.setText("1\n2\n3\n4\n5");
  assert.equal(b.plain().length, 2 + 5);
});

test("the status says what Pi is doing, in the text colour, beside Pi's spinner in cyan", (t) => {
  const b = boxed(t);
  b.editor.setWorkingStatusIndicator(b.indicator);
  b.status = { kind: "thinking", label: "Thinking", tokens: "104 tok" };
  const bottom = b.editor.render(80)[1 + MIN_ROWS];
  assert.match(strip(bottom), /^╰─ ⠋ Thinking 104 tok ─+ ~\/project \(main\) ─╯$/);
  for (const part of [themes.theme.fg("text", "Thinking"), themes.theme.fg("dim", "104 tok")])
    assert(bottom.includes(part), JSON.stringify(bottom));
  assert(bottom.includes(paint(themes.theme, "sky", "⠋")), "Pi's spinner in the terminal's cyan");
  // Idle, Pi hands the editor no status: the border's left is empty.
  b.editor.setWorkingStatusIndicator(undefined);
  assert.match(b.plain()[1 + MIN_ROWS], /^╰─+ ~\/project \(main\) ─╯$/);
});

test("a status holds a second before another kind replaces it, and the hint shows at once", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  const b = boxed(t);
  b.editor.setWorkingStatusIndicator(b.indicator);
  const status = () => b.plain()[1 + MIN_ROWS].match(/^╰─ ⠋ (.*?) ─/)?.[1];
  b.status = { kind: "thinking", label: "Thinking" };
  assert.equal(status(), "Thinking");
  // A quick call comes and goes within the second: the status shown stays.
  b.status = { kind: "running", label: "Running read" };
  assert.equal(status(), "Thinking");
  t.mock.timers.tick(1000);
  assert.equal(status(), "Running read");
  // The same kind, as more tools start, changes in place.
  b.status = { kind: "running", label: "Running 2 tools" };
  assert.equal(status(), "Running 2 tools");
  // The Esc hint, and Pi's own statuses, show at once.
  b.status = { kind: "armed", label: "Press Esc again to stop" };
  assert.equal(status(), "Press Esc again to stop");
  // With nothing known yet of what it does, Pi's word.
  b.status = undefined;
  t.mock.timers.tick(1000);
  assert.equal(status(), "Working");
});

test("Pi's own statuses, as a retry's countdown, keep Pi's words", (t) => {
  const b = boxed(t);
  b.status = { kind: "thinking", label: "Thinking" };
  b.editor.setWorkingStatusIndicator(
    fake<NonNullable<Parameters<typeof b.editor.setWorkingStatusIndicator>[0]>>({
      kind: "retry",
      renderInBorder: () => "⠋ Retrying in 3s (2/3) · Esc to cancel",
      renderSpinnerInBorder: () => "⠋",
    }),
  );
  assert.match(b.plain()[1 + MIN_ROWS], /^╰─ ⠋ Retrying in 3s \(2\/3\) · Esc to cancel ─/);
});

test("the activity follows Pi's events: waiting, thinking, writing, calling, running", () => {
  const pi = fakePi();
  const activity = trackActivity(pi.api);
  const now = () => activity()?.label;
  assert.equal(activity(), undefined, "nothing while Pi does nothing");
  pi.emit("agent_start");
  assert.equal(now(), "Waiting");
  const update = (type: string, output = 0, content: object[] = []) =>
    pi.emit("message_update", {
      message: { role: "assistant", content, usage: { output } },
      assistantMessageEvent: { type, contentIndex: 0, partial: { content } },
    });
  // A count stuck where the reply started, as Anthropic's is until the reply ends, is not shown.
  pi.emit("message_start", { message: { role: "assistant", content: [] } });
  update("thinking_delta", 3);
  assert.deepEqual(activity(), { kind: "thinking", label: "Thinking", tokens: undefined });
  update("thinking_delta", 3);
  assert.equal(activity()?.tokens, undefined);
  // One that counts along, once it has moved.
  update("thinking_delta", 120);
  assert.deepEqual(activity(), { kind: "thinking", label: "Thinking", tokens: "120 tok" });
  update("text_delta");
  assert.deepEqual(activity(), { kind: "writing", label: "Writing", tokens: undefined });
  update("toolcall_start", 0, [{ type: "toolCall", name: "bash" }]);
  assert.equal(now(), "Calling bash");
  pi.emit("tool_execution_start", { toolCallId: "a", toolName: "read" });
  assert.equal(now(), "Running read");
  pi.emit("tool_execution_start", { toolCallId: "b", toolName: "bash" });
  assert.equal(now(), "Running 2 tools");
  // A script's own calls are the script's.
  pi.emit("tool_execution_start", { toolCallId: "s/1", toolName: "read", parentToolCallId: "s" });
  assert.equal(now(), "Running 2 tools");
  pi.emit("tool_execution_end", { toolCallId: "a", toolName: "read" });
  assert.equal(now(), "Running bash");
  pi.emit("tool_execution_end", { toolCallId: "b", toolName: "bash" });
  assert.equal(now(), "Waiting");
  pi.emit("turn_start");
  assert.equal(now(), "Waiting");
  pi.emit("agent_end");
  assert.equal(activity(), undefined);
});

test("a tool's name, which a model chooses, shows as one short line", () => {
  const pi = fakePi();
  const activity = trackActivity(pi.api);
  pi.emit("agent_start");
  pi.emit("tool_execution_start", { toolCallId: "a", toolName: "evil\x1b[2J\nname\ttool" });
  assert.equal(activity()?.label, "Running evil [2J name tool");
  pi.emit("tool_execution_end", { toolCallId: "a" });
  pi.emit("tool_execution_start", { toolCallId: "b", toolName: "x".repeat(200) });
  assert.equal(activity()?.label, `Running ${"x".repeat(40)}`);
  pi.emit("tool_execution_end", { toolCallId: "b" });
  pi.emit("tool_execution_start", { toolCallId: "c", toolName: "\x07" });
  assert.equal(activity()?.label, "Running a tool");
});

test("a click on the statistic cycles tokens, cache, cost and context", (t) => {
  const b = boxed(t);
  const stat = () => b.plain()[0].match(/ (\S.*?) ─ \(anthropic\)/)?.[1];
  assert.equal(stat(), STATS.tokens);
  for (const next of [STATS.cache, STATS.cost, STATS.context, STATS.tokens]) {
    const x = b.plain()[0].indexOf(stat() ?? "");
    b.click(x + 1, 0);
    assert.equal(stat(), next);
  }
  // Elsewhere on the top border, a click changes nothing.
  b.click(3, 0);
  assert.equal(stat(), STATS.tokens);
});

test("dragging the top border resizes the box, from three rows to where Pi's editor scrolls", (t) => {
  const b = boxed(t, 40);
  b.editor.render(80);
  const height = () => b.plain().length - 2;
  b.editor.handleMouse?.(b.mouse("press", 10, 0, 20));
  // Up three rows: three more rows of text.
  b.editor.handleMouse?.(b.mouse("drag", 10, 0, 17));
  assert.equal(height(), MIN_ROWS + 3);
  assert(b.renders > 0, "the drag asks for a frame");
  // Down past its start: never fewer than three.
  b.editor.handleMouse?.(b.mouse("drag", 10, 0, 30));
  assert.equal(height(), MIN_ROWS);
  // Far up: no taller than Pi's editor shows text before it scrolls, 30% of 40 rows.
  b.editor.handleMouse?.(b.mouse("drag", 10, 0, -100));
  assert.equal(height(), 12);
  b.editor.handleMouse?.(b.mouse("release", 10, 0, -100));
  // Released, the box no longer follows the pointer.
  b.editor.handleMouse?.(b.mouse("drag", 10, 0, 30));
  assert.equal(height(), 12);
  // Another drag starts from the box's height now.
  b.editor.render(80);
  b.editor.handleMouse?.(b.mouse("press", 10, 0, 20));
  b.editor.handleMouse?.(b.mouse("drag", 10, 0, 22));
  assert.equal(height(), 10);
  // A new editor, as each session has, starts at three rows.
  assert.equal(boxed(t).plain().length - 2, MIN_ROWS);
});

test("a box dragged tall is no taller than the terminal allows once it shrinks", (t) => {
  const b = boxed(t, 40);
  b.editor.render(80);
  b.editor.handleMouse?.(b.mouse("press", 10, 0, 30));
  b.editor.handleMouse?.(b.mouse("drag", 10, 0, 0));
  b.editor.handleMouse?.(b.mouse("release", 10, 0, 0));
  assert.equal(b.plain().length - 2, 12);
  (b.host.terminal as { rows: number }).rows = 20;
  // 30% of 20 rows is 6: where Pi's editor scrolls its text now.
  assert.equal(b.plain().length - 2, 6);
});

test("on the top border, the wheel and other buttons pass on to Pi; a lost release ends a drag", (t) => {
  const b = boxed(t);
  b.editor.render(80);
  assert.equal(b.editor.handleMouse?.({ ...b.mouse("wheel", 10, 0), button: "none" }), undefined);
  assert.equal(b.editor.handleMouse?.({ ...b.mouse("press", 10, 0), button: "right" }), undefined);
  assert.equal(b.editor.handleMouse?.(b.mouse("move", 10, 0)), undefined);
  // Pi forgets a capture when the terminal loses focus: the next drag over the box is Pi's.
  b.editor.handleMouse?.(b.mouse("press", 10, 0, 20));
  b.editor.handleMouse?.(b.mouse("move", 10, 2, 22));
  b.editor.handleMouse?.(b.mouse("drag", 10, 1, 10));
  assert.equal(b.plain().length - 2, MIN_ROWS, "no resize from a stale press");
});

test("clicks below the top border reach Pi's editor where Pi drew them", (t) => {
  const b = boxed(t);
  b.editor.setText("hello");
  b.editor.render(80);
  const reached = () => b.editor.seen.at(-1);
  // The text: one column in, past the side border.
  b.editor.handleMouse?.(b.mouse("click", 4, 1));
  assert.deepEqual([reached()?.x, reached()?.y, reached()?.width], [3, 1, 78]);
  // Blank rows and the bottom border: below Pi's text, which Pi takes as below its text.
  for (const y of [2, 3, 4]) {
    b.editor.handleMouse?.(b.mouse("click", 4, y));
    assert.equal(reached()?.y, 2, `row ${y}`);
  }
});

test("Pi's command menu stays below the box, and its clicks reach it", async (t) => {
  const b = boxed(t);
  b.editor.setAutocompleteProvider({
    getSuggestions: async () => ({
      prefix: "/fi",
      items: [
        { value: "/first", label: "/first" },
        { value: "/final", label: "/final" },
      ],
    }),
    applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
  });
  b.editor.setText("/fi");
  b.editor.handleInput("\t");
  await new Promise(setImmediate);
  const shown = b.plain();
  const bottom = shown.findIndex((row) => row.startsWith("╰"));
  assert.equal(bottom, 1 + MIN_ROWS, "the box keeps its rows");
  assert(
    shown.slice(bottom + 1).some((row) => row.includes("/final")),
    "the menu below it",
  );
  // A click on the menu's second row reaches Pi's editor on Pi's own row for it.
  const row = shown.findIndex((line, index) => index > bottom && line.includes("/final"));
  b.editor.handleMouse?.(b.mouse("click", 4, row));
  // Pi drew one row of text, its border, then the menu.
  assert.equal(b.editor.seen.at(-1)?.y, row - (MIN_ROWS - 1));
});

/** Boxes `editor` with nothing to show but the warnings and the footer's return it records. */
function watched(editor: import("@earendil-works/pi-tui").EditorComponent, labels?: () => never) {
  const host = fake<TUI>({ terminal: { rows: 40 } as Fake<TUI["terminal"]>, requestRender() {} });
  const reports: string[] = [];
  let unboxed = 0;
  boxEditor(editor, {
    tui: host,
    theme: () => themes.theme,
    status: () => undefined,
    labels: labels ?? (() => ({ pwd: "", model: "", stat: (which) => STATS[which], statuses: [] })),
    report: (message) => reports.push(message),
    unboxed: () => {
      unboxed++;
    },
  });
  return { reports, unboxed: () => unboxed };
}
const piEditor = () => {
  const host = fake<TUI>({ terminal: { rows: 40 } as Fake<TUI["terminal"]>, requestRender() {} });
  return new core.CustomEditor(host, themes.getEditorTheme(), new KeybindingsManager({}), {
    embedWorkingStatus: true,
  });
};

test("an editor drawn in another shape is left as Pi draws it, with one warning and the footer", () => {
  class Odd extends core.CustomEditor {
    override render(_width: number) {
      return ["not an editor"];
    }
  }
  const host = fake<TUI>({ terminal: { rows: 40 } as Fake<TUI["terminal"]>, requestRender() {} });
  const editor = new Odd(host, themes.getEditorTheme(), new KeybindingsManager({}));
  const w = watched(editor);
  assert.deepEqual(editor.render(80), ["not an editor"]);
  assert.deepEqual(editor.render(80), ["not an editor"]);
  assert.equal(w.reports.length, 1);
  assert.match(w.reports[0], /Pi's editor changed: the editor is drawn as Pi draws it/);
  assert.equal(w.unboxed(), 1, "Pi's footer comes back, once");
});

test("labels that throw, as after a Pi upgrade, leave the editor to Pi rather than end Pi", () => {
  const editor = piEditor();
  const w = watched(editor, () => {
    throw new Error("getThinkingLevel is not a function");
  });
  const lines = editor.render(80).map(strip);
  assert(!lines.some((row) => row.startsWith("╭")), "drawn as Pi draws it");
  assert.match(w.reports[0] ?? "", /the box failed \(getThinkingLevel is not a function\)/);
  assert.equal(w.unboxed(), 1);
  editor.render(80);
  assert.equal(w.reports.length, 1, "one warning");
});

test("a status of another shape leaves the editor to Pi, with Pi's own status", () => {
  const editor = piEditor();
  const w = watched(editor);
  // A status Pi has changed: it still draws itself on Pi's border, but not as the box reads it.
  editor.setWorkingStatusIndicator(
    fake<NonNullable<Parameters<typeof editor.setWorkingStatusIndicator>[0]>>({
      kind: "working",
      renderInBorder: () => "⠋ Working anew",
    }),
  );
  const lines = editor.render(80).map(strip);
  assert.match(w.reports[0] ?? "", /Pi's working status changed/);
  assert.equal(w.unboxed(), 1);
  // Unboxed, the status is Pi's editor's again, drawn on its top border.
  assert.match(lines[0], /⠋ Working anew/);
});

test("an editor that is not Pi's is left unboxed, with the footer", () => {
  const editor = { render: () => ["custom"], invalidate() {}, handleInput() {} };
  const w = watched(editor as unknown as import("@earendil-works/pi-tui").EditorComponent);
  assert.deepEqual(editor.render(), ["custom"]);
  assert.match(w.reports[0] ?? "", /not Pi's/);
  assert.equal(w.unboxed(), 1);
});

test("boxed, Pi's editor draws no status of its own: the box's bottom border carries it", (t) => {
  const b = boxed(t);
  b.editor.setWorkingStatusIndicator(b.indicator);
  const lines = b.plain();
  assert(!lines[0].includes("Working"), "nothing on the top border");
  assert.match(lines[1 + MIN_ROWS], /⠋ Working/);
  assert.equal(b.unboxed, 0);
});

test("a shell command's draft is marked on the top border, which Pi marks by colour alone", (t) => {
  const b = boxed(t);
  b.editor.setText("!ls");
  const top = b.editor.render(80)[0];
  assert.match(strip(top), /^╭─ bash ─+ ↑1\.2k/);
  assert(top.includes(themes.theme.fg("bashMode", "bash")), "in Pi's colour for it");
  b.editor.setText("  !!ls");
  assert.match(b.plain()[0], /^╭─ bash \(no context\) ─+ /);
  b.editor.setText("ls");
  assert.match(b.plain()[0], /^╭─+ ↑1\.2k/);
});

test("a status too long for the border is cut to fit, its spinner kept", (t) => {
  const b = boxed(t);
  b.editor.setWorkingStatusIndicator(b.indicator);
  b.status = { kind: "running", label: "Running a_tool_with_a_rather_long_name_that_goes_on" };
  const bottom = b.plain(40)[1 + MIN_ROWS];
  assert.match(bottom, /^╰─ ⠋ Running a_tool.*…/);
  assert.equal(tui.visibleWidth(b.editor.render(40)[1 + MIN_ROWS]), 40);
});

test("the statistic's click lands on its first and last columns, not beside it", (t) => {
  const b = boxed(t);
  const top = b.plain()[0];
  const start = top.indexOf("↑1.2k");
  const end = start + STATS.tokens.length;
  b.click(start - 1, 0);
  assert.match(b.plain()[0], /↑1\.2k ↓300/, "the space before it");
  b.click(end, 0);
  assert.match(b.plain()[0], /↑1\.2k ↓300/, "the space after it");
  b.click(start, 0);
  assert.match(b.plain()[0], /R5\.0k W1\.0k CH80\.0%/, "its first column");
  const cache = b.plain()[0].indexOf("R5.0k") + STATS.cache.length - 1;
  b.click(cache, 0);
  assert.match(b.plain()[0], /\$0\.120 \(sub\)/, "its last column");
});

test("the terminal losing focus mid-drag ends it, as Pi forgets the press", (t) => {
  const b = boxed(t);
  b.editor.render(80);
  b.editor.handleMouse?.(b.mouse("press", 10, 0, 20));
  assert.equal(b.listeners.size, 1, "a drag listens for the focus going");
  b.input("\x1b[O");
  assert.equal(b.listeners.size, 0);
  // A selection dragged from the transcript across the box, with no move between: no resize.
  b.editor.handleMouse?.(b.mouse("drag", 10, 0, 10));
  assert.equal(b.plain().length - 2, MIN_ROWS);
  // A drag that ends as it should stops listening too.
  b.editor.handleMouse?.(b.mouse("press", 10, 0, 20));
  b.editor.handleMouse?.(b.mouse("release", 10, 0, 20));
  assert.equal(b.listeners.size, 0);
});

test("the footer knows whether the box drew, and which statistic it shows", (t) => {
  const b = boxed(t);
  assert(b.handle);
  assert.equal(b.handle.drew(), false, "not drawn yet");
  b.editor.render(80);
  assert.equal(b.handle.drew(), true);
  assert.equal(b.handle.drew(), false, "asked once per frame");
  b.click(b.plain()[0].indexOf("↑1.2k"), 0);
  assert.equal(b.handle.stat(), "cache");
  // Too narrow for the box, the editor draws as Pi's, and the footer is told.
  b.handle.drew();
  b.editor.render(10);
  assert.equal(b.handle.drew(), false);
});

test("without the box, the labels fit one line: the statistic goes before the model is cut", () => {
  const labels = {
    pwd: "~/project (main)",
    model: "(anthropic) claude-opus-5-5 • xhigh",
    stat: (which: keyof typeof STATS) => STATS[which],
    statuses: ["lint ok"],
  };
  const wide = labelLine(labels, "context", 100);
  assert.equal(tui.visibleWidth(wide), 100);
  assert.match(
    wide,
    /^~\/project \(main\) lint ok +12\.5%\/200k \(auto\) {2}\(anthropic\) claude-opus-5-5 • xhigh$/,
  );
  const narrow = labelLine(labels, "context", 62);
  assert.match(narrow, /^~\/project \(main\) lint ok +\(anthropic\) claude-opus-5-5 • xhigh$/);
  const cut = strip(labelLine(labels, "context", 56));
  assert.match(cut, /^~\/project \(main\) l… {2}\(anthropic\) claude-opus-5-5 • xhigh$/);
  const tiny = labelLine(labels, "context", 20);
  assert(tui.visibleWidth(tiny) <= 20);
});

type Reply = Parameters<SessionManager["appendMessage"]>[0];
/** An assistant reply with the usage a provider reported for it. */
const reply = (
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  cost: number,
) =>
  ({
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-5-5",
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite,
      totalTokens: input + output + cacheRead + cacheWrite,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
    },
    stopReason: "stop",
    timestamp: 1,
  }) as Reply;

test("the labels follow Pi's footer: directory, model, statistics, and extensions' statuses", () => {
  const sessionManager = core.SessionManager.inMemory(process.cwd());
  sessionManager.appendMessage(reply(1000, 200, 3000, 500, 0.1));
  sessionManager.appendMessage(reply(500, 100, 4000, 0, 0.02));
  let percent = 25;
  let scans = 0;
  const entries = sessionManager.getEntries.bind(sessionManager);
  sessionManager.getEntries = () => {
    scans++;
    return entries();
  };
  const ctx = fake<ExtensionContext>({
    sessionManager,
    model: fake<NonNullable<ExtensionContext["model"]>>({
      provider: "anthropic",
      id: "claude-opus-5-5",
      reasoning: true,
      contextWindow: 200000,
    }),
    getContextUsage: () => ({ tokens: percent * 2000, contextWindow: 200000, percent }),
    modelRegistry: fake<ExtensionContext["modelRegistry"]>({ isUsingOAuth: () => true }),
    ui: fake<ExtensionContext["ui"]>({ theme: themes.theme }),
  });
  const pi = { ...fakePi().api, getThinkingLevel: () => "xhigh" } as ExtensionAPI;
  const footer = {
    getGitBranch: () => "main",
    getAvailableProviderCount: () => 2,
    getExtensionStatuses: () =>
      new Map([
        ["b", "two\nlines"],
        ["a", "one"],
      ]),
    onBranchChange: () => () => {},
  };
  const labels = createLabels(pi);
  const shown = labels(ctx, footer);
  assert.equal(strip(shown.pwd), `${footerPath(process.cwd())} (main)`);
  assert.equal(strip(shown.model), "(anthropic) claude-opus-5-5 • xhigh");
  assert.deepEqual(
    Object.fromEntries(
      (["tokens", "cache", "cost", "context"] as const).map((key) => [key, strip(shown.stat(key))]),
    ),
    {
      tokens: "↑1.5k ↓300",
      // The latest prompt read 4000 of its 4500 tokens from cache.
      cache: "R7.0k W500 CH88.9%",
      cost: "$0.120 (sub)",
      context: "25.0%/200k (auto)",
    },
  );
  assert.deepEqual(shown.statuses, ["one", "two lines"]);
  // Drawn every frame, the session is read once until it moves on.
  labels(ctx, footer);
  assert.equal(scans, 1);
  sessionManager.appendMessage(reply(10, 10, 0, 0, 0));
  labels(ctx, footer);
  assert.equal(scans, 2);
  // Another model, whose context window may differ, reads the session again.
  ctx.model = fake<NonNullable<ExtensionContext["model"]>>({
    provider: "anthropic",
    id: "claude-sonnet-5-5",
    reasoning: true,
    contextWindow: 200000,
  });
  assert.match(strip(labels(ctx, footer).model), /claude-sonnet-5-5/);
  assert.equal(scans, 3);
  // Context fills: Pi's warning colour past 70%, its error colour past 90%.
  for (const [value, colour] of [
    [75, "warning"],
    [95, "error"],
  ] as const) {
    percent = value;
    sessionManager.appendMessage(reply(1, 1, 0, 0, 0));
    assert(labels(ctx, footer).stat("context").includes(themes.theme.getFgAnsi(colour)));
  }
});

test("the labels say what Pi's own footer says, drawn from the same session", () => {
  const sessionManager = core.SessionManager.inMemory(process.cwd());
  sessionManager.appendMessage(reply(1000, 200, 3000, 500, 0.1));
  sessionManager.appendMessage(reply(500, 100, 4000, 0, 0.02));
  sessionManager.appendSessionInfo("named session");
  const model = fake<NonNullable<ExtensionContext["model"]>>({
    provider: "anthropic",
    id: "claude-opus-5-5",
    reasoning: true,
    contextWindow: 200000,
  });
  const getContextUsage = () => ({ tokens: 84000, contextWindow: 200000, percent: 42 });
  const footer = {
    getGitBranch: () => "main",
    getAvailableProviderCount: () => 2,
    getExtensionStatuses: () => new Map([["a", "one"]]),
    onBranchChange: () => () => {},
  };
  const ctx = fake<ExtensionContext>({
    sessionManager,
    model,
    getContextUsage,
    modelRegistry: fake<ExtensionContext["modelRegistry"]>({ isUsingOAuth: () => true }),
    ui: fake<ExtensionContext["ui"]>({ theme: themes.theme }),
  });
  const pi = { ...fakePi().api, getThinkingLevel: () => "high" } as ExtensionAPI;
  const shown = createLabels(pi)(ctx, footer);
  type Session = ConstructorParameters<typeof core.FooterComponent>[0];
  const session = fake<Session>({
    sessionManager,
    model,
    state: fake<Session["state"]>({ model, thinkingLevel: "high" }),
    getContextUsage,
    modelRuntime: fake<Session["modelRuntime"]>({ isUsingSubscription: () => true }),
  });
  const [pwd, stats, statuses] = new core.FooterComponent(session, footer)
    .render(200)
    .map((row) => strip(row));
  assert.equal(strip(shown.pwd), pwd);
  const [left, right] = stats.split(/ {2,}/);
  assert.equal(left, STAT_NAMES.map((which) => strip(shown.stat(which))).join(" "));
  assert.equal(strip(shown.model), right);
  assert.equal(shown.statuses.join(" "), statuses);
});

const STAT_NAMES = ["tokens", "cache", "cost", "context"] as const;

test("token counts are in Pi's footer format, shared with comrade", () => {
  assert.deepEqual([805, 7200, 41000, 1200000, 12000000].map(formatTokens), [
    "805",
    "7.2k",
    "41k",
    "1.2M",
    "12M",
  ]);
});
