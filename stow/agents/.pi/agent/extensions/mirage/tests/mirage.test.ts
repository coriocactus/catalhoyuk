import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { Theme, ToolInfo, ToolRenderers } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { OPEN_FILE_EVENT, type OpenFileRequest } from "../../shared/protocol.ts";
import { fake, fakePi, type Tool } from "../../test/fake-pi.ts";
import { core, loadFuture, themes, tui } from "../../test/pi.ts";
import { assistant as assistantMessage, toolSession } from "../../test/transcript.ts";
import { colours } from "../colours.ts";
import {
  assistantStart,
  colouredDiff,
  component,
  diffCounts,
  firstText,
  fixture,
  installDisplay,
  interactive,
  internals,
  isImageLine,
  type Message,
  mouse,
  PIXEL_PNG,
  paint,
  plain,
  type RenderContext,
  type Result,
  result,
  root,
  ToolGroups,
  writtenLines,
} from "./fixture.ts";

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
  assert.equal(add("write1", "write", {}).group, add("write2", "write", {}).group);
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

test("mixed groups merge across tool-only turns without crossing messages or foreign tools", () => {
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
  assert.equal(a.group, b.group, "a streaming call joins its run while arguments load");
  assert(model.expanded(a) && model.expanded(a.group), "joining preserves open diffs");
  model.finishMessage(second as unknown as Message, root);
  assert.equal(a.group, b.group);
  // Late commentary renders above the call, so it must split the provisional join.
  const late = batch("late");
  assert.equal(row("late").group, a.group);
  late.content.push({ type: "text", text: "Late commentary" } as never);
  model.observe(late as unknown as Message, root);
  assert.notEqual(row("late").group, a.group, "late commentary splits at once, mid-stream");
  assert.deepEqual(
    a.group.rows.map((value) => value.id),
    ["first", "second"],
  );
  assert(model.expanded(a), "splitting preserves open rows");
  model.finishMessage(late as unknown as Message, root);
  assert.notEqual(row("late").group, a.group);

  for (const block of [
    { type: "text", text: "Commentary" },
    { type: "thinking", thinking: "Reasoning" },
  ]) {
    const previous = row("late");
    const next = batch(block.type);
    next.content.push(block);
    model.finishMessage(next as unknown as Message, root);
    assert.notEqual(row(block.type).group, previous.group);
  }
  for (const name of ["read", "bash", "write", "grep"]) {
    const before = add(`before-${name}`, "edit");
    model.addCall(`boundary-${name}`, name, {}, root);
    const after = add(`after-${name}`, "edit");
    if (name === "grep") assert.notEqual(before.group, after.group, name);
    else assert.equal(before.group, after.group, name);
  }
  for (const role of ["user", "custom", "bashExecution"]) {
    const before = add(`before-${role}`, "edit");
    model.startMessage({ role, content: "Boundary" } as unknown as Message, root);
    assert.notEqual(add(`after-${role}`, "edit").group, before.group);
  }
});

