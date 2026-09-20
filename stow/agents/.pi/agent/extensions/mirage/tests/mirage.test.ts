import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type {
  AgentToolResult,
  ExtensionContext,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI, TuiMouseEvent, TuiMouseEventType } from "@earendil-works/pi-tui";
import { OPEN_FILE_EVENT, type OpenFileRequest } from "../../shared/protocol.ts";
import { type FakePi, fake, fakePi, type Tool } from "../../test/fake-pi.ts";
import { core, load, loadFuture, themes, tui } from "../../test/pi.ts";
import { colours } from "../colours.ts";
import type { ToolGroupView } from "../view.ts";

const { default: installDisplay } = await load<typeof import("../index.ts")>(
  "../index.ts",
  import.meta.url,
);
const { ToolGroups } = await load<typeof import("../model.ts")>("../model.ts", import.meta.url);
const { diffCounts } = await load<typeof import("../view.ts")>("../view.ts", import.meta.url);
const { paint, colouredDiff } = await load<typeof import("../style.ts")>(
  "../style.ts",
  import.meta.url,
);

type Result = AgentToolResult<unknown>;
type Message = Parameters<InstanceType<typeof ToolGroups>["observe"]>[0];
type RenderContext = Parameters<NonNullable<Tool["renderCall"]>>[2];
type DisplayState = { view?: ToolGroupView };
type Notice = Parameters<ExtensionContext["ui"]["notify"]>;
/** Private InteractiveMode lookup that binds tool renderers to their host. */
interface ToolLookup {
  getRegisteredToolDefinition(this: object, name: string): Tool | undefined;
}

const interactive = core.InteractiveMode.prototype as unknown as ToolLookup;
const nativeRender = core.ToolExecutionComponent.prototype.render;
const nativeLookup = interactive.getRegisteredToolDefinition;
const ui = fake<TUI>({ requestRender() {} });
const assistantStart = { role: "assistant", content: [] } as unknown as Message;
const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=";
const root = mkdtempSync(join(tmpdir(), "pi-mirage-"));
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
const sessions: FakePi[] = [];
after(async () => {
  for (const pi of sessions) await pi.event("session_shutdown");
  assert.equal(
    core.ToolExecutionComponent.prototype.render,
    nativeRender,
    "last owner restores Pi rendering on shutdown",
  );
  assert.equal(
    interactive.getRegisteredToolDefinition,
    nativeLookup,
    "last owner restores Pi's tool lookup on shutdown",
  );
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  rmSync(root, { recursive: true, force: true });
});

const mouse = (x: number, y = 0, type: TuiMouseEventType = "click"): TuiMouseEvent => ({
  type,
  button: "left",
  x,
  y,
  screenX: x,
  screenY: y,
  width: 160,
  height: 40,
  shift: false,
  alt: false,
  ctrl: false,
});
const plain = (component: Component, width = 160) =>
  component
    .render(width)
    .map((line) => tui.stripTerminalSequences(line).trimEnd())
    .join("\n");
const isImageLine = (line: string) => line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
const result = (value: string, details: unknown = {}): Result => ({
  content: [{ type: "text", text: value }],
  details,
});
const firstText = (output: Result) => {
  const part = output.content[0];
  assert(part?.type === "text", "text result");
  return part.text;
};
/** Private ToolExecutionComponent state. */
const internals = (component: object) =>
  component as { rendererState: DisplayState; imageComponents: Component[] };
const component = (
  name: string,
  id: string,
  args: unknown,
  definition: Tool | undefined,
  cwd: string,
  options: { showImages?: boolean } = {},
) => new core.ToolExecutionComponent(name, id, args, options, definition, ui, cwd);

interface Slot {
  definition: Tool;
  context: RenderContext;
  view: ToolGroupView;
  redraw(): void;
  result(output: Result, failed?: boolean, partial?: boolean): void;
}

async function fixture({
  global = {},
  project = {},
  trusted = false,
  mode = "tui",
}: {
  global?: object;
  project?: object;
  trusted?: boolean;
  mode?: ExtensionContext["mode"];
} = {}) {
  const dir = mkdtempSync(join(root, "case-"));
  const config = join(dir, "config");
  mkdirSync(config);
  mkdirSync(join(dir, ".pi"));
  writeFileSync(join(config, "settings.json"), JSON.stringify(global));
  writeFileSync(join(dir, ".pi/settings.json"), JSON.stringify(project));
  process.env.PI_CODING_AGENT_DIR = config;
  const pi = fakePi(),
    slots: Slot[] = [],
    notices: Notice[] = [];
  let allExpanded = false,
    entries: SessionEntry[] = [],
    invalidations = 0;
  const ctx = fake<ExtensionContext>({
    mode,
    cwd: dir,
    isProjectTrusted: () => trusted,
    ui: {
      getToolsExpanded: () => allExpanded,
      notify: (...args) => notices.push(args),
    },
    sessionManager: {
      buildContextEntries: () => entries,
      getSessionId: () => "test",
      getSessionFile: () => undefined,
    },
  });
  installDisplay(pi.api);
  sessions.push(pi);
  await pi.event("session_start", {}, ctx);
  const tool = (name: string): Tool => {
    const definition = pi.tools.get(name);
    assert(definition, `${name} is registered`);
    return definition;
  };
  function call(name: string, id: string, args: unknown, started = true): Slot {
    const definition = tool(name);
    const context = fake<RenderContext>({
      args,
      toolCallId: id,
      state: {},
      cwd: dir,
      executionStarted: started,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: false,
      isError: false,
      invalidate() {
        invalidations++;
      },
    });
    const render = () =>
      definition.renderCall?.(context.args, themes.theme, context) as ToolGroupView;
    const slot: Slot = {
      definition,
      context,
      view: render(),
      redraw() {
        slot.view = render();
      },
      result(output, failed = false, partial = false) {
        context.isError = failed;
        definition.renderResult?.(
          output,
          { expanded: allExpanded, isPartial: partial },
          themes.theme,
          context,
        );
      },
    };
    slots.push(slot);
    return slot;
  }
  return {
    pi,
    ctx,
    dir,
    tool,
    call,
    notices,
    get invalidations() {
      return invalidations;
    },
    expand(value: boolean) {
      allExpanded = value;
      for (const slot of slots) slot.redraw();
    },
    async rebuild(event: string, values: unknown[] = []) {
      entries = values as SessionEntry[];
      await pi.event(event, {}, ctx);
    },
  };
}

