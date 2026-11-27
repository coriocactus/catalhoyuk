// Where prose is loaded, a comrade's rows bound Pi's selection to their text as Pi's own rows do:
// every line marks where its content starts, after the row's indents and the task's bar, and a
// wrapped line's continuations mark how they continue it, so a copy joins them back. Either
// extension still works without the other.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTENT_START, CONTINUES_SPACED, findMarker } from "../shared/selection.ts";
import { load, themes, tui } from "./pi.ts";

const { installProse } = await load<typeof import("../prose/markdown.ts")>(
  "../prose/markdown.ts",
  import.meta.url,
);
const view = await load<typeof import("../comrade/view.ts")>("../comrade/view.ts", import.meta.url);

/** Where each drawn line's marker sits, as the column it marks and what it marks. */
const markers = (lines: string[]) =>
  lines.map((line) => {
    const found = findMarker(line);
    if (!found) return undefined;
    const column = tui.visibleWidth(line.slice(0, found.at));
    return { column, marker: found.marker, text: tui.stripTerminalSequences(line).trim() };
  });

test("with prose loaded, a comrade's wrapped lines mark their content and how they continue", (t) => {
  const release = installProse(() => {});
  t.after(() => release?.());
  const words = (word: string) => Array.from({ length: 30 }, () => word).join(" ");
  const look = {
    phase: "failed" as const,
    task: words("task"),
    title: "Wrap",
    expanded: true,
    note: words("reason"),
    blocks: [{ kind: "thinking" as const, text: `**Planning**\n\n${words("thought")}` }],
  };
  const lines = new view.RowView(look, undefined, "", themes.theme, 0).render(60);
  const marked = markers(lines);
  // Every line with text marks it.
  for (const [i, line] of lines.entries())
    if (tui.stripTerminalSequences(line).trim()) assert(marked[i], JSON.stringify(line));
  const at = (text: string) => marked.filter((each) => each?.text.includes(text));
  // The task: its content starts after the bar, and its continuation lines say they continue it.
  const task = at("task task");
  assert(task.length > 1, "the task wraps");
  assert.deepEqual(task[0], { ...task[0], column: 4, marker: CONTENT_START });
  for (const line of task.slice(1)) assert.equal(line?.marker, CONTINUES_SPACED);
  assert(
    task.slice(1).every((line) => line?.column === 4),
    "after the bar",
  );
  // Why it failed, and its thinking, wrap the same way.
  const reason = at("reason reason");
  assert.equal(reason[0]?.marker, CONTENT_START);
  assert(reason.slice(1).every((line) => line?.marker === CONTINUES_SPACED));
  const thought = at("thought thought");
  assert(thought.length > 1, "the thinking wraps");
  assert(thought.slice(1).every((line) => line?.marker === CONTINUES_SPACED));
  // Its carets are layout: a selection ends before each.
  const screen = tui.TuiAltScreen.prototype as unknown as {
    getSelectionColumns(line: string, row: number, selection: object): { end: number };
  };
  const across = { start: { row: 0, col: 0 }, end: { row: 2, col: 0 } };
  for (const text of ["Comrade"]) {
    const line = lines.find((each) => tui.stripTerminalSequences(each).includes(text)) ?? "";
    const shown = tui.stripTerminalSequences(line).trimEnd();
    assert(shown.endsWith(" ▾"), shown);
    assert.equal(screen.getSelectionColumns(line, 1, across).end, shown.length - 2, text);
  }
});