test("hidden thinking joins mixed turns, while visibility toggles restore ordered boundaries", async () => {
  const f = await fixture({ global: { hideThinkingBlock: true } });
  const batch = async (id: string, name: string, blocks: object[] = []) => {
    await f.pi.event("message_start", { message: assistantStart }, f.ctx);
    const message = {
      role: "assistant",
      content: [...blocks, { type: "toolCall", id, name, arguments: { path: `${id}.txt` } }],
      stopReason: "toolUse",
    };
    await f.pi.event("message_end", { message }, f.ctx);
    return f.call(name, id, { path: `${id}.txt`, command: "echo ok", content: "new" });
  };
  const a = await batch("mixed-read", "read");
  a.result(result("READ_BODY"));
  const thinking = { type: "thinking" as const, thinking: "REASONING" };
  const b = await batch("mixed-command", "bash", [thinking]);
  b.result(result("COMMAND_BODY"));
  const c = await batch("mixed-write", "write", [thinking]);
  c.result(result("done"));
  const d = await batch("mixed-edit", "edit");
  d.result(result("done", { diff: "-1 before\n+1 after" }));
  assert.equal(
    plain(a.view),
    "✓ Read 1 file, ran 1 command, wrote 1 file (+1), edited 1 file (+1 −1) ▸",
  );
  assert.equal(plain(b.view), "");
  a.view.handleMouse(mouse(0));
  assert.match(plain(a.view), /mixed-write.txt/);
  b.result(result("COMMAND_FAILED"), true);
  a.view.handleMouse(mouse(0));
  assert.equal(
    plain(a.view),
    "✓ Read 1 file, ran 1 command, wrote 1 file (+1), edited 1 file (+1 −1) ▸",
  );
  // The native toggle drives all existing view models without replacing their rows.
  const assistant = new core.AssistantMessageComponent();
  assistant.updateContent(assistantMessage("", [thinking]));
  assert.match(plain(a.view), /^✓ Read mixed-read.txt/);
  assert.match(plain(b.view), /^\$ echo ok/);
  assert.match(plain(c.view), /^✓ Wrote 1 file \(\+1\), edited 1 file/);
  assistant.setHideThinkingBlock(true);
  assert.match(plain(a.view), /Read 1 file, ran 1 command, wrote 1 file \(\+1\), edited 1 file/);
  const boundary = await batch("after-text", "read", [{ type: "text", text: "COMMENTARY" }]);
  assert.notEqual(boundary.view.row.group, a.view.row.group);
  const late = {
    role: "assistant",
    content: [{ type: "toolCall", id: "late-mixed", name: "write", arguments: {} }] as object[],
  };
  await f.pi.event("message_start", { message: assistantStart }, f.ctx);
  await f.pi.event("message_update", { message: late }, f.ctx);
  late.content.push({ type: "text", text: "LATE_COMMENTARY" });
  await f.pi.event("message_end", { message: late }, f.ctx);
  const afterLate = f.call("write", "late-mixed", {});
  assert.notEqual(afterLate.view.row.group, boundary.view.row.group);
  for (const value of [false, true]) {
    assistant.setHideThinkingBlock(value);
    assert.notEqual(afterLate.view.row.group, boundary.view.row.group);
    assert.notEqual(boundary.view.row.group, a.view.row.group);
  }
});

test("hidden thinking and images join runs; assistant failures remain boundaries", () => {
  const model = new ToolGroups();
  model.setThinkingHidden(true);
  const a = model.addCall("a", "read", {}, root);
  assert(a);
  const reasoning = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "hidden" }],
    stopReason: "stop",
  } as Message;
  model.startMessage(reasoning, root);
  model.finishMessage(reasoning, root);
  const b = model.addCall("b", "write", {}, root);
  assert(b);
  assert.equal(a.group, b.group);
  model.setThinkingHidden(false);
  assert.notEqual(a.group, b.group);
  model.setThinkingHidden(true);
  assert.equal(a.group, b.group);
  const image = model.addCall("image", "read", {}, root);
  const after = model.addCall("after", "edit", {}, root);
  assert(image && after);
  model.updateResult(
    image,
    { content: [{ type: "image", data: PIXEL_PNG, mimeType: "image/png" }], details: undefined },
    false,
    false,
  );
  for (const hidden of [false, true]) {
    model.setThinkingHidden(hidden);
    assert.equal(image.group, after.group);
    assert.equal(image.group, b.group);
  }
  for (const stopReason of ["aborted", "error", "length"] as const) {
    const failure = { ...reasoning, stopReason };
    model.startMessage(failure, root);
    model.finishMessage(failure, root);
    const next = model.addCall(stopReason, "bash", {}, root);
    assert(next);
    assert.notEqual(next.group, after.group);
  }
});