test("compatibility checks capabilities, not a version allowlist, and warns before native fallback", async (t) => {
  const images = await loadFuture<typeof import("../native-images.ts")>(
    "../native-images.ts",
    import.meta.url,
  );
  const padding = await loadFuture<typeof import("../native-padding.ts")>(
    "../native-padding.ts",
    import.meta.url,
  );
  t.mock.method(core.ToolExecutionComponent.prototype, "render", () => ["native fallback"]);
  t.mock.method(interactive, "getRegisteredToolDefinition", function (this: { definition?: Tool }) {
    return this.definition;
  });
  const notices: string[] = [],
    releases: (() => void)[] = [];
  try {
    releases.push(images.installNativeImageSlot((error) => notices.push(error.message)));
    releases.push(padding.installNativeOutputPadding((error) => notices.push(error.message)));
    const broken = {
      toolDefinition: images.ownImageRendering({ renderShell: "self" }),
      rendererState: {},
    };
    for (let i = 0; i < 2; i++)
      assert.deepEqual(core.ToolExecutionComponent.prototype.render.call(broken, 30), [
        "native fallback",
      ]);
    assert.equal(notices.length, 1, "one warning, not one per paint");
    assert.match(notices[0], /Pi 999\.0\.0: image adapter API changed/);
    const state = {};
    const host: { outputPad?: number; definition: Tool } = {
      outputPad: 2,
      definition: padding.ownOutputPadding(
        fake<Tool>({
          renderCall() {
            return fake<Component>({});
          },
        }),
      ),
    };
    interactive.getRegisteredToolDefinition
      .call(host, "read")
      ?.renderCall?.({}, themes.theme, fake<RenderContext>({ state }));
    assert.equal(padding.outputPadding(state), 2, "nonnegative integer padding remains compatible");
    delete host.outputPad;
    assert.equal(padding.outputPadding(state), 0);
    assert.equal(padding.outputPadding(state), 0);
    assert.equal(notices.length, 2);
    assert.match(notices[1], /Pi 999\.0\.0: output padding API changed/);
  } finally {
    for (const release of releases.reverse()) release();
  }
  const prototype = core.ToolExecutionComponent.prototype as { render?: unknown };
  const imageRender = prototype.render;
  prototype.render = undefined;
  try {
    assert.throws(() => images.installNativeImageSlot(), /renderer is unavailable/);
  } finally {
    prototype.render = imageRender;
  }
});

test("palette supplies RGB and indexed colours without losing diff word highlights", (t) => {
  // Pi's chalk styles are disabled when this test's stdout is a pipe.
  t.mock.method(themes.Theme.prototype, "inverse", (text: string) => `\x1b[7m${text}\x1b[27m`);
  const rgb = fake<Theme>({ getColorMode: () => "truecolor" });
  const indexed = fake<Theme>({ getColorMode: () => "256color" });
  for (const [tone, hex] of Object.entries(colours) as [keyof typeof colours, string][]) {
    const channels = (hex.slice(1).match(/../g) ?? []).map((value) => Number.parseInt(value, 16));
    assert.equal(paint(rgb, tone, "text"), `\x1b[38;2;${channels.join(";")}mtext\x1b[39m`);
    const escaped = paint(indexed, tone, "text");
    assert(escaped.startsWith("\x1b[38;5;") && escaped.endsWith("mtext\x1b[39m"));
    const index = Number(escaped.slice(7).split("m")[0]);
    assert(index >= 16 && index <= 255);
    if (hex.toLowerCase() === "#5f87ff")
      assert.equal(index, 63, "exact xterm cube colour stays exact");
  }
  const source = '-1 const value = "before";\n+1 const value = "after";\n 2 unchanged';
  const lines = colouredDiff(rgb, source).split("\n");
  for (const [line, tone] of [
    [lines[0], "red"],
    [lines[1], "green"],
  ] as const) {
    assert(line.startsWith(paint(rgb, tone, "").split("\x1b[39m")[0]));
    assert(line.includes("\x1b[7m") && line.includes("\x1b[27m"), "word changes remain inverse");
  }
  assert.equal(lines[2], core.renderDiff(source).split("\n")[2], "context keeps Pi styling");
});

