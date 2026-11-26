import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { paint } from "../../shared/colours.ts";
import {
  CONTENT_END,
  CONTENT_START,
  CONTINUES_JOINED,
  CONTINUES_SPACED,
} from "../../shared/selection.ts";
import { core, load, tui } from "../../test/pi.ts";

const { installProse, wrapLine } = await load<typeof import("../markdown.ts")>(
  "../markdown.ts",
  import.meta.url,
);

const lang: (string | undefined)[] = [];
/** Styles nothing. With `highlight`, highlighting is recorded and marked with angle brackets. */
const themed = (highlight: boolean) =>
  new Proxy({} as MarkdownTheme, {
    get: (_, key) => {
      if (key === "codeBlockIndent") return "    ";
      if (key === "highlightCode")
        return highlight
          ? (code: string, language?: string) => {
              lang.push(language);
              return code.split("\n").map((line) => `<${line}>`);
            }
          : undefined;
      return (text: string) => text;
    },
  });
const theme = themed(true);
const unstyled = themed(false);

function installed(t: TestContext) {
  const notes: string[] = [];
  const release = installProse((message) => notes.push(message));
  t.after(release);
  return notes;
}
const render = (
  text: string,
  width = 40,
  style?: { bgColor: (text: string) => string },
  with_ = theme,
) => new tui.Markdown(text, 0, 0, with_, style).render(width);
const plain = (lines: readonly string[]) =>
  lines.map((line) => tui.stripTerminalSequences(line).trimEnd());

type Screen = {
  getLineSelection(point: { row: number; col: number }): {
    start: { row: number; col: number };
    end: { row: number; col: number };
  };
  getSelectionColumns(
    line: string,
    row: number,
    selection: object,
    min?: number,
    max?: number,
  ): { start: number; end: number };
  getActiveSelectionText(): string | undefined;
};
/** Pi's own selection over these rendered rows, from the first row's start to `focus`. */
const copy = (lines: readonly string[], focus = { row: lines.length - 1, col: 200 }) =>
  (
    Object.assign(Object.create(tui.TuiAltScreen.prototype), {
      selectionAnchor: { row: 0, col: 0 },
      selectionFocus: focus,
      previousScreen: lines,
    }) as Screen
  ).getActiveSelectionText();
const columns = tui.TuiAltScreen.prototype as unknown as Screen;

test("code blocks have no fence lines, keep their language's highlighting, and are indented", (t) => {
  assert.deepEqual(installed(t), []);
  lang.length = 0;
  const lines = render("Before\n\n```zsh\nprompt() {\n  local x\n}\n```\n\nAfter");
  assert.deepEqual(plain(lines), [
    "Before",
    "",
    "    <prompt() {>",
    "    <  local x>",
    "    <}>",
    "",
    "After",
  ]);
  assert.deepEqual(lang, ["zsh"]);
  // The code's content starts after the indent.
  assert(lines[2].startsWith(`    ${CONTENT_START}`));
});

test("code nested in lists and quotes loses its fences too", (t) => {
  installed(t);
  for (const text of ["- item\n\n  ```js\n  x\n  ```", "> ```js\n> x\n> ```"])
    assert(!plain(render(text)).some((line) => line.includes("```")), text);
});

test("wrapped lines keep their indent", (t) => {
  installed(t);
  const code = render(
    "```js\n  const value = someFunction(argumentOne, argumentTwo)\n```",
    30,
    undefined,
    unstyled,
  );
  assert.deepEqual(plain(code), [
    "      const value =",
    // Too wide for its row, so pi-tui breaks inside it. The copy puts it back together.
    "      someFunction(argumentOne",
    "      , argumentTwo)",
  ]);
  const list = render("- an item with enough words to wrap twice over here", 20);
  assert.deepEqual(plain(list), [
    "- an item with",
    "  enough words to",
    "  wrap twice over",
    "  here",
  ]);
});

