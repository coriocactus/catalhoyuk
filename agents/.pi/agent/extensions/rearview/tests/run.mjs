import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { pkg, require } from "../../mirage/tests/pi-package.mjs";

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
const { default: installDisplay } = await jiti.import("../../mirage/index.ts");
const { default: installHistory } = await jiti.import("../index.ts");
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

test("scroll input between prepend construction and layout is rebased, ordered and coalesced", () => {
  for (const [name, inputs, expected] of [
    ["wheel", (s) => assert.equal(s.scrollBy(-1), 0), 29],
    [
      "several wheels",
      (s) => {
        s.scrollBy(-1);
        s.scrollBy(-2);
        s.scrollBy(1);
      },
      28,
    ],
    [
      "clamp each move",
      (s) => {
        s.scrollBy(-100);
        s.scrollBy(2);
      },
      2,
    ],
    ["page up", (s) => s.scrollBy(-20), 10],
    ["page down", (s) => s.scrollBy(20), 50],
    [
      "absolute old-layout position",
      (s) => {
        s.scrollTo(10);
        s.scrollBy(-2);
      },
      38,
    ],
    [
      "coalesced Home",
      (s) => {
        s.scrollToStart();
        s.scrollToStart();
      },
      30,
    ],
    ["explicit End", (s) => s.scrollToEnd(), 110],
  ]) {
    const scroll = new tui.ScrollView(new tui.Container(), { follow: "end" });
    scroll.updateLayout(100, 20, () => {});
    let loads = 0,
      settled = 0;
    const hook = attachTopPaging(scroll, {
      active: () => true,
      width: () => 100,
      load: () => loads++,
      settled: () => settled++,
      end() {},
    });
    try {
      scroll.scrollToStart();
      hook.anchor({ render: () => Array(30).fill("older"), invalidate() {} });
      inputs(scroll);
      scroll.updateLayout(130, 20, () => {});
      assert.equal(scroll.scrollTop, expected, name);
      scroll.updateLayout(130, 20, () => {});
      assert.equal(scroll.scrollTop, expected, `${name}: no duplicate compensation`);
      assert.equal(settled, 1);
      assert.equal(loads, 1, `${name}: no second page during the first prepend`);
    } finally {
      hook.dispose();
    }
  }
  const scroll = new tui.ScrollView(new tui.Container(), { follow: "end" });
  scroll.updateLayout(100, 20, () => {});
  let width = 100;
  const hook = attachTopPaging(scroll, {
    active: () => true,
    width: () => width,
    load() {},
    settled() {},
    end() {},
  });
  try {
    scroll.scrollToStart();
    hook.anchor({ render: () => Array(width === 100 ? 30 : 44).fill("older"), invalidate() {} });
    scroll.scrollBy(-1);
    width = 80;
    scroll.updateLayout(900, 20, () => {}); // Resize AND streaming tail growth.
    assert.equal(scroll.scrollTop, 43);
    hook.anchor({ render: () => Array(30).fill("cancelled"), invalidate() {} });
    scroll.scrollBy(-1);
    hook.reset();
    scroll.updateLayout(900, 20, () => {});
    assert.equal(scroll.scrollTop, 43, "reset cancels deferred input as well as the anchor");
  } finally {
    hook.dispose();
  }
});

test("an incompatible history API falls back to the full native transcript with one warning", () => {
  const f = fixture(0),
    notices = [];
  f.host.sessionManager = core.SessionManager.inMemory(process.cwd());
  for (let i = 0; i < 70; i++) f.host.sessionManager.appendMessage(assistant(`FALLBACK_${i}`));
  const entries = f.host.sessionManager.buildContextEntries();
  const before = JSON.stringify(entries);
  f.scroll.getContentWidth = undefined;
  const adapter = installHistoryAdapter((error) => notices.push(error.message), 5);
  try {
    for (let i = 0; i < 2; i++) {
      f.chat.clear();
      f.host.renderSessionEntries(entries);
      assert.equal(text(f.chat).match(/FALLBACK_/g).length, 70);
    }
    assert.equal(notices.length, 1);
    assert.match(
      notices[0],
      /history paging disabled; using the native transcript.*scroll API changed/,
    );
    assert.equal(JSON.stringify(f.host.sessionManager.buildContextEntries()), before);
    assert(!Object.hasOwn(f.scroll, "scrollBy"), "failed capability checks leave no partial hooks");
  } finally {
    adapter.dispose();
  }
});