test("group boundaries, streaming snapshots, and expansion survive growth and merges", () => {
  const model = new ToolGroups();
  const add = (id: string, name: string, args: unknown) => {
    const row = model.addCall(id, name, args, root);
    assert(row, `${id} row`);
    return row;
  };
  const a = add("a", "read", { path: "a" });
  model.toggle(a);
  const b = add("b", "read", { path: "b" });
  assert.equal(a.group, b.group);
  assert(
    model.expanded(a) && model.expanded(a.group),
    "promoting a singleton preserves its visible output",
  );
  assert(!model.expanded(b));
  assert.equal(model.addCall("a", "read", { path: "updated" }, root), a);
  assert.equal(a.file?.path, "updated", "streamed arguments update the snapshot");
  model.addCall("foreign", "grep", {}, root);
  assert.notEqual(add("c", "read", {}).group, a.group);
  assert.equal(add("edit1", "edit", {}).group, add("edit2", "edit", {}).group);
  assert.notEqual(add("write1", "write", {}).group, add("write2", "write", {}).group);
  model.reset();
  const batch = (id: string, blocks: object[] = []) => {
    const message = {
      role: "assistant",
      content: [...blocks, { type: "toolCall", id, name: "read", arguments: { path: id } }],
      stopReason: "toolUse",
    } as unknown as Message;
    model.startMessage(assistantStart, root);
    model.observe(message, root);
    model.finishMessage(message, root);
    const row = model.rows.get(id);
    assert(row, `${id} row`);
    return row;
  };
  const first = batch("first");
  model.toggle(first);
  const second = batch("second");
  assert.equal(first.group, second.group);
  assert(model.expanded(first) && model.expanded(first.group));
  const commentary = batch("commentary", [{ type: "text", text: "Visible boundary" }]);
  assert.notEqual(commentary.group, second.group);
  const thinking = batch("thinking", [{ type: "thinking", thinking: "Reasoning boundary" }]);
  assert.notEqual(thinking.group, commentary.group);
  const late = {
    role: "assistant",
    content: [{ type: "toolCall", id: "late", name: "read", arguments: {} }] as object[],
  };
  const lateMessage = late as unknown as Message;
  model.startMessage(assistantStart, root);
  model.observe(lateMessage, root);
  late.content.push({ type: "text", text: "Late commentary" });
  model.finishMessage(lateMessage, root);
  assert.notEqual(model.rows.get("late")?.group, thinking.group);
  model.setAllExpanded(true);
  model.toggle(first);
  model.setAllExpanded(false);
  model.setAllExpanded(true);
  assert(model.expanded(first), "global expansion supersedes local choices");
});

test("edit groups merge across tool-only turns without crossing message or tool boundaries", () => {
  const model = new ToolGroups();
  const row = (id: string) => {
    const value = model.rows.get(id);
    assert(value, `${id} row`);
    return value;
  };
  const add = (id: string, name: string) => {
    const value = model.addCall(id, name, {}, root);
    assert(value, `${id} row`);
    return value;
  };
  function batch(id: string, blocks: object[] = []) {
    const message = {
      role: "assistant",
      content: [...blocks, { type: "toolCall", id, name: "edit", arguments: { path: id } }],
      stopReason: "toolUse",
    };
    model.startMessage(assistantStart, root);
    model.observe(message as unknown as Message, root);
    return message;
  }
  const first = batch("first");
  model.finishMessage(first as unknown as Message, root);
  const a = row("first");
  model.toggle(a);
  const second = batch("second");
  const b = row("second");
  assert.notEqual(a.group, b.group, "wait for late commentary before merging");
  model.finishMessage(second as unknown as Message, root);
  assert.equal(a.group, b.group);
  assert(model.expanded(a) && model.expanded(a.group), "merging preserves open diffs");

  for (const block of [
    { type: "text", text: "Commentary" },
    { type: "thinking", thinking: "Reasoning" },
  ]) {
    const previous = row("second");
    const next = batch(block.type);
    next.content.push(block);
    model.finishMessage(next as unknown as Message, root);
    assert.notEqual(row(block.type).group, previous.group);
  }
  for (const name of ["read", "bash", "write", "grep"]) {
    const before = add(`before-${name}`, "edit");
    model.addCall(`boundary-${name}`, name, {}, root);
    const after = add(`after-${name}`, "edit");
    assert.notEqual(before.group, after.group, name);
  }
  for (const role of ["user", "custom", "bashExecution"]) {
    const before = add(`before-${role}`, "edit");
    model.startMessage({ role, content: "Boundary" } as unknown as Message, root);
    assert.notEqual(add(`after-${role}`, "edit").group, before.group);
  }
});

test("normalized renderer inputs tolerate invalid arguments without bypassing validation", async () => {
  const f = await fixture();
  for (const name of ["read", "bash", "edit", "write"]) {
    for (const [i, args] of [null, undefined, [], 17, "invalid", {}, { path: 3 }].entries()) {
      await f.pi.event("message_start", { message: { role: "user", content: "boundary" } }, f.ctx);
      const row = component(name, `${name}-${i}`, args, f.tool(name), f.dir, {
        showImages: false,
      });
      row.updateResult({ ...result("VALIDATION_ERROR"), isError: true });
      assert.doesNotThrow(() => row.render(100));
      assert.match(plain(row), name === "bash" ? /\$ … ▸/ : /✗/);
      assert(!plain(row).includes("VALIDATION_ERROR"));
    }
  }
  const invalid = f.call("edit", "invalid-expanded", null);
  invalid.result(result("VALIDATION_ERROR"), true);
  invalid.view.render(100);
  invalid.view.handleMouse(mouse(0));
  assert.match(plain(invalid.view), /VALIDATION_ERROR/);
});

test("rendering is read-only and cached; file clicks use an acknowledged reference", async () => {
  const f = await fixture();
  let opened: OpenFileRequest | undefined;
  f.pi.events.on(OPEN_FILE_EVENT, (data) => {
    const request = data as OpenFileRequest;
    request.accepted = true;
    opened = request;
  });
  const a = f.call("read", "a", { path: "-file space 日本語;$(echo unsafe).txt" });
  a.result(result("OPEN_OUTPUT"));
  a.view.render(160);
  a.view.handleMouse(mouse(0));
  assert.match(plain(a.view), /OPEN_OUTPUT/);
  const b = f.call("read", "b", { path: "b.txt" });
  b.result(result("READ_B"));
  assert.match(plain(a.view), /Explored 2 files/);
  assert.match(plain(a.view), /OPEN_OUTPUT/, "output remains open after group growth");
  assert(!plain(a.view).includes("READ_B"));
  assert.equal(plain(b.view), "");
  const lines = a.view.render(160);
  const y = lines.findIndex((line) => tui.stripTerminalSequences(line).includes("file space"));
  const x = tui.stripTerminalSequences(lines[y]).indexOf("file space");
  assert.equal(tui.getOsc8LinkAtColumn(lines[y], x), undefined);
  a.view.invalidate(); // A click can arrive before the next repaint.
  a.view.handleMouse(mouse(x, y));
  assert.deepEqual(opened, {
    path: (a.context.args as { path: string }).path,
    cwd: f.dir,
    tool: "read",
    accepted: true,
  });
  const snapshot = JSON.stringify(
    [...a.view.row.group.rows].map((row) => ({ ...row, group: undefined })),
  );
  const cached = a.view.render(160),
    count = f.invalidations;
  for (let i = 0; i < 10000; i++) assert.equal(a.view.render(160), cached);
  assert.equal(f.invalidations, count);
  assert.equal(
    JSON.stringify([...a.view.row.group.rows].map((row) => ({ ...row, group: undefined }))),
    snapshot,
  );
  a.view.handleMouse(mouse(0, 0, "drag"));
  assert.equal(f.invalidations, count);
  const same = a.view;
  a.redraw();
  assert.equal(a.view, same);
  f.expand(true);
  assert.match(plain(a.view), /READ_B/);
  // Two global updates before the next frame still clear local overrides.
  f.expand(false);
  assert(!plain(a.view).includes("OPEN_OUTPUT"));
  f.expand(true);
  f.expand(false);
  assert(!plain(a.view).includes("OPEN_OUTPUT"));
});

