// mirage × rearview: grouped tool rows inside lazily prepended history pages.
// These interact through shared/ contracts, so they are tested together here.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TUI } from "@earendil-works/pi-tui";
import { TRANSCRIPT_VIEW } from "../shared/transcript.ts";
import { fakePi, type Tool } from "./fake-pi.ts";
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

test("initial tool groups contain only displayed calls, while older pages keep independent leaders", async () => {
  const pi = fakePi(),
    errors: unknown[] = [];
  let executions = 0;
  installDisplay(pi.api);
  const tools = new Map<string, Tool>(
    [...pi.tools].map(([name, tool]) => [
      name,
      {
        ...tool,
        async execute() {
          executions++;
          throw new Error("History must never execute tools.");
        },
      },
    ]),
  );
  const f = transcript(0),
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
    assert.equal(text(f.document).match(/Explored 5 files/g)?.length, 2);
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
    pi.emit("session_shutdown", { reason: "quit" });
  }
});

for (const name of ["read", "edit"]) {
  test(`archived ${name} groups never execute or merge into live pending tools`, async () => {
    const pi = fakePi();
    installDisplay(pi.api);
    const f = transcript(0);
    bindTools(f.host, pi.tools);
    const live = new core.ToolExecutionComponent(
      name,
      "live-tool",
      { path: "live.txt" },
      {},
      pi.tools.get(name),
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
      assert.match(text(page), name === "edit" ? /Edited 2 files \+2 −2/ : /Explored 2 files/);
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