test("every outgoing history runtime releases its owner, pending input and scroll hooks", async () => {
  const key = Symbol.for("rearview.patch.v1");
  for (const reason of ["new", "new", "resume", "fork", "reload", "quit"]) {
    const handlers = new Map();
    installHistory({
      on: (name, fn) => handlers.set(name, fn),
      events: core.createEventBus(),
    });
    const f = fixture(70),
      originalScroll = f.scroll.scrollBy;
    let onInput,
      unsubscribed = 0;
    const ctx = {
      mode: "tui",
      ui: {
        notify: (message) => assert.fail(message),
        onTerminalInput(fn) {
          onInput = fn;
          return () => unsubscribed++;
        },
      },
    };
    try {
      // Reconstruction happens BEFORE the new runtime's session_start.
      assert.equal(core.InteractiveMode.prototype[key].owners.size, 1);
      f.host.renderSessionEntries(f.sm.buildContextEntries());
      f.layout();
      handlers.get("session_start")({}, ctx);
      f.scroll.scrollToStart();
      onInput();
      handlers.get("session_shutdown")({ reason });
      handlers.get("session_shutdown")({ reason }); // Idempotent disposal.
      assert.equal(core.InteractiveMode.prototype[key], undefined);
      assert.equal(core.InteractiveMode.prototype.renderSessionEntries, nativeRender);
      assert.equal(f.scroll.scrollBy, originalScroll);
      assert.equal(unsubscribed, 1);
      await tick();
      assert(!text(f.document).includes("OLD_"), "shutdown cancels queued page construction");
    } finally {
      handlers.get("session_shutdown")({ reason: "quit" });
    }
  }
  // No replacement factory (extension disabled): nothing remains patched.
  const disabled = fixture();
  disabled.host.renderSessionEntries(disabled.sm.buildContextEntries());
  assert.equal(core.InteractiveMode.prototype[key], undefined);
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
    f.scroll.scrollBy(-1); // Page exists, but its prepend has not been laid out yet.
    f.layout();
    const lines = f.document.render(100).map(tui.stripTerminalSequences);
    assert.equal(lines.filter((line) => line.includes("OLD_")).length, 10);
    assert(lines.some((line) => line.includes("OLD_025")));
    const anchor = lines.findIndex((line) => line.includes("CURRENT_ANCHOR")) - f.scroll.scrollTop;
    assert.equal(
      anchor,
      initialAnchor + 1,
      "short transcripts preserve the anchor plus the intervening one-row scroll",
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

function bindTools(host, tools) {
  Object.defineProperty(host, "session", {
    configurable: true,
    value: { getToolDefinition: (name) => tools.get(name) },
  });
  delete host.getRegisteredToolDefinition; // Use Pi's actual lookup and our scoped adapters.
}

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
  bindTools(f.host, tools);
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
    (view) => events.emit("rearview:transcript-view", view),
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
    for (const padding of [1, 0, 1]) {
      f.host.outputPad = padding;
      const headers = text(f.document)
        .split("\n")
        .filter((line) => line.includes("Explored 5 files"));
      assert.equal(headers.length, 2);
      for (const header of headers) assert.equal(header.indexOf("✓"), padding);
    }
    f.host.loadedResourcesContainer = new tui.Container();
    f.host.builtInHeader = new tui.Container();
    f.host.showStatus = () => {};
    f.host.setToolsExpanded(true);
    f.layout();
    assert(text(f.document).includes("BODY_29") && text(f.document).includes("BODY_24"));
    for (const padding of [0, 1]) {
      f.host.outputPad = padding;
      const bodies = text(f.document)
        .split("\n")
        .filter((line) => line.includes("BODY_"));
      assert.equal(bodies.length, 10);
      for (const body of bodies) assert.equal(body.indexOf("BODY_"), padding + 4);
    }
    assert.equal(executions, 0);
    assert.deepEqual(errors, []);
  } finally {
    adapter.dispose();
    handlers.get("session_shutdown")({ reason: "quit" });
  }
});

for (const name of ["read", "edit"]) {
  test(`archived ${name} groups never execute or merge into live pending tools`, async () => {
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
    bindTools(f.host, tools);
    const live = new core.ToolExecutionComponent(
      name,
      "live-tool",
      { path: "live.txt" },
      {},
      tools.get(name),
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
        assistant("", [{ type: "toolCall", id, name, arguments: { path: `${id}.txt` } }]),
      );
      archive.appendMessage({
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        content: [{ type: "text", text: id }],
        details: name === "edit" ? { diff: "-1 before\n+1 after" } : undefined,
        isError: false,
        timestamp: 1,
      });
    }
    try {
      const page = renderHistoryPage(f.host, archive.getEntries(), nativeRender);
      assert.match(text(page), name === "edit" ? /Edited 2 files \+2 −2/ : /Explored 2 files/);
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
}