test("transactional prepends keep live identities, in-flight fences, results and expansion", () => {
  const live = new ToolGroups();
  live.setThinkingHidden(true);
  const a = live.addCall("live-a", "bash", { command: "cd project" }, root);
  assert(a);
  live.toggle(a);
  live.startMessage(assistantStart, root);
  const b = live.addCall("live-b", "read", { path: "b" }, root);
  assert(b);
  assert.equal(b.group, a.group, "a loading call joins its group immediately");
  live.updateResult(b, result("PARTIAL"), true, false);
  const older = new ToolGroups();
  older.startMessage(assistantStart, root);
  older.finishMessage(
    assistantMessage("", [
      { type: "toolCall", id: "older", name: "read", arguments: { path: "picture.png" } },
    ]),
    root,
  );
  const staged = live.stagePrepend(older);
  assert(live.rows.has("older"));
  const ids = () => a.group.rows.map((row) => row.id);
  assert.deepEqual(ids(), ["live-a", "live-b"], "construction cannot regroup mounted rows");
  staged.rollback();
  staged.rollback();
  assert(!live.rows.has("older"));
  const committed = live.stagePrepend(older);
  committed.commit();
  committed.commit();
  assert.deepEqual(ids(), ["older", "live-a", "live-b"]);
  assert(live.expanded(a.group) && live.expanded(a));
  assert.equal(live.rows.get("live-a"), a);
  assert.equal(b.status, "running");
  assert.equal(firstText(b.result as Result), "PARTIAL");
  const call = { type: "toolCall" as const, id: "live-b", name: "read", arguments: { path: "b" } };
  live.observe(assistantMessage("", [{ type: "thinking", thinking: "hidden" }, call]), root);
  assert.equal(b.group, a.group, "hidden thinking does not split");
  const late = assistantMessage("", [{ type: "text", text: "LATE" }, call]);
  live.observe(late, root);
  assert.notEqual(b.group, a.group, "the in-flight fence survives the prepend");
  assert.deepEqual(ids(), ["older", "live-a"]);
  live.finishMessage(late, root);
  const next = live.addCall("next", "write", { path: "next" }, root);
  assert.equal(next?.group, b.group, "later calls continue the live tail");
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
  await f.pi.event("user_bash");
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
  await f.pi.event("user_bash");
  const write = f.call("write", "trailing-write", { path: "new.ts", content: "new" });
  write.result(result("written"));
  assert.equal(plain(write.view), "✓ Wrote new.ts +1 ▸");
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
  assert.equal(plain(a.view), "$ Ran 2 commands ▸", "no failure count; closed groups are one line");
  assert(
    a.view.render(160)[0].startsWith(`${paint(themes.theme, "green", "$")} Ran `),
    "one failure does not turn the group red",
  );
  f.expand(true);
  const headers = () =>
    a.view.render(160).filter((line) => tui.stripTerminalSequences(line).endsWith("▾"));
  assert.equal(headers().length, 3);
  for (const [i, tone] of (["green", "green", "red"] as const).entries()) {
    const prefix = `${i ? "  " : ""}${paint(themes.theme, tone, "$")} `;
    assert(headers()[i].startsWith(prefix), "the failed call is red on its own row");
    assert(!/[✓✗]/.test(tui.stripTerminalSequences(headers()[i])));
  }
  a.result(result("failed"), true);
  assert(
    headers()[0].startsWith(`${paint(themes.theme, "red", "$")} Ran 2 commands `),
    "a group is red only when every call failed",
  );
});

