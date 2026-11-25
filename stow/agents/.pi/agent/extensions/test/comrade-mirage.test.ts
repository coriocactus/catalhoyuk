// Where mirage is loaded, it draws a comrade's calls itself, through shared/nested.ts, so they
// read as Pi's own calls do. Either extension still works without the other.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, render } from "../comrade/tests/fixture.ts";
import { NESTED_ROWS_EVENT, type NestedRowsRequest } from "../shared/nested.ts";
import { fake, type Tool } from "./fake-pi.ts";
import { core, load, themes, tui } from "./pi.ts";

type Result = Awaited<ReturnType<Tool["execute"]>>;
type RenderContext = Parameters<NonNullable<Tool["renderResult"]>>[3];
const { default: installMirage } = await load<typeof import("../mirage/index.ts")>(
  "../mirage/index.ts",
  import.meta.url,
);
const { createTranscripts } = await load<typeof import("../comrade/transcripts.ts")>(
  "../comrade/transcripts.ts",
  import.meta.url,
);

/** A finished comrade's row, opened, as Pi draws it. */
const opened = (tool: Tool, result: Result, task: string) =>
  tool.renderResult?.(
    result,
    { expanded: true, isPartial: false },
    themes.theme,
    fake<RenderContext>({
      args: { task },
      state: {},
      toolCallId: "call",
      isPartial: false,
      expanded: true,
      isError: false,
      durationMs: 1000,
      invalidate() {},
    }),
  );

test("with mirage loaded, a comrade's calls are mirage's rows, which open with a click", async (t) => {
  const { tool, call } = fixture(t, "work", { beside: installMirage });
  const result = await call({ task: "Check the notes", title: "Check notes" });
  const row = opened(tool, result, "Check the notes");
  assert.equal(
    render(row),
    [
      "✓ Comrade #1  Check notes  $0.03 · 1.0s ▾",
      "",
      "  │ Check the notes",
      "",
      "  Chain of thought ▸",
      "",
      "  Reading the notes.",
      "",
      "  ✓ Read 1 file, ran 2 commands ▸",
      "",
      "  All good: the notes read cleanly.",
    ].join("\n"),
  );
  // A click on mirage's group opens it, as on Pi's own rows: a command on its lines, and how a
  // failed one exited.
  assert(row?.handleMouse);
  assert.deepEqual(row.handleMouse({ type: "click", button: "left", x: 4, y: 8 } as never), {
    handled: true,
  });
  assert.match(
    render(row),
    /\n {2}✓ Read 1 file, ran 2 commands ▾\n {4}✓ Read \/tmp\/notes\.md ▸\n {4}\$ cd \/tmp &&\n {8}ls -la ▸\n {4}\$ false \(exit code: 1\) ▸\n/,
  );
});

test("Pi's thinking toggle leaves a comrade's thoughts and its groups as they are", async (t) => {
  const { tool, call } = fixture(t, "work", { beside: installMirage });
  const result = await call({ task: "Check the notes" });
  const row = opened(tool, result, "Check the notes");
  const before = render(row);
  // Ctrl+T: Pi sets each assistant message's visibility and redraws, rendering no tool afresh.
  const toggle = (hidden: boolean) =>
    new core.AssistantMessageComponent(
      fake<ConstructorParameters<typeof core.AssistantMessageComponent>[0]>({
        role: "assistant",
        content: [],
      }),
      !hidden,
    ).setHideThinkingBlock(hidden);
  for (const hidden of [true, false]) {
    toggle(hidden);
    assert.equal(render(row), before, `thinking hidden: ${hidden}`);
  }
});

test("a comrade's titled thought separates its calls in mirage's groups, untitled thinking none", async (t) => {
  const { pi } = fixture(t, "echo", { beside: installMirage });
  const transcripts = createTranscripts(pi.api);
  const read = (id: string, thinking?: string) => [
    {
      role: "assistant",
      content: [
        ...(thinking ? [{ type: "thinking", thinking }] : []),
        { type: "toolCall", id, name: "read", arguments: { path: `/tmp/${id}.ts` } },
      ],
      stopReason: "toolUse",
      timestamp: 0,
    },
    { role: "toolResult", toolCallId: id, toolName: "read", content: [], isError: false },
  ];
  const messages = [
    { role: "user", content: "task" },
    ...read("a"),
    ...read("b", "Musing without a title."),
    ...read("c", "**Checking c**\n\nThe last file.\n\n**Wrapping up**\n\nDone."),
  ] as never[];
  const blocks = transcripts.blocksFor("run", () => messages, "/tmp", themes.theme, false);
  const shown = blocks.map((block) =>
    block.kind === "rows" ? `rows of ${block.calls}` : block.kind === "thinking" ? block.text : "",
  );
  // One thinking block is one piece of the row, however many thoughts it holds.
  assert.deepEqual(shown, [
    "rows of 2",
    "**Checking c**\n\nThe last file.\n\n**Wrapping up**\n\nDone.",
    "rows of 1",
  ]);
});

test("mirage draws a comrade's calls under way once the reply asking for them ends", async (t) => {
  const { pi } = fixture(t, "echo", { beside: installMirage });
  const request: NestedRowsRequest = {};
  pi.events.emit(NESTED_ROWS_EVENT, request);
  assert(request.rows, "mirage answers");
  const transcript = request.rows.transcript("/tmp", () => "⠋");
  const read = (id: string, path: string) => ({
    type: "toolCall" as const,
    id,
    name: "read",
    arguments: { path },
  });
  transcript.add(
    fake<Parameters<typeof transcript.add>[0]>({
      role: "assistant",
      content: [read("a", "/tmp/a.ts"), read("b", "/tmp/b.ts")],
      stopReason: "toolUse",
      timestamp: 0,
    }),
  );
  const row = transcript.row("a", themes.theme);
  assert.equal(transcript.row("b", themes.theme), undefined, "b is in a's group");
  assert.match(tui.stripTerminalSequences(row?.render(80)[0] ?? ""), /^⠋ Exploring 2 files/);
});
