// How a comrade looks: its tool row, a background comrade's delivered message, and its line in
// the widget above the editor. Rows are flat, as mirage draws its own. At rest a row is one
// line: glyph, `Comrade #N`, its title, then how it went. While it runs, two fixed lines follow:
// what it is doing, and the last thing it said. Expanded, a row is its conversation: its task,
// then what it said and did, its calls drawn by mirage where mirage is loaded, then its answer.
import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Markdown,
  sliceByColumn,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { paint } from "./colours.ts";
import type { Activity, Streamed } from "./run.ts";
import { homePath, type Live, type Row, summary, type Work } from "./work.ts";

/** How a comrade's row names it, set when it is called. */
export interface Face {
  /** As the caller named it. Absent in rows saved by older versions. */
  title?: string;
  /** Its model and thinking level when not the caller's: `claude-fable-5-2:high`. */
  chip?: string;
}

/** Everything a row shows besides its answer. Stored in tool result and message details. */
export interface Card extends Face {
  model: string;
  thinking: string;
  tools: string[];
  turns: number;
  calls: number;
  /** Absent in rows saved by older versions. */
  work?: Work;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: { total: number };
  };
  /** The full answer's file, when the returned text was truncated or written to output. */
  answer?: string;
  /** How many files were attached to the task. */
  files?: number;
  /** The directory the comrade ran in, when not the caller's. */
  cwd?: string;
  /** Why the comrade's last turn ended: anything but `stop` means the answer is cut off. */
  stopReason?: string;
  /** Stopped because it ran past its timeout. */
  timedOut?: boolean;
  /** Why it did not succeed, in a line. */
  reason?: string;
  /** The session file holding the comrade's conversation, which a follow-up continues. */
  session?: string;
  /** This run continued an earlier conversation. */
  followUp?: boolean;
  /** This run carried on after Pi exited while the comrade ran. */
  resumed?: boolean;
  /** When it started, and once it has ended, when: its conversation in between is what it did. */
  started?: number;
  ended?: number;
  activity?: Activity;
  streamed?: Streamed;
  /** While it runs: the last complete line of its thinking or text. */
  said?: string;
  /** Whether that line is its thinking, shown only where Pi shows thinking. */
  saidThinking?: boolean;
  /** The last complete line of its text alone, for where thinking is hidden. */
  spoke?: string;
  /** Said or spoke in an earlier turn: still shown, dimmer. */
  saidBefore?: boolean;
  spokeBefore?: boolean;
}

export type Phase =
  /** A foreground comrade at work. */
  | "running"
  | "finished"
  | "failed"
  | "stopped"
  /** A background comrade's start row, while its run goes on or once it has ended. */
  | "background"
  | "lost"
  /** Carrying on after Pi exited while it ran. */
  | "resumed"
  /** A message sent to a running comrade. */
  | "sent";

/** How a background run ended, as its start row says once it has. */
export type Outcome = "finished" | "failed" | "stopped" | "lost";

export interface Look {
  phase: Phase;
  /** The task: its first line names a row saved before titles. */
  task: string;
  /** Its title, when there is no card to carry it yet. */
  title?: string;
  expanded: boolean;
  id?: number;
  durationMs?: number;
  /** Pi's working spinner frame, while it runs. */
  spinner?: string;
  /** A background start row whose run goes on. */
  live?: boolean;
  /** A background start row whose run has ended. */
  outcome?: Outcome;
  /** A message sent to a running comrade. */
  message?: string;
  /** What a row with no card says: why it was refused, or a resumed comrade's note. */
  note?: string;
  /** The whole task, not just its first lines. */
  taskOpen?: boolean;
  /** All its work, not just its latest blocks. */
  earlierOpen?: boolean;
  /** Its work, in order, once known: its words, thinking, what it was told, and its calls. */
  blocks?: Block[];
  /** Whether Pi shows thinking now, so a row shows the comrade's. */
  thinking?: boolean;
  /** The caller's directory, which a comrade run elsewhere is named from. */
  home?: string;
  /**
   * Brings `thinking` and `blocks` up to date before each draw: Pi's thinking toggle redraws
   * rows without rendering them afresh.
   */
  refresh?: () => void;
}

/** One piece of a comrade's work, as its row shows it below its prompt. */
export type Block =
  /** What it said. `source` is the message part it came from, by which it is drawn once. */
  | { kind: "text"; text: string; source?: object }
  /** What it thought, shown only where Pi shows thinking. */
  | { kind: "thinking"; text: string; source?: object }
  /** A message sent to it while it ran. */
  | { kind: "message"; text: string }
  /**
   * Mirage's row for a group of its calls: how many, how many still run, and the last of them as
   * a call row, which a running row's line names when the group has only it.
   */
  | { kind: "rows"; component: Component; calls: number; running: number; last?: LiveRow }
  /** A call mirage does not draw, or every call where mirage is not loaded. */
  | { kind: "call"; row: LiveRow };

