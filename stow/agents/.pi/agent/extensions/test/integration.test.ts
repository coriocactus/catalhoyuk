// mirage × rearview: grouped tool rows inside lazily prepended history pages.
// These interact through shared/ contracts, so they are tested together here.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import { TRANSCRIPT_VIEW } from "../shared/transcript.ts";
import { fakePi } from "./fake-pi.ts";
import { core, load, tui } from "./pi.ts";
import { assistant, bindTools, nativeRenderEntries, text, tick, transcript } from "./transcript.ts";

const { default: installDisplay } = await load<typeof import("../mirage/index.ts")>(
  "../mirage/index.ts",
  import.meta.url,
);
const { installHistoryAdapter, renderHistoryPage } = await load<
  typeof import("../rearview/native.ts")
>("../rearview/native.ts", import.meta.url);

type NativeHost = Parameters<typeof renderHistoryPage>[0];
type NativeRender = Parameters<typeof renderHistoryPage>[2];

test("bounded pages share one growing group, preserving loaded rows and global expansion", async () => {
  const pi = fakePi(),
    errors: unknown[] = [];
  installDisplay(pi.api);
  // Mirage only draws: Pi keeps executing its own tools, and history never executes any.
  assert.equal(pi.tools.size, 0);
  const f = transcript(0),
    sm = core.SessionManager.inMemory(process.cwd());
  f.host.sessionManager = sm;
  bindTools(f.host, pi.renderers);
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
    (view) => pi.events.emit(TRANSCRIPT_VIEW, view),
  );
  try {
    f.host.renderSessionEntries(sm.buildContextEntries());
    f.layout();
    assert.match(text(f.document), /Explored 5 files/);
    assert(!text(f.document).includes("Explored 30 files"));
    f.scroll.scrollToStart();
    await tick();
    f.layout();
    assert.equal(text(f.document).match(/Explored 10 files/g)?.length, 1);
    assert(!text(f.document).includes("Explored 5 files"));
    for (const padding of [1, 0, 1]) {
      f.host.outputPad = padding;
      const headers = text(f.document)
        .split("\n")
        .filter((line) => line.includes("Explored 10 files"));
      assert.equal(headers.length, 1);
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
    // Every explicit trip loads one bounded page, even inside an arbitrarily long run.
    for (const count of [15, 20, 25, 30]) {
      f.scroll.scrollToStart();
      await tick();
      f.layout();
      assert.equal(text(f.document).match(new RegExp(`Explored ${count} files`, "g"))?.length, 1);
      assert.equal(text(f.document).match(/BODY_/g)?.length, count);
    }
    f.chat.clear();
    f.host.renderSessionEntries(sm.buildContextEntries());
    f.layout();
    assert.match(text(f.document), /Explored 30 files/);
    assert.equal(
      text(f.document).match(/BODY_/g)?.length,
      30,
      "reconstruction retains loaded pages",
    );
    assert.deepEqual(errors, []);
  } finally {
    adapter.dispose();
    pi.emit("session_shutdown", { reason: "quit" });
  }
});

