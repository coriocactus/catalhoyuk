import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Component, ScrollView } from "@earendil-works/pi-tui";
import type { TranscriptView } from "../../shared/transcript.ts";
import { fake, fakePi } from "../../test/fake-pi.ts";
import { core, load, loadFuture, tui } from "../../test/pi.ts";
import { assistant, nativeRenderEntries, text, tick, transcript } from "../../test/transcript.ts";

const { HistoryCursor, historyBoundary } = await load<typeof import("../model.ts")>(
  "../model.ts",
  import.meta.url,
);
const { attachTopPaging } = await load<typeof import("../scroll.ts")>(
  "../scroll.ts",
  import.meta.url,
);
const { installHistoryAdapter } = await load<typeof import("../native.ts")>(
  "../native.ts",
  import.meta.url,
);
const { default: installHistory } = await load<typeof import("../index.ts")>(
  "../index.ts",
  import.meta.url,
);

const PATCH = Symbol.for("rearview.patch.v1");
const patch = () =>
  (core.InteractiveMode.prototype as unknown as { [PATCH]?: { owners: Set<unknown> } })[PATCH];
const renderedEntries = () =>
  (core.InteractiveMode.prototype as unknown as { renderSessionEntries: unknown })
    .renderSessionEntries;
const page = (lines: number, fill = "older"): Component => ({
  render: () => Array(lines).fill(fill),
  invalidate() {},
});
const messageText = (entry: SessionEntry | undefined) => {
  assert(entry?.type === "message" && entry.message.role === "assistant");
  const part = entry.message.content[0];
  assert(part?.type === "text");
  return part.text;
};
const count = (value: string, pattern: RegExp) => value.match(pattern)?.length ?? 0;

test("ancestor pages are demand-driven, bounded, chronological, and transactional", () => {
  const f = transcript(1000),
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
  assert(first);
  assert.equal(reads, 10);
  assert.equal(messageText(first.entries[0]), "OLD_990");
  assert.equal(messageText(first.entries.at(-1)), "OLD_999");
  assert.equal(cursor.prepare(10)?.from, first.from, "failed rendering can retry the same page");
  cursor.commit(first);
  const next = cursor.prepare(10);
  assert.equal(messageText(next?.entries.at(-1)), "OLD_989");
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
  assert(batch);
  assert.equal(batch.entries.length, 3);
  cursor.commit(batch);
  assert.equal(cursor.prepare(1), undefined);
  assert.throws(
    () => new HistoryCursor("missing", () => undefined, new Set()).prepare(),
    /Missing/,
  );
  const cycle = { id: "cycle", parentId: "cycle", type: "model_change" } as SessionEntry;
  assert.throws(() => new HistoryCursor("cycle", () => cycle, new Set()).prepare(), /Cycle/);
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
  const cases: [string, (scroll: ScrollView) => void, number][] = [
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
  ];
  for (const [name, inputs, expected] of cases) {
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
      hook.anchor(page(30));
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
    hook.anchor(page(30, "cancelled"));
    scroll.scrollBy(-1);
    hook.reset();
    scroll.updateLayout(900, 20, () => {});
    assert.equal(scroll.scrollTop, 43, "reset cancels deferred input as well as the anchor");
  } finally {
    hook.dispose();
  }
});

