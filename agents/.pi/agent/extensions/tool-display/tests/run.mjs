import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { pkg, require } from "./pi-package.mjs";

const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": join(pkg, "dist/index.js"),
    "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
    typebox: require.resolve("typebox"),
  },
});
const extension = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { default: installDisplay } = await jiti.import(join(extension, "index.ts"));
const { default: installVim } = await jiti.import(join(extension, "../vim-files/index.ts"));
const { OPEN_FILE_EVENT } = await jiti.import(join(extension, "../file-tools-shared/protocol.ts"));
const { resolveToolFile } = await jiti.import(join(extension, "../vim-files/paths.ts"));
const { ToolGroups } = await jiti.import(join(extension, "model.ts"));
const { diffCounts } = await jiti.import(join(extension, "view.ts"));
const { colours } = await jiti.import(join(extension, "colours.ts"));
const { paint, colouredDiff } = await jiti.import(join(extension, "style.ts"));
const core = await import(join(pkg, "dist/index.js"));
const themes = await import(join(pkg, "dist/modes/interactive/theme/theme.js"));
const tui = await import(require.resolve("@earendil-works/pi-tui"));
core.initTheme("dark");
const nativeRender = core.ToolExecutionComponent.prototype.render;
const PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=";
const root = mkdtempSync(join(tmpdir(), "pi-tool-display-"));
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
const sessions = [];
after(async () => {
  for (const pi of sessions) await pi.event("session_shutdown");
  assert.equal(
    core.ToolExecutionComponent.prototype.render,
    nativeRender,
    "last owner restores Pi rendering on shutdown",
  );
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  rmSync(root, { recursive: true, force: true });
});