test("trailing carets survive truncation and toggle independently of filename links", async () => {
  const f = await fixture();
  const opened: string[] = [];
  f.pi.events.on(OPEN_FILE_EVENT, (data) => {
    const request = data as OpenFileRequest;
    request.accepted = true;
    opened.push(request.path);
  });
  const path = "日本語 very long filename that must be truncated.txt";
  const a = f.call("read", "trailing-a", { path });
  a.result(result("DETAIL_A"));
  assert.equal(plain(a.view), `✓ Read ${path} ▸`);
  const b = f.call("read", "trailing-b", { path: "b.txt" });
  b.result(result("DETAIL_B"));
  assert.equal(plain(a.view), "✓ Explored 2 files ▸");
  a.view.handleMouse(mouse(tui.visibleWidth(plain(a.view)) - 1));
  assert.equal(plain(a.view), `✓ Explored 2 files ▾\n  ✓ Read ${path} ▸\n  ✓ Read b.txt ▸`);
  for (const width of [0, 1, 2, 3, 4, 10, 24, 40, 160]) {
    const lines = a.view.render(width);
    for (const [i, line] of lines.entries()) {
      assert(tui.visibleWidth(line) <= width);
      if (width > 0) assert(tui.stripTerminalSequences(line).endsWith(i === 0 ? "▾" : "▸"));
    }
  }
  const clipped = a.view.render(24)[1];
  assert(!tui.stripTerminalSequences(clipped).includes(path));
  a.view.invalidate(); // Hit targets still refer to the last painted frame.
  a.view.handleMouse(mouse(tui.visibleWidth("  ✓ Read "), 1));
  assert.deepEqual(opened, [path]);
  a.view.handleMouse(mouse(tui.visibleWidth(clipped) - 1, 1));
  assert.match(plain(a.view, 24), /DETAIL_A/);
  assert.deepEqual(opened, [path], "the clipped filename link must not capture the caret");
  const write = f.call("write", "trailing-write", { path: "new.ts", content: "new" });
  write.result(result("written"));
  assert.equal(plain(write.view), "✓ Wrote new.ts ▸");
});

test("command headers use a status-coloured dollar without ticks or crosses", async () => {
  const f = await fixture();
  const a = f.call("bash", "dollar-a", { command: "npm test" }, false);
  const neutral = themes.theme.fg("muted", "$");
  assert.equal(plain(a.view), "$ npm test ▸");
  assert(a.view.render(160)[0].startsWith(`${neutral} npm test `));
  a.result(result("streaming"), false, true);
  assert(a.view.render(160)[0].startsWith(`${neutral} npm test `));
  a.result(result("passed"));
  assert(a.view.render(160)[0].startsWith(`${paint(themes.theme, "green", "$")} npm test `));
  a.result(result("failed"), true);
  assert.equal(plain(a.view), "$ npm test ▸");
  assert(a.view.render(160)[0].startsWith(`${paint(themes.theme, "red", "$")} npm test `));
  a.result(result("passed"));
  const b = f.call("bash", "dollar-b", { command: "npm run lint" }, false);
  assert.equal(plain(a.view), "$ Run 2 commands ▸");
  assert(a.view.render(160)[0].startsWith(`${neutral} Run `));
  b.result(result("streaming"), false, true);
  assert.equal(plain(a.view), "$ Running 2 commands ▸");
  assert(a.view.render(160)[0].startsWith(`${neutral} Running `));
  b.result(result("passed"));
  assert.equal(plain(a.view), "$ Ran 2 commands ▸");
  assert(a.view.render(160)[0].startsWith(`${paint(themes.theme, "green", "$")} Ran `));
  b.result(result("failed"), true);
  assert.equal(plain(a.view), "$ Ran 2 commands (1 failed) ▸\n  $ npm run lint ▸");
  assert(a.view.render(160)[0].startsWith(`${paint(themes.theme, "red", "$")} Ran `));
  f.expand(true);
  const headers = a.view
    .render(160)
    .filter((line) => tui.stripTerminalSequences(line).endsWith("▾"));
  assert.equal(headers.length, 3);
  for (const [i, tone] of (["red", "green", "red"] as const).entries()) {
    const prefix = `${i ? "  " : ""}${paint(themes.theme, tone, "$")} `;
    assert(headers[i].startsWith(prefix));
    assert(!/[✓✗]/.test(tui.stripTerminalSequences(headers[i])));
  }
});

