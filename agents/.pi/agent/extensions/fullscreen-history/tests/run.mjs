import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pkg, require } from "../../tool-display/tests/pi-package.mjs";

const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": join(pkg, "dist/index.js"),
    "@earendil-works/pi-tui": require.resolve("@earendil-works/pi-tui"),
    typebox: require.resolve("typebox"),
  },
});
const { HistoryCursor, historyBoundary } = await jiti.import("../model.ts");
const { attachTopPaging } = await jiti.import("../scroll.ts");
const { renderHistoryPage, installHistoryAdapter } = await jiti.import("../native.ts");
const { default: installDisplay } = await jiti.import("../../tool-display/index.ts");
const core = await import(join(pkg, "dist/index.js"));
const tui = await import(require.resolve("@earendil-works/pi-tui"));
core.initTheme("dark");
const nativeRender = core.InteractiveMode.prototype.renderSessionEntries;
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (text, content = [{ type: "text", text }]) => ({
  role: "assistant",
  content,
  api: "openai-responses",
  provider: "openai",
  model: "fixture",
  usage,
  stopReason: "stop",
  timestamp: 1,
});
const text = (component) => component.render(100).map(tui.stripTerminalSequences).join("\n");
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(count = 130) {
  const sm = core.SessionManager.inMemory(process.cwd());
  for (let i = 0; i < count; i++) sm.appendMessage(assistant(`OLD_${String(i).padStart(3, "0")}`));
  const kept = sm.appendMessage(assistant("CURRENT_ANCHOR"));
  sm.appendCompaction("CHECKPOINT", kept, 10000);
  const chat = new tui.Container(),
    document = new tui.Container();
  document.addChild(chat);
  const scroll = new tui.ScrollView(document, { follow: "end" });
  let renders = 0,
    historyAdds = 0;
  const host = Object.create(core.InteractiveMode.prototype);
  const fields = {
    sessionManager: sm,
    settingsManager: {
      getShowCacheMissNotices: () => false,
      getShowImages: () => false,
      getImageWidthCells: () => 8,
    },
    chatContainer: chat,
    documentContainer: document,
    transcriptScrollView: scroll,
    pendingTools: new Map([["live", { untouched: true }]]),
    ui: {
      mode: "fullscreen",
      terminal: { columns: 100 },
      requestRender() {
        renders++;
      },
    },
    toolOutputExpanded: false,
    hideThinkingBlock: true,
    hiddenThinkingLabel: "Thinking…",
    outputPad: 1,
    getRegisteredToolDefinition: () => undefined,
    getMarkdownThemeWithSettings: () => core.getMarkdownTheme(),
    getMarkdownTransformers: () => [],
    editor: {
      addToHistory() {
        historyAdds++;
      },
    },
  };
  for (const [key, value] of Object.entries(fields))
    Object.defineProperty(host, key, { value, writable: true, configurable: true });
  return {
    host,
    sm,
    chat,
    document,
    scroll,
    get renders() {
      return renders;
    },
    get historyAdds() {
      return historyAdds;
    },
    layout(height = 20) {
      scroll.updateLayout(document.render(100).length, height, () => {});
    },
  };
}

test("ancestor pages are demand-driven, bounded, chronological, and transactional", () => {
  const f = fixture(1000),
    entries = f.sm.buildContextEntries();
  let reads = 0;
  const cursor = new HistoryCursor(
    historyBoundary(entries),
    (id) => {
      reads++;
      return f.sm.getEntry(id);
    },
    new Set(entries.map((e) => e.id)),
  );
  const before = JSON.stringify(f.sm.getEntries());
  assert.equal(reads, 0);
  const first = cursor.prepare(10);
  assert.equal(reads, 10);
  assert.equal(first.entries[0].message.content[0].text, "OLD_990");
  assert.equal(first.entries.at(-1).message.content[0].text, "OLD_999");
  assert.equal(cursor.prepare(10).from, first.from, "failed rendering can retry the same page");
  cursor.commit(first);
  const next = cursor.prepare(10);
  assert.equal(next.entries.at(-1).message.content[0].text, "OLD_989");
  assert.throws(() => cursor.commit(first), /Stale/);
  assert.equal(JSON.stringify(f.sm.getEntries()), before);
  assert.equal(historyBoundary([]), null);
  assert.equal(historyBoundary([entries[0]]), entries[0].parentId);
});

