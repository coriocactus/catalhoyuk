// Markdown as Amp draws it, and selection bounded to text. Code blocks lose their fence lines and
// are indented. Wrapped lines, in Markdown and in plain text, keep their indent, and rows end where
// their text ends. In fullscreen, Pi's own selection then stops at each row's text and starts at its
// content, skipping margins and indents, a copy joins wrapped rows back into the lines they came
// from, and a triple-click selects a whole wrapped line.
import { VERSION } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  type MarkdownTheme,
  sliceByColumn,
  stripTerminalSequences,
  Text,
  TuiAltScreen,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  CONTENT_START,
  CONTINUES_JOINED,
  CONTINUES_SPACED,
  findMarker,
} from "../shared/selection.ts";

const PATCH = Symbol.for("prose.markdown.patch.v1");
/** Rows a copy is reading, in order, while Pi's getActiveSelectionText runs. */
const READING = Symbol("prose.reading");
const DEPTH = Symbol("prose.depth");
/** Tokens whose text wraps as prose. Lists, quotes and tables wrap through them. */
const WRAPPED = new Set(["paragraph", "heading", "text"]);
/** Narrower than this, a continuation row does not hang under its line's indent. */
const MIN_ROOM = 12;
/** How far a triple-click follows a wrapped line. */
const MAX_WRAPPED_ROWS = 500;
/** A scroll view scrollbar's track and thumb, after padding at the end of a row. */
const SCROLLBAR = /\s[│┃█]$/;

interface Token {
  type: string;
  text?: string;
  lang?: string;
}
interface Point {
  row: number;
  col: number;
  boundary?: boolean;
}
type Continuation = "spaced" | "joined" | undefined;
/** The parts of pi-tui's components this adapter reads, which their declarations keep private. */
interface MarkdownInternals {
  theme: MarkdownTheme;
  defaultTextStyle?: { bgColor?: unknown };
  blockHighlightedCode?: Map<string, string[]>;
  [DEPTH]?: number;
}
interface TextInternals {
  text: string;
  paddingX: number;
  cachedText?: string;
  cachedWidth?: number;
  cachedLines?: string[];
}
interface ScreenInternals {
  [READING]?: Continuation[];
  getSelectionSourceLine(point: Point): string;
}
// biome-ignore lint/suspicious/noExplicitAny: patched methods have different signatures.
type Method = (this: any, ...args: any[]) => any;
interface Patch {
  owners: Set<object>;
  originals: Map<string, Method>;
  installed: Map<string, Method>;
}

const continuation = (line: string): Continuation => {
  const marker = findMarker(line)?.marker;
  return marker === CONTINUES_SPACED
    ? "spaced"
    : marker === CONTINUES_JOINED
      ? "joined"
      : undefined;
};
const isImageLine = (line: string) => line.includes("\x1b_G") || line.includes("\x1b]1337;File=");

/**
 * Wraps a line to `width` after `prefix`. The first row keeps the line's own indent and, when
 * `mark` is set, marks where its content starts. Later rows hang under that indent and mark how
 * they continue it. The prefix is layout, such as a code block's indent, so it is never copied.
 */
export function wrapLine(line: string, width: number, prefix = "", mark = true): string[] {
  // A line break inside a line, such as Markdown's soft and hard breaks or CRLF output, starts
  // a new line, never a continuation.
  const parts = line.split(/\r\n|\r|\n/);
  if (parts.length > 1) return parts.flatMap((part) => wrapLine(part, width, prefix, mark));
  const start = mark ? CONTENT_START : "";
  const prefixWidth = visibleWidth(prefix);
  if (!line || isImageLine(line) || prefixWidth + visibleWidth(line) <= width)
    return [`${prefix}${start}${line}`];
  const plain = stripTerminalSequences(line);
  // The line's own indent, in columns, so wide spaces measure right.
  let own = visibleWidth(plain.slice(0, plain.length - plain.trimStart().length));
  let room = width - prefixWidth - own;
  if (room < MIN_ROOM) {
    // Too little room to hang under the indent: wrap the whole line, indent included.
    own = 0;
    room = Math.max(1, width - prefixWidth);
  }
  const hang = own;
  const head = own ? sliceByColumn(line, 0, own, true) : "";
  const body = own ? sliceByColumn(line, own, visibleWidth(line) - own, true) : line;
  const source = stripTerminalSequences(body);
  let at = 0;
  return wrapTextWithAnsi(body, room).map((piece, index) => {
    // Find the piece in the line to learn what the wrap dropped before it.
    let spaced = false;
    while (at < source.length && /\s/.test(source[at] ?? "")) {
      at++;
      spaced = true;
    }
    const text = stripTerminalSequences(piece);
    if (source.startsWith(text, at)) at += text.length;
    else {
      // Pi changed the piece, for example dropping spaces inside it: find it further on.
      const found = text ? source.indexOf(text, at) : -1;
      spaced ||= found < 0 || /\s/.test(source.slice(at, found));
      if (found >= 0) at = found + text.length;
    }
    if (!index) return `${prefix}${start}${head}${piece}`;
    const continues = spaced ? CONTINUES_SPACED : CONTINUES_JOINED;
    return `${prefix}${" ".repeat(hang)}${continues}${piece}`;
  });
}