function api() {
  const handlers = new Map(),
    tools = new Map();
  return {
    tools,
    events: core.createEventBus(),
    on(name, callback) {
      handlers.set(name, [...(handlers.get(name) ?? []), callback]);
    },
    async event(name, value, ctx) {
      for (const handler of handlers.get(name) ?? []) await handler(value, ctx);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  };
}
const mouse = (x, y = 0, type = "click") => ({
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
const plain = (component, width = 160) =>
  component
    .render(width)
    .map((line) => tui.stripTerminalSequences(line).trimEnd())
    .join("\n");
const isImageLine = (line) => line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
const result = (value, details = {}) => ({ content: [{ type: "text", text: value }], details });
const waitFor = async (predicate) => {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error("Timed out waiting for editor lifecycle");
};

async function fixture({ global = {}, project = {}, trusted = false, mode = "tui" } = {}) {
  const dir = mkdtempSync(join(root, "case-"));
  const config = join(dir, "config");
  mkdirSync(config);
  mkdirSync(join(dir, ".pi"));
  writeFileSync(join(config, "settings.json"), JSON.stringify(global));
  writeFileSync(join(dir, ".pi/settings.json"), JSON.stringify(project));
  process.env.PI_CODING_AGENT_DIR = config;
  const pi = api(),
    slots = [],
    notices = [];
  let allExpanded = false,
    entries = [],
    invalidations = 0;
  const ctx = {
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
  };
  installDisplay(pi);
  sessions.push(pi);
  await pi.event("session_start", {}, ctx);
  function call(name, id, args, started = true) {
    const definition = pi.tools.get(name);
    const context = {
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
    };
    const slot = {
      definition,
      context,
      redraw() {
        slot.view = definition.renderCall(context.args, themes.theme, context);
      },
      result(output, failed = false, partial = false) {
        context.isError = failed;
        definition.renderResult(
          output,
          { expanded: allExpanded, isPartial: partial },
          themes.theme,
          context,
        );
      },
    };
    slot.redraw();
    slots.push(slot);
    return slot;
  }
  return {
    pi,
    ctx,
    dir,
    call,
    notices,
    get invalidations() {
      return invalidations;
    },
    expand(value) {
      allExpanded = value;
      for (const slot of slots) slot.redraw();
    },
    async rebuild(event, values = []) {
      entries = values;
      await pi.event(event, {}, ctx);
    },
  };
}

test("palette supplies RGB and indexed colours without losing diff word highlights", (t) => {
  // Pi's chalk styles are disabled when this test's stdout is a pipe.
  t.mock.method(themes.Theme.prototype, "inverse", (text) => `\x1b[7m${text}\x1b[27m`);
  const rgb = { getColorMode: () => "truecolor" };
  const indexed = { getColorMode: () => "256color" };
  for (const [tone, hex] of Object.entries(colours)) {
    const channels = hex
      .slice(1)
      .match(/../g)
      .map((value) => Number.parseInt(value, 16));
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
  ]) {
    assert(line.startsWith(paint(rgb, tone, "").split("\x1b[39m")[0]));
    assert(line.includes("\x1b[7m") && line.includes("\x1b[27m"), "word changes remain inverse");
  }
  assert.equal(lines[2], core.renderDiff(source).split("\n")[2], "context keeps Pi styling");
});

test("group boundaries, streaming snapshots, and expansion survive growth and merges", () => {
  const model = new ToolGroups();
  const a = model.addCall("a", "read", { path: "a" }, root);
  model.toggle(a);
  const b = model.addCall("b", "read", { path: "b" }, root);
  assert.equal(a.group, b.group);
  assert(
    model.expanded(a) && model.expanded(a.group),
    "promoting a singleton preserves its visible output",
  );
  assert(!model.expanded(b));
  assert.equal(model.addCall("a", "read", { path: "updated" }, root), a);
  assert.equal(a.file.path, "updated", "streamed arguments update the snapshot");
  model.addCall("foreign", "grep", {}, root);
  assert.notEqual(model.addCall("c", "read", {}, root).group, a.group);
  assert.notEqual(
    model.addCall("edit1", "edit", {}, root).group,
    model.addCall("edit2", "edit", {}, root).group,
  );
  model.reset();
  function batch(id, blocks = []) {
    const message = {
      role: "assistant",
      content: [...blocks, { type: "toolCall", id, name: "read", arguments: { path: id } }],
      stopReason: "toolUse",
    };
    model.startMessage({ role: "assistant", content: [] }, root);
    model.observe(message, root);
    model.finishMessage(message, root);
    return model.rows.get(id);
  }
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
    content: [{ type: "toolCall", id: "late", name: "read", arguments: {} }],
  };
  model.startMessage({ role: "assistant", content: [] }, root);
  model.observe(late, root);
  late.content.push({ type: "text", text: "Late commentary" });
  model.finishMessage(late, root);
  assert.notEqual(model.rows.get("late").group, thinking.group);
  model.setAllExpanded(true);
  model.toggle(first);
  model.setAllExpanded(false);
  model.setAllExpanded(true);
  assert(model.expanded(first), "global expansion supersedes local choices");
});

test("normalized renderer inputs tolerate invalid arguments without bypassing validation", async () => {
  const f = await fixture();
  for (const name of ["read", "bash", "edit", "write"]) {
    for (const [i, args] of [null, undefined, [], 17, "invalid", {}, { path: 3 }].entries()) {
      await f.pi.event("message_start", { message: { role: "user", content: "boundary" } }, f.ctx);
      const component = new core.ToolExecutionComponent(
        name,
        `${name}-${i}`,
        args,
        { showImages: false },
        f.pi.tools.get(name),
        { requestRender() {} },
        f.dir,
      );
      component.updateResult({ ...result("VALIDATION_ERROR"), isError: true });
      assert.doesNotThrow(() => component.render(100));
      assert.match(plain(component), /✗/);
      assert(!plain(component).includes("VALIDATION_ERROR"));
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
  let opened;
  f.pi.events.on(OPEN_FILE_EVENT, (request) => {
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
  assert.deepEqual(opened, { path: a.context.args.path, cwd: f.dir, tool: "read", accepted: true });
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
  assert.match(plain(a.view), /✗ \$ exit 1/);
  assert(!plain(a.view).includes("ERROR_BODY"));
  a.view.handleMouse(mouse(0, 1));
  assert.match(plain(a.view), /ERROR_BODY\n\s*STACK_TRACE/);
  a.view.handleMouse(mouse(0, 1));
  assert(!plain(a.view).includes("STACK_TRACE"));
  f.expand(true);
  assert.match(plain(a.view), /STACK_TRACE/);
  f.expand(false);
  assert.match(plain(a.view), /✗ \$ exit 1/);
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
    assert.equal(plain(edit.view), `▸ ✓ Edited edit.ts${suffix}`);
  }
});

test("native previews default hidden, obey local/global toggles, and leave payloads and other tools untouched", async () => {
  const f = await fixture();
  const png = PIXEL_PNG;
  tui.setCapabilityOverrides({ images: "kitty" });
  try {
    const components = ["before", "picture", "after"].map(
      (id) =>
        new core.ToolExecutionComponent(
          "read",
          id,
          { path: `${id}.png` },
          { showImages: true },
          f.pi.tools.get("read"),
          { requestRender() {} },
          f.dir,
        ),
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
    const unmanaged = new core.ToolExecutionComponent(
      "read",
      "unmanaged",
      { path: "picture.png" },
      { showImages: true },
      core.createReadToolDefinition(f.dir),
      { requestRender() {} },
      f.dir,
    );
    unmanaged.updateResult(output);
    const nativeImageLines = unmanaged.render(160).filter(isImageLine).length;
    assert(nativeImageLines > 0, "unmanaged tools retain their original behavior");
    assert.equal(expanded.filter(isImageLine).length, nativeImageLines, "image is not duplicated");
    components[1].handleMouse(mouse(0, 1));
    assert.equal(components[1].render(160).length, 2);
    for (const value of [true, false]) {
      f.expand(value);
      for (const component of components) component.setExpanded(value);
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
    const resumed = new core.ToolExecutionComponent(
      "read",
      "resumed-image",
      { path: "picture.png" },
      { showImages: true },
      f.pi.tools.get("read"),
      { requestRender() {} },
      f.dir,
    );
    resumed.updateResult(output);
    assert.equal(resumed.render(160).length, 2);
    resumed.handleMouse(mouse(0, 1));
    assert(
      resumed.render(160).some(isImageLine),
      "image control reattaches after a shutdown/start cycle",
    );
  } finally {
    tui.setCapabilityOverrides({ images: false });
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
    const output = await f.pi.tools
      .get("bash")
      .execute(
        "bash",
        { command: 'printf "%s/%s" "$PREFIX" "$SHELL_SELECTED"' },
        undefined,
        undefined,
        f.ctx,
      );
    assert.equal(output.content[0].text, `${trusted ? "project" : "global"}/yes`);
  }
  const f = await fixture({ global: { images: { autoResize: false } } });
  // A valid 2100x1 RGBA PNG: larger than Pi's default 2000px resize limit.
  const widePng =
    "iVBORw0KGgoAAAANSUhEUgAACDQAAAABCAYAAAArDGywAAAAH0lEQVR4nO3BIQEAAAACIP+f1hsGIAUAAAAAAAAAODMSH7ERSSRpYgAAAABJRU5ErkJggg==";
  const imagePath = join(f.dir, "wide.png");
  writeFileSync(imagePath, Buffer.from(widePng, "base64"));
  const image = await f.pi.tools
    .get("read")
    .execute("image", { path: imagePath }, undefined, undefined, f.ctx);
  const block = image.content.find((part) => part.type === "image");
  assert.equal(tui.getImageDimensions(block.data, block.mimeType).widthPx, 2100);
  const path = join(f.dir, "file.txt");
  writeFileSync(path, "before\n");
  await f.pi.tools
    .get("edit")
    .execute(
      "edit",
      { path: "file.txt", edits: [{ oldText: "before", newText: "after" }] },
      undefined,
      undefined,
      f.ctx,
    );
  assert.equal(readFileSync(path, "utf8"), "after\n");
  await f.pi.tools
    .get("write")
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
    ])
      assert.deepEqual(f.pi.tools.get(name)[key], factory(f.dir)[key]);
  }
  const headless = await fixture({
    mode: "rpc",
    global: { shellCommandPrefix: "export PREFIX=rpc" },
  });
  const reply = await headless.pi.tools
    .get("bash")
    .execute("rpc", { command: 'printf "%s" "$PREFIX"' }, undefined, undefined, headless.ctx);
  assert.equal(reply.content[0].text, "rpc", "execution configuration also applies without a TUI");
  writeFileSync(
    join(headless.dir, "config/settings.json"),
    JSON.stringify({ shellCommandPrefix: "export PREFIX=reloaded" }),
  );
  await headless.pi.event("session_start", { reason: "reload" }, headless.ctx);
  const reloaded = await headless.pi.tools
    .get("bash")
    .execute(
      "rpc-after-reload",
      { command: 'printf "%s" "$PREFIX"' },
      undefined,
      undefined,
      headless.ctx,
    );
  assert.equal(reloaded.content[0].text, "reloaded", "reload discards cached execution settings");
});

test("filename resolution matches Pi, including Unicode spaces, URLs, and macOS fallbacks", async () => {
  const f = await fixture();
  writeFileSync(join(f.dir, "a b.txt"), "ASCII");
  writeFileSync(join(f.dir, "a\u00a0b.txt"), "NBSP");
  const args = { path: "a\u00a0b.txt" };
  assert.equal(
    (await f.pi.tools.get("read").execute("read", args, undefined, undefined, f.ctx)).content[0]
      .text,
    "ASCII",
  );
  for (const tool of ["read", "edit", "write"]) {
    const target = await resolveToolFile({ ...args, cwd: f.dir, tool });
    assert.equal(readFileSync(target, "utf8"), "ASCII");
    assert.equal(await resolveToolFile({ path: "@a b.txt", cwd: f.dir, tool }), target);
    assert.equal(
      await resolveToolFile({ path: pathToFileURL(target).href, cwd: f.dir, tool }),
      target,
    );
  }
  const screenshot = join(f.dir, "Screenshot 1.00\u202fPM.png");
  writeFileSync(screenshot, "screenshot");
  assert.equal(
    await resolveToolFile({ path: "Screenshot 1.00 PM.png", cwd: f.dir, tool: "read" }),
    screenshot,
  );
  const row = f.call("read", "missing-opener", args);
  const label = plain(row.view);
  row.view.handleMouse(mouse(label.indexOf(args.path) + 1));
  assert.match(f.notices.at(-1)[0], /requires vim-files/);
});

test("reload/tree/compaction reconstruct persisted groups, failures, and image boundaries", async () => {
  const f = await fixture();
  const assistant = (content) => ({ role: "assistant", content });
  const call = (id, path) => ({ type: "toolCall", id, name: "read", arguments: { path } });
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

test("Vim works while busy, keeps literal filenames safe, and handles cancellation/errors/shutdown", async () => {
  const f = await fixture();
  const pi = api(),
    terminal = [],
    notices = [];
  let finished = 0;
  installVim(pi);
  assert.equal(pi.tools.size, 0);
  const ctx = {
    mode: "tui",
    cwd: f.dir,
    isIdle() {
      throw new Error("must not require idle");
    },
    ui: {
      notify: (...args) => notices.push(args),
      custom: async (factory) => {
        try {
          await factory(
            {
              stop: () => terminal.push("stop"),
              start: () => terminal.push("start"),
              requestRender: () => terminal.push("render"),
            },
            null,
            null,
            () => {},
          );
        } finally {
          finished++;
        }
      },
    },
  };
  const path = join(f.dir, "-file space 日本語;$(echo unsafe).txt");
  writeFileSync(path, "safe\n");
  const editor = join(f.dir, "fake-editor"),
    log = join(f.dir, "editor.log");
  writeFileSync(editor, '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@" > "$VIM_TEST_LOG"\n', {
    mode: 0o700,
  });
  const oldVisual = process.env.VISUAL,
    oldLog = process.env.VIM_TEST_LOG,
    oldWrite = process.stdout.write;
  const open = () => {
    const request = { path, cwd: f.dir, tool: "read", accepted: false };
    pi.events.emit(OPEN_FILE_EVENT, request);
    return request;
  };
  process.env.VISUAL = editor;
  process.env.VIM_TEST_LOG = log;
  process.stdout.write = function (chunk, ...args) {
    return chunk === "\x1b[2J\x1b[H" ? true : oldWrite.call(this, chunk, ...args);
  };
  try {
    await pi.event("session_start", {}, ctx);
    assert(open().accepted);
    await waitFor(() => finished === 1);
    assert.deepEqual(terminal, ["stop", "start", "render"]);
    assert.equal(readFileSync(log, "utf8"), [realpathSync(f.dir), "--", path, ""].join("\n"));
    assert.equal(notices.length, 0);
    process.env.VISUAL = join(f.dir, "missing-editor");
    open();
    await waitFor(() => notices.length === 1);
    assert.deepEqual(terminal.slice(-3), ["stop", "start", "render"]);
    assert.equal(notices[0][1], "error");
    pi.events.emit(OPEN_FILE_EVENT, { path: f.dir, cwd: f.dir, tool: "read", accepted: false });
    await waitFor(() => notices.length === 2);
    assert.match(notices[1][0], /regular files/);
    writeFileSync(editor, "#!/bin/sh\nexec sleep 30\n", { mode: 0o700 });
    process.env.VISUAL = editor;
    terminal.length = 0;
    const before = finished;
    open();
    open();
    await waitFor(() => terminal.length > 0);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    await delay(100);
    clearInterval(timer);
    assert(ticks >= 3);
    await pi.event("session_shutdown");
    await waitFor(() => finished > before);
    assert.deepEqual(terminal, ["stop"]);
    assert(!open().accepted);
    await pi.event("session_start", {}, ctx);
    terminal.length = 0;
    open();
    await pi.event("session_shutdown");
    await delay(20);
    assert.deepEqual(terminal, [], "a stale request cannot take terminal ownership");
  } finally {
    await pi.event("session_shutdown");
    process.stdout.write = oldWrite;
    if (oldVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = oldVisual;
    if (oldLog === undefined) delete process.env.VIM_TEST_LOG;
    else process.env.VIM_TEST_LOG = oldLog;
  }
});