test("failed calls remain visible, but their error bodies obey row and global toggles", async () => {
  const f = await fixture();
  const a = f.call("bash", "a", { command: "printf hello" }, false);
  const b = f.call("bash", "b", { command: "exit 1" }, false);
  assert.match(plain(a.view), /Run 2 commands/);
  a.result(result("streaming"), false, true);
  assert.match(plain(a.view), /Running 2 commands/);
  a.result(result("success"));
  b.result(result("ERROR_BODY\nSTACK_TRACE"), true);
  assert.match(plain(a.view), /Ran 2 commands \(1 failed\)/);
  assert.match(plain(a.view), /^ {2}\$ exit 1 ▸$/m);
  assert(!plain(a.view).includes("ERROR_BODY"));
  a.view.handleMouse(mouse(0, 1));
  assert.match(plain(a.view), /ERROR_BODY\n\s*STACK_TRACE/);
  a.view.handleMouse(mouse(0, 1));
  assert(!plain(a.view).includes("STACK_TRACE"));
  f.expand(true);
  assert.match(plain(a.view), /STACK_TRACE/);
  f.expand(false);
  assert.match(plain(a.view), /^ {2}\$ exit 1 ▸$/m);
  assert(!plain(a.view).includes("STACK_TRACE"));
  const edit = f.call("edit", "e", { path: "edit.ts" });
  edit.result(result("success", { diff: "-1 before\n+1 after" }));
  assert.match(plain(edit.view), /\+1 −1/);
  edit.view.handleMouse(mouse(0));
  assert.match(plain(edit.view), /-1 before\n\s*\+1 after/);
  assert.deepEqual(diffCounts(" 8 unchanged\n-9 old\n+9 new\n+10 another\n ..."), {
    added: 2,
    removed: 1,
  });
  for (const width of [1, 2, 10, 40, 160])
    for (const line of edit.view.render(width)) assert(tui.visibleWidth(line) <= width);
});

test("edit headers omit zero counts while retaining nonzero additions and removals", async () => {
  const f = await fixture();
  const edit = f.call("edit", "counts", { path: "edit.ts" });
  for (const [diff, suffix] of [
    ["-1 before\n+1 after", " +1 −1"],
    ["+1 after", " +1"],
    ["-1 before", " −1"],
    [" 1 unchanged", ""],
    ["", ""],
  ]) {
    edit.result(result("success", { diff }));
    assert.equal(plain(edit.view), `✓ Edited edit.ts${suffix} ▸`);
  }
});

test("edit groups count distinct files and sum only completed diff snapshots", async () => {
  const f = await fixture();
  const a = f.call("edit", "edits-a", { path: "a.txt" }, false);
  const b = f.call("edit", "edits-b", { path: "b.txt" }, false);
  assert.equal(plain(a.view), "… Edit 2 files ▸");
  assert.equal(plain(b.view), "");
  b.result(result("partial", { diff: "-1 old-b\n+1 new-b\n+2 extra" }), false, true);
  assert.equal(plain(a.view), "… Editing 2 files ▸", "partial diffs do not inflate totals");
  b.result(result("done", { diff: "-1 old-b\n+1 new-b\n+2 extra" }));
  a.context.executionStarted = true;
  a.redraw();
  assert.equal(plain(a.view), "… Editing 2 files +2 −1 ▸");
  a.result(result("done", { diff: "-1 old-a\n+1 new-a" }));
  assert.equal(plain(a.view), "✓ Edited 2 files +3 −2 ▸");
  const cached = a.view.render(160);
  assert.equal(a.view.render(160), cached);
  b.result(result("done", { diff: "-1 old-b\n+1 new-b\n+2 extra" }));
  assert.equal(plain(a.view), "✓ Edited 2 files +3 −2 ▸", "snapshots are not cumulative");

  const again = f.call("edit", "edits-again", { path: "a.txt" });
  again.result(result("done", { diff: "-1 old-a\n-2 another" }));
  assert.equal(plain(a.view), "✓ Edited 2 files +3 −4 ▸", "repeated paths count once");
  again.context.cwd = join(f.dir, "other-project");
  again.redraw();
  assert.equal(plain(a.view), "✓ Edited 3 files +3 −4 ▸", "working directories stay distinct");
  again.context.cwd = f.dir;
  again.redraw();
  b.result(result("done"));
  again.result(result("done", { diff: "" }));
  for (const [diff, suffix] of [
    ["+1 addition", " +1"],
    ["-1 removal", " −1"],
    [" 1 unchanged", ""],
  ]) {
    a.result(result("done", { diff }));
    assert.equal(plain(a.view), `✓ Edited 2 files${suffix} ▸`);
  }
});

test("edit groups expand into clickable files with independent diffs and global toggles", async () => {
  const f = await fixture();
  let opened: OpenFileRequest | undefined;
  f.pi.events.on(OPEN_FILE_EVENT, (data) => {
    const request = data as OpenFileRequest;
    request.accepted = true;
    opened = request;
  });
  const path = "日本語 long edited filename.txt";
  const a = f.call("edit", "expand-edit-a", { path });
  a.result(result("done", { diff: "-1 BEFORE_A\n+1 AFTER_A" }));
  const b = f.call("edit", "expand-edit-b", { path: "b.txt" });
  b.result(result("done", { diff: "+1 AFTER_B" }));
  assert.equal(plain(a.view), "✓ Edited 2 files +2 −1 ▸");
  const header = a.view.render(160)[0];
  assert(header.includes(paint(themes.theme, "green", "+2")));
  assert(header.includes(paint(themes.theme, "red", "−1")));
  a.view.handleMouse(mouse(tui.visibleWidth(plain(a.view)) - 1));
  assert.equal(
    plain(a.view),
    `✓ Edited 2 files +2 −1 ▾\n  ✓ Edited ${path} +1 −1 ▸\n  ✓ Edited b.txt +1 ▸`,
  );
  for (const width of [0, 1, 2, 3, 10, 24, 160]) {
    for (const [i, line] of a.view.render(width).entries()) {
      assert(tui.visibleWidth(line) <= width);
      if (width) assert(tui.stripTerminalSequences(line).endsWith(i ? "▸" : "▾"));
    }
  }
  const clipped = a.view.render(24)[1];
  a.view.invalidate();
  a.view.handleMouse(mouse(tui.visibleWidth("  ✓ Edited "), 1));
  assert.deepEqual(opened, { path, cwd: f.dir, tool: "edit", accepted: true });
  a.view.handleMouse(mouse(tui.visibleWidth(clipped) - 1, 1));
  assert.match(plain(a.view), /-1 BEFORE_A\n\s*\+1 AFTER_A/);
  assert(!plain(a.view).includes("AFTER_B"));
  const c = f.call("edit", "expand-edit-c", { path: "c.txt" });
  c.result(result("done", { diff: "+1 AFTER_C" }));
  assert.match(plain(a.view), /Edited 3 files \+3 −1 ▾/);
  assert(plain(a.view).includes("AFTER_A"), "growing a group preserves its open diffs");
  assert(!plain(a.view).includes("AFTER_C"));
  f.expand(true);
  assert(plain(a.view).includes("AFTER_B") && plain(a.view).includes("AFTER_C"));
  f.expand(false);
  assert.equal(plain(a.view), "✓ Edited 3 files +3 −1 ▸");
});