/** Every theme slot styles nothing, so a probe sees only the layout. */
const plainTheme = new Proxy({} as MarkdownTheme, {
  get: (_, key) =>
    key === "highlightCode" || key === "codeBlockIndent" ? undefined : (text: string) => text,
});
const trimmedLines = (lines: string[]) =>
  lines.map((line) => stripTerminalSequences(line).trimEnd());

/** Pi still draws a code block as `` ```lang ``, the indented code, then `` ``` ``. */
function knownMarkdown(render: Method): boolean {
  const probe = new Markdown("```js\nx = 1\n```", 0, 0, plainTheme);
  const lines = trimmedLines(render.call(probe, 40));
  return lines[0] === "```js" && lines.includes("  x = 1") && lines.at(-1) === "```";
}

/** Pi's Text still wraps at spaces and caches its lines by text and width. */
function knownText(render: Method): boolean {
  const probe = new Text("ab cd", 0, 0) as unknown as TextInternals;
  const lines = render.call(probe, 3);
  return (
    JSON.stringify(trimmedLines(lines)) === '["ab","cd"]' &&
    probe.cachedText === "ab cd" &&
    probe.cachedWidth === 3 &&
    probe.cachedLines === lines
  );
}

/** Pi's selection still takes column bounds per row, and copies rows one per line. */
function knownSelection(columns: Method, copy: Method, lineSelection: Method): boolean {
  const probe = Object.assign(Object.create(TuiAltScreen.prototype), {
    selectionAnchor: { row: 0, col: 0 },
    selectionFocus: { row: 1, col: 1 },
    previousScreen: ["ab ", "cd"],
  });
  const bounded = columns.call(
    probe,
    "abcdef",
    0,
    { start: { row: 0, col: 0 }, end: { row: 0, col: 5 } },
    2,
  );
  const line = lineSelection.call(probe, { row: 1, col: 0 });
  return (
    typeof probe.getSelectionSourceLine === "function" &&
    bounded.start === 2 &&
    bounded.end === 6 &&
    copy.call(probe) === "ab\ncd" &&
    line.start.row === 1 &&
    line.end.col === 2
  );
}

const markdown = Markdown.prototype as unknown as Record<string, Method> & { [PATCH]?: Patch };
const text = Text.prototype as unknown as Record<string, Method>;
const screen = TuiAltScreen.prototype as unknown as Record<string, Method>;

/** Through the patched methods: fences gone, code and wraps marked, backgrounds still full. */
function checkMarkdown(): boolean {
  const code = new Markdown("```js\nx\n```", 0, 0, plainTheme).render(20);
  const wrapped = new Markdown("aa bb cc dd ee ff gg hh", 0, 0, plainTheme).render(8);
  const filled = new Markdown("x", 0, 0, plainTheme, { bgColor: (line: string) => line }).render(
    10,
  );
  return (
    !trimmedLines(code).includes("```js") &&
    code.some((line) => findMarker(line)?.marker === CONTENT_START) &&
    wrapped.some((line) => continuation(line) === "spaced") &&
    visibleWidth(filled[0] ?? "") === 10
  );
}

/** Through the patched render: wrapped and marked inside the margins, and still cached. */
function checkText(): boolean {
  const probe = new Text("aa bb cc dd", 1, 0);
  const lines = probe.render(8);
  return (
    JSON.stringify(trimmedLines(lines)) === '[" aa bb"," cc dd"]' &&
    continuation(lines[1] ?? "") === "spaced" &&
    probe.render(8) === lines
  );
}

/** Through the patched selection: a copy reads row by row, so it can join wrapped rows. */
function checkSelection(): boolean {
  const probe = Object.assign(Object.create(TuiAltScreen.prototype), {
    selectionAnchor: { row: 0, col: 0 },
    selectionFocus: { row: 1, col: 9 },
    previousScreen: [`${CONTENT_START}aa   `, `  ${CONTINUES_SPACED}bb`],
  }) as unknown as Record<string, Method>;
  return probe.getActiveSelectionText?.() === "aa bb";
}