test("closed groups hide failed calls; open groups show them with their error bodies", async () => {
  const f = await fixture();
  const a = f.call("bash", "a", { command: "printf hello" }, false);
  const b = f.call("bash", "b", { command: "exit 1" }, false);
  assert.match(plain(a.view), /Run 2 commands/);
  a.result(result("streaming"), false, true);
  assert.match(plain(a.view), /Running 2 commands/);
  a.result(result("success"));
  b.result(result("ERROR_BODY\nSTACK_TRACE"), true);
  assert.equal(plain(a.view), "$ Ran 2 commands ▸");
  a.view.handleMouse(mouse(0));
  assert.match(plain(a.view), /^ {2}\$ exit 1 ▸$/m);
  assert(!plain(a.view).includes("ERROR_BODY"), "error output stays closed with its row");
  a.view.handleMouse(mouse(0, 2));
  assert.match(plain(a.view), /ERROR_BODY\n\s*STACK_TRACE/);
  a.view.handleMouse(mouse(0, 2));
  assert(!plain(a.view).includes("STACK_TRACE"));
  a.view.handleMouse(mouse(0));
  assert.equal(plain(a.view), "$ Ran 2 commands ▸");
  f.expand(true);
  assert.match(plain(a.view), /STACK_TRACE/);
  f.expand(false);
  assert.equal(plain(a.view), "$ Ran 2 commands ▸");
  await f.pi.event("user_bash");
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

test("writes count the lines they wrote, in rows and per-kind group totals", async () => {
  const f = await fixture();
  for (const [content, lines] of [
    ["", 0],
    ["one", 1],
    ["one\n", 1],
    ["one\ntwo", 2],
    ["one\r\ntwo\r\n", 2],
    ["\n\n", 2],
  ] as const)
    assert.equal(writtenLines(content), lines, JSON.stringify(content));
  const a = f.call("write", "write-a", { path: "a.ts", content: "1\n2\n3\n" }, false);
  assert.equal(plain(a.view), "… Write a.ts ▸", "pending writes add no count");
  a.result(result("written"));
  assert.equal(plain(a.view), "✓ Wrote a.ts +3 ▸");
  assert(
    a.view.render(160)[0].includes(paint(themes.theme, "green", "+3")),
    "rows show the count in green",
  );
  const empty = f.call("write", "write-empty", { path: "empty.ts", content: "" });
  empty.result(result("written"));
  const b = f.call("write", "write-b", { path: "b.ts", content: "x\ny" });
  b.result(result("written"));
  assert.equal(plain(a.view), "✓ Wrote 3 files (+5) ▸", "empty writes add nothing");
  const header = a.view.render(160)[0];
  const dim = (text: string) => themes.theme.fg("dim", text);
  assert(
    header.includes(`${dim("(")}+5${dim(")")}`),
    "summaries show plain counts in grey brackets",
  );
  const failed = f.call("write", "write-failed", { path: "c.ts", content: "NOT\nWRITTEN" });
  failed.result(result("EACCES"), true);
  assert.equal(plain(a.view), "✓ Wrote 4 files (+5) ▸", "failed writes add no count");
  const edit = f.call("edit", "write-then-edit", { path: "a.ts" });
  edit.result(result("done", { diff: "-1 1\n+1 one" }));
  assert.equal(
    plain(a.view),
    "✓ Wrote 4 files (+5), edited 1 file (+1 −1) ▸",
    "each kind has its own total",
  );
  a.view.handleMouse(mouse(0));
  assert.match(plain(a.view), /^ {2}✓ Wrote a\.ts \+3 ▸$/m);
  assert.match(plain(a.view), /^ {2}✓ Wrote empty\.ts ▸$/m, "zero counts are omitted");
  assert.match(plain(a.view), /^ {2}✗ Write c\.ts ▸$/m);
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
  assert.equal(plain(a.view), "… Editing 2 files (+2 −1) ▸");
  a.result(result("done", { diff: "-1 old-a\n+1 new-a" }));
  assert.equal(plain(a.view), "✓ Edited 2 files (+3 −2) ▸");
  const cached = a.view.render(160);
  assert.equal(a.view.render(160), cached);
  b.result(result("done", { diff: "-1 old-b\n+1 new-b\n+2 extra" }));
  assert.equal(plain(a.view), "✓ Edited 2 files (+3 −2) ▸", "snapshots are not cumulative");

  const again = f.call("edit", "edits-again", { path: "a.txt" });
  again.result(result("done", { diff: "-1 old-a\n-2 another" }));
  assert.equal(plain(a.view), "✓ Edited 2 files (+3 −4) ▸", "repeated paths count once");
  again.context.cwd = join(f.dir, "other-project");
  again.redraw();
  assert.equal(plain(a.view), "✓ Edited 3 files (+3 −4) ▸", "working directories stay distinct");
  again.context.cwd = f.dir;
  again.redraw();
  b.result(result("done"));
  again.result(result("done", { diff: "" }));
  for (const [diff, suffix] of [
    ["+1 addition", " (+1)"],
    ["-1 removal", " (−1)"],
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
  assert.equal(plain(a.view), "✓ Edited 2 files (+2 −1) ▸");
  const header = a.view.render(160)[0];
  // Group summaries: grey brackets around plain counts; rows keep green/red counts.
  const dim = (text: string) => themes.theme.fg("dim", text);
  assert(header.includes(`${dim("(")}+2 −1${dim(")")}`));
  assert(!header.includes(paint(themes.theme, "green", "+2")));
  a.view.handleMouse(mouse(tui.visibleWidth(plain(a.view)) - 1));
  assert.equal(
    plain(a.view),
    `✓ Edited 2 files (+2 −1) ▾\n  ✓ Edited ${path} +1 −1 ▸\n  ✓ Edited b.txt +1 ▸`,
  );
  const row = a.view.render(160)[1];
  assert(
    row.includes(paint(themes.theme, "green", "+1")) &&
      row.includes(paint(themes.theme, "red", "−1")),
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
  assert.match(plain(a.view), /Edited 3 files \(\+3 −1\) ▾/);
  assert(plain(a.view).includes("AFTER_A"), "growing a group preserves its open diffs");
  assert(!plain(a.view).includes("AFTER_C"));
  f.expand(true);
  assert(plain(a.view).includes("AFTER_B") && plain(a.view).includes("AFTER_C"));
  f.expand(false);
  assert.equal(plain(a.view), "✓ Edited 3 files (+3 −1) ▸");
});

test("failed edits are hidden in closed groups, red only when all failed, and add no diff totals", async () => {
  const f = await fixture();
  const a = f.call("edit", "good-edit", { path: "good.txt" });
  a.result(result("done", { diff: "-1 before\n+1 after" }));
  const b = f.call("edit", "failed-edit", { path: "bad.txt" });
  b.result(result("EDIT_ERROR_BODY", { diff: "+1 NOT_APPLIED" }), true);
  assert.equal(plain(a.view), "✓ Edited 2 files (+1 −1) ▸");
  assert(a.view.render(160)[0].startsWith(paint(themes.theme, "green", "✓")));
  assert.equal(plain(b.view), "");
  a.view.handleMouse(mouse(0));
  assert.match(plain(a.view), /\n {2}✗ Edit bad.txt ▸$/);
  a.view.handleMouse(mouse(0, 2));
  assert(plain(a.view).includes("EDIT_ERROR_BODY"));
  assert(!plain(a.view).includes("NOT_APPLIED"));
  f.expand(true);
  assert(plain(a.view).includes("EDIT_ERROR_BODY") && plain(a.view).includes("-1 before"));
  f.expand(false);
  assert.equal(plain(a.view), "✓ Edited 2 files (+1 −1) ▸");
  a.result(result("ALSO_FAILED"), true);
  assert.equal(plain(a.view), "✗ Edit 2 files ▸", "all-failed edits did not happen");
  assert(a.view.render(160)[0].startsWith(paint(themes.theme, "red", "✗")));
});

test("output padding follows the live host for cached headers, bodies, clicks and images", async (t) => {
  const f = await fixture();
  const host = {
    outputPad: 0,
    session: toolSession((name, base) => f.pi.renderers(name, base)),
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
    await f.pi.event("user_bash");
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
  await f.pi.event("user_bash");
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
  const original = f.pi.renderers("write");
  assert.notEqual(other?.renderCall, original?.renderCall);
  assert.equal(f.pi.renderers("write"), original);
  const unmanaged = core.createReadToolDefinition(f.dir);
  const plainHost = { outputPad: 1, session: toolSession(() => unmanaged as ToolRenderers) };
  assert.equal(
    interactive.getRegisteredToolDefinition.call(plainHost, "read")?.renderCall,
    unmanaged.renderCall,
  );

  tui.setCapabilityOverrides({ images: "kitty" });
  try {
    await f.pi.event("user_bash");
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

test("grouped native images bind before first paint and expand independently without duplication", async (t) => {
  const f = await fixture();
  tui.setCapabilityOverrides({ images: "kitty" });
  try {
    const components = ["before", "picture", "wide"].map((id) =>
      component("read", id, { path: `${id}.png` }, f.tool("read"), f.dir, { showImages: true }),
    );
    const leader = components[0];
    leader.updateResult({ ...result("TEXT_BODY"), isError: false });
    const wide =
      "iVBORw0KGgoAAAANSUhEUgAACDQAAAABCAYAAAArDGywAAAAH0lEQVR4nO3BIQEAAAACIP+f1hsGIAUAAAAAAAAAODMSH7ERSSRpYgAAAABJRU5ErkJggg==";
    const outputs = [PIXEL_PNG, wide].map((data) => ({
      content: [{ type: "image", data, mimeType: "image/png" }],
      isError: false,
    }));
    const payload = JSON.stringify(outputs);
    for (const [i, output] of outputs.entries()) components[i + 1].updateResult(output);
    const rendered: number[] = [];
    for (const [i, item] of components.slice(1).entries()) {
      const nativeImage = internals(item).imageComponents[0];
      const render = nativeImage.render.bind(nativeImage);
      t.mock.method(nativeImage, "render", (width: number) => {
        rendered.push(i);
        return render(width);
      });
    }
    // Neither image member has ever been painted; its slot must already exist.
    assert.match(plain(leader), /Explored 3 files ▸/);
    assert(!leader.render(160).some(isImageLine));
    leader.handleMouse(mouse(0, 1));
    const toggle = (path: string) => {
      const y = leader
        .render(160)
        .findIndex((line) => tui.stripTerminalSequences(line).includes(path));
      assert(y > 0);
      leader.handleMouse(mouse(0, y));
    };
    assert.match(plain(leader), /Read picture.png \(image\)/);
    assert(!leader.render(160).some(isImageLine));
    toggle("picture.png");
    assert(leader.render(160).some(isImageLine));
    assert.deepEqual(rendered, [0], "first frame uses only the requested member's preview");
    rendered.length = 0;
    toggle("wide.png");
    assert.equal(leader.render(160).filter(isImageLine).length, 2);
    assert.deepEqual(rendered, [0, 1]);
    for (const item of components.slice(1))
      assert.deepEqual(item.render(160), [], "no native duplicate outside leader");
    toggle("picture.png");
    assert.equal(leader.render(160).filter(isImageLine).length, 1);
    const command = component(
      "bash",
      "after-image",
      { command: "echo after" },
      f.tool("bash"),
      f.dir,
    );
    command.updateResult({ ...result("AFTER_BODY"), isError: false });
    components.push(command);
    assert.match(plain(leader), /Read 3 files, ran 1 command/);
    for (const value of [true, false, true]) {
      f.expand(value);
      for (const item of components) item.setExpanded(value);
      assert.equal(leader.render(160).filter(isImageLine).length, value ? 2 : 0);
    }
    components[2].setShowImages(false);
    assert.equal(leader.render(160).filter(isImageLine).length, 1);
    assert.match(
      plain(leader),
      /image\/png/,
      "disabled member gets a fallback, not another member's preview",
    );
    components[2].updateResult({ ...result("REPLACED_IMAGE"), isError: false });
    assert.match(plain(leader), /REPLACED_IMAGE/);
    assert(!plain(leader).includes("image/png"));
    const unmanaged = component(
      "read",
      "unmanaged",
      {},
      core.createReadToolDefinition(f.dir),
      f.dir,
    );
    unmanaged.updateResult(outputs[0]);
    assert(unmanaged.render(160).some(isImageLine));
    assert.equal(JSON.stringify(outputs), payload);
    f.expand(false);
    await f.pi.event("session_shutdown");
    await f.pi.event("session_start", {}, f.ctx);
    const resumed = component("read", "resumed", { path: "resumed.png" }, f.tool("read"), f.dir);
    resumed.updateResult(outputs[0]);
    assert(!resumed.render(160).some(isImageLine), "resumed previews start hidden");
    resumed.handleMouse(mouse(0, 1));
    assert(resumed.render(160).some(isImageLine));
  } finally {
    tui.setCapabilityOverrides({ images: null });
  }
});

test("Pi executes its own tools; mirage draws only them and leaves other tools' renderers", async () => {
  const f = await fixture();
  assert.equal(
    f.pi.tools.size,
    0,
    "mirage overrides no tools, so Pi's shell, image and trust settings apply",
  );
  const foreign: ToolRenderers = { renderCall: () => fake<Component>({}) };
  const base = () => foreign;
  for (const name of ["read", "bash", "edit", "write", "codemode"])
    assert.notEqual(f.pi.renderers(name, base), foreign, `${name} is drawn by mirage`);
  for (const name of ["grep", "mcp__docs__search", "web_search"])
    assert.equal(f.pi.renderers(name, base), foreign, `${name} keeps its renderer`);
  // A tool another extension registered under a built-in name keeps that extension's renderer.
  const sources: Record<string, string> = { read: "builtin", bash: "local", codemode: "builtin" };
  Object.assign(f.pi.api, {
    getAllTools: () =>
      Object.entries(sources).map(([name, source]) =>
        fake<ToolInfo>({ name, sourceInfo: { source } }),
      ),
  } satisfies Partial<typeof f.pi.api>);
  assert.notEqual(f.pi.renderers("read", base), foreign);
  assert.notEqual(f.pi.renderers("codemode", base), foreign);
  assert.notEqual(f.pi.renderers("write", base), foreign, "unregistered calls are still drawn");
  assert.equal(f.pi.renderers("bash", base), foreign);
  const before = f.call("read", "before-foreign-bash", { path: "a.txt" });
  await f.pi.event(
    "message_end",
    {
      message: assistantMessage("", [
        { type: "toolCall", id: "foreign-bash", name: "bash", arguments: { command: "x" } },
      ]),
    },
    f.ctx,
  );
  const after = f.call("read", "after-foreign-bash", { path: "b.txt" });
  assert.notEqual(after.view.row.group, before.view.row.group, "an undrawn call is a boundary");
  const older = fakePi();
  Object.assign(older.api, { registerToolRenderer: undefined });
  assert.throws(() => installDisplay(older.api), /Pi .*: tool renderer API is unavailable/);
});

test("filename clicks without inspector warn instead of opening", async () => {
  const f = await fixture();
  const args = { path: "a\u00a0b.txt" };
  const row = f.call("read", "missing-opener", args);
  const label = plain(row.view);
  row.view.handleMouse(mouse(label.indexOf(args.path) + 1));
  assert.match(f.notices.at(-1)?.[0] ?? "", /requires inspector/);
});

test("reconstruction keeps images in persisted groups and failures discoverable", async () => {
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
    assert.equal(plain(view), "✓ Explored 4 files ▸");
    assert.equal(plain(f.call("read", "picture", { path: "image.png" }).view), "");
    view.handleMouse(mouse(0));
    assert.match(plain(view), /✗ Read b/);
    assert(!plain(view).includes("SAVED_ERROR"));
    assert.match(plain(view), /Read image.png \(image\)/);
    assert.match(plain(view), /Read c/);
    view.handleMouse(mouse(0));
  }
  await f.rebuild("session_tree");
  assert(!plain(f.call("read", "new-branch", {}).view).includes("2 files"));
});

test("in-runtime reconstruction preserves rows and local expansion without editing entries", async () => {
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
    if (event === "session_start") {
      assert.equal(plain(view), "✓ Edited 2 files (+2 −2) ▸");
      view.handleMouse(mouse(0));
    }
    assert(plain(view).includes("Edited a.txt") && plain(view).includes("Edited b.txt"));
    assert.equal(plain(f.call("edit", "b", { path: "b.txt" }).view), "");
  }
  assert.equal(JSON.stringify(entries), before, "grouping is presentation-only");
});