test("failed edits stay visible in collapsed groups and do not contribute diff totals", async () => {
  const f = await fixture();
  const a = f.call("edit", "good-edit", { path: "good.txt" });
  a.result(result("done", { diff: "-1 before\n+1 after" }));
  const b = f.call("edit", "failed-edit", { path: "bad.txt" });
  b.result(result("EDIT_ERROR_BODY", { diff: "+1 NOT_APPLIED" }), true);
  assert.equal(plain(a.view), "✗ Edited 2 files +1 −1 (1 failed) ▸\n  ✗ Edit bad.txt ▸");
  assert.equal(plain(b.view), "");
  a.view.handleMouse(mouse(0, 1));
  assert(plain(a.view).includes("EDIT_ERROR_BODY"));
  assert(!plain(a.view).includes("NOT_APPLIED"));
  f.expand(true);
  assert(plain(a.view).includes("EDIT_ERROR_BODY") && plain(a.view).includes("-1 before"));
  f.expand(false);
  assert(plain(a.view).includes("✗ Edit bad.txt") && !plain(a.view).includes("EDIT_ERROR_BODY"));
});

test("output padding follows the live host for cached headers, bodies, clicks and images", async (t) => {
  const f = await fixture();
  const definitions = new Map(f.pi.tools);
  const host = {
    outputPad: 0,
    session: { getToolDefinition: (name: string) => definitions.get(name) },
  };
  const lookup = (name: string) => interactive.getRegisteredToolDefinition.call(host, name);
  const row = (name: string, id: string, args: unknown) =>
    component(name, id, args, lookup(name), f.dir, {});
  const opened: string[] = [];
  f.pi.events.on(OPEN_FILE_EVENT, (data) => {
    const request = data as OpenFileRequest;
    request.accepted = true;
    opened.push(request.path);
  });
  const path = "日本語-padding-long-filename.txt";
  const read = row("read", "padded-read", { path });
  read.updateResult({ ...result("READ_BODY"), isError: false });
  const unpadded = tui.stripTerminalSequences(read.render(30)[1]);
  assert(unpadded.startsWith("✓ Read ") && unpadded.endsWith(" ▸"));
  // The view keeps the old hit targets until it is rendered with the new inset.
  const view = internals(read).rendererState.view;
  assert(view, "mirage view");
  host.outputPad = 1;
  view.invalidate();
  view.handleMouse(mouse(tui.visibleWidth("✓ Read ")));
  assert.deepEqual(opened, [path]);
  view.handleMouse(mouse(tui.visibleWidth(unpadded) - 1));
  assert.match(plain(read, 30), /^ {3}READ_BODY/m);
  const padded = tui.stripTerminalSequences(read.render(30)[1]);
  assert(padded.startsWith(" ✓ Read ") && padded.endsWith(" ▾"));
  read.handleMouse({ ...mouse(tui.visibleWidth(" ✓ Read "), 1), width: 30 });
  assert.deepEqual(opened, [path, path]);

  f.expand(true);
  const components = [read];
  for (const [name, args, output] of [
    ["edit", { path: "edit.txt" }, result("edited", { diff: "-1 before\n+1 after" })],
    ["write", { path: "write.txt", content: "WRITE_BODY" }, result("written")],
    ["bash", { command: "echo BASH_BODY" }, result("BASH_BODY")],
  ] as const) {
    const next = row(name, `padded-${name}`, args);
    next.updateResult({ ...output, isError: false });
    components.push(next);
  }
  for (const padding of [1, 0, 1]) {
    host.outputPad = padding; // No updateDisplay/invalidate: exercise the render-cache key.
    for (const item of components) {
      const lines = item.render(30).slice(1).map(tui.stripTerminalSequences);
      assert.equal(lines[0].match(/^ */)?.[0].length, padding);
      assert(lines[0].endsWith(" ▾"));
      assert(lines.slice(1).some((line) => line.trim()));
      for (const line of lines) {
        assert(tui.visibleWidth(line) <= 30 - padding, "right padding reduces available width");
        if (line.trim()) assert(line.startsWith(" ".repeat(padding)));
      }
      for (const width of [0, 1, 2, 3, 10])
        for (const line of item.render(width)) assert(tui.visibleWidth(line) <= width);
      item.render(30); // Leave the same width cached before changing only outputPad.
    }
  }

  // Binding is host-local, scoped to our definitions, and never mutates the originals.
  const otherHost = { ...host, outputPad: 0 };
  const other = interactive.getRegisteredToolDefinition.call(otherHost, "write");
  const otherRow = component(
    "write",
    "other-host",
    { path: "other.txt", content: "OTHER" },
    other,
    f.dir,
    {},
  );
  otherRow.updateResult({ ...result("written"), isError: false });
  assert(tui.stripTerminalSequences(otherRow.render(30)[1]).startsWith("✓ Wrote "));
  const original = definitions.get("write");
  assert.notEqual(other?.renderCall, original?.renderCall);
  assert.equal(f.pi.tools.get("write"), original);
  const unmanaged = core.createReadToolDefinition(f.dir);
  const plainHost = { outputPad: 1, session: { getToolDefinition: () => unmanaged } };
  assert.equal(
    interactive.getRegisteredToolDefinition.call(plainHost, "read")?.renderCall,
    unmanaged.renderCall,
  );

  tui.setCapabilityOverrides({ images: "kitty" });
  try {
    const image = row("read", "padded-image", { path: "picture.png" });
    const output = {
      content: [{ type: "image", data: PIXEL_PNG, mimeType: "image/png" }],
      isError: false,
    };
    const payload = JSON.stringify(output);
    image.updateResult(output);
    const widths: number[] = [];
    const nativeImage = internals(image).imageComponents[0];
    const render = nativeImage.render.bind(nativeImage);
    t.mock.method(nativeImage, "render", (width: number) => {
      widths.push(width);
      return render(width);
    });
    for (const padding of [0, 1]) {
      host.outputPad = padding;
      const lines = image.render(40);
      assert.equal(widths.at(-1), 40 - padding * 2 - 2);
      assert(lines.find(isImageLine)?.startsWith(" ".repeat(padding + 2)));
      assert.equal(JSON.stringify(output), payload);
    }
  } finally {
    tui.setCapabilityOverrides({ images: null });
  }
});