/** What prose replaces, in groups that are probed, installed, and then checked together. */
const GROUPS: {
  label: string;
  methods: { key: string; prototype: Record<string, Method>; name: string }[];
  known: (originals: Method[]) => boolean;
  check: () => boolean;
}[] = [
  {
    label: "Markdown code blocks changed. prose left Pi's own Markdown",
    methods: [
      { key: "markdown.renderToken", prototype: markdown, name: "renderToken" },
      { key: "markdown.render", prototype: markdown, name: "render" },
    ],
    known: ([, render]) => knownMarkdown(render),
    check: checkMarkdown,
  },
  {
    label: "text wrapping changed. prose left Pi's own plain text",
    methods: [{ key: "text.render", prototype: text, name: "render" }],
    known: ([render]) => knownText(render),
    check: checkText,
  },
  {
    label: "text selection changed. prose left Pi's own selection",
    methods: [
      { key: "screen.getSelectionColumns", prototype: screen, name: "getSelectionColumns" },
      { key: "screen.getActiveSelectionText", prototype: screen, name: "getActiveSelectionText" },
      { key: "screen.getLineSelection", prototype: screen, name: "getLineSelection" },
    ],
    known: ([columns, copy, line]) => knownSelection(columns, copy, line),
    check: checkSelection,
  },
];

function replacement(key: string, original: Method): Method {
  switch (key) {
    case "markdown.renderToken": {
      const code = function (this: MarkdownInternals, token: Token, width: number, next?: string) {
        const source = token.text ?? "";
        let lines: string[];
        if (this.theme.highlightCode) {
          // The same per-block cache Pi's own code block uses.
          const cacheKey = `${token.lang ?? ""}\0${source}`;
          lines =
            this.blockHighlightedCode?.get(cacheKey) ??
            this.theme.highlightCode(source, token.lang);
          this.blockHighlightedCode?.set(cacheKey, lines);
        } else lines = source.split("\n").map((line) => this.theme.codeBlock(line));
        const indent = this.theme.codeBlockIndent ?? "  ";
        const shown = lines.flatMap((line) => wrapLine(line, width, indent));
        // Pi's own spacing after a code block.
        if (next && next !== "space") shown.push("");
        return shown;
      };
      return function (
        this: MarkdownInternals,
        token: Token,
        width: number,
        next?: string,
        style?: unknown,
      ) {
        const depth = this[DEPTH] ?? 0;
        this[DEPTH] = depth + 1;
        try {
          let lines: string[];
          if (token.type === "code") lines = code.call(this, token, width, next);
          else {
            lines = original.call(this, token, width, next, style);
            // Wrap leaf text here, marking continuations, before Pi's own wrapping would drop that.
            if (WRAPPED.has(token.type))
              lines = lines.flatMap((line) => wrapLine(line, width, "", false));
          }
          if (depth) return lines;
          // A whole rendered row, list bullets and quote borders included: mark where it starts.
          return lines.map((line) =>
            !line || findMarker(line) ? line : `${CONTENT_START}${line}`,
          );
        } finally {
          this[DEPTH] = depth;
        }
      };
    }
    case "markdown.render": {
      const trimmed = new WeakMap<string[], string[]>();
      return function (this: MarkdownInternals, width: number) {
        const lines: string[] = original.call(this, width);
        // A background must still reach the edge, as user messages need.
        if (this.defaultTextStyle?.bgColor) return lines;
        let result = trimmed.get(lines);
        if (!result) {
          result = lines.map((line) => (isImageLine(line) ? line : line.replace(/ +$/, "")));
          trimmed.set(lines, result);
        }
        return result;
      };
    }
    case "text.render":
      return function (this: TextInternals, width: number) {
        if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width)
          return this.cachedLines;
        const source = this.text;
        if (!source || source.trim() === "") return original.call(this, width);
        // Wrap each line as Pi would, but marked, so Pi's own wrapping finds nothing left to do.
        const paddingX = Math.min(this.paddingX, Math.max(0, Math.floor((width - 1) / 2)));
        const contentWidth = Math.max(1, width - paddingX * 2);
        this.text = source
          .replace(/\t/g, "   ")
          .split(/\r\n|\r|\n/)
          .flatMap((line) => wrapLine(line, contentWidth))
          .join("\n");
        try {
          return original.call(this, width);
        } finally {
          this.text = source;
          // Pi caches by the text it rendered: key the cache by the text it was given.
          this.cachedText = source;
        }
      };
    case "screen.getSelectionColumns":
      return function (
        this: ScreenInternals,
        line: string,
        row: number,
        selection: unknown,
        minColumn?: number,
        maxColumn?: number,
      ) {
        const limit = maxColumn ?? visibleWidth(line);
        // Every row ends at its last character, wherever its padding or background reaches.
        let content = stripTerminalSequences(sliceByColumn(line, 0, limit, true)).trimEnd();
        // While highlighting, the row may end in the scroll view's scrollbar, after padding.
        if (maxColumn !== undefined && SCROLLBAR.test(content) && visibleWidth(content) === limit)
          content = content.slice(0, -1).trimEnd();
        const end = Math.min(limit, visibleWidth(content));
        const found = findMarker(line);
        const start = found
          ? Math.max(minColumn ?? 0, visibleWidth(line.slice(0, found.at)))
          : minColumn;
        this[READING]?.push(continuation(line));
        return original.call(this, line, row, selection, start, end);
      };
    case "screen.getActiveSelectionText":
      return function (this: ScreenInternals) {
        const reading: Continuation[] = [];
        this[READING] = reading;
        let copied: string | undefined;
        try {
          copied = original.call(this);
        } finally {
          delete this[READING];
        }
        if (!copied) return copied;
        const lines = copied.split("\n");
        // Pi reads one row per line. If that ever changes, copy what Pi copied.
        if (lines.length !== reading.length) return copied;
        const joined: string[] = [];
        lines.forEach((line, index) => {
          const continues = reading[index];
          if (!continues || !joined.length) joined.push(line);
          // A continuation row selected only in its indent adds nothing.
          else if (line) joined[joined.length - 1] += `${continues === "spaced" ? " " : ""}${line}`;
        });
        return joined.join("\n");
      };
    case "screen.getLineSelection":
      return function (this: ScreenInternals, point: Point) {
        const range = original.call(this, point);
        if (typeof this.getSelectionSourceLine !== "function") return range;
        // A triple-click selects the whole wrapped line, not just the row clicked.
        const row = (at: number) => this.getSelectionSourceLine({ ...point, row: at });
        let first = point.row;
        let last = point.row;
        while (first > 0 && point.row - first < MAX_WRAPPED_ROWS && continuation(row(first)))
          first--;
        while (last - point.row < MAX_WRAPPED_ROWS && continuation(row(last + 1))) last++;
        if (first === point.row && last === point.row) return range;
        return {
          start: { ...point, row: first, col: 0 },
          end: { ...point, row: last, col: visibleWidth(row(last)), boundary: true },
        };
      };
    default:
      return original;
  }
}