test("lines end at their text, unless a background must reach the edge", (t) => {
  installed(t);
  assert.deepEqual(plain(render("Short line", 40)), ["Short line"]);
  assert.equal(tui.visibleWidth(render("Short line", 40)[0]), "Short line".length);
  const filled = render("Short line", 40, { bgColor: (text) => text });
  assert.equal(tui.visibleWidth(filled[0]), 40);
});

test("every selection row ends at its text and starts at its content", (t) => {
  installed(t);
  const across = { start: { row: 0, col: 0 }, end: { row: 2, col: 3 } };
  // Padding and backgrounds are not selected, on any row, marked or not.
  assert.deepEqual(columns.getSelectionColumns("  plain text      ", 1, across), {
    start: 0,
    end: 12,
  });
  // A code line from after its indent, keeping the code's own indentation.
  const code = `    ${CONTENT_START}  local x`;
  assert.deepEqual(columns.getSelectionColumns(code, 1, across), { start: 4, end: 13 });
  assert.equal(columns.getSelectionColumns(code, 0, across).start, 4, "starting in the indent");
  const ends = { start: { row: 0, col: 0 }, end: { row: 1, col: 2 } };
  const last = columns.getSelectionColumns(code, 1, ends);
  assert(last.end <= last.start, "ending in the indent selects nothing on that row");
  // A wrapped row from after its hanging indent.
  assert.equal(columns.getSelectionColumns(`  ${CONTINUES_SPACED}more`, 1, across).start, 2);
  // A blank row selects nothing.
  const blank = columns.getSelectionColumns("          ", 1, across);
  assert(blank.end <= blank.start);
});

test("a selection ends where a line marks its content's end, before its caret", (t) => {
  installed(t);
  const across = { start: { row: 0, col: 0 }, end: { row: 2, col: 0 } };
  const row = `${CONTENT_START}✓ Ran 2 commands${CONTENT_END} ▸`;
  assert.deepEqual(columns.getSelectionColumns(row, 1, across), { start: 0, end: 16 });
  assert.equal(copy([row]), "✓ Ran 2 commands");
  // A caret too narrow to have its line's end marked is selected as Pi selects it.
  assert.equal(copy(["✓ Ran 2 commands ▸"]), "✓ Ran 2 commands ▸");
});

test("inline code is bold in the terminal's yellow, and headings in its cyan", (t) => {
  installed(t);
  const bold = (text: string) => `<b>${text}</b>`;
  const themedBold = new Proxy({} as MarkdownTheme, {
    get: (_, key) =>
      key === "bold"
        ? bold
        : key === "highlightCode" || key === "codeBlockIndent"
          ? undefined
          : (text: string) => text,
  });
  const markdown = (text: string) => new tui.Markdown(text, 0, 0, themedBold).render(40)[0] ?? "";
  assert(markdown("Run `jj status` now").includes(bold(paint(undefined, "yellow", "jj status"))));
  // Headings keep Pi's bold, in the terminal's cyan.
  assert(markdown("## Fixed").includes(paint(undefined, "sky", bold("Fixed"))));
});

test("list markers, bulleted and numbered, take the text's colour", (t) => {
  installed(t);
  const marked = new Proxy({} as MarkdownTheme, {
    get: (_, key) =>
      key === "listBullet"
        ? (text: string) => `<${text}>`
        : key === "highlightCode" || key === "codeBlockIndent"
          ? undefined
          : (text: string) => text,
  });
  const lines = new tui.Markdown("- one\n- two\n\n1. first\n2. second", 0, 0, marked).render(40);
  assert.deepEqual(plain(lines), ["- one", "- two", "", "1. first", "2. second"]);
  assert(!lines.some((line) => line.includes("<")), "no colour of the theme's own");
});

