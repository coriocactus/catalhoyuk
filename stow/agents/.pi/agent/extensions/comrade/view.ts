// How a comrade looks, in its tool row and in a background comrade's delivered message.
// Collapsed, it is one line: glyph, `Comrade #N`, the task, and cost and duration. Ctrl+O adds
// the model, a mirage-style summary of the comrade's calls, the calls worth naming, the whole
// task, and the answer. While it runs, its clock ticks and a second line shows what it is
// doing, and Ctrl+O shows the whole task under them.
import { homedir } from "node:os";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Markdown,
  Spacer,
  sliceByColumn,
  Text,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Activity } from "./run.ts";
import { homePath, type Row, summary, type Work } from "./work.ts";

/** Everything the row shows besides the answer. Stored in tool result and message details. */
export interface Card {
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
  /** The session file holding the comrade's conversation, which a follow-up continues. */
  session?: string;
  /** This run continued an earlier conversation. */
  followUp?: boolean;
  /** While it runs: when it started, and what it is doing. */
  started?: number;
  activity?: Activity;
}

export type Phase = "running" | "finished" | "failed" | "stopped" | "background" | "lost";

export interface Look {
  phase: Phase;
  /** The task, whose first line the header shows. */
  task: string;
  expanded: boolean;
  /** Whether the expanded row shows the whole task. A delivered message leaves it to the start row. */
  prompt?: boolean;
  id?: number;
  durationMs?: number;
  /** What to say under a stopped or lost comrade, and why one failed. */
  note?: string;
  /** Pi's working spinner frame, while the comrade runs. */
  spinner?: string;
  /** A background comrade's start row while it runs: show its clock and progress. */
  live?: boolean;
}

/** Still running: the clock ticks in whole seconds and the progress line shows. */
const running = (look: Look) => look.phase === "running" || Boolean(look.live);

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

export function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 1e6) return `${Math.round(count / 1000)}k`;
  return `${(count / 1e6).toFixed(count < 1e7 ? 1 : 0)}M`;
}

// Resets text styles but never the background, so a cut keeps the tool box's colour behind it.
// pi-tui's truncateToWidth ends with a full reset, which clears it.
const SOFT_RESET = "\x1b[22;23;24;39m";

/** Cuts a styled line to the width, ending in `…`. */
export function cut(line: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(line) <= width) return line;
  return `${sliceByColumn(line, 0, width - 1, true)}${SOFT_RESET}…`;
}

/** Lines cut to the width rather than wrapped. */
class Lines implements Component {
  private readonly lines: string[];
  constructor(lines: string[]) {
    this.lines = lines;
  }
  render(width: number): string[] {
    return this.lines.map((line) => cut(line, width));
  }
  invalidate(): void {}
}

/** A label and a path, cut from the path's start so its file name stays visible. */
class PathLine implements Component {
  private readonly label: string;
  private readonly path: string;
  private readonly style: (text: string) => string;
  constructor(label: string, path: string, style: (text: string) => string) {
    this.label = label;
    this.path = path;
    this.style = style;
  }
  render(width: number): string[] {
    const room = width - visibleWidth(this.label);
    const total = visibleWidth(this.path);
    if (total <= room) return [this.style(this.label + this.path)];
    if (room < 2) return [cut(this.style(this.label + this.path), width)];
    const tail = sliceByColumn(this.path, total - room + 1, room - 1, true);
    return [this.style(`${this.label}…${tail}`)];
  }
  invalidate(): void {}
}

/**
 * The whole task, as sent, wrapped to the width behind a bar. The header shows only its first
 * line, cut to fit.
 */
export class Prompt implements Component {
  private readonly lines: string[];
  private readonly bar: string;
  constructor(task: string, theme: Theme) {
    this.lines = task
      .replace(/\r\n?/g, "\n")
      .replace(/\t/g, "  ")
      .replace(CONTROLS_BUT_LINES, "")
      .trim()
      .split("\n");
    this.bar = theme.fg("muted", BAR);
  }
  render(width: number): string[] {
    const room = width - visibleWidth(BAR);
    if (room < 8) return this.lines.map((line) => cut(line, width));
    return this.lines.flatMap((line) =>
      (line ? wrapTextWithAnsi(line, room) : [""]).map((part) => this.bar + part),
    );
  }
  invalidate(): void {}
}