test("tool batches are not split and corrupt parent chains fail visibly", () => {
  const sm = core.SessionManager.inMemory(process.cwd());
  sm.appendMessage(
    assistant("", [
      { type: "toolCall", id: "a", name: "read", arguments: { path: "a" } },
      { type: "toolCall", id: "b", name: "read", arguments: { path: "b" } },
    ]),
  );
  for (const id of ["a", "b"])
    sm.appendMessage({
      role: "toolResult",
      toolCallId: id,
      toolName: "read",
      content: [{ type: "text", text: id }],
      isError: false,
      timestamp: 1,
    });
  const cursor = new HistoryCursor(sm.getLeafId(), (id) => sm.getEntry(id), new Set());
  const batch = cursor.prepare(1);
  assert.equal(batch.entries.length, 3);
  cursor.commit(batch);
  assert.equal(cursor.prepare(1), undefined);
  assert.throws(
    () => new HistoryCursor("missing", () => undefined, new Set()).prepare(),
    /Missing/,
  );
  assert.throws(
    () =>
      new HistoryCursor(
        "cycle",
        () => ({ id: "cycle", parentId: "cycle", type: "model_change" }),
        new Set(),
      ).prepare(),
    /Cycle/,
  );
});

test("top-scroll hooks ignore paints, preserve anchors across resize/appends, and restore methods", () => {
  const scroll = new tui.ScrollView(new tui.Container(), { follow: "end" });
  scroll.updateLayout(100, 20, () => {});
  const original = scroll.scrollBy;
  let loads = 0,
    width = 100,
    active = true;
  const hook = attachTopPaging(scroll, {
    active: () => active,
    width: () => width,
    load: () => loads++,
    settled() {},
    end() {},
  });
  scroll.updateLayout(100, 20, () => {});
  assert.equal(loads, 0);
  scroll.scrollToStart();
  assert.equal(loads, 1);
  hook.anchor({ render: () => Array(width < 100 ? 12 : 6).fill("older"), invalidate() {} });
  scroll.updateLayout(300, 20, () => {}); // Tail grew too, but only the prepend counts.
  assert.equal(scroll.scrollTop, 6);
  width = 80;
  scroll.updateLayout(350, 20, () => {});
  assert.equal(scroll.scrollTop, 12);
  assert.equal(loads, 1);
  scroll.scrollToEnd();
  scroll.updateLayout(350, 20, () => {});
  assert.equal(scroll.scrollTop, 330);
  active = false;
  scroll.scrollToStart();
  assert.equal(loads, 1);
  hook.dispose();
  assert.equal(scroll.scrollBy, original);
  assert(!Object.hasOwn(scroll, "scrollBy"));
});

test("native adapter loads one page per trip to top, retains anchors and leaves context untouched", async () => {
  const errors = [],
    adapter = installHistoryAdapter((error) => errors.push(error), 10);
  const f = fixture(35);
  const leaf = f.sm.getLeafId();
  f.sm.branch(f.sm.getEntries()[10].id);
  f.sm.appendMessage(assistant("OFF_BRANCH_MESSAGE"));
  f.sm.branch(leaf);
  try {
    f.host.renderSessionEntries(f.sm.buildContextEntries());
    f.layout();
    const context = JSON.stringify(f.sm.buildSessionContext()),
      branch = f.sm.getLeafId(),
      session = JSON.stringify(f.sm.getEntries());
    const pending = f.host.pendingTools;
    assert(!text(f.document).includes("OLD_"));
    const initialAnchor =
      f.document
        .render(100)
        .map(tui.stripTerminalSequences)
        .findIndex((line) => line.includes("CURRENT_ANCHOR")) - f.scroll.scrollTop;
    // Duplicate wheel/Home signals before the paint must not fetch a second page.
    f.scroll.scrollToStart();
    f.layout(); // An unrelated paint must not release the in-flight load guard.
    f.scroll.scrollToStart();
    await tick();
    f.layout();
    const lines = f.document.render(100).map(tui.stripTerminalSequences);
    assert.equal(lines.filter((line) => line.includes("OLD_")).length, 10);
    assert(lines.some((line) => line.includes("OLD_025")));
    const anchor = lines.findIndex((line) => line.includes("CURRENT_ANCHOR")) - f.scroll.scrollTop;
    assert.equal(
      anchor,
      initialAnchor,
      "short transcripts keep their blank space below the viewport anchor",
    );
    f.scroll.scrollToStart();
    await tick();
    f.layout();
    assert.equal(text(f.document).match(/OLD_/g).length, 20);
    f.scroll.scrollToStart();
    await tick();
    f.layout();
    f.scroll.scrollToStart();
    await tick();
    f.layout();
    assert.equal(text(f.document).match(/OLD_/g).length, 35);
    assert(!text(f.document).includes("OFF_BRANCH_MESSAGE"), "follow ancestors, not JSONL order");
    const exhausted = text(f.document);
    f.scroll.scrollToStart();
    await tick();
    f.layout();
    assert.equal(text(f.document), exhausted);
    assert.equal(JSON.stringify(f.sm.buildSessionContext()), context);
    assert.equal(JSON.stringify(f.sm.getEntries()), session);
    assert.equal(f.sm.getLeafId(), branch);
    assert.equal(f.host.pendingTools, pending);
    assert.equal(f.historyAdds, 0);
    assert.deepEqual(errors, []);
  } finally {
    adapter.dispose();
  }
  assert.equal(core.InteractiveMode.prototype.renderSessionEntries, nativeRender);
  assert(!text(f.document).includes("OLD_"));
});