test("a merge across pages keeps its header at the viewport top through expansion and rebuilds", async () => {
  const pi = fakePi(),
    errors: unknown[] = [];
  installDisplay(pi.api);
  const f = transcript(0),
    sm = core.SessionManager.inMemory(process.cwd());
  f.host.sessionManager = sm;
  bindTools(f.host, pi.renderers);
  for (let i = 0; i < 12; i++) sm.appendMessage(assistant(`BEFORE_${i}`));
  // One run of 8 calls; pages of 10 split it 4 | 4.
  for (let i = 0; i < 8; i++) {
    const name = i % 2 ? "bash" : "read",
      id = `run-${i}`;
    sm.appendMessage(
      assistant("", [
        { type: "toolCall", id, name, arguments: { path: `run-${i}.txt`, command: `echo ${i}` } },
      ]),
    );
    sm.appendMessage({
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: [{ type: "text", text: `RUN_BODY_${i}` }],
      isError: false,
      timestamp: 1,
    });
  }
  for (let i = 0; i < 12; i++) sm.appendMessage(assistant(`AFTER_${i}`));
  const adapter = installHistoryAdapter(
    (error) => errors.push(error),
    10,
    (view) => pi.events.emit(TRANSCRIPT_VIEW, view),
  );
  const height = 12;
  const viewport = () =>
    f.document
      .render(100)
      .map((line) => tui.stripTerminalSequences(line).trim())
      .slice(f.scroll.scrollTop, f.scroll.scrollTop + height);
  const load = async () => {
    f.scroll.scrollToStart();
    await tick();
    f.layout(height);
  };
  try {
    f.host.renderSessionEntries(sm.buildContextEntries());
    f.layout(height);
    await load();
    assert.match(text(f.document), /Read 2 files, ran 2 commands/);
    f.scroll.scrollToStart();
    assert.match(viewport().join("\n"), /^\n?✓ Read 2 files, ran 2 commands ▸/, "page top");
    await tick();
    f.layout(height);
    const header = "✓ Read 4 files, ran 4 commands ▸";
    assert.equal(text(f.document).match(/Read \d files, ran \d commands/g)?.length, 1);
    assert(viewport().slice(0, 2).includes(header), "the merged header replaces the old top");
    assert(!viewport().includes("BEFORE_11"), "older rows remain above the viewport");
    // Expanding the merged group must not scroll its header away.
    f.host.loadedResourcesContainer = new tui.Container();
    f.host.builtInHeader = new tui.Container();
    f.host.showStatus = () => {};
    f.host.setToolsExpanded(true);
    f.layout(height);
    assert(viewport().slice(0, 2).includes(header.replace("▸", "▾")), "expanded header stays");
    assert(viewport().some((line) => line.includes("run-0.txt")));
    // Pi rebuilds the chat for idle settings changes; rows and position survive.
    f.chat.clear();
    f.host.renderSessionEntries(sm.buildContextEntries());
    f.layout(height);
    assert(viewport().slice(0, 2).includes(header.replace("▸", "▾")), "rebuild keeps the anchor");
    assert.equal(text(f.document).match(/RUN_BODY_/g)?.length, 8);
    assert.deepEqual(errors, []);
  } finally {
    adapter.dispose();
    pi.emit("session_shutdown", { reason: "quit" });
  }
});

