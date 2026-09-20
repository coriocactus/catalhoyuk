import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pkg, require } from "../../mirage/tests/pi-package.mjs";

const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": join(pkg, "dist/index.js"),
    "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
  },
});
const { default: install } = await jiti.import("../index.ts");
const { KeybindingsManager } = await import(join(pkg, "dist/core/keybindings.js"));
const { WorkingStatusIndicator } = await import(
  join(pkg, "dist/modes/interactive/components/status-indicator.js")
);
const { stripTerminalSequences, visibleWidth } = await import(
  require.resolve("@earendil-works/pi-tui")
);
const { initTheme, getEditorTheme } = await import(
  join(pkg, "dist/modes/interactive/theme/theme.js")
);
initTheme("dark");

function fixture(t, { mode = "tui", bindings = {} } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const handlers = new Map();
  let editor,
    renders = 0,
    idle = false,
    escapes = 0;
  install({ on: (name, handler) => handlers.set(name, handler) });
  const tui = {
    terminal: { rows: 40 },
    requestRender() {
      renders++;
    },
  };
  const indicator = new WorkingStatusIndicator(tui, "Working", { frames: ["⠋"] });
  t.after(() => indicator.dispose());
  const ctx = {
    mode,
    isIdle: () => idle,
    ui: {
      setStatus() {
        assert.fail("The hint must not add a footer row");
      },
      setWidget() {
        assert.fail("The hint must not add a widget row");
      },
      setWorkingMessage(message) {
        indicator.setMessage(message ?? "Working");
      },
      setEditorComponent(factory) {
        editor = factory(tui, getEditorTheme(), new KeybindingsManager(bindings));
        editor.setWorkingStatusIndicator(indicator);
        // Pi wires the default editor's dynamic interrupt handler this way.
        editor.onEscape = () => escapes++;
      },
    },
  };
  const emit = (name) => handlers.get(name)({}, ctx);
  emit("session_start");
  t.after(() => emit("session_shutdown"));
  return {
    emit,
    get editor() {
      return editor;
    },
    get status() {
      const border = stripTerminalSequences(editor.render(100)[0]);
      return border.match(/Press Esc again to stop/)?.[0];
    },
    get renders() {
      return renders;
    },
    get escapes() {
      return escapes;
    },
    set idle(value) {
      idle = value;
    },
  };
}

for (const key of ["\x1b", "\x1b[27u"]) {
  test(`first Escape arms, second invokes Pi's handler (${JSON.stringify(key)})`, (t) => {
    const f = fixture(t);
    f.editor.setText("keep this draft");
    assert.equal(f.editor.embedWorkingStatus, true);
    f.editor.handleInput(key);
    assert.equal(f.escapes, 0);
    assert.match(f.status, /Press Esc again/);
    t.mock.timers.tick(1499);
    f.editor.handleInput(key);
    assert.equal(f.escapes, 1);
    assert.equal(f.status, undefined);
    assert.equal(f.editor.getText(), "keep this draft");
  });
}

test("1.5 seconds expires the confirmation and the next Escape only arms again", (t) => {
  const f = fixture(t);
  f.editor.handleInput("\x1b");
  t.mock.timers.tick(1499);
  assert.equal(f.status, "Press Esc again to stop");
  t.mock.timers.tick(1);
  assert.equal(f.status, undefined);
  f.editor.handleInput("\x1b");
  assert.equal(f.escapes, 0);
  assert.match(f.status, /Press Esc again/);
});

test("the hint replaces Working beside the spinner without changing the layout", (t) => {
  const f = fixture(t);
  f.editor.setText("keep this draft\nsecond line");
  for (const width of [1, 5, 20, 35, 60, 100]) {
    const before = f.editor.render(width);
    const renders = f.renders;
    f.editor.handleInput("\x1b");
    assert.equal(f.renders, renders + 1, "arming requests a repaint");
    const armed = f.editor.render(width);
    assert.equal(armed.length, before.length, "no added rows");
    assert.deepEqual(armed.slice(1), before.slice(1), "draft, cursor and bottom border stay put");
    assert.equal(visibleWidth(armed[0]), width, "border does not wrap");
    assert.match(stripTerminalSequences(armed[0]), /⠋/, "keep Pi's spinner");
    if (width >= 60) assert.match(stripTerminalSequences(armed[0]), /⠋ Press Esc again/);
    t.mock.timers.tick(1500);
    assert.equal(f.renders, renders + 2, "expiry repaints even without keyboard input");
    assert.deepEqual(f.editor.render(width), before, "restore Pi's original working border");
  }
});

test("other input disarms and continues normal editing and app shortcuts", (t) => {
  const f = fixture(t);
  let clears = 0;
  f.editor.onAction("app.clear", () => clears++);
  for (const key of ["x", "\x1b[D", "\x03"]) {
    f.editor.handleInput("\x1b");
    f.editor.handleInput(key);
    assert.equal(f.status, undefined);
  }
  assert.equal(f.editor.getText(), "x");
  assert.equal(clears, 1);
  f.editor.handleInput("\x1b");
  assert.equal(f.escapes, 0);
});

test("idle Escape passes straight through, preserving idle double-Escape navigation", (t) => {
  const f = fixture(t);
  f.idle = true;
  f.editor.handleInput("\x1b");
  f.editor.handleInput("\x1b");
  assert.equal(f.escapes, 2);
  assert.equal(f.status, undefined);
});

test("autocomplete dismisses on one Escape without arming or aborting", async (t) => {
  const f = fixture(t);
  f.editor.setAutocompleteProvider({
    getSuggestions: () => ({
      prefix: "/fi",
      items: [
        { value: "/first", label: "/first" },
        { value: "/final", label: "/final" },
      ],
    }),
    applyCompletion: () => assert.fail("Escape must not accept a completion"),
  });
  f.editor.setText("/fi");
  f.editor.handleInput("\t");
  await new Promise(setImmediate);
  assert.equal(f.editor.isShowingAutocomplete(), true);
  f.editor.handleInput("\x1b");
  assert.equal(f.editor.isShowingAutocomplete(), false);
  assert.equal(f.status, undefined);
  assert.equal(f.escapes, 0);
  f.editor.handleInput("\x1b");
  assert.match(f.status, /Press Esc again/);
  assert.equal(f.escapes, 0);
});

for (const event of ["agent_start", "agent_end", "session_shutdown", "session_start"]) {
  test(`${event} clears pending confirmation and timers`, (t) => {
    const f = fixture(t);
    f.editor.handleInput("\x1b");
    f.emit(event);
    f.emit(event); // Idempotent cleanup/replacement.
    assert.equal(f.status, undefined);
    t.mock.timers.tick(2000);
    if (event !== "session_shutdown") {
      f.editor.handleInput("\x1b");
      assert.equal(f.escapes, 0);
      assert.match(f.status, /Press Esc again/);
    }
  });
}

test("remapped interrupts are untouched; plain Escape does not arm", (t) => {
  const f = fixture(t, { bindings: { "app.interrupt": "ctrl+x" } });
  f.editor.handleInput("\x1b");
  assert.equal(f.status, undefined);
  assert.equal(f.escapes, 0);
  f.editor.handleInput("\x18");
  assert.equal(f.escapes, 1);
});

for (const mode of ["rpc", "print", "json"]) {
  test(`${mode} does not install a terminal editor`, (t) => {
    const f = fixture(t, { mode });
    assert.equal(f.editor, undefined);
    f.emit("agent_start");
    f.emit("agent_end");
  });
}
