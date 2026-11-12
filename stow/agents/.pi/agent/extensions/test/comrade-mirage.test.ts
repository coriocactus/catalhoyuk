// Comrade summarises its comrades' calls in mirage's words and counts, with its own copies
// so the extensions stay independent. These must not drift apart. Where mirage is loaded,
// it draws a comrade's calls itself, through shared/nested.ts.
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

const comrade = await load<typeof import("../comrade/work.ts")>(
  "../comrade/work.ts",
  import.meta.url,
);
const comradeView = await load<typeof import("../comrade/view.ts")>(
  "../comrade/view.ts",
  import.meta.url,
);
const mirage = await load<typeof import("../mirage/view.ts")>("../mirage/view.ts", import.meta.url);
const comradeColours = await load<typeof import("../comrade/colours.ts")>(
  "../comrade/colours.ts",
  import.meta.url,
);
const mirageColours = await load<typeof import("../mirage/colours.ts")>(
  "../mirage/colours.ts",
  import.meta.url,
);
const mirageStyle = await load<typeof import("../mirage/style.ts")>(
  "../mirage/style.ts",
  import.meta.url,
);

test("comrade counts diffs and written lines as mirage does", () => {
  for (const diff of ["", "+ 1 a\n- 2 b\n  3 c\n+12 d", "-  9 x\n+ 10 y\n+ 11 z", "+x\n-y"])
    assert.deepEqual(comrade.diffCounts(diff), mirage.diffCounts(diff), JSON.stringify(diff));
  for (const content of ["", "one", "one\n", "one\ntwo", "one\ntwo\n\n"])
    assert.equal(
      comrade.writtenLines(content),
      mirage.writtenLines(content),
      JSON.stringify(content),
    );
});

test("comrade formats durations as mirage and Pi do", () => {
  for (const ms of [0, 1234, 59_949, 60_000, 754_000, 3_600_000, 3_725_000])
    assert.equal(comradeView.formatDuration(ms), mirage.formatDuration(ms), String(ms));
});

test("comrade paints its green and red as mirage does", () => {
  assert.equal(comradeColours.colours.green, mirageColours.colours.green);
  assert.equal(comradeColours.colours.red, mirageColours.colours.red);
  for (const mode of ["truecolor", "256color"] as const) {
    const theme = { getColorMode: () => mode } as Parameters<typeof mirageStyle.paint>[0];
    for (const tone of ["green", "red"] as const)
      assert.equal(
        comradeColours.paint(theme, tone, "✓"),
        mirageStyle.paint(theme, tone, "✓"),
        `${tone} in ${mode}`,
      );
  }
});

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
      "  The notes come first.",
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

test("Pi's thinking toggle shows and hides a comrade's thinking in rows already drawn", async (t) => {
  const { tool, call } = fixture(t, "work", { beside: installMirage });
  const result = await call({ task: "Check the notes" });
  const row = opened(tool, result, "Check the notes");
  assert(render(row).includes("The notes come first."));
  // Ctrl+T: Pi sets each assistant message's visibility and redraws, rendering no tool afresh.
  const toggle = (hidden: boolean) =>
    new core.AssistantMessageComponent(
      fake<ConstructorParameters<typeof core.AssistantMessageComponent>[0]>({
        role: "assistant",
        content: [],
      }),
      !hidden,
    ).setHideThinkingBlock(hidden);
  toggle(true);
  assert(!render(row).includes("The notes come first."));
  toggle(false);
  assert(render(row).includes("The notes come first."));
});

test("with mirage loaded, a comrade's thinking follows Pi's setting from the start", async (t) => {
  const { tool, call } = fixture(t, "work", {
    beside: installMirage,
    settings: { hideThinkingBlock: true },
  });
  const shown = render(opened(tool, await call({ task: "Check the notes" }), "Check the notes"));
  assert(!shown.includes("The notes come first."));
  assert(shown.includes("Reading the notes."));
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