test("an incompatible history API falls back to the full native transcript with one warning", () => {
  const f = transcript(0),
    notices: string[] = [];
  f.host.sessionManager = core.SessionManager.inMemory(process.cwd());
  for (let i = 0; i < 70; i++) f.host.sessionManager.appendMessage(assistant(`FALLBACK_${i}`));
  const entries = f.host.sessionManager.buildContextEntries();
  const before = JSON.stringify(entries);
  (f.scroll as { getContentWidth?: unknown }).getContentWidth = undefined;
  const adapter = installHistoryAdapter((error) => notices.push((error as Error).message), 5);
  try {
    for (let i = 0; i < 2; i++) {
      f.chat.clear();
      f.host.renderSessionEntries(entries);
      assert.equal(count(text(f.chat), /FALLBACK_/g), 70);
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

test("a future Pi version still installs the adapter: capability checks, not a version allowlist", async () => {
  const history = await loadFuture<typeof import("../native.ts")>("../native.ts", import.meta.url);
  const adapter = history.installHistoryAdapter((error) => assert.fail(String(error)));
  assert.equal(patch()?.owners.size, 1);
  adapter.dispose();
  assert.equal(patch(), undefined);
  assert.equal(renderedEntries(), nativeRenderEntries);
});

test("every outgoing history runtime releases its owner, pending input and scroll hooks", async () => {
  for (const reason of ["new", "new", "resume", "fork", "reload", "quit"]) {
    const pi = fakePi();
    installHistory(pi.api);
    const f = transcript(70),
      originalScroll = f.scroll.scrollBy;
    let onInput: ((data: string) => unknown) | undefined,
      unsubscribed = 0;
    const ctx = fake<ExtensionContext>({
      mode: "tui",
      ui: {
        notify: (message) => assert.fail(message),
        onTerminalInput(handler) {
          onInput = handler;
          return () => unsubscribed++;
        },
      },
    });
    try {
      // Reconstruction happens BEFORE the new runtime's session_start.
      assert.equal(patch()?.owners.size, 1);
      f.host.renderSessionEntries(f.sm.buildContextEntries());
      f.layout();
      pi.emit("session_start", {}, ctx);
      f.scroll.scrollToStart();
      onInput?.("");
      pi.emit("session_shutdown", { reason });
      pi.emit("session_shutdown", { reason }); // Idempotent disposal.
      assert.equal(patch(), undefined);
      assert.equal(renderedEntries(), nativeRenderEntries);
      assert.equal(f.scroll.scrollBy, originalScroll);
      assert.equal(unsubscribed, 1);
      await tick();
      assert(!text(f.document).includes("OLD_"), "shutdown cancels queued page construction");
    } finally {
      pi.emit("session_shutdown", { reason: "quit" });
    }
  }
  // No replacement factory (extension disabled): nothing remains patched.
  const disabled = transcript();
  disabled.host.renderSessionEntries(disabled.sm.buildContextEntries());
  assert.equal(patch(), undefined);
});

test("native adapter loads one page per trip to top, retains anchors and leaves context untouched", async () => {
  const errors: unknown[] = [],
    adapter = installHistoryAdapter((error) => errors.push(error), 10);
  const f = transcript(35);
  const leaf = f.sm.getLeafId();
  assert(leaf);
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
    assert.equal(count(text(f.document), /OLD_/g), 20);
    f.scroll.scrollToStart();
    await tick();
    f.layout();
    f.scroll.scrollToStart();
    await tick();
    f.layout();
    assert.equal(count(text(f.document), /OLD_/g), 35);
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
  assert.equal(renderedEntries(), nativeRenderEntries);
  assert(!text(f.document).includes("OLD_"));
});

test("shutdown/branch changes cancel work; compaction retains already loaded history", async () => {
  const adapter = installHistoryAdapter((error) => {
      throw error;
    }, 5),
    f = transcript(20);
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
    assert.equal(count(text(f.document), /OLD_/g), 5, "compaction retains the loaded page");
    assert(
      text(f.document).includes("CURRENT_ANCHOR"),
      "evicted displayed messages remain accessible",
    );
    assert(text(f.document).includes("NEW_CONTEXT"));
    f.scroll.scrollToStart();
    await tick();
    f.layout();
    assert.equal(count(text(f.document), /OLD_/g), 10, "older cursor survives compaction");
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
  const f = transcript(0),
    sm = core.SessionManager.inMemory(process.cwd()),
    errors: unknown[] = [],
    presented: TranscriptView[] = [];
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
    assert.equal(count(text(f.document), /REPLY_/g), 5);
    assert(!text(f.document).includes("REPLY_34"));
    assert.equal(f.historyAdds, 40, "all original prompt history is retained");
    assert.equal(presented.at(-1)?.entries.length, 10);
    f.scroll.scrollToStart();
    await tick();
    f.layout();
    assert.equal(count(text(f.document), /REPLY_/g), 10);
    assert.equal(f.historyAdds, 40, "paging does not duplicate input history");
    assert.equal(JSON.stringify(sm.buildSessionContext()), before);
    for (let i = 40; i < 44; i++) sm.appendMessage(assistant(`REPLY_${i}`));
    f.chat.clear();
    f.host.renderSessionEntries(sm.buildContextEntries());
    f.layout();
    assert.equal(
      count(text(f.document), /REPLY_/g),
      14,
      "rebuilds retain loaded pages and new live messages",
    );
    assert.deepEqual(errors, []);
  } finally {
    adapter.dispose();
  }
});