test("native previews default hidden, obey local/global toggles, and leave payloads and other tools untouched", async () => {
  const f = await fixture();
  const png = PIXEL_PNG;
  tui.setCapabilityOverrides({ images: "kitty" });
  try {
    const components = ["before", "picture", "after"].map((id) =>
      component("read", id, { path: `${id}.png` }, f.tool("read"), f.dir, { showImages: true }),
    );
    components[0].updateResult({ ...result("before"), isError: false });
    const output = {
      content: [{ type: "image", data: png, mimeType: "image/png" }],
      isError: false,
    };
    const payload = JSON.stringify(output);
    components[1].updateResult(output);
    components[2].updateResult({ ...result("after"), isError: false });
    assert(!plain(components[0]).includes("Explored 3 files"));
    assert.match(plain(components[1]), /Read picture.png \(image\)/);
    assert.match(plain(components[2]), /Read after.png/);
    assert.equal(
      components[1].render(160).length,
      2,
      "collapsed row has only a header and spacing",
    );
    assert(!components[1].render(160).some(isImageLine));
    components[1].handleMouse(mouse(0, 1));
    const expanded = components[1].render(160);
    assert(expanded.some(isImageLine), "expanded row contains real native image protocol");
    const unmanaged = component(
      "read",
      "unmanaged",
      { path: "picture.png" },
      core.createReadToolDefinition(f.dir),
      f.dir,
      { showImages: true },
    );
    unmanaged.updateResult(output);
    const nativeImageLines = unmanaged.render(160).filter(isImageLine).length;
    assert(nativeImageLines > 0, "unmanaged tools retain their original behavior");
    assert.equal(expanded.filter(isImageLine).length, nativeImageLines, "image is not duplicated");
    components[1].handleMouse(mouse(0, 1));
    assert.equal(components[1].render(160).length, 2);
    for (const value of [true, false]) {
      f.expand(value);
      for (const item of components) item.setExpanded(value);
      assert.equal(
        components[1].render(160).some(isImageLine),
        value,
        "Ctrl+O also controls previews",
      );
    }
    const next = f.call("read", "next", { path: "next.txt" });
    assert.equal(
      next.view.row.group.rows[0].id,
      "after",
      "new calls cannot merge across the image",
    );
    components[1].setShowImages(false);
    components[1].render(160);
    components[1].handleMouse(mouse(0, 1));
    assert.match(
      plain(components[1]),
      /image\/png/,
      "disabled image setting gives a text fallback",
    );
    assert(!components[1].render(160).some(isImageLine));
    assert.equal(JSON.stringify(output), payload, "model/session image data stays unchanged");
    await f.pi.event("session_shutdown");
    await f.pi.event("session_start", {}, f.ctx);
    const resumed = component(
      "read",
      "resumed-image",
      { path: "picture.png" },
      f.tool("read"),
      f.dir,
      { showImages: true },
    );
    resumed.updateResult(output);
    assert.equal(resumed.render(160).length, 2);
    resumed.handleMouse(mouse(0, 1));
    assert(
      resumed.render(160).some(isImageLine),
      "image control reattaches after a shutdown/start cycle",
    );
  } finally {
    tui.setCapabilityOverrides({ images: null });
  }
});