test("a user message shows as typed: a green bar beside green italic text, no background", (t) => {
  let release: (() => void) | undefined = installProse(() => {});
  t.after(() => release?.());
  const message = (text: string, pad = 1) =>
    new core.UserMessageComponent(text, unstyled, pad).render(40);
  const lines = message("First line\n\nSecond paragraph");
  // The bar beside every line, the blank one between paragraphs too. Pi puts the blank lines
  // around the message.
  assert.deepEqual(plain(lines), [" ┃ First line", " ┃", " ┃ Second paragraph"]);
  assert(lines[0].includes(paint(undefined, "moss", "┃")), "a green bar");
  // Green italic text, one span to the line's end.
  const green = paint(undefined, "moss", "").split("\x1b[39m")[0];
  assert(lines[0].includes(`\x1b[3m${green}`), "green italic");
  assert(lines[0].endsWith("First line\x1b[39m\x1b[23m"), "one span to the line's end");
  assert(tui.visibleWidth(lines[0]) < 40, "no background reaching the edge");
  // The bar is layout: a selection starts after it, and a copy has the text alone.
  const across = { start: { row: 0, col: 0 }, end: { row: 2, col: 0 } };
  assert.equal(columns.getSelectionColumns(lines[0], 1, across).start, 3);
  assert.equal(copy(lines), "First line\n\nSecond paragraph");
  // Pi's output padding comes before the bar.
  assert.deepEqual(plain(message("x", 0)), ["┃ x"]);
  // No Markdown: what was typed shows, marks, indents and all, in nothing but the green.
  const typed = message(
    "# Heading\n**bold** `code` [a](b)\n- one\n    indented\n```ts\nconst x = 1;\n```",
    1,
  );
  assert.deepEqual(plain(typed), [
    " ┃ # Heading",
    " ┃ **bold** `code` [a](b)",
    " ┃ - one",
    " ┃     indented",
    " ┃ ```ts",
    " ┃ const x = 1;",
    " ┃ ```",
  ]);
  for (const line of typed) {
    const colours = line.split("\x1b[38;5;").slice(1);
    assert(
      colours.every((colour) => colour.startsWith("2m")),
      JSON.stringify(line),
    );
    assert(!line.includes("\x1b[1m"), "nothing bold");
  }
  // A long line wraps beside the bar, and a copy joins it back.
  const long = "a long message that wraps across more than one row of the transcript";
  const wrapped = message(long);
  assert(wrapped.length > 1 && plain(wrapped).every((line) => line.startsWith(" ┃ ")));
  assert.equal(copy(wrapped), long);
  release();
  release = undefined;
  // Pi's own user message is back, padded: its background reaches the edge.
  assert.equal(tui.visibleWidth(message("x")[1] ?? ""), 40);
});

test("a copy joins wrapped rows back into their lines", (t) => {
  installed(t);
  const sentence = "The quick brown fox jumps over the lazy dog and keeps running far away";
  assert.equal(copy(render(sentence, 20)), sentence);
  // Inside a word there is nothing to put back.
  assert.equal(copy(render("aaaaaaaaaaaaaaaaaaaaaaaaa bb", 10)), "aaaaaaaaaaaaaaaaaaaaaaaaa bb");
  const item = "- an item with enough words to wrap twice over here";
  assert.equal(copy(render(item, 20)), item);
  const line = "  const value = someFunction(argumentOne, argumentTwo)";
  assert.equal(copy(render(`\`\`\`js\n${line}\n\`\`\``, 30, undefined, unstyled)), line);
  // Separate lines and paragraphs stay separate.
  assert.equal(copy(render("One short.\n\nTwo short.", 40)), "One short.\n\nTwo short.");
  // Rows without markers copy as Pi copies them.
  assert.equal(copy(["first   ", `  ${CONTINUES_JOINED}second`]), "firstsecond");
  assert.equal(copy(["one  ", "two"]), "one\ntwo");
});

test("installs are shared and released in full, and Pi's rendering comes back", () => {
  const before = render("```js\nx\n```");
  assert.equal(plain(before)[0], "```js", "Pi's own rendering before");
  const first = installProse(() => {});
  const second = installProse(() => {});
  first();
  assert(!plain(render("```js\nx\n```")).includes("```js"), "still installed for the second");
  second();
  assert.deepEqual(plain(render("```js\nx\n```")), plain(before));
  assert.equal(copy(["one  ", "  two"]), "one\n  two", "Pi's own copy is back");
});