/** The header: the task gives way so the trailer always fits. */
class Header implements Component {
  private readonly label: string;
  private readonly trailer: string;
  constructor(label: string, trailer: string) {
    this.label = label;
    this.trailer = trailer;
  }
  render(width: number): string[] {
    const tail = this.trailer ? `  ${this.trailer}` : "";
    const room = Math.max(0, width - visibleWidth(tail));
    return [cut(cut(this.label, room) + tail, width)];
  }
  invalidate(): void {}
}

function glyph(look: Look, theme: Theme): string {
  if (look.phase === "finished") return theme.fg("success", "✓");
  if (look.phase === "failed") return theme.fg("error", "✗");
  if (look.phase === "stopped" || look.phase === "lost") return theme.fg("muted", "✗");
  // Running: Pi's working spinner, in its colour, as mirage draws calls in progress.
  return look.spinner ? theme.fg("accent", look.spinner) : theme.fg("muted", "…");
}

export function header(look: Look, card: Card | undefined, theme: Theme): Component {
  const name = theme.fg(
    "toolTitle",
    theme.bold(look.id === undefined ? "Comrade" : `Comrade #${look.id}`),
  );
  const label = `${glyph(look, theme)} ${name}  ${theme.fg("dim", taskLine(look.task))}`;
  const costs = [
    card?.turns ? formatCost(card.usage.cost.total) : "",
    look.durationMs === undefined
      ? ""
      : running(look)
        ? formatElapsed(look.durationMs)
        : formatDuration(look.durationMs),
  ].filter(Boolean);
  const word =
    look.phase === "failed"
      ? theme.fg("error", card?.timedOut ? "timed out" : "failed")
      : look.phase === "stopped" || look.phase === "lost" || look.phase === "background"
        ? theme.fg("muted", look.phase)
        : look.phase === "finished" && cutOff(card)
          ? theme.fg("warning", "cut off")
          : "";
  const trailer = [word, ...costs.map((part) => theme.fg("dim", part))]
    .filter(Boolean)
    .join(theme.fg("dim", " · "));
  return new Header(label, trailer);
}

/** `Explored 4 files, ran 2 searches (+3 −1)`, with dim brackets. */
function summaryLine(work: Work, theme: Theme): string {
  const failed = work.tallies.every((tally) => tally.failed === tally.calls);
  const mark = failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
  const text = summary(work.tallies).replace(
    /\(([^)]*)\)/g,
    (_, inner: string) => `${theme.fg("dim", "(")}${inner}${theme.fg("dim", ")")}`,
  );
  return `${mark} ${text}`;
}