/** A call as a row draws it, running or ended. */
export type LiveRow = Omit<Row, "status"> & { status: Live };

/** What clicking a row does: its header opens or closes it, its task line the whole task. */
export interface Toggles {
  row?: () => void;
  task?: () => void;
  /** An open row's work before its latest blocks. */
  earlier?: () => void;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip control bytes from task text.
const CONTROLS = /[\x00-\x1f\x7f]+/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: keep only newlines and tabs of a task.
const CONTROLS_BUT_LINES = /[\x00-\x08\x0b-\x1f\x7f]+/g;
/** The bar beside each line of the task, as a quotation. */
const BAR = "│ ";
const TRUNCATED = /\n\n\[Answer truncated: [^\]]*\]$/;
/** The run line that ends the text the calling model reads. The row shows the run itself. */
const RUN = /\n\n\[comrade(?: #\d+)?: [^\n]*\]$/;
/** The first line of an answer that is not final. The row's header says so instead. */
const NOT_FINAL = /^\[Comrade(?:'s answer is cut off| timed out)[^\n]*\]\n\n/;
/** Lines of the task an expanded row shows before `… N more lines ▸`. */
const TASK_LINES = 6;
/** An open row shows at most this many blocks of its work, its latest, until asked for all. */
const BLOCKS_SHOWN = 24;
/** A row that did not succeed says why in at most this many lines until opened. */
const REASON_LINES = 3;
/** Below these widths a header drops the model chip, then the cost. */
const CHIP_WIDTH = 80;
const COST_WIDTH = 60;

/** Cut off: the answer ended for a reason other than finishing. */
export const cutOff = (card: Card | undefined) =>
  Boolean(card?.stopReason && card.stopReason !== "stop" && !card.timedOut);

/** The task's first line, on one line, with the home directory as `~`. */
export function taskLine(task: string): string {
  const first = task.split("\n").find((line) => line.trim()) ?? "";
  return first.replace(CONTROLS, " ").replace(/\s+/g, " ").trim().replaceAll(`${homedir()}/`, "~/");
}

/** Pi's formats: `1.2s`, `2m 5s`, `1h 2m 5s`. */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${total % 60}s`;
}

/** A running clock: Pi's formats in whole seconds, so it ticks once a second. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : formatDuration(seconds * 1000);
}

/** Cents from one cent up, two significant digits below a cent. */
export function formatCost(cost: number): string {
  if (!cost) return "$0.00";
  return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

/** Pi's footer format: `805`, `7.2k`, `41k`, `1.2M`. */
export function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1e4) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1e6) return `${Math.round(count / 1000)}k`;
  if (count < 1e7) return `${(count / 1e6).toFixed(1)}M`;
  return `${Math.round(count / 1e6)}M`;
}

// Resets text styles but never the background, so a cut keeps any colour behind it.
// pi-tui's truncateToWidth ends with a full reset, which clears it.
const SOFT_RESET = "\x1b[22;23;24;39m";

/** Cuts a styled line to the width, ending in `…`. */
export function cut(line: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(line) <= width) return line;
  // The ellipsis in the style it cuts, so a dim line does not end bright.
  return `${sliceByColumn(line, 0, width - 1, true)}…${SOFT_RESET}`;
}

/**
 * What a running comrade is doing, in a word or two: `waiting 48s`, `thinking`, `calling edit`,
 * `Reading ~/x`. A wait after the first turn says how long it has lasted.
 */
export function activityText(card: Card): string {
  const activity = card.activity;
  if (!activity) return card.work?.current ?? "";
  switch (activity.state) {
    case "starting":
      return "starting";
    case "waiting":
      return card.turns ? `waiting ${formatElapsed(Date.now() - activity.since)}` : "waiting";
    case "thinking":
    case "writing":
      return activity.state;
    case "calling":
      return `calling ${activity.detail ?? "a tool"}`;
    case "running":
      return card.work?.current ?? "running tools";
    case "retrying":
      return ["retrying", activity.detail ?? ""].filter(Boolean).join(" · ");
    case "compacting":
      return "compacting its context";
  }
}

/**
 * `↑150 ↓~2.1k`: the finished messages' tokens plus the streaming message's. The output is
 * marked `~` while it is estimated from the streamed text. Each part shows once it is known.
 */
export function tokensText(card: Card, running: boolean): string {
  const { usage, streamed } = card;
  const input =
    usage.input + usage.cacheRead + usage.cacheWrite + (running ? (streamed?.input ?? 0) : 0);
  const output = usage.output + (running ? (streamed?.output ?? 0) : 0);
  const estimated = running && Boolean(streamed?.output) && !streamed?.exact;
  return [
    input ? `↑${formatTokens(input)}` : "",
    output ? `↓${estimated ? "~" : ""}${formatTokens(output)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The run, for the calling model, which never sees the row:
 * `[comrade #3: model:level · 2 turns · 1 call · explored 1 file · ↑300 ↓20 · $0.02 · 1.2s · stop]`.
 */
export function runLine(card: Card, durationMs: number, id?: number): string {
  const { usage } = card;
  const work = card.work?.tallies.length ? summary(card.work.tallies) : "";
  const parts = [
    card.thinking ? `${card.model}:${card.thinking}` : card.model,
    `${card.turns} turn${card.turns === 1 ? "" : "s"}`,
    `${card.calls} call${card.calls === 1 ? "" : "s"}`,
    work && work[0].toLowerCase() + work.slice(1),
    `↑${formatTokens(usage.input + usage.cacheRead + usage.cacheWrite)} ↓${formatTokens(usage.output)}`,
    formatCost(usage.cost.total),
    formatDuration(durationMs),
    card.timedOut ? "timed out" : (card.stopReason ?? ""),
  ];
  return `[comrade${id === undefined ? "" : ` #${id}`}: ${parts.filter(Boolean).join(" · ")}]`;
}

/** Whether the row's comrade is still at work: its clock ticks and its live lines show. */
const working = (look: Look) => look.phase === "running" || Boolean(look.live);

/** The glyph that leads a row. */
function glyph(look: Look, card: Card | undefined, theme: Theme): string {
  const spinning = (fallback: string) =>
    look.spinner ? theme.fg("accent", look.spinner) : theme.fg("muted", fallback);
  switch (look.phase) {
    case "running":
      return spinning("…");
    case "background":
      return look.live ? spinning("…") : theme.fg("muted", "↗");
    case "finished":
      return cutOff(card) ? theme.fg("warning", "!") : paint(theme, "green", "✓");
    case "failed":
      return paint(theme, "red", "✗");
    case "stopped":
    case "lost":
      return theme.fg("muted", "✗");
    case "resumed":
      return theme.fg("muted", "↻");
    case "sent":
      return theme.fg("muted", "→");
  }
}

/** The word after the title that says how it went, if anything needs saying, styled. */
function word(look: Look, card: Card | undefined, theme: Theme): string {
  switch (look.phase) {
    case "failed":
      return paint(theme, "red", card?.timedOut ? "timed out" : "failed");
    case "finished":
      return cutOff(card) ? theme.fg("warning", "cut off") : "";
    case "background":
      return theme.fg("muted", look.outcome ? `background · ${look.outcome}` : "background");
    case "running":
      return "";
    default:
      return theme.fg("muted", look.phase);
  }
}

/** Whether expanding the row shows anything more. */
function expandable(look: Look, card: Card | undefined, answer: string): boolean {
  switch (look.phase) {
    case "resumed":
      return Boolean(look.note);
    case "lost":
      return false;
    case "sent":
      return Boolean(look.message);
    default:
      return Boolean(card || answer || look.note || look.task.trim());
  }
}

/**
 * The header: glyph, `Comrade #N`, the title (or a dim first line of the task in rows saved
 * before titles), the model chip, then how it went, its cost and its time, and a caret when it
 * expands. The title gives way so the rest always fits; narrow, the chip goes, then the cost.
 */
function header(
  look: Look,
  card: Card | undefined,
  theme: Theme,
  width: number,
  opens: boolean,
): string {
  const name = theme.fg(
    "toolTitle",
    theme.bold(look.id === undefined ? "Comrade" : `Comrade #${look.id}`),
  );
  const named = card?.title ?? look.title;
  const title = named ? named : theme.fg("dim", taskLine(look.task).slice(0, 80) || "…");
  const message =
    look.phase === "sent" && look.message
      ? `  ${theme.fg("dim", `"${taskLine(look.message)}"`)}`
      : "";
  // What it ran with that is not the caller's: another model, another directory.
  const chips = [card?.chip, card?.cwd ? `in ${place(card.cwd, look.home)}` : undefined].filter(
    Boolean,
  );
  const chip =
    chips.length && width >= CHIP_WIDTH ? `  ${theme.fg("muted", chips.join(" · "))}` : "";
  const label = `${glyph(look, card, theme)} ${name}  ${title}${chip}${message}`;
  const ended = look.phase === "background" && !look.live;
  // A start row whose run goes on has its cost and clock, as a foreground row has.
  const costs =
    (look.phase === "background" && !look.live) || look.phase === "sent" || look.phase === "resumed"
      ? []
      : [
          card?.turns && width >= COST_WIDTH ? formatCost(card.usage.cost.total) : "",
          look.durationMs === undefined
            ? ""
            : working(look)
              ? formatElapsed(look.durationMs)
              : formatDuration(look.durationMs),
        ];
  // Narrow, a start row says how its run went without the word background, before its name goes.
  const narrow = width < COST_WIDTH && look.phase === "background";
  const said = narrow
    ? look.outcome
      ? theme.fg("muted", look.outcome)
      : ""
    : word(look, card, theme);
  const parts = [said, ...costs.filter(Boolean).map((part) => theme.fg("dim", part))].filter(
    Boolean,
  );
  const caret = opens ? theme.fg("dim", look.expanded ? "▾" : "▸") : "";
  const trailer = [parts.join(theme.fg("dim", " · ")), caret].filter(Boolean).join(" ");
  const tail = trailer ? `  ${trailer}` : "";
  const line = cut(label, Math.max(0, width - visibleWidth(tail))) + tail;
  // An ended start row is history: all of it dim.
  return ended ? theme.fg("dim", stripStyles(line)) : line;
}

/** A directory as the caller would name it: inside its own, from there; else from home. */
function place(cwd: string, home?: string): string {
  const inside = home ? relative(home, cwd) : "";
  return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside : homePath(cwd);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR sequences start with ESC.
const STYLES = /\x1b\[[0-9;]*m/g;
const stripStyles = (text: string) => text.replace(STYLES, "");
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC 8 links start with ESC.
const LINKS = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const stripLinks = (text: string) => text.replace(LINKS, "");

/** `Explored 4 files, ran 2 searches (+3 −1)`, with dim brackets. */
function summaryText(work: Work, theme: Theme): string {
  return summary(work.tallies).replace(
    /\(([^)]*)\)/g,
    (_, inner: string) => `${theme.fg("dim", "(")}${inner}${theme.fg("dim", ")")}`,
  );
}

function changes(row: { added?: number; removed?: number }, theme: Theme): string {
  return [
    row.added ? paint(theme, "green", `+${row.added}`) : "",
    row.removed ? paint(theme, "red", `−${row.removed}`) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** A call as mirage names it, its path in the accent colour and its line counts coloured. */
function callLabel(row: Omit<Row, "status">, theme: Theme): string {
  if (row.label.startsWith("$ ")) return row.label.slice(2);
  if (row.kind === "read" || row.kind === "edit" || row.kind === "write") {
    const space = row.label.indexOf(" ");
    const verb = space < 0 ? row.label : row.label.slice(0, space);
    const path = space < 0 ? "" : row.label.slice(space + 1);
    return [verb, path && theme.fg("accent", path), changes(row, theme)].filter(Boolean).join(" ");
  }
  return row.label;
}

/** A call's status mark: `$` for commands, `✓` or `✗` otherwise, or the spinner while running. */
function mark(row: { label: string; status: Live }, theme: Theme, spinner?: string): string {
  const command = row.label.startsWith("$ ");
  if (row.status === "running")
    return spinner ? theme.fg("accent", spinner) : theme.fg("muted", command ? "$" : "…");
  if (row.status === "success") return paint(theme, "green", command ? "$" : "✓");
  if (row.status === "error") return paint(theme, "red", command ? "$" : "✗");
  return theme.fg("muted", command ? "$" : "✗");
}

/** One call worth naming, after a finished comrade's summary. */
function rowLine(row: Row, theme: Theme): string {
  let line = `${mark(row, theme)} ${callLabel(row, theme)}`;
  if (row.times && row.times > 1) line += ` ${theme.fg("dim", `×${row.times}`)}`;
  if (row.error) line += `  ${paint(theme, "red", row.error)}`;
  return `  ${line}`;
}

/**
 * A call's mark and label, or for one still running, the spinner's. A failed command ends with
 * its exit code, as mirage writes it; another failure with its error.
 */
function callLine(row: LiveRow, theme: Theme, spinner?: string) {
  const note = (text: string) => theme.italic(theme.fg("dim", text));
  const tail = row.code
    ? ` ${note("(exit code: ")}${paint(theme, "red", row.code)}${note(")")}`
    : row.error
      ? `  ${paint(theme, "red", row.error)}`
      : "";
  return `${mark(row, theme, row.status === "running" ? spinner : undefined)} ${callLabel(row, theme)}${tail}`;
}

/** Mirage's line for a group, as a running row names it: no caret, and no links it cannot open. */
function quiet(line: string): string {
  return stripLinks(line).replace(UNDERLINES, "").replace(CARET, "");
}
// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR sequences start with ESC.
const CARET = /\s*(?:\x1b\[[0-9;]*m)*[▸▾](?:\x1b\[[0-9;]*m)*\s*$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR sequences start with ESC.
const UNDERLINES = /\x1b\[(?:4|24)m/g;

/** What it waits on: `thinking`, `waiting 48s`, a retry in the warning colour. */
function status(card: Card, theme: Theme): string {
  const retrying = card.activity?.state === "retrying";
  return theme.fg(retrying ? "warning" : "dim", activityText(card) || "starting");
}

/**
 * What a running row says under its header, in two lines that change in place. First, what it
 * is doing: the call it runs, or mirage's line for its group when several run at once; else
 * what it waits on; else the last call it ran. Then the last complete thing it said, its
 * thinking only where Pi shows thinking, dimmer once a later turn has begun; or until it has
 * said anything, its tokens so far. While it thinks or writes what shows below, the line above
 * names the last call it ran instead, rather than labelling the words.
 */
function live(look: Look, card: Card, theme: Theme, width: number): string[] {
  const latest = look.blocks?.findLast((block) => block.kind === "rows" || block.kind === "call");
  const recent = card.work?.recent?.at(-1);
  const state = card.activity?.state;
  const thought = look.thinking || !card.saidThinking;
  const said = thought ? card.said : card.spoke;
  const before = thought ? card.saidBefore : card.spokeBefore;
  const shownBelow = Boolean(said) && !before && (state === "thinking" || state === "writing");
  const ran = (): string | undefined => {
    if (latest?.kind === "rows")
      return latest.calls > 1 || !latest.last
        ? quiet(latest.component.render(width)[0] ?? "")
        : callLine(latest.last, theme, look.spinner);
    if (latest?.kind === "call") return callLine(latest.row, theme, look.spinner);
    return recent ? callLine(recent, theme, look.spinner) : undefined;
  };
  let doing: string;
  if (recent?.status === "running")
    doing =
      latest?.kind === "rows" && latest.running > 1
        ? quiet(latest.component.render(width)[0] ?? "")
        : callLine(recent, theme, look.spinner);
  else if (state && state !== "running" && !shownBelow) doing = status(card, theme);
  else doing = ran() ?? status(card, theme);
  const saying = said
    ? theme.fg(before ? "dim" : "muted", theme.italic(fitted(said, width)))
    : theme.fg("dim", tokensText(card, true));
  return [doing, saying].map((line) => (line ? `  ${line}` : ""));
}

/**
 * As much of what it said as fits, its latest first: earlier sentences go before the latest is
 * cut, so the newest words always show.
 */
export function fitted(said: string, width: number): string {
  if (visibleWidth(said) <= width) return said;
  const sentences = said.split(/(?<=[.!?])\s+(?=\S)/);
  let kept = sentences.pop() ?? said;
  while (sentences.length) {
    const longer = `${sentences[sentences.length - 1]} ${kept}`;
    if (visibleWidth(longer) > width) break;
    kept = longer;
    sentences.pop();
  }
  return cut(kept, width);
}

/** What a working comrade waits on when not a call, which shows itself: thinking, a retry. */
function waiting(card: Card, theme: Theme): string {
  const state = card.activity?.state;
  if (!state || state === "running") return "";
  return theme.fg(state === "retrying" ? "warning" : "dim", activityText(card));
}

/** Text as a row shows it: no control bytes, which the terminal would act on, and no tabs. */
const printable = (text: string) =>
  text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(CONTROLS_BUT_LINES, "");

/** Tasks already drawn, by width, openness and text. */
const tasks = new Map<string, { lines: string[]; toggle?: number }>();

/** The task behind a bar, its first lines unless opened whole, with a toggle when longer. */
function taskBlock(
  task: string,
  open: boolean,
  width: number,
  theme: Theme,
): { lines: string[]; toggle?: number } {
  drawing(theme);
  const key = `${width}\u0000${open}\u0000${task}`;
  const known = tasks.get(key);
  if (known) return known;
  const source = printable(task).trim().split("\n");
  const room = width - 2 - visibleWidth(BAR);
  const bar = theme.fg("muted", BAR);
  const wrapped =
    room < 8 ? source : source.flatMap((line) => (line ? wrapTextWithAnsi(line, room) : [""]));
  const lines = (open ? wrapped : wrapped.slice(0, TASK_LINES)).map((line) => `  ${bar}${line}`);
  let block: { lines: string[]; toggle?: number } = { lines };
  if (wrapped.length > TASK_LINES) {
    const more = wrapped.length - TASK_LINES;
    lines.push(
      `  ${theme.fg("dim", open ? "show fewer lines ▴" : `… ${more} more line${more === 1 ? "" : "s"} ▸`)}`,
    );
    block = { lines, toggle: lines.length - 1 };
  }
  if (tasks.size >= DRAWN_MAX) tasks.delete(tasks.keys().next().value as string);
  tasks.set(key, block);
  return block;
}

/** Markdown already drawn, by width and text: a running row is drawn afresh many times a second. */
const drawn = new Map<string, string[]>();
const DRAWN_MAX = 200;
/** A conversation's blocks already drawn, by the message part each came from, however many. */
const drawnParts = new WeakMap<object, { width: number; theme: Theme; lines: string[] }>();
/** The theme what is drawn was drawn in: another one draws everything afresh. */
let drawnIn: Theme | undefined;
const drawing = (theme: Theme) => {
  if (theme === drawnIn) return;
  drawnIn = theme;
  drawn.clear();
  tasks.clear();
};

/** Text as Markdown, two columns in, at most once per width. */
function markdown(text: string, width: number, theme: Theme, source?: object): string[] {
  drawing(theme);
  const part = source && drawnParts.get(source);
  if (part?.width === width && part.theme === theme) return part.lines;
  const key = `${width}\u0000${text}`;
  let lines = source ? undefined : drawn.get(key);
  if (!lines) {
    lines = new Markdown(printable(text), 2, 0, getMarkdownTheme()).render(width);
    if (source) drawnParts.set(source, { width, theme, lines });
    else {
      if (drawn.size >= DRAWN_MAX) drawn.delete(drawn.keys().next().value as string);
      drawn.set(key, lines);
    }
  }
  return lines;
}

/** Thinking, dim and italic, wrapped two columns in, at most once per width. */
function thinkingLines(text: string, width: number, theme: Theme, source?: object): string[] {
  const part = source && drawnParts.get(source);
  if (part?.width === width && part.theme === theme) return part.lines;
  const lines = wrapTextWithAnsi(printable(text).trim(), Math.max(8, width - 2)).map(
    (line) => `  ${theme.fg("dim", theme.italic(line))}`,
  );
  if (source) drawnParts.set(source, { width, theme, lines });
  return lines;
}

/** The answer, as Markdown, without the run line and markers the model reads. */
function answerLines(answer: string, width: number, theme: Theme): string[] {
  const body = answer.replace(RUN, "").replace(TRUNCATED, "").replace(NOT_FINAL, "").trim();
  return body ? markdown(body, width, theme) : [];
}

/** Why an answer that ended early is not whole. */
function cutOffReason(card: Card | undefined): string {
  return card?.stopReason === "length"
    ? "Reached its output token limit. The answer is partial."
    : `Its last turn ended with "${card?.stopReason}". The answer may be partial.`;
}

/** Where a block of mirage's rows was drawn, so a click there reaches it. */
interface Zone {
  start: number;
  end: number;
  component: Component;
}

/**
 * A comrade's row. It renders from its look and card, and draws again when they change. A click
 * on mirage's rows inside it reaches them; on its task's toggle line, the whole task; on its
 * header, the row itself where it has its own toggle (a message), or else Pi's (a tool row).
 */
export class CardView implements Component {
  private readonly look: Look;
  private readonly card: Card | undefined;
  private readonly answer: string;
  private readonly theme: Theme;
  private readonly pad: number;
  private readonly toggles: Toggles;
  private targets = new Map<number, keyof Toggles>();
  private zones: Zone[] = [];
  private indent = 0;
  private cache?: { width: number; thinking?: boolean; lines: string[] };

  constructor(
    look: Look,
    card: Card | undefined,
    answer: string,
    theme: Theme,
    pad: number,
    toggles: Toggles = {},
  ) {
    this.look = look;
    this.card = card;
    this.answer = answer;
    this.theme = theme;
    this.pad = pad;
    this.toggles = toggles;
  }

  // Mirage's rows are not invalidated with it: Pi invalidates a running row on every spinner
  // frame, and mirage redraws its rows itself when they change, or their theme or frame does.
  invalidate(): void {
    this.cache = undefined;
  }

  render(width: number): string[] {
    this.look.refresh?.();
    if (this.cache?.width === width && this.cache.thinking === this.look.thinking)
      return this.cache.lines;
    // Pi's output padding, which a row drawing its own shell applies itself.
    const pad = Math.min(
      Number.isFinite(this.pad) ? this.pad : 0,
      Math.max(0, Math.floor((width - 1) / 2)),
    );
    const room = Math.max(1, width - pad * 2);
    this.targets.clear();
    this.zones = [];
    this.indent = pad;
    const lines = this.lines(room).map((line) => (line ? " ".repeat(pad) + cut(line, room) : ""));
    this.cache = { width, thinking: this.look.thinking, lines };
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== "left") return undefined;
    // Mirage's rows, two columns in, open their groups and files as Pi's own rows do.
    const zone = this.zones.find((item) => event.y >= item.start && event.y < item.end);
    const result = zone?.component.handleMouse?.({
      ...event,
      x: event.x - this.indent - 2,
      y: event.y - (zone?.start ?? 0),
    });
    if (result?.handled) {
      this.cache = undefined;
      return result;
    }
    if (event.type !== "click") return undefined;
    // Anywhere else, a click opens or closes the row: Pi does it for a tool row, and the row
    // itself for its answer, which has no toggle of Pi's.
    const target = this.targets.get(event.y) ?? (this.targets.has(0) ? "row" : undefined);
    const toggle = target && this.toggles[target];
    if (!toggle) return undefined;
    toggle();
    this.invalidate();
    return { handled: true };
  }

  private lines(width: number): string[] {
    const { look, card, answer, theme } = this;
    // A call whose arguments still stream has nothing to open yet.
    const opens = expandable(look, card, answer) && !(look.phase === "running" && !card);
    const lines = [header(look, card, theme, width, opens)];
    if (opens && this.toggles.row) this.targets.set(0, "row");
    const blank = () => {
      if (lines.at(-1) !== "") lines.push("");
    };
    // The prompt: its first lines, the files attached to it, and a toggle for the rest.
    const prompt = () => {
      if (!look.task.trim()) return;
      blank();
      const block = taskBlock(look.task, Boolean(look.taskOpen), width, theme);
      if (block.toggle !== undefined) this.targets.set(lines.length + block.toggle, "task");
      lines.push(...block.lines);
      if (card?.files)
        lines.push(
          `  ${theme.fg("dim", `${card.files} file${card.files === 1 ? "" : "s"} attached`)}`,
        );
    };
    // Its work, in order: its words, its thinking where Pi shows it, what it was told, and its
    // calls, mirage's rows stacked as mirage stacks them.
    // Its work, its latest blocks unless all were asked for, with a toggle for the rest.
    const work = () => {
      const blocks = look.blocks ?? [];
      const earlier = look.earlierOpen ? 0 : Math.max(0, blocks.length - BLOCKS_SHOWN);
      if (blocks.length > BLOCKS_SHOWN && this.toggles.earlier) {
        blank();
        this.targets.set(lines.length, "earlier");
        lines.push(
          `  ${theme.fg("dim", earlier ? `… ${earlier} earlier ▸` : "show only the latest ▴")}`,
        );
      }
      let previous: Block["kind"] | undefined;
      for (const block of blocks.slice(this.toggles.earlier ? earlier : 0)) {
        const prose =
          block.kind === "text" || block.kind === "thinking" || block.kind === "message";
        if (
          prose ||
          previous === undefined ||
          previous === "text" ||
          previous === "thinking" ||
          previous === "message"
        )
          blank();
        previous = block.kind;
        if (block.kind === "text") lines.push(...markdown(block.text, width, theme, block.source));
        else if (block.kind === "thinking")
          lines.push(...thinkingLines(block.text, width, theme, block.source));
        else if (block.kind === "message")
          lines.push(...taskBlock(block.text, true, width, theme).lines);
        else if (block.kind === "call") lines.push(`  ${callLine(block.row, theme, look.spinner)}`);
        else {
          const drawn = block.component.render(Math.max(1, width - 2));
          this.zones.push({
            start: lines.length,
            end: lines.length + drawn.length,
            component: block.component,
          });
          for (const line of drawn) lines.push(line ? `  ${line}` : "");
        }
      }
    };
    const reason = card?.reason ?? (look.phase === "failed" && !card ? look.note : undefined);

    switch (look.phase) {
      case "running":
      case "background": {
        const going = working(look) && card;
        if (going && look.phase === "running" && !look.expanded)
          lines.push(...live(look, card, theme, Math.max(1, width - 2)));
        if (!look.expanded) break;
        prompt();
        work();
        // While it works, what it waits on, under what it has done: its calls show their own.
        const now = going ? waiting(card, theme) : "";
        if (now) {
          blank();
          lines.push(`  ${now}`);
        }
        break;
      }
      case "sent":
        if (look.expanded && look.message) {
          blank();
          lines.push(...taskBlock(look.message, true, width, theme).lines);
        }
        break;
      case "resumed":
        if (look.expanded && look.note)
          for (const line of wrapTextWithAnsi(look.note, Math.max(8, width - 2)))
            lines.push(`  ${theme.fg("muted", line)}`);
        break;
      default: {
        // Ended: why it did not succeed, always, whole once expanded; then its prompt and work.
        const why = (reason ?? (cutOff(card) ? cutOffReason(card) : ""))
          .split("\n")
          .filter((line) => line.trim());
        const tone = (text: string) =>
          look.phase === "failed"
            ? paint(theme, "red", text)
            : theme.fg(look.phase === "finished" ? "warning" : "muted", text);
        if (why.length && look.phase !== "stopped") {
          // Closed, its first line, wrapped, in at most three lines; open, all of it.
          const wrap = (line: string) => wrapTextWithAnsi(printable(line), Math.max(8, width - 2));
          let shown = look.expanded ? why.flatMap(wrap) : wrap(why[0]);
          if (!look.expanded && shown.length > REASON_LINES)
            shown = [
              ...shown.slice(0, REASON_LINES - 1),
              cut(`${shown[REASON_LINES - 1]} ${shown.slice(REASON_LINES).join(" ")}`, width - 2),
            ];
          for (const line of shown) lines.push(`  ${tone(line)}`);
        }
        if (!look.expanded) break;
        prompt();
        if (look.blocks?.length) work();
        else {
          // Rows saved before comrades showed their work, or a conversation since deleted: what
          // its calls came to, and its answer.
          const done = card?.work;
          if (done && card.calls > 0 && done.tallies.length) {
            blank();
            const failed = done.tallies.every((tally) => tally.failed === tally.calls);
            lines.push(
              `  ${failed ? paint(theme, "red", "✓") : paint(theme, "green", "✓")} ${summaryText(done, theme)}`,
              ...done.rows.map((row) => `  ${rowLine(row, theme)}`),
            );
            if (done.omitted) lines.push(`    ${theme.fg("muted", `… ${done.omitted} more`)}`);
          }
          const said = answerLines(answer, width, theme);
          if (said.length && look.phase !== "lost") {
            blank();
            lines.push(...said);
          }
        }
        if (card?.answer) {
          blank();
          lines.push(`  ${theme.fg("muted", `Full answer: ${homePath(card.answer)}`)}`);
        }
      }
    }
    return lines;
  }
}

/** A background comrade, for the widget above the editor. */
export interface Running {
  id: number;
  title: string;
  /** What it is doing, or for one that has ended, how it went. */
  doing: string;
  cost: number;
  elapsedMs: number;
  /** Ended, its answer waiting for the session to take it. */
  ended?: "finished" | "failed";
}

/**
 * One background comrade in the widget: `• #12  Glide indicators  Editing ~/x.ts  $1.20 · 3m 2s`,
 * one column in as Pi's own lines are, its ids and titles in columns and its cost and clock at
 * the right. Narrow, what it is doing goes first, then the title shrinks and goes, then the
 * cost; the clock stays.
 */
export function widgetLine(
  running: Running,
  idWidth: number,
  titleWidth: number,
  width: number,
  theme: Theme,
): string {
  const inner = Math.max(1, width - 2);
  const lead =
    running.ended === "finished"
      ? paint(theme, "green", "✓")
      : running.ended === "failed"
        ? paint(theme, "red", "✗")
        : theme.fg("accent", "•");
  const id = theme.fg("muted", `#${running.id}`.padEnd(idWidth));
  const clock = formatElapsed(running.elapsedMs);
  // Its mark and id, then the clock with at least two columns before it.
  const base = 2 + idWidth + 2;
  const costly = `${formatCost(running.cost)} · ${clock}`;
  const right = theme.fg("dim", base + visibleWidth(costly) <= inner ? costly : clock);
  const room = Math.min(
    inner >= 68 ? titleWidth : visibleWidth(running.title),
    inner - base - visibleWidth(right) - 2,
  );
  const title = room >= 4 ? cut(running.title, room) : "";
  const named = title ? `  ${title}${" ".repeat(Math.max(0, room - visibleWidth(title)))}` : "";
  const name = `${lead} ${id}${named}`;
  const left = inner - visibleWidth(name) - visibleWidth(right) - 4;
  const doing = inner >= 68 && left > 8 ? `  ${cut(running.doing, left)}` : "";
  const gap = inner - visibleWidth(name) - visibleWidth(doing) - visibleWidth(right);
  const line = `${name}${doing}${" ".repeat(Math.max(1, gap))}${right}`;
  // Narrower still than its mark, id and clock: as much as fits, the clock first to go.
  return ` ${cut(line, inner)}`;
}