test("a Markdown renderer of an unexpected shape is left alone, with one warning", (t) => {
  const prototype = tui.Markdown.prototype as unknown as { render(width: number): string[] };
  const original = prototype.render;
  prototype.render = () => ["something else"];
  t.after(() => {
    prototype.render = original;
  });
  const notes = installed(t);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Markdown code blocks changed\. prose left Pi's own Markdown\./);
  assert.equal(prototype.render.call(new tui.Markdown("x", 0, 0, theme), 10)[0], "something else");
});

test("plain text wraps under its indent, starts after its margin, and copies whole", (t) => {
  installed(t);
  const output = new tui.Text("short\n    indented output that is long enough to wrap", 1, 0);
  const lines = output.render(24);
  assert.deepEqual(plain(lines), [
    " short",
    "     indented output",
    "     that is long",
    "     enough to wrap",
  ]);
  assert.equal(copy(lines), "short\n    indented output that is long enough to wrap");
  // The margin is layout: a row starts at its content.
  const across = { start: { row: 0, col: 0 }, end: { row: 3, col: 30 } };
  assert.equal(columns.getSelectionColumns(lines[0], 1, across).start, 1);
  // Pi's cache still works, and new text still renders anew.
  assert.equal(output.render(24), lines);
  output.setText("changed");
  assert.deepEqual(plain(output.render(24)), [" changed"]);
});

test("a triple-click selects the whole wrapped line", (t) => {
  installed(t);
  const lines = [
    ...render("One short.\n\nThe quick brown fox jumps over the lazy dog again", 20),
    "next",
  ];
  const probe = Object.assign(Object.create(tui.TuiAltScreen.prototype), {
    previousScreen: lines,
  }) as Screen;
  // Clicking the middle row of the wrapped paragraph.
  const range = probe.getLineSelection({ row: 3, col: 2 });
  assert.deepEqual([range.start.row, range.end.row], [2, 4]);
  // A line that did not wrap selects as before.
  assert.deepEqual([probe.getLineSelection({ row: 0, col: 1 }).end.row], [0]);
});

test("line breaks inside a wrapped line stay line breaks in a copy", (t) => {
  installed(t);
  // A soft break and a hard break, each in a paragraph too wide for its row.
  const soft = "a first line that wraps around\nsecond line";
  assert.equal(copy(render(soft, 12)), soft);
  assert.equal(copy(render("a first line that wraps around  \nsecond line", 12)), soft);
  // CRLF output in plain text.
  assert.deepEqual(plain(new tui.Text("one\r\ntwo\rthree", 0, 0).render(10)), [
    "one",
    "two",
    "three",
  ]);
});

test("a highlight stops before the scrollbar, and a narrow wrap still fits", (t) => {
  installed(t);
  const across = { start: { row: 0, col: 0 }, end: { row: 2, col: 3 } };
  assert.equal(columns.getSelectionColumns("text     │", 1, across, 0, 10).end, 4);
  assert.equal(columns.getSelectionColumns("text     ┃", 1, across, 0, 10).end, 4);
  // Copies read content lines, which have no scrollbar, and keep a real trailing bar.
  assert.equal(columns.getSelectionColumns("a | b    │", 1, across).end, 10);
  // Too narrow to hang under its indent, a line wraps whole, and every row fits.
  for (const row of wrapLine(`${" ".repeat(10)}aaaa bbbb cccc dddd`, 16))
    assert(tui.visibleWidth(row) <= 16, JSON.stringify(row));
});

test("a continuation row selected only in its indent adds nothing to a copy", (t) => {
  installed(t);
  const lines = [`${CONTENT_START}aa`, `  ${CONTINUES_SPACED}bb`];
  assert.equal(copy(lines, { row: 1, col: 1 }), "aa");
});