function changes(row: Row, theme: Theme): string {
  return [
    row.added ? theme.fg("success", `+${row.added}`) : "",
    row.removed ? theme.fg("error", `−${row.removed}`) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** One named call: failures with their error, changed files with their counts, commands. */
function rowLine(row: Row, theme: Theme): string {
  const failed = row.status !== "success";
  const command = row.label.startsWith("$ ");
  let label: string;
  if (command) {
    const dollar = theme.fg(failed ? (row.status === "error" ? "error" : "muted") : "success", "$");
    label = `${dollar} ${row.label.slice(2)}`;
  } else if (row.kind === "read" || row.kind === "edit" || row.kind === "write") {
    const space = row.label.indexOf(" ");
    const verb = space < 0 ? row.label : row.label.slice(0, space);
    const path = space < 0 ? "" : row.label.slice(space + 1);
    label = [verb, path && theme.fg("accent", path), changes(row, theme)].filter(Boolean).join(" ");
  } else label = row.label;
  if (row.times && row.times > 1) label += ` ${theme.fg("dim", `×${row.times}`)}`;
  if (!failed) return `  ${label}`;
  const mark = command ? "" : `${theme.fg(row.status === "error" ? "error" : "muted", "✗")} `;
  return `  ${mark}${label}${row.error ? `  ${theme.fg("error", row.error)}` : ""}`;
}

const tokens = (count: number | undefined) =>
  count ? `~${formatTokens(count)} token${count === 1 ? "" : "s"}` : "";

/**
 * What a running comrade is doing: `waiting for anthropic/claude-fable-5-1`, `thinking · ~2k
 * tokens`, `Reading ~/x`. A wait after the first turn says how long it has lasted.
 */
export function activityText(card: Card): string {
  const activity = card.activity;
  if (!activity) return card.work?.current ?? "";
  const parts: string[] = [];
  switch (activity.state) {
    case "starting":
      parts.push(`starting ${card.model}`);
      break;
    case "waiting":
      parts.push(
        card.turns
          ? `waiting ${formatElapsed(Date.now() - activity.since)} for ${card.model}`
          : `waiting for ${card.model}`,
      );
      break;
    case "thinking":
    case "writing":
      parts.push(activity.state, tokens(activity.tokens));
      break;
    case "calling":
      parts.push(`calling ${activity.detail ?? "a tool"}`, tokens(activity.tokens));
      break;
    case "running":
      parts.push(card.work?.current ?? "running tools");
      break;
    case "retrying":
      parts.push("retrying", activity.detail ?? "");
      break;
    case "compacting":
      parts.push("compacting its context");
      break;
  }
  return parts.filter(Boolean).join(" · ");
}

/** The second line of a running comrade: `turn 3 · 12 calls · thinking · ~2k tokens`. */
function progressLine(card: Card, theme: Theme): string {
  // Jobs adopted across a /reload from an older version report no activity.
  const fresh = card.activity ? card.activity.state === "starting" : !card.turns && !card.calls;
  if (fresh) return theme.fg("dim", `starting ${card.model}`);
  const parts = [
    `turn ${card.activity?.turn ?? card.turns + 1}`,
    card.calls ? `${card.calls} call${card.calls === 1 ? "" : "s"}` : "",
    activityText(card),
  ];
  return theme.fg("dim", parts.filter(Boolean).join(" · "));
}

function metaLine(card: Card, theme: Theme): string {
  const { usage } = card;
  return theme.fg(
    "dim",
    [
      ...(card.followUp ? ["follow-up"] : []),
      card.thinking ? `${card.model}:${card.thinking}` : card.model,
      card.tools.length ? card.tools.join(", ") : "no tools",
      ...(card.files ? [`${card.files} file${card.files === 1 ? "" : "s"} attached`] : []),
      ...(card.cwd ? [`in ${homePath(card.cwd)}`] : []),
      ...(card.turns
        ? [
            `${card.turns} turn${card.turns === 1 ? "" : "s"}`,
            `↑${formatTokens(usage.input + usage.cacheRead + usage.cacheWrite)} ↓${formatTokens(usage.output)}`,
          ]
        : []),
    ].join(" · "),
  );
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

/**
 * Header, then (running) the progress line or (expanded) everything else. Expanded, the whole
 * task comes right before the answer, so the question and its answer read together.
 */
export function card(
  look: Look,
  details: Card | undefined,
  answer: string,
  theme: Theme,
): Component {
  const view = new Container();
  view.addChild(header(look, details, theme));
  const prompt = look.expanded && look.prompt && look.task.trim();
  if (running(look)) {
    if (details) view.addChild(new Lines([progressLine(details, theme)]));
    // The row's size does not change while it runs: the task is the same from start to end.
    if (prompt) {
      view.addChild(new Spacer(1));
      view.addChild(new Prompt(look.task, theme));
    }
    return view;
  }
  if (!look.expanded) return view;

  // Expanded, blocks with a blank line between them: the header, what the run did, what it was
  // asked, and what it said.
  const blocks: Component[] = [];
  const lines: string[] = [];
  if (details) lines.push(metaLine(details, theme));
  const work = details?.work;
  if (work && details.calls > 0 && work.tallies.length) {
    lines.push(summaryLine(work, theme), ...work.rows.map((row) => rowLine(row, theme)));
    if (work.omitted) lines.push(`  ${theme.fg("muted", `… ${work.omitted} more`)}`);
  }
  if (lines.length || details?.session) {
    const block = new Container();
    // The conversation's file follows the model line, cut from the start to keep its name.
    const [meta, ...rest] = lines;
    if (meta) block.addChild(new Lines([meta]));
    if (details?.session)
      block.addChild(
        new PathLine("Conversation: ", homePath(details.session), (text) => theme.fg("dim", text)),
      );
    if (rest.length) block.addChild(new Lines(rest));
    blocks.push(block);
  }

  if (prompt) blocks.push(new Prompt(look.task, theme));

  const body = answer.replace(RUN, "").replace(TRUNCATED, "").replace(NOT_FINAL, "").trim();
  const said = new Container();
  if (look.phase === "finished" && body)
    said.addChild(new Markdown(body, 0, 0, getMarkdownTheme()));
  else if (look.note ?? body)
    said.addChild(
      new Text(theme.fg(look.phase === "failed" ? "error" : "muted", look.note ?? body), 0, 0),
    );
  if (details?.answer)
    said.addChild(new Lines([theme.fg("muted", `Full answer: ${homePath(details.answer)}`)]));
  if (said.children.length) blocks.push(said);
  for (const block of blocks) {
    view.addChild(new Spacer(1));
    view.addChild(block);
  }
  return view;
}