test("shutdown/branch changes cancel work; compaction retains already loaded history", async () => {
  const adapter = installHistoryAdapter((error) => {
      throw error;
    }, 5),
    f = fixture(20);
  f.host.renderSessionEntries(f.sm.buildContextEntries());
  f.layout();
  f.scroll.scrollToStart();
  adapter.dispose();
  await tick();
  f.layout();
  assert(!text(f.document).includes("OLD_"));
  const next = installHistoryAdapter((error) => {
    throw error;
  }, 5);
  try {
    f.chat.clear();
    f.host.renderSessionEntries(f.sm.buildContextEntries());
    f.layout();
    f.scroll.scrollToStart();
    await tick();
    f.layout();
    assert(text(f.document).includes("OLD_"));
    const kept = f.sm.appendMessage(assistant("NEW_CONTEXT"));
    f.sm.appendCompaction("NEW_CHECKPOINT", kept, 20000);
    f.chat.clear();
    f.host.renderSessionEntries(f.sm.buildContextEntries());
    f.layout();
    assert.equal(text(f.document).match(/OLD_/g).length, 5, "compaction retains the loaded page");
    assert(
      text(f.document).includes("CURRENT_ANCHOR"),
      "evicted displayed messages remain accessible",
    );
    assert(text(f.document).includes("NEW_CONTEXT"));
    f.scroll.scrollToStart();
    await tick();
    f.layout();
    assert.equal(text(f.document).match(/OLD_/g).length, 10, "older cursor survives compaction");
    next.reset();
    f.chat.clear();
    f.host.renderSessionEntries(f.sm.buildContextEntries());
    f.layout();
    assert(!text(f.document).includes("OLD_"), "branch navigation starts a new view");
  } finally {
    next.dispose();
  }
});

test("uncompacted sessions start bounded without clipping prompt history or growing live messages", async () => {
  const f = fixture(0),
    sm = core.SessionManager.inMemory(process.cwd()),
    errors = [],
    presented = [];
  f.host.sessionManager = sm;
  for (let i = 0; i < 40; i++) {
    sm.appendMessage({ role: "user", content: `PROMPT_${i}`, timestamp: 1 });
    sm.appendMessage(assistant(`REPLY_${i}`));
  }
  const adapter = installHistoryAdapter(
    (error) => errors.push(error),
    10,
    (view) => presented.push(view),
  );
  try {
    const before = JSON.stringify(sm.buildSessionContext());
    f.host.renderSessionEntries(sm.buildContextEntries(), { populateHistory: true });
    f.layout();
    assert.equal(text(f.document).match(/REPLY_/g).length, 5);
    assert(!text(f.document).includes("REPLY_34"));
    assert.equal(f.historyAdds, 40, "all original prompt history is retained");
    assert.equal(presented.at(-1).entries.length, 10);
    f.scroll.scrollToStart();
    await tick();
    f.layout();
    assert.equal(text(f.document).match(/REPLY_/g).length, 10);
    assert.equal(f.historyAdds, 40, "paging does not duplicate input history");
    assert.equal(JSON.stringify(sm.buildSessionContext()), before);
    for (let i = 40; i < 44; i++) sm.appendMessage(assistant(`REPLY_${i}`));
    f.chat.clear();
    f.host.renderSessionEntries(sm.buildContextEntries());
    f.layout();
    assert.equal(
      text(f.document).match(/REPLY_/g).length,
      14,
      "rebuilds retain loaded pages and new live messages",
    );
    assert.deepEqual(errors, []);
  } finally {
    adapter.dispose();
  }
});

