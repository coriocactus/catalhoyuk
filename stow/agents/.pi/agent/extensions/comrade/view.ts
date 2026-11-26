// How a comrade looks: the row of its call, a background comrade's delivered message, and its line in
// the widget above the editor. Rows are flat, as mirage draws its own. Collapsed, a row is one
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
  Text,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { paint } from "../shared/colours.ts";
import { formatCost, formatDuration, homePath } from "../shared/format.ts";
import { ALL_MARKERS, CONTENT_END, CONTENT_START, findMarker } from "../shared/selection.ts";
import type { Activity, Streamed } from "./run.ts";
import { type Live, oneLine, type Row, summary, type Work } from "./work.ts";

/** How a comrade's row names it, set when it is called. */
export interface Face {
  /** As the caller named it. Absent in rows saved by older versions. */
  title?: string;
  /** Its model and thinking level when not the caller's: `claude-fable-5-2:high`. */
  chip?: string;
}

/** Everything a row shows besides its answer. Stored in tool result and message details. */
export interface RunDetails extends Face {
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
  /** Why the comrade's last turn ended: anything but `stop` means the answer is partial. */
  stopReason?: string;
  /** Stopped because it ran past its timeout. */
  timedOut?: boolean;
  /** Why it did not succeed, in a line. */
  reason?: string;
  /** The session file holding the comrade's conversation, which a follow-up continues. */
  session?: string;
  /** This run continued an earlier conversation. */
  followUp?: boolean;
  /** This run resumed one that Pi exited during. */
  resumed?: boolean;
  /** When it started, and once it has ended, when: its conversation in between is what it did. */
  started?: number;
  ended?: number;
  activity?: Activity;
  streamed?: Streamed;
  /** While it runs: the last complete line of its text, or the title of its latest thought. */
  said?: string;
  /** Said in an earlier turn: still shown, dimmer. */
  saidBefore?: boolean;
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
  /** Resumed after Pi exited while it ran. */
  | "resumed"
  /** A steer sent to a running comrade. */
  | "sent";

/** How a background run ended, as its start row says once it has. */
export type Ending = "finished" | "failed" | "stopped" | "lost";

export interface Look {
  phase: Phase;
  /** The task: its first line names a row saved before titles. */
  task: string;
  /** Its title, when there are no run details to carry it yet. */
  title?: string;
  expanded: boolean;
  id?: number;
  durationMs?: number;
  /** Pi's working spinner frame, while it runs. */
  spinner?: string;
  /** A background start row whose run goes on. */
  live?: boolean;
  /** A background start row whose run has ended. */
  ending?: Ending;
  /**
   * A row in an older listing: how its run stood when that listing was made, with its cost and
   * clock then, not how it stands now.
   */
  stood?: boolean;
  /** A steer sent to a running comrade. */
  message?: string;
  /** What a row with no run details says: why it was refused, or a resumed comrade's note. */
  note?: string;
  /** The whole task, not just its first lines. */
  taskExpanded?: boolean;
  /** All its work, not just its latest blocks. */
  earlierExpanded?: boolean;
  /** Its work, in order, once known: its words, thoughts, the steers sent to it, and its calls. */
  blocks?: Block[];
  /** The thinking blocks expanded to their thoughts, by `key`. */
  thinkingOpen?: ReadonlySet<number>;
  /** The caller's directory, which a comrade run elsewhere is named from. */
  home?: string;
  /**
   * Brings the look up to date before each draw: Pi draws rows again without rendering them
   * afresh, for every frame while a comrade works. It may change `spinner`, `durationMs` and
   * `blocks`, and returns the run details to draw when it has newer ones than the row was given.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: a refresh with no newer run details returns nothing.
  refresh?: () => RunDetails | undefined | void;
}

/** One piece of a comrade's work, as its row shows it below its task. */
export type Block =
  /** What it said. `source` is the message part it came from, by which it is drawn once. */
  | { kind: "text"; text: string; source?: object }
  /**
   * A thinking block with titled thoughts (thoughts.ts): `Chain of thought ▸`, and once expanded
   * its thoughts, from the first title on, as Markdown. `key` counts the thinking blocks of its run
   * a row shows, so an expanded one stays expanded as the run goes on.
   */
  | { kind: "thinking"; text: string; key: number }
  /** A steer sent to it. */
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

/** What clicking a row does: its header expands or collapses it, its task line the whole task. */
export interface Toggles {
  row?: () => void;
  task?: () => void;
  /** An expanded row's work before its latest blocks. */
  earlier?: () => void;
  /** One of its thinking blocks, by key: its thoughts. */
  thinking?: (key: number) => void;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: keep only newlines and tabs of a task.
const CONTROLS_BUT_LINES = /[\x00-\x08\x0b-\x1f\x7f]+/g;
/** The bar beside each line of the task, as a quotation. */
const BAR = "│ ";
const TRUNCATED = /\n\n\[Answer truncated: [^\]]*\]$/;
/** The run line that ends the text the calling model reads. The row shows the run itself. */
const RUN = /\n\n\[comrade(?: #\d+)?: [^\n]*\]$/;
/** The first line of an answer that is not final. The row's header says so instead. */
const NOT_FINAL = /^\[Comrade(?:'s answer is (?:cut off|partial)| timed out)[^\n]*\]\n\n/;
/** Lines of the task an expanded row shows before `… N more lines ▸`. */
const TASK_LINES = 6;
/** An expanded row shows at most this many blocks of its work, its latest, until asked for all. */
const BLOCKS_SHOWN = 24;
/** A row that did not succeed says why in at most this many lines until expanded. */
const REASON_LINES = 3;
/** Below these widths a header drops the model chip, then the cost. */
const CHIP_WIDTH = 80;
const COST_WIDTH = 60;

/** Partial: the answer ended for a reason other than finishing. */
export const partialAnswer = (card: RunDetails | undefined) =>
  Boolean(card?.stopReason && card.stopReason !== "stop" && !card.timedOut);

/** The task's first line, on one line, with the home directory as `~`. */
export function taskLine(task: string): string {
  const first = task.split("\n").find((line) => line.trim()) ?? "";
  return oneLine(first).replaceAll(`${homedir()}/`, "~/");
}

/** A running clock: Pi's formats in whole seconds, so it ticks once a second. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : formatDuration(seconds * 1000);
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
 * `Reading ~/x`. A wait after the first turn says how long it had lasted by `now`.
 */
export function activityText(card: RunDetails, now = Date.now()): string {
  const activity = card.activity;
  if (!activity) return card.work?.current ?? "";
  switch (activity.state) {
    case "starting":
      return "starting";
    case "waiting":
      return card.turns ? `waiting ${formatElapsed(now - activity.since)}` : "waiting";
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
 * `↑150 ↓2.1k`: the finished messages' tokens plus the streaming message's, as the provider has
 * counted them. Each part shows once it is known.
 */
export function tokensText(card: RunDetails, running: boolean): string {
  const { usage, streamed } = card;
  const input =
    usage.input + usage.cacheRead + usage.cacheWrite + (running ? (streamed?.input ?? 0) : 0);
  const output = usage.output + (running ? (streamed?.output ?? 0) : 0);
  return [input ? `↑${formatTokens(input)}` : "", output ? `↓${formatTokens(output)}` : ""]
    .filter(Boolean)
    .join(" ");
}

/**
 * The run, for the calling model, which never sees the row:
 * `[comrade #3: model:level · 2 turns · 1 call · explored 1 file · ↑300 ↓20 · $0.02 · 1.2s · stop]`.
 */
export function runLine(card: RunDetails, durationMs: number, id?: number): string {
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

/** Whether the row's comrade is still at work: its clock ticks and its progress lines show. */
const working = (look: Look) => look.phase === "running" || Boolean(look.live);

/** The glyph that leads a row. */
function glyph(look: Look, card: RunDetails | undefined, theme: Theme): string {
  const spinning = (fallback: string) =>
    look.spinner ? paint(theme, "sky", look.spinner) : theme.fg("muted", fallback);
  switch (look.phase) {
    case "running":
      return spinning("…");
    case "background":
      return look.live ? spinning("…") : theme.fg("muted", look.stood ? "·" : "↗");
    case "finished":
      return partialAnswer(card) ? theme.fg("warning", "!") : paint(theme, "green", "✓");
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
function word(look: Look, card: RunDetails | undefined, theme: Theme): string {
  switch (look.phase) {
    case "failed":
      return paint(theme, "red", card?.timedOut ? "timed out" : "failed");
    case "finished":
      return partialAnswer(card) ? theme.fg("warning", "partial") : "";
    case "background":
      return theme.fg("muted", look.ending ? `background · ${look.ending}` : "background");
    case "running":
      return "";
    default:
      return theme.fg("muted", look.phase);
  }
}

/** Whether expanding the row shows anything more. */
function expandable(look: Look, card: RunDetails | undefined, answer: string): boolean {
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
  card: RunDetails | undefined,
  theme: Theme,
  width: number,
  expands: boolean,
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
    (look.phase === "background" && !look.live && !look.stood) ||
    look.phase === "sent" ||
    look.phase === "resumed"
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
    ? look.ending
      ? theme.fg("muted", look.ending)
      : ""
    : word(look, card, theme);
  const parts = [said, ...costs.filter(Boolean).map((part) => theme.fg("dim", part))].filter(
    Boolean,
  );
  const shown = parts.join(theme.fg("dim", " · "));
  // The caret is layout: a selection ends before it.
  const caret = expands ? caretAfter(theme, look.expanded ? "▾" : "▸", shown ? " " : "  ") : "";
  const tail = `${shown ? `  ${shown}` : ""}${caret}`;
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

/**
 * A call's status mark: a bold `$` for commands, `✓` or `✗` otherwise, or the spinner while
 * running.
 */
function mark(row: { label: string; status: Live }, theme: Theme, spinner?: string): string {
  const command = row.label.startsWith("$ ");
  const glyph = (other: string) => (command ? theme.bold("$") : other);
  if (row.status === "running")
    return spinner ? paint(theme, "sky", spinner) : theme.fg("muted", glyph("…"));
  if (row.status === "success") return paint(theme, "green", glyph("✓"));
  if (row.status === "error") return paint(theme, "red", glyph("✗"));
  return theme.fg("muted", glyph("✗"));
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

/**
 * How long a state or a call must last before a running row names it. Between quick calls a
 * comrade waits, calls and runs many times a second: until one of these lasts, the row says what
 * its calls have come to, which only counts up.
 */
export const SETTLE_MS = 2000;

/**
 * How long what a running row shows stays before it may change, so a state that lasted just long
 * enough to show does not flash by when it ends.
 */
export const STEADY_MS = 1000;

/**
 * What the comrade is doing has lasted long enough to name. A retry is named at once, and so is
 * what a run from an older version, which reported no activity, is doing.
 */
export function lasting(card: RunDetails): boolean {
  const activity = card.activity;
  if (!activity) return true;
  if (activity.state === "retrying" || activity.state === "starting") return true;
  return Date.now() - activity.since >= SETTLE_MS;
}

/**
 * What a running comrade is doing, for the widget, with its kind for a Steady line: what it does
 * or waits on once that has lasted, and until then what its calls have come to.
 */
export function nowDoing(card: RunDetails): [kind: string, text: string] {
  const done = card.work?.tallies.length ? summary(card.work.tallies) : "";
  if (done && !lasting(card)) return ["done", done];
  return [card.activity?.state ?? "", activityText(card) || "starting"];
}

/**
 * A line that changes what it shows at most once every STEADY_MS. Its kind says what the line
 * shows, a wait or a call: another kind waits until the last has shown that long, and is dropped
 * if a third replaces it first. The same kind updates in place, as a clock ticks or a spinner
 * turns. While another waits, `redraw` draws the kind shown from what is known now, so a call held
 * on its line still turns its spinner, or says it has ended; a kind it cannot draw stays as drawn.
 */
export class Steady {
  private kind?: string;
  private line = "";
  private since = 0;

  show(kind: string, line: string, redraw?: (kind: string) => string | undefined): string {
    const now = Date.now();
    if (kind !== this.kind) {
      if (this.kind !== undefined && now - this.since < STEADY_MS) {
        this.line = redraw?.(this.kind) ?? this.line;
        return this.line;
      }
      this.kind = kind;
      this.since = now;
    }
    this.line = line;
    return line;
  }
}

/** What it waits on: `thinking`, `waiting 48s`, a retry in the warning colour. */
function status(card: RunDetails, theme: Theme): string {
  const retrying = card.activity?.state === "retrying";
  return theme.fg(retrying ? "warning" : "dim", activityText(card) || "starting");
}

/** What its calls have come to, as an ended row sums them up: `✓ Read 3 files, ran 1 command`. */
function doneLine(work: Work, theme: Theme): string {
  const failed = work.tallies.every((tally) => tally.failed === tally.calls);
  return `${paint(theme, failed ? "red" : "green", "✓")} ${summaryText(work, theme)}`;
}

/**
 * What a running row says under its header, in two lines that change in place. First, what it
 * is doing, once that has lasted SETTLE_MS: the call it runs, or mirage's line for its group when
 * several run at once; else what it waits on. Until then, what its calls have come to, or before
 * any, what it waits on. Then the last complete thing it said, or the title of its latest
 * thought, dimmer once a later turn has begun; or until it has said anything, its tokens so far.
 * While it thinks or writes what shows below, the line above sums up its calls instead, rather
 * than labelling the words. The first line is held steady, so it changes at most once a second.
 */
function progressLines(
  look: Look,
  card: RunDetails,
  theme: Theme,
  width: number,
  steady: Steady,
): string[] {
  const latest = look.blocks?.findLast((block) => block.kind === "rows" || block.kind === "call");
  const recent = card.work?.recent?.at(-1);
  const state = card.activity?.state;
  const { said, saidBefore: before } = card;
  const shownBelow = Boolean(said) && !before && (state === "thinking" || state === "writing");
  const done = card.work?.tallies.length ? card.work : undefined;
  const named = !done || lasting(card);
  // Each with its kind: one call, mirage's line for a group, its calls summed up, or the state it
  // waits in.
  const group = (rows: Extract<Block, { kind: "rows" }>): [string, string] => [
    "group",
    quiet(rows.component.render(width)[0] ?? ""),
  ];
  const call = (row: LiveRow): [string, string] => ["call", callLine(row, theme, look.spinner)];
  const sum = (work: Work): [string, string] => ["done", doneLine(work, theme)];
  const waits = (): [string, string] => [state ?? "starting", status(card, theme)];
  const ran = (): [string, string] | undefined => {
    if (latest?.kind === "rows")
      return latest.calls > 1 || !latest.last ? group(latest) : call(latest.last);
    if (latest?.kind === "call") return call(latest.row);
    return recent ? call(recent) : undefined;
  };
  let doing: [string, string];
  if (named && recent?.status === "running")
    doing = latest?.kind === "rows" && latest.running > 1 ? group(latest) : call(recent);
  else if (named && state && state !== "running" && !shownBelow) doing = waits();
  // A run from an older version, which reported no activity, names the last call it ran.
  else doing = (done && card.activity ? sum(done) : ran()) ?? waits();
  // What is held on the line, as it is now: a call in progress, or ended; its calls summed up.
  const redraw = (kind: string) => {
    if (kind === "done") return done && sum(done)[1];
    if (kind === "group") return latest?.kind === "rows" ? group(latest)[1] : undefined;
    if (kind !== "call") return undefined;
    if (recent?.status === "running") return call(recent)[1];
    const row =
      (latest?.kind === "rows" ? latest.last : latest?.kind === "call" ? latest.row : undefined) ??
      recent;
    return row ? call(row)[1] : undefined;
  };
  const saying = said
    ? theme.fg(before ? "dim" : "muted", theme.italic(fitted(said, width)))
    : theme.fg("dim", tokensText(card, true));
  return [steady.show(...doing, redraw), saying].map((line) => (line ? `  ${line}` : ""));
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
function waiting(card: RunDetails, theme: Theme): string {
  const state = card.activity?.state;
  if (!state || state === "running") return "";
  return theme.fg(state === "retrying" ? "warning" : "dim", activityText(card));
}

/** Text as a row shows it: no control bytes, which the terminal would act on, and no tabs. */
const printable = (text: string) =>
  text.replace(/\r\n?/g, "\n").replace(/\t/g, "  ").replace(CONTROLS_BUT_LINES, "");

/**
 * Marks where a line's content starts, after its indent, for prose's bounded selection, unless the
 * line marks it already: Markdown, wrapped text and mirage's rows do.
 */
function marked(line: string): string {
  if (!line || findMarker(line)) return line;
  const lead = line.length - line.trimStart().length;
  return `${line.slice(0, lead)}${CONTENT_START}${line.slice(lead)}`;
}

/** A line without its markers, to be joined to another. */
const unmarked = (line: string) =>
  ALL_MARKERS.reduce((text, each) => text.replaceAll(each, ""), line);

/** A caret after a line's content, which a selection leaves out. */
const caretAfter = (theme: Theme, caret: string, gap = " ") =>
  `${CONTENT_END}${gap}${theme.fg("dim", caret)}`;

/**
 * Plain text wrapped to the width as Pi's Text wraps it, and so as prose does where it is loaded:
 * each continuation line hangs under its line's indent and marks how it continues, so a copy joins
 * it back. Without the spaces Text pads each line with.
 */
function wrap(text: string, width: number): string[] {
  return new Text(text, 0, 0).render(width).map((line) => line.replace(/ +$/, ""));
}

/** Tasks already drawn, by width, whether expanded, and text. */
const tasks = new Map<string, { lines: string[]; toggle?: number }>();

/** The task behind a bar, its first lines unless expanded whole, with a toggle when longer. */
function taskBlock(
  task: string,
  expanded: boolean,
  width: number,
  theme: Theme,
): { lines: string[]; toggle?: number } {
  drawing(theme);
  const key = `${width}\u0000${expanded}\u0000${task}`;
  const known = tasks.get(key);
  if (known) return known;
  const source = printable(task).trim();
  const room = width - 2 - visibleWidth(BAR);
  const bar = theme.fg("muted", BAR);
  const wrapped = room < 8 ? source.split("\n") : wrap(source, room);
  // The bar is layout: a selection starts after it.
  const lines = (expanded ? wrapped : wrapped.slice(0, TASK_LINES)).map(
    (line) => `  ${bar}${findMarker(line) ? line : `${CONTENT_START}${line}`}`,
  );
  let block: { lines: string[]; toggle?: number } = { lines };
  if (wrapped.length > TASK_LINES) {
    const more = wrapped.length - TASK_LINES;
    const toggle = expanded ? "show fewer lines" : `… ${more} more line${more === 1 ? "" : "s"}`;
    lines.push(`  ${theme.fg("dim", toggle)}${caretAfter(theme, expanded ? "▴" : "▸")}`);
    block = { lines, toggle: lines.length - 1 };
  }
  if (tasks.size >= DRAWN_MAX) tasks.delete(tasks.keys().next().value as string);
  tasks.set(key, block);
  return block;
}

/** Markdown already drawn, by width and text: a running row is drawn afresh many times a second. */
const drawn = new Map<string, readonly string[]>();
const DRAWN_MAX = 200;
/** A conversation's blocks already drawn, by the message part each came from, however many. */
const drawnParts = new WeakMap<
  object,
  { width: number; colours: object; lines: readonly string[] }
>();
/**
 * The colours what is drawn was drawn in: others draw everything afresh. Pi hands every row the
 * same theme object whatever the theme, but each theme has colours of its own.
 */
let drawnIn: object | undefined;
const drawing = (theme: Theme) => {
  if (theme.colors === drawnIn) return;
  drawnIn = theme.colors;
  drawn.clear();
  tasks.clear();
};

/**
 * Text as Markdown, two columns in, at most once per width. Thinking is four columns in, under
 * its `Chain of thought` line, in Pi's style for thinking.
 */
function markdown(
  text: string,
  width: number,
  theme: Theme,
  source?: object,
  thinking = false,
): readonly string[] {
  drawing(theme);
  const part = source && drawnParts.get(source);
  if (part?.width === width && part.colours === theme.colors) return part.lines;
  const key = `${width}\u0000${text}`;
  let lines = source ? undefined : drawn.get(key);
  if (!lines) {
    const style = thinking
      ? { color: (line: string) => theme.fg("thinkingText", line), italic: true }
      : undefined;
    lines = new Markdown(printable(text), thinking ? 4 : 2, 0, getMarkdownTheme(), style).render(
      width,
    );
    if (source) drawnParts.set(source, { width, colours: theme.colors, lines });
    else {
      if (drawn.size >= DRAWN_MAX) drawn.delete(drawn.keys().next().value as string);
      drawn.set(key, lines);
    }
  }
  return lines;
}

/** The answer, as Markdown, without the run line and markers the model reads. */
function answerLines(answer: string, width: number, theme: Theme): readonly string[] {
  const body = answer.replace(RUN, "").replace(TRUNCATED, "").replace(NOT_FINAL, "").trim();
  return body ? markdown(body, width, theme) : [];
}

/** Why an answer that ended early is not whole. */
function partialReason(card: RunDetails | undefined): string {
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
 * A comrade's row. It renders from its look and run details, and draws again when they change. A click
 * on mirage's rows inside it reaches them; on its task's toggle line, the whole task; on its
 * header, the row itself where it has its own toggle (a message), or else Pi's (a call's row).
 */
export class RowView implements Component {
  private look: Look;
  private card: RunDetails | undefined;
  private answer: string;
  private theme: Theme;
  private pad: number;
  private toggles: Toggles;
  private targets = new Map<number, Exclude<keyof Toggles, "thinking">>();
  /** The lines that say `Chain of thought`, and the thinking block each expands. */
  private thinkingTargets = new Map<number, number>();
  private zones: Zone[] = [];
  private indent = 0;
  /** While it works, what it is doing, collapsed and expanded, each held steady. */
  private doing = new Steady();
  private now = new Steady();
  /** The lines last drawn, and everything a later frame could have changed since. */
  private cache?: {
    width: number;
    spinner?: string;
    durationMs?: number;
    second?: number;
    blocks?: Block[];
    card?: RunDetails;
    lines: string[];
  };

  constructor(
    look: Look,
    card: RunDetails | undefined,
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

  /** Draws another state of the same row, so Pi's renderers can keep one component for it. */
  update(
    look: Look,
    card: RunDetails | undefined,
    answer: string,
    theme: Theme,
    pad: number,
    toggles: Toggles = {},
  ): this {
    this.look = look;
    this.card = card;
    this.answer = answer;
    this.theme = theme;
    this.pad = pad;
    this.toggles = toggles;
    this.cache = undefined;
    return this;
  }

  // Mirage's rows are not invalidated with it: mirage redraws its rows itself when they change,
  // or their theme or frame does.
  invalidate(): void {
    this.cache = undefined;
  }

  render(width: number): string[] {
    const { look } = this;
    const card = look.refresh?.() ?? this.card;
    // A comrade at work shows clocks in whole seconds, its own and how long it has waited: they
    // are read as it is drawn, at least once a second. At rest, its time is what it was given.
    const second = working(look) ? Math.floor(Date.now() / 1000) : undefined;
    const durationMs = working(look) ? undefined : look.durationMs;
    const cache = this.cache;
    if (
      cache?.width === width &&
      cache.spinner === look.spinner &&
      cache.durationMs === durationMs &&
      cache.second === second &&
      cache.blocks === look.blocks &&
      cache.card === card
    )
      return cache.lines;
    // Pi's output padding, which a row drawing its own shell applies itself.
    const pad = Math.min(
      Number.isFinite(this.pad) ? this.pad : 0,
      Math.max(0, Math.floor((width - 1) / 2)),
    );
    const room = Math.max(1, width - pad * 2);
    this.targets.clear();
    this.thinkingTargets.clear();
    this.zones = [];
    this.indent = pad;
    const lines = this.lines(room, card).map((line) =>
      line ? " ".repeat(pad) + cut(marked(line), room) : "",
    );
    this.cache = {
      width,
      spinner: look.spinner,
      durationMs,
      second,
      blocks: look.blocks,
      card,
      lines,
    };
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== "left") return undefined;
    // Mirage's rows, two columns in, expand their groups and open their files as Pi's own rows do.
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
    // `Chain of thought` expands or collapses its thoughts.
    const thinking = this.thinkingTargets.get(event.y);
    if (thinking !== undefined && this.toggles.thinking) {
      this.toggles.thinking(thinking);
      this.invalidate();
      return { handled: true };
    }
    // Anywhere else, a click expands or collapses the row: Pi does it for a call's row, and the row
    // itself for its answer, which has no toggle of Pi's.
    const target = this.targets.get(event.y) ?? (this.targets.has(0) ? "row" : undefined);
    const toggle = target && this.toggles[target];
    if (!toggle) return undefined;
    toggle();
    this.invalidate();
    return { handled: true };
  }

  /**
   * A thinking block: `Chain of thought ▸`, as Pi labels hidden thinking, which a click expands to
   * its thoughts under it.
   */
  private thinking(block: Extract<Block, { kind: "thinking" }>, lines: string[], width: number) {
    const { look, theme } = this;
    const open = look.thinkingOpen?.has(block.key) === true;
    if (this.toggles.thinking) this.thinkingTargets.set(lines.length, block.key);
    const label = theme.italic(theme.fg("thinkingText", "Chain of thought"));
    lines.push(`  ${label}${caretAfter(theme, open ? "▾" : "▸")}`);
    if (open) lines.push(...markdown(block.text, width, theme, block, true));
  }

  private lines(width: number, card: RunDetails | undefined): string[] {
    const { look, answer, theme } = this;
    // A call whose arguments still stream has nothing to expand yet.
    const expands = expandable(look, card, answer) && !(look.phase === "running" && !card);
    const lines = [header(look, card, theme, width, expands)];
    if (expands && this.toggles.row) this.targets.set(0, "row");
    const blank = () => {
      if (lines.at(-1) !== "") lines.push("");
    };
    // The task: its first lines, the files attached to it, and a toggle for the rest.
    const showTask = () => {
      if (!look.task.trim()) return;
      blank();
      const block = taskBlock(look.task, Boolean(look.taskExpanded), width, theme);
      if (block.toggle !== undefined) this.targets.set(lines.length + block.toggle, "task");
      lines.push(...block.lines);
      if (card?.files)
        lines.push(
          `  ${theme.fg("dim", `${card.files} file${card.files === 1 ? "" : "s"} attached`)}`,
        );
    };
    // Its work, in order: its words, its thoughts, the steers sent to it, and its calls, mirage's
    // rows stacked as mirage stacks them. Its latest blocks unless all were asked for, with a
    // toggle for the rest.
    const work = () => {
      const blocks = look.blocks ?? [];
      const earlier = look.earlierExpanded ? 0 : Math.max(0, blocks.length - BLOCKS_SHOWN);
      if (blocks.length > BLOCKS_SHOWN && this.toggles.earlier) {
        blank();
        this.targets.set(lines.length, "earlier");
        const toggle = earlier ? `… ${earlier} earlier` : "show only the latest";
        lines.push(`  ${theme.fg("dim", toggle)}${caretAfter(theme, earlier ? "▸" : "▴")}`);
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
        else if (block.kind === "thinking") this.thinking(block, lines, width);
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
          lines.push(...progressLines(look, card, theme, Math.max(1, width - 2), this.doing));
        if (!look.expanded) break;
        showTask();
        work();
        // While it works, what it waits on once that has lasted, under what it has done: its calls
        // show their own.
        const named = going && lasting(card);
        const now = going
          ? this.now.show(
              named ? (card.activity?.state ?? "") : "",
              named ? waiting(card, theme) : "",
            )
          : "";
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
          for (const line of wrap(printable(look.note), Math.max(8, width - 2)))
            lines.push(`  ${theme.fg("muted", line)}`);
        break;
      default: {
        // Ended: why it did not succeed, always, whole once expanded; then its task and work.
        const why = (reason ?? (partialAnswer(card) ? partialReason(card) : ""))
          .split("\n")
          .filter((line) => line.trim());
        const tone = (text: string) =>
          look.phase === "failed"
            ? paint(theme, "red", text)
            : theme.fg(look.phase === "finished" ? "warning" : "muted", text);
        if (why.length && look.phase !== "stopped") {
          // Collapsed, its first line, wrapped, in at most three lines; expanded, all of it.
          const wrapped = (line: string) => wrap(printable(line), Math.max(8, width - 2));
          let shown = look.expanded ? why.flatMap(wrapped) : wrapped(why[0]);
          if (!look.expanded && shown.length > REASON_LINES) {
            const rest = shown.slice(REASON_LINES).map(unmarked).join(" ");
            shown = [
              ...shown.slice(0, REASON_LINES - 1),
              cut(`${shown[REASON_LINES - 1]} ${rest}`, width - 2),
            ];
          }
          for (const line of shown) lines.push(`  ${tone(line)}`);
        }
        if (!look.expanded) break;
        showTask();
        if (look.blocks?.length) work();
        else {
          // Rows saved before comrades showed their work, or a conversation since deleted: what
          // its calls came to, and its answer.
          const done = card?.work;
          if (done && card.calls > 0 && done.tallies.length) {
            blank();
            lines.push(
              `  ${doneLine(done, theme)}`,
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

/**
 * An older listing of several runs, in one dim line: each run's number and what it was doing
 * then, and their cost together. A click expands it to their rows, as they stood.
 */
export class ListingLine implements Component {
  private readonly runs: (RunDetails & { id: number })[];
  /** When the listing was made, or 0 if it does not say. */
  private readonly at: number;
  private readonly theme: Theme;
  private readonly pad: number;
  private readonly expanded: () => boolean;
  private readonly toggle: () => void;

  constructor(
    runs: (RunDetails & { id: number })[],
    at: number,
    theme: Theme,
    pad: number,
    expanded: () => boolean,
    toggle: () => void,
  ) {
    this.runs = runs;
    this.at = at;
    this.theme = theme;
    this.pad = pad;
    this.expanded = expanded;
    this.toggle = toggle;
  }

  render(width: number): string[] {
    const { theme, runs } = this;
    const pad = Math.min(this.pad, Math.max(0, Math.floor((width - 1) / 2)));
    const room = Math.max(1, width - pad * 2);
    // What each was doing when the listing was made: a wait then is not still counting.
    const then = this.at || undefined;
    const doing = runs.map(
      (run) => `#${run.id} ${activityText(run, then) || `turn ${run.turns + 1}`}`,
    );
    const cost = runs.reduce((sum, run) => sum + run.usage.cost.total, 0);
    const caret = this.expanded() ? "▾" : "▸";
    // The caret is layout: a selection ends before it.
    const tail = ` · ${formatCost(cost)}${CONTENT_END}  ${caret}`;
    const head = `· Comrades ${runs.map((run) => `#${run.id}`).join(", ")}  ${doing.join(" · ")}`;
    const line = cut(head, Math.max(0, room - visibleWidth(tail))) + tail;
    return [" ".repeat(pad) + marked(theme.fg("dim", line))];
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.button !== "left") return undefined;
    this.toggle();
    return { handled: true };
  }

  invalidate(): void {}
}

/** One of the rows a StackView draws, and whether it is expanded now. */
export interface Stacked {
  component: Component;
  expanded: boolean;
}

/**
 * Rows drawn one after another as one component, as a listing draws its comrades: a blank line
 * between two of them when either is expanded, so a row's work never runs into the next header.
 * A click reaches the row it lands on.
 */
export class StackView implements Component {
  private readonly rows: () => Stacked[];
  private layout: { start: number; end: number; component: Component }[] = [];

  /** `rows`: asked on every draw, so each row can follow its run. */
  constructor(rows: () => Stacked[]) {
    this.rows = rows;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    this.layout = [];
    let previous = false;
    for (const [index, { component, expanded }] of this.rows().entries()) {
      if (index > 0 && (previous || expanded)) lines.push("");
      const drawn = component.render(width);
      this.layout.push({ start: lines.length, end: lines.length + drawn.length, component });
      lines.push(...drawn);
      previous = expanded;
    }
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const row = this.layout.find((item) => event.y >= item.start && event.y < item.end);
    return row?.component.handleMouse?.({
      ...event,
      y: event.y - row.start,
      height: row.end - row.start,
    });
  }

  invalidate(): void {
    for (const { component } of this.layout) component.invalidate();
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