/**
 * Installs the adapter, or joins it if another session of this extension already did. Groups
 * whose Pi code no longer looks as expected are left alone, with one warning each.
 */
export function installProse(report: (message: string) => void): () => void {
  const methods = GROUPS.flatMap((group) => group.methods);
  let patch = markdown[PATCH];
  if (patch) {
    const current = patch;
    const replaced = methods.some(
      ({ key, prototype, name }) =>
        current.installed.has(key) && prototype[name] !== current.installed.get(key),
    );
    if (replaced) {
      report("Another extension replaced prose's adapter. Pi's own rendering is in use.");
      return () => {};
    }
  } else {
    const originals = new Map<string, Method>();
    const installed = new Map<string, Method>();
    for (const group of GROUPS) {
      const found = group.methods.map(({ prototype, name }) => prototype[name]);
      let known = false;
      try {
        known = found.every((method) => typeof method === "function") && group.known(found);
      } catch {
        known = false;
      }
      if (!known) {
        report(`Pi ${VERSION}: ${group.label}. Run npm run verify in ~/.pi/agent/extensions.`);
        continue;
      }
      group.methods.forEach(({ key }, index) => {
        const original = found[index] as Method;
        originals.set(key, original);
        installed.set(key, replacement(key, original));
      });
    }
    for (const { key, prototype, name } of methods) {
      const method = installed.get(key);
      if (method) prototype[name] = method;
    }
    // Pi code can pass the probes yet stop calling what prose patched. Check through the
    // patches, and put back Pi's own methods for a group that no longer works.
    for (const group of GROUPS) {
      if (!group.methods.every(({ key }) => installed.has(key))) continue;
      let works = false;
      try {
        works = group.check();
      } catch {
        works = false;
      }
      if (works) continue;
      for (const { key, prototype, name } of group.methods) {
        const original = originals.get(key);
        if (original) prototype[name] = original;
        originals.delete(key);
        installed.delete(key);
      }
      report(`Pi ${VERSION}: ${group.label}. Run npm run verify in ~/.pi/agent/extensions.`);
    }
    patch = { owners: new Set(), originals, installed };
    markdown[PATCH] = patch;
  }
  const token = {};
  const current = patch;
  current.owners.add(token);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    current.owners.delete(token);
    if (current.owners.size) return;
    // Restore only what is still ours, so a later patch by someone else survives.
    for (const { key, prototype, name } of methods) {
      const installed = current.installed.get(key);
      const original = current.originals.get(key);
      if (installed && original && prototype[name] === installed) prototype[name] = original;
    }
    delete markdown[PATCH];
  };
}