test("initial tool groups contain only displayed calls, while older pages keep independent leaders", async () => {
  const handlers = new Map(),
    tools = new Map(),
    events = core.createEventBus(),
    errors = [];
  let executions = 0;
  installDisplay({
    on(name, fn) {
      handlers.set(name, fn);
    },
    registerTool(tool) {
      tools.set(tool.name, {
        ...tool,
        execute() {
          executions++;
          throw new Error("History must never execute tools.");
        },
      });
    },
    events,
  });
  const f = fixture(0),
    sm = core.SessionManager.inMemory(process.cwd());
  f.host.sessionManager = sm;
  f.host.getRegisteredToolDefinition = (name) => tools.get(name);
  for (let i = 0; i < 30; i++) {
    const id = `read-${i}`;
    sm.appendMessage(
      assistant("", [{ type: "toolCall", id, name: "read", arguments: { path: `file-${i}.txt` } }]),
    );
    sm.appendMessage({
      role: "toolResult",
      toolCallId: id,
      toolName: "read",
      content: [{ type: "text", text: `BODY_${i}` }],
      isError: false,
      timestamp: 1,
    });
  }
  const adapter = installHistoryAdapter(
    (error) => errors.push(error),
    10,
    (view) => events.emit("pi-local:transcript-view", view),
  );
  try {
    f.host.renderSessionEntries(sm.buildContextEntries());
    f.layout();
    assert.match(text(f.document), /Explored 5 files/);
    assert(!text(f.document).includes("Explored 30 files"));
    f.scroll.scrollToStart();
    await tick();
    f.layout();
    assert.equal(text(f.document).match(/Explored 5 files/g).length, 2);
    f.host.loadedResourcesContainer = new tui.Container();
    f.host.builtInHeader = new tui.Container();
    f.host.showStatus = () => {};
    f.host.setToolsExpanded(true);
    f.layout();
    assert(text(f.document).includes("BODY_29") && text(f.document).includes("BODY_24"));
    assert.equal(executions, 0);
    assert.deepEqual(errors, []);
  } finally {
    adapter.dispose();
    handlers.get("session_shutdown")({ reason: "quit" });
  }
});

test("archived tool renderers keep separate groups and never execute or disturb live pending tools", async () => {
  const handlers = new Map(),
    tools = new Map();
  const pi = {
    on(name, fn) {
      handlers.set(name, fn);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    events: core.createEventBus(),
  };
  installDisplay(pi);
  const f = fixture(0);
  f.host.getRegisteredToolDefinition = (name) => tools.get(name);
  const live = new core.ToolExecutionComponent(
    "read",
    "live-read",
    { path: "live.txt" },
    {},
    tools.get("read"),
    f.host.ui,
    process.cwd(),
  );
  live.updateResult({ content: [{ type: "text", text: "LIVE_RESULT" }], isError: false });
  const before = text(live),
    pending = f.host.pendingTools,
    context = JSON.stringify(f.sm.buildSessionContext());
  const archive = core.SessionManager.inMemory(process.cwd());
  for (const id of ["old-a", "old-b"]) {
    archive.appendMessage(
      assistant("", [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.txt` } }]),
    );
    archive.appendMessage({
      role: "toolResult",
      toolCallId: id,
      toolName: "read",
      content: [{ type: "text", text: id }],
      isError: false,
      timestamp: 1,
    });
  }
  try {
    const page = renderHistoryPage(f.host, archive.getEntries(), nativeRender);
    assert.match(text(page), /Explored 2 files/);
    assert.equal(text(live), before);
    assert.equal(f.host.pendingTools, pending);
    assert.equal(f.host.pendingTools.size, 1);
    assert.equal(JSON.stringify(f.sm.buildSessionContext()), context);
    assert.equal(f.historyAdds, 0);
    assert.equal(text(f.chat), "");
  } finally {
    handlers.get("session_shutdown")();
  }
});
