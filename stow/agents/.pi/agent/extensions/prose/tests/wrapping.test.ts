import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { CONTINUES_JOINED, CONTINUES_SPACED } from "../../shared/selection.ts";
import { load, tui } from "../../test/pi.ts";

const { installProse, wrapLine } = await load<typeof import("../markdown.ts")>(
  "../markdown.ts",
  import.meta.url,
);

function installed(t: TestContext) {
  const notes: string[] = [];
  t.after(installProse((message) => notes.push(message)));
  assert.deepEqual(notes, []);
}
/** Pi's own selection over these lines, from the first line's start to the end of the last. */
const copy = (lines: string[]) =>
  (
    Object.assign(Object.create(tui.TuiAltScreen.prototype), {
      selectionAnchor: { row: 0, col: 0 },
      selectionFocus: { row: lines.length - 1, col: 200 },
      previousScreen: lines,
    }) as { getActiveSelectionText(): string | undefined }
  ).getActiveSelectionText();

const BOLD = "\x1b[1m";
const UNBOLD = "\x1b[22m";
const LINK = "https://example.com/abc";
const OPEN = `\x1b]8;;${LINK}\x1b\\`;
const CLOSE = "\x1b]8;;\x1b\\";

test("a line styled before its indent keeps its style to its end, and no further", (t) => {
  installed(t);
  const line = `${BOLD}    bold indented long line that will need to wrap around the width${UNBOLD}`;
  const lines = wrapLine(line, 30);
  assert(lines.length > 2);
  for (const continued of lines.slice(1))
    assert(continued.startsWith(`    ${CONTINUES_SPACED}${BOLD}`), JSON.stringify(continued));
  assert(lines.at(-1)?.endsWith(UNBOLD), "the last line still ends the bold");
  assert.equal(copy(lines), tui.stripTerminalSequences(line));
  // In plain text the next line is not bold.
  const text = new tui.Text(`${line}\nplain next line`, 0, 0).render(30);
  assert(!text.at(-1)?.includes(BOLD), JSON.stringify(text.at(-1)));
  // A link that ends such a line is closed there, before any padding that a background adds.
  const linked = wrapLine(
    `\x1b[2m    an indented line long enough to wrap, then ${OPEN}${LINK}${CLOSE}`,
    40,
  );
  assert(linked.at(-1)?.endsWith(`${LINK}${CLOSE}`), JSON.stringify(linked.at(-1)));
});

test("a line too narrow to hang under its indent wraps whole and copies whole", (t) => {
  installed(t);
  for (const [line, width, prefix] of [
    ["    word a word", 12, ""],
    ["  bb  漢字かな ｆｕｌｌ 日本語", 15, "  "],
  ] as const) {
    const lines = wrapLine(line, width, prefix);
    assert(lines.length > 1, line);
    assert.equal(copy(lines), line);
  }
  // pi-tui drops a no-break space at a wrap, but keeps the space after it. The next break is
  // inside a word.
  const kept = wrapLine("  e-f a  x.y/z 日本語 漢 tab \u00a0 漢 x.y/z  日本語", 16);
  assert.equal(tui.stripTerminalSequences(kept[2] ?? ""), "   漢 x.y/z  日");
  assert(kept[3]?.includes(`${CONTINUES_JOINED}本語`), JSON.stringify(kept[3]));
});

test("a wrap that leaves a line of codes alone keeps the space it dropped", (t) => {
  installed(t);
  // Underlined, a wrap at the space, then a word too long for any line.
  const line = "\x1b[4maaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbb\x1b[24m";
  const lines = wrapLine(line, 10);
  assert(
    lines.some((piece) => tui.stripTerminalSequences(piece) === ""),
    "a line of codes",
  );
  assert.equal(copy(lines), "aaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbb");
});

test("a style open across a line break is open again on the next line", (t) => {
  installed(t);
  const link = wrapLine(
    `See ${OPEN}\x1b[34ma link whose text\ncontinues here\x1b[39m${CLOSE} tail`,
    80,
  );
  assert.equal(link.length, 2);
  assert(link[1].includes(`\x1b[34m${OPEN}continues here`), JSON.stringify(link[1]));
  // CRLF and a lone CR still break lines.
  assert.deepEqual(wrapLine("one\r\ntwo\rthree", 10).map(tui.stripTerminalSequences), [
    "one",
    "two",
    "three",
  ]);
  // A soft break inside bold Markdown, as Pi's own wrapping draws it.
  const theme = new Proxy({} as MarkdownTheme, {
    get: (_, key) =>
      key === "highlightCode" || key === "codeBlockIndent"
        ? undefined
        : key === "bold"
          ? (text: string) => `${BOLD}${text}${UNBOLD}`
          : (text: string) => text,
  });
  const lines = new tui.Markdown("Intro **bold start\nbold end** tail", 0, 0, theme).render(40);
  assert(lines[1].includes(`${BOLD}bold end${UNBOLD}`), JSON.stringify(lines[1]));
});