test("a failed page construction rolls back its staged rows and leaves mounted groups intact", async () => {
  const pi = fakePi(),
    errors: unknown[] = [];
  installDisplay(pi.api);
  const f = transcript(0),
    sm = core.SessionManager.inMemory(process.cwd());
  f.host.sessionManager = sm;
  let fail = false;
  bindTools(f.host, (name, base) => {
    if (fail) throw new Error("PAGE_CONSTRUCTION_FAILED");
    return pi.renderers(name, base);
  });
  for (let i = 0; i < 12; i++) sm.appendMessage(assistant(`BEFORE_${i}`));
  for (let i = 0; i < 8; i++) {
    const id = `run-${i}`;
    sm.appendMessage(
      assistant("", [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.txt` } }]),
    );
    sm.appendMessage({
      role: "toolResult",
      toolCallId: id,
      toolName: "read",
      content: [{ type: "text", text: id }],
      isError: false,
      timestamp: 1,
    });
  }
  for (let i = 0; i < 12; i++) sm.appendMessage(assistant(`AFTER_${i}`));
  const adapter = installHistoryAdapter(
    (error) => errors.push(error),
    10,
    (view) => pi.events.emit(TRANSCRIPT_VIEW, view),
  );
  try {
    f.host.renderSessionEntries(sm.buildContextEntries());
    f.layout();
    f.scroll.scrollToStart();
    await tick();
    f.layout();
    assert.match(text(f.document), /Explored 4 files/);
    const before = text(f.document);
    fail = true;
    f.scroll.scrollToStart();
    await tick();
    f.layout();
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /PAGE_CONSTRUCTION_FAILED/);
    // Committing rows without their page would hide this header behind a missing leader.
    assert.equal(text(f.document), before, "mounted groups are unchanged");
    fail = false;
    f.chat.clear();
    f.host.renderSessionEntries(sm.buildContextEntries());
    f.layout();
    assert.match(text(f.document), /Explored 4 files/, "a rebuild sees only loaded pages");
    assert(!text(f.document).includes("Explored 8 files"));
  } finally {
    adapter.dispose();
    pi.emit("session_shutdown", { reason: "quit" });
  }
});

test("archived mixed groups follow thinking visibility without moving commentary or editing history", () => {
  const pi = fakePi();
  installDisplay(pi.api);
  const f = transcript(0);
  bindTools(f.host, pi.renderers);
  const archive = core.SessionManager.inMemory(process.cwd());
  for (const [id, name, prefix] of [
    ["a", "read", { type: "thinking", thinking: "ARCHIVED_REASONING_A" }],
    ["b", "write", { type: "thinking", thinking: "ARCHIVED_REASONING_B" }],
    ["c", "bash", { type: "text", text: "COMMENTARY_BOUNDARY" }],
  ] as const) {
    archive.appendMessage(
      assistant("", [
        prefix,
        { type: "toolCall", id, name, arguments: { path: `${id}.txt`, command: "echo c" } },
      ]),
    );
    archive.appendMessage({
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: [{ type: "text", text: `RESULT_${id}` }],
      isError: false,
      timestamp: 1,
    });
  }
  const entries = archive.getEntries();
  const snapshot = JSON.stringify(entries);
  try {
    const page = renderHistoryPage(
      f.host as unknown as NativeHost,
      entries,
      nativeRenderEntries as NativeRender,
    );
    assert.match(text(page), /Read 1 file, wrote 1 file/);
    assert(!text(page).includes("ARCHIVED_REASONING") && !text(page).includes("Thinking"));
    assert(text(page).indexOf("COMMENTARY_BOUNDARY") > text(page).indexOf("wrote 1 file"));
    assert(text(page).indexOf("echo c") > text(page).indexOf("COMMENTARY_BOUNDARY"));
    for (const hidden of [false, true, false, true]) {
      for (const child of page.children) {
        if (child instanceof core.AssistantMessageComponent) child.setHideThinkingBlock(hidden);
      }
      const output = text(page);
      assert.equal(output.includes("Read 1 file, wrote 1 file"), hidden);
      assert.equal(output.includes("ARCHIVED_REASONING_B"), !hidden);
      if (!hidden) {
        assert(output.indexOf("Read a.txt") < output.indexOf("ARCHIVED_REASONING_B"));
        assert(output.indexOf("Wrote b.txt") > output.indexOf("ARCHIVED_REASONING_B"));
      }
    }
    assert.equal(JSON.stringify(entries), snapshot);
  } finally {
    pi.emit("session_shutdown");
  }
});

for (const name of ["read", "edit"]) {
  test(`archived ${name} groups never execute or merge into live pending tools`, async () => {
    const pi = fakePi();
    installDisplay(pi.api);
    const f = transcript(0);
    bindTools(f.host, pi.renderers);
    const live = new core.ToolExecutionComponent(
      name,
      "live-tool",
      { path: "live.txt" },
      {},
      pi.renderers(name),
      f.host.ui as unknown as TUI,
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
      const page = renderHistoryPage(
        f.host as unknown as NativeHost,
        archive.getEntries(),
        nativeRenderEntries as NativeRender,
      );
      assert.match(text(page), name === "edit" ? /Edited 2 files \(\+2 −2\)/ : /Explored 2 files/);
      assert.equal(text(live), before);
      assert.equal(f.host.pendingTools, pending);
      assert.equal(f.host.pendingTools.size, 1);
      assert.equal(JSON.stringify(f.sm.buildSessionContext()), context);
      assert.equal(f.historyAdds, 0);
      assert.equal(text(f.chat), "");
    } finally {
      pi.emit("session_shutdown");
    }
  });
}

test("archived scripts list their saved calls and keep their run across store() entries", () => {
  const pi = fakePi();
  installDisplay(pi.api);
  const f = transcript(0);
  bindTools(f.host, pi.renderers);
  const archive = core.SessionManager.inMemory(process.cwd());
  archive.appendMessage(
    assistant("", [
      { type: "toolCall", id: "script", name: "codemode", arguments: { code: "return 1;" } },
    ]),
  );
  archive.appendCustomEntry("codemode-store", { set: { key: 1 }, delete: [] });
  archive.appendMessage({
    role: "toolResult",
    toolCallId: "script",
    toolName: "codemode",
    content: [
      { type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
      { type: "text", text: "ARCHIVED_SCRIPT_OUTPUT" },
    ],
    details: { calls: [] },
    nestedCalls: {
      complete: true,
      calls: [
        { id: "script/1", name: "read", arguments: { path: "inside.txt" }, status: "ok" },
        { id: "script/2", name: "bash", arguments: { command: "echo inside" }, status: "ok" },
      ],
    },
    isError: false,
    timestamp: 1,
  });
  archive.appendMessage(
    assistant("", [
      { type: "toolCall", id: "after", name: "read", arguments: { path: "after.txt" } },
    ]),
  );
  archive.appendMessage({
    role: "toolResult",
    toolCallId: "after",
    toolName: "read",
    content: [{ type: "text", text: "AFTER" }],
    isError: false,
    timestamp: 1,
  });
  const entries = archive.getEntries();
  const snapshot = JSON.stringify(entries);
  try {
    const page = renderHistoryPage(
      f.host as unknown as NativeHost,
      entries,
      nativeRenderEntries as NativeRender,
    );
    assert.match(text(page), /✓ Read 2 files, ran 1 command ▸/);
    assert(!text(page).includes("ARCHIVED_SCRIPT_OUTPUT"), "archived scripts start collapsed");
    assert.equal(JSON.stringify(entries), snapshot, "history pages never edit entries");
  } finally {
    pi.emit("session_shutdown");
  }
});