test("configured executors preserve shell options, image sizing, and project trust", async () => {
  const shellDir = mkdtempSync(join(root, "shell-"));
  const shell = join(shellDir, "shell");
  writeFileSync(shell, '#!/bin/sh\nexport SHELL_SELECTED=yes\nexec /bin/bash "$@"\n', {
    mode: 0o700,
  });
  for (const trusted of [false, true]) {
    const f = await fixture({
      trusted,
      global: { shellPath: shell, shellCommandPrefix: "export PREFIX=global" },
      project: { shellCommandPrefix: "export PREFIX=project" },
    });
    const output = await f
      .tool("bash")
      .execute(
        "bash",
        { command: 'printf "%s/%s" "$PREFIX" "$SHELL_SELECTED"' },
        undefined,
        undefined,
        f.ctx,
      );
    assert.equal(firstText(output), `${trusted ? "project" : "global"}/yes`);
  }
  const f = await fixture({ global: { images: { autoResize: false } } });
  // A valid 2100x1 RGBA PNG: larger than Pi's default 2000px resize limit.
  const widePng =
    "iVBORw0KGgoAAAANSUhEUgAACDQAAAABCAYAAAArDGywAAAAH0lEQVR4nO3BIQEAAAACIP+f1hsGIAUAAAAAAAAAODMSH7ERSSRpYgAAAABJRU5ErkJggg==";
  const imagePath = join(f.dir, "wide.png");
  writeFileSync(imagePath, Buffer.from(widePng, "base64"));
  const image = await f
    .tool("read")
    .execute("image", { path: imagePath }, undefined, undefined, f.ctx);
  const block = image.content.find((part) => part.type === "image");
  assert(block?.type === "image", "image result");
  assert.equal(tui.getImageDimensions(block.data, block.mimeType)?.widthPx, 2100);
  const path = join(f.dir, "file.txt");
  writeFileSync(path, "before\n");
  await f
    .tool("edit")
    .execute(
      "edit",
      { path: "file.txt", edits: [{ oldText: "before", newText: "after" }] },
      undefined,
      undefined,
      f.ctx,
    );
  assert.equal(readFileSync(path, "utf8"), "after\n");
  await f
    .tool("write")
    .execute("write", { path: "file.txt", content: "final\n" }, undefined, undefined, f.ctx);
  assert.equal(readFileSync(path, "utf8"), "final\n");
  for (const [name, factory] of Object.entries({
    read: core.createReadToolDefinition,
    bash: core.createBashToolDefinition,
    edit: core.createEditToolDefinition,
    write: core.createWriteToolDefinition,
  })) {
    for (const key of [
      "parameters",
      "description",
      "promptGuidelines",
      "promptSnippet",
      "executionMode",
    ] as const)
      assert.deepEqual(f.tool(name)[key], factory(f.dir)[key]);
  }
  const headless = await fixture({
    mode: "rpc",
    global: { shellCommandPrefix: "export PREFIX=rpc" },
  });
  const reply = await headless
    .tool("bash")
    .execute("rpc", { command: 'printf "%s" "$PREFIX"' }, undefined, undefined, headless.ctx);
  assert.equal(firstText(reply), "rpc", "execution configuration also applies without a TUI");
  writeFileSync(
    join(headless.dir, "config/settings.json"),
    JSON.stringify({ shellCommandPrefix: "export PREFIX=reloaded" }),
  );
  await headless.pi.event("session_start", { reason: "reload" }, headless.ctx);
  const reloaded = await headless
    .tool("bash")
    .execute(
      "rpc-after-reload",
      { command: 'printf "%s" "$PREFIX"' },
      undefined,
      undefined,
      headless.ctx,
    );
  assert.equal(firstText(reloaded), "reloaded", "reload discards cached execution settings");
});

test("filename clicks without inspector warn instead of opening", async () => {
  const f = await fixture();
  const args = { path: "a\u00a0b.txt" };
  const row = f.call("read", "missing-opener", args);
  const label = plain(row.view);
  row.view.handleMouse(mouse(label.indexOf(args.path) + 1));
  assert.match(f.notices.at(-1)?.[0] ?? "", /requires inspector/);
});

test("reload/tree/compaction reconstruct persisted groups, failures, and image boundaries", async () => {
  const f = await fixture();
  const assistant = (content: object[]) => ({ role: "assistant", content });
  const call = (id: string, path: string) => ({
    type: "toolCall",
    id,
    name: "read",
    arguments: { path },
  });
  const entries = [
    {
      type: "message",
      message: assistant([
        call("saved1", "a"),
        call("saved2", "b"),
        call("picture", "image.png"),
        call("after-image", "c"),
      ]),
    },
    ...["saved1", "saved2"].map((id) => ({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: id,
        toolName: "read",
        ...result("SAVED_ERROR"),
        isError: id === "saved2",
      },
    })),
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "picture",
        toolName: "read",
        content: [{ type: "image", data: PIXEL_PNG, mimeType: "image/png" }],
        isError: false,
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "after-image",
        toolName: "read",
        ...result("after"),
        isError: false,
      },
    },
  ];
  for (const event of ["session_start", "session_tree", "session_compact"]) {
    await f.rebuild(event, entries);
    const view = f.call("read", "saved1", { path: "a" }).view;
    assert.match(plain(view), /Explored 2 files \(1 failed\)/);
    assert.match(plain(view), /✗ Read b/);
    assert(!plain(view).includes("SAVED_ERROR"));
    assert.match(
      plain(f.call("read", "picture", { path: "image.png" }).view),
      /Read image.png \(image\)/,
    );
    assert.match(plain(f.call("read", "after-image", { path: "c" }).view), /Read c/);
  }
  await f.rebuild("session_tree");
  assert(!plain(f.call("read", "new-branch", {}).view).includes("2 files"));
});

test("reload/tree/compaction reconstruct edit groups and reset local expansion", async () => {
  const f = await fixture();
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        content: ["a", "b"].map((id) => ({
          type: "toolCall",
          id,
          name: "edit",
          arguments: { path: `${id}.txt` },
        })),
      },
    },
    ...["a", "b"].map((id) => ({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: id,
        toolName: "edit",
        ...result("done", { diff: `-1 before-${id}\n+1 after-${id}` }),
        isError: false,
      },
    })),
  ];
  const before = JSON.stringify(entries);
  for (const event of ["session_start", "session_tree", "session_compact"]) {
    await f.rebuild(event, entries);
    const view = f.call("edit", "a", { path: "a.txt" }).view;
    assert.equal(plain(view), "✓ Edited 2 files +2 −2 ▸");
    view.handleMouse(mouse(0));
    assert(plain(view).includes("Edited a.txt") && plain(view).includes("Edited b.txt"));
    assert.equal(plain(f.call("edit", "b", { path: "b.txt" }).view), "");
  }
  assert.equal(JSON.stringify(entries), before, "grouping is presentation-only");
});
