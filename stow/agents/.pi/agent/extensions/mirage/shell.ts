// Shell commands drawn for reading: one line per step of an `&&`, `||`, `|` or `;`
// chain, a leading `cd DIR &&` shown as `(in DIR)`, heredoc bodies counted rather than shown,
// and light highlighting. Display only: the command itself is never changed.

/** How each kind of token looks. Plain functions, so tests can pass identity paints. */
export interface ShellPaint {
  command(text: string): string;
  flag(text: string): string;
  string(text: string): string;
  variable(text: string): string;
  operator(text: string): string;
  redirect(text: string): string;
  comment(text: string): string;
  dim(text: string): string;
}

export interface ShownCommand {
  /** Display lines, painted. The first follows the status glyph, the rest are indented. */
  lines: string[];
  /** The directory a leading `cd DIR &&` moved to. */
  cwd?: string;
  /** True when a heredoc body or lines past the cap are left out. */
  elided: boolean;
}

const MAX_LINES = 8;
const SPLITS = new Set(["&&", "||", "|", "|&", ";"]);
const OPENS = new Set(["for", "while", "until", "if", "case", "select", "{"]);
const CLOSES = new Set(["done", "fi", "esac", "}"]);
/** Words after which the next word is still in command position. */
const KEYWORDS = new Set(["do", "then", "else", "elif", "!", "{", "time"]);
/** A function's name and parentheses: its body, such as a `{ …; }` group, follows. */
const FUNCTION = /^[\w.:-]+\(\)$/;
/** What closes each kind of span. */
const CLOSERS: Readonly<Record<string, string>> = {
  "'": "'",
  '"': '"',
  "`": "`",
  "(": ")",
  "{": "}",
};

type Kind = "word" | "string" | "operator" | "redirect" | "space" | "comment";
interface Token {
  kind: Kind;
  text: string;
}

/**
 * Where the quoted or bracketed span starting at `i` ends: `'…'`, `"…"`, `` `…` ``, `(…)` or
 * `{…}`, or the line's last character when it does not close. Spans inside it wait on a stack,
 * not in recursion, so any nesting costs one pass.
 */
function spanEnd(line: string, i: number): number {
  const closers = [CLOSERS[line[i]]];
  for (let j = i + 1; j < line.length; j++) {
    const char = line[j];
    const closer = closers[closers.length - 1];
    if (closer === "'") {
      if (char === "'") closers.pop();
    } else if (char === "\\") j++;
    else if (char === closer) closers.pop();
    else if (closer === '"' || closer === "`") {
      // `$(…)` inside double quotes holds quotes of its own: "$(git log --format="%h")".
      if (closer === '"' && char === "$" && line[j + 1] === "(") {
        closers.push(")");
        j++;
      }
    } else if (char === "'" || char === '"' || char === "`") closers.push(char);
    // $( … ), ${ … }, ( … ): brackets of the span's own kind nest.
    else if (char === (closer === ")" ? "(" : "{")) closers.push(closer);
    if (!closers.length) return j;
  }
  return line.length - 1;
}

/** Splits one line into tokens, keeping quotes, `$(…)` and subshells whole. */
function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    const space = /^\s+/.exec(rest);
    if (space) {
      tokens.push({ kind: "space", text: space[0] });
      i += space[0].length;
      continue;
    }
    if (rest[0] === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      tokens.push({ kind: "comment", text: rest });
      break;
    }
    const operator = /^(\|\||&&|\|&|\||;;?|&(?!>))/.exec(rest);
    if (operator) {
      tokens.push({ kind: "operator", text: operator[0] });
      i += operator[0].length;
      continue;
    }
    const redirect = /^(\d*>>?&?\d*-?|&>>?|\d*<<<|\d*<<-?|\d*<&?\d*)/.exec(rest);
    if (redirect?.[0]) {
      tokens.push({ kind: "redirect", text: redirect[0] });
      i += redirect[0].length;
      continue;
    }
    let j = i;
    while (j < line.length && !/[\s|&;<>]/.test(line[j])) {
      const char = line[j];
      // A backslash escapes the character after it, an operator or a space too: `\;`.
      if (char === "\\") j += 2;
      else if (char === "'" || char === '"' || char === "`") j = spanEnd(line, j) + 1;
      else if (char === "$" && (line[j + 1] === "(" || line[j + 1] === "{"))
        j = spanEnd(line, j + 1) + 1;
      else if (char === "(" && j === i) j = spanEnd(line, j) + 1;
      else j++;
    }
    const text = line.slice(i, Math.max(j, i + 1));
    tokens.push({ kind: /^(['"]).*\1$/s.test(text) ? "string" : "word", text });
    i += text.length;
  }
  return tokens;
}

/** Paints a run of tokens; the first word of each step is its command. */
function paint(tokens: readonly Token[], style: ShellPaint): string {
  let command = true;
  return tokens
    .map((token) => {
      if (token.kind === "space") return token.text;
      if (token.kind === "comment") return style.comment(token.text);
      if (token.kind === "operator") {
        command = true;
        return style.operator(token.text);
      }
      if (token.kind === "redirect") return style.redirect(token.text);
      if (token.kind === "string") {
        command = false;
        return style.string(token.text);
      }
      const text = token.text;
      if (text.startsWith("$")) {
        command = false;
        return style.variable(text);
      }
      // Assignments before a command leave the command still to come.
      if (command && /^[A-Za-z_][\w]*=/.test(text)) return style.variable(text);
      if (command) {
        command = false;
        return style.command(text);
      }
      return text.startsWith("-") && text.length > 1 ? style.flag(text) : text;
    })
    .join("");
}

const unquote = (text: string) => text.replace(/^(['"])(.*)\1$/s, "$2");

/** Lays out a command for a row header. */
export function showCommand(command: string, style: ShellPaint): ShownCommand {
  // Backslash-newline continues a line: the line breaks shown here replace it.
  const source = command
    .replace(/\\\r?\n\s*/g, " ")
    .replace(/\r\n?/g, "\n")
    .trim();
  const physical = source.split("\n");
  let first = tokenize(physical[0] ?? "");

  // `cd DIR && …` or `cd DIR; …` at the start: the rest runs in DIR.
  let cwd: string | undefined;
  const words = first.filter((token) => token.kind !== "space");
  if (
    words[0]?.text === "cd" &&
    (words[1]?.kind === "word" || words[1]?.kind === "string") &&
    (words[2]?.text === "&&" || words[2]?.text === ";") &&
    words.length > 3
  ) {
    cwd = unquote(words[1].text);
    const after = first.indexOf(words[2]) + 1;
    first = first.slice(after);
    while (first[0]?.kind === "space") first.shift();
  }

  const lines: string[] = [];
  let elided = false;
  if (physical.length === 1) {
    // One line: a line per step, each ending in its operator and, when a step follows, a
    // backslash, as typed by hand.
    let step: Token[] = [];
    const flush = (operator?: Token, more = false) => {
      while (step.at(-1)?.kind === "space") step.pop();
      while (step[0]?.kind === "space") step.shift();
      if (!step.length && !operator) return;
      let line = paint(step, style);
      if (operator) line += `${operator.text === ";" ? "" : " "}${style.operator(operator.text)}`;
      if (more) line += ` ${style.operator("\\")}`;
      lines.push(line);
      step = [];
    };
    // A loop, conditional, `[[ … ]]` test or `{ …; }` group stays on one line, as people write
    // them.
    let depth = 0;
    let test = false;
    let command = true;
    const last = first.findLastIndex((token) => token.kind !== "space");
    for (const [index, token] of first.entries()) {
      if (token.kind === "word") {
        if (command && OPENS.has(token.text)) depth++;
        else if (command && CLOSES.has(token.text)) depth = Math.max(0, depth - 1);
        else if (command && token.text === "[[") test = true;
        else if (token.text === "]]") test = false;
      }
      if (token.kind === "operator") command = true;
      else if (
        token.kind !== "space" &&
        !(command && (KEYWORDS.has(token.text) || FUNCTION.test(token.text)))
      )
        command = false;
      if (token.kind === "operator" && SPLITS.has(token.text) && depth === 0 && !test)
        flush(token, index < last);
      else step.push(token);
    }
    flush();
  } else {
    // A script: its own lines, with heredoc bodies counted.
    const shownLines: { index: number; stop?: number }[] = [];
    for (let index = 0; index < physical.length; index++) {
      // `<<<word` is a here-string, not a heredoc: it has no body.
      const heredoc = /(?:^|[^<])<<-?\s*(['"]?)([A-Za-z_]\w*)\1/.exec(physical[index] ?? "");
      if (!heredoc) {
        shownLines.push({ index });
        continue;
      }
      const end = physical.findIndex(
        (candidate, at) => at > index && candidate.trim() === heredoc[2],
      );
      const stop = end < 0 ? physical.length : end;
      shownLines.push({ index, stop });
      index = stop;
    }
    // The indentation its later lines share goes, as when a chain is typed with each step
    // indented: the row indents them itself. What one indents more than another stays.
    const indents = shownLines
      .slice(1)
      .map(({ index }) => physical[index] ?? "")
      .filter((line) => line.trim())
      .map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0);
    const indent = indents.length ? Math.min(...indents) : 0;
    for (const { index, stop } of shownLines) {
      const tokens = index === 0 ? first : tokenize((physical[index] ?? "").slice(indent));
      let shown = paint(tokens, style).trimEnd();
      const count = stop === undefined ? 0 : stop - index - 1;
      if (count > 0) {
        shown += ` ${style.dim(`… ${count} line${count === 1 ? "" : "s"}`)}`;
        elided = true;
      }
      if (shown || index === 0) lines.push(shown);
    }
  }

  if (lines.length > MAX_LINES) {
    const hidden = lines.length - (MAX_LINES - 1);
    lines.splice(MAX_LINES - 1, lines.length, style.dim(`… ${hidden} more lines`));
    elided = true;
  }
  return { lines: lines.length ? lines : [""], ...(cwd === undefined ? {} : { cwd }), elided };
}
