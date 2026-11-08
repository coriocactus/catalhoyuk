// How a comrade looks, in its tool row and in a background comrade's delivered message.
// Collapsed, it is one line: glyph, `Comrade`, the task, and cost and duration. Ctrl+O adds
// the model, a mirage-style summary of the comrade's calls, the calls worth naming, and the
// answer. While it runs, a second line shows its progress.
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
} from "@earendil-works/pi-tui";
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
  /** Why the comrade's last turn ended: anything but `stop` means the answer is cut off. */
  stopReason?: string;
  /** Stopped because it ran past its timeout. */
  timedOut?: boolean;
}

export type Phase = "running" | "finished" | "failed" | "stopped" | "background" | "lost";

export interface Look {
  phase: Phase;
  task: string;
  expanded: boolean;
  id?: number;
  durationMs?: number;
  /** What to say under a stopped or lost comrade, and why one failed. */
  note?: string;
  /** Pi's working spinner frame, while the comrade runs. */
  spinner?: string;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip control bytes from task text.
const CONTROLS = /[\x00-\x1f\x7f]+/g;
const TRUNCATED = /\n\n\[Answer truncated: [^\]]*\]$/;
/** The run line that ends the text the calling model reads. The row shows the run itself. */
const RUN = /\n\n\[comrade: [^\n]*\]$/;
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
    look.durationMs === undefined ? "" : formatDuration(look.durationMs),
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
  return new Header(label, look.phase === "running" ? "" : trailer);
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

/** The second line of a running comrade: `turn 3 · 12 calls · $0.10 · Reading ~/x`. */
function progressLine(card: Card, theme: Theme): string {
  if (!card.turns && !card.calls) return theme.fg("dim", `starting ${card.model}`);
  const parts = [
    `turn ${card.turns + 1}`,
    `${card.calls} call${card.calls === 1 ? "" : "s"}`,
    formatCost(card.usage.cost.total),
    card.work?.current ?? "",
  ];
  return theme.fg("dim", parts.filter(Boolean).join(" · "));
}

function metaLine(card: Card, theme: Theme): string {
  const { usage } = card;
  return theme.fg(
    "dim",
    [
      card.thinking ? `${card.model}:${card.thinking}` : card.model,
      card.tools.length ? card.tools.join(", ") : "no tools",
      ...(card.files ? [`${card.files} file${card.files === 1 ? "" : "s"} attached`] : []),
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
 * `[comrade: model:level · 2 turns · 1 call · explored 1 file · ↑300 ↓20 · $0.02 · 1.2s · stop]`.
 */
export function runLine(card: Card, durationMs: number): string {
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
  return `[comrade: ${parts.filter(Boolean).join(" · ")}]`;
}

/** Header, then (running) the progress line or (expanded) everything else. */
export function card(
  look: Look,
  details: Card | undefined,
  answer: string,
  theme: Theme,
): Component {
  const view = new Container();
  view.addChild(header(look, details, theme));
  if (look.phase === "running") {
    if (details) view.addChild(new Lines([progressLine(details, theme)]));
    return view;
  }
  if (!look.expanded) return view;

  // Expanded, three blocks with a blank line between them: the header, what the run did, and
  // what it said.
  const blocks: Component[] = [];
  const lines: string[] = [];
  if (details) lines.push(metaLine(details, theme));
  const work = details?.work;
  if (work && details.calls > 0 && work.tallies.length) {
    lines.push(summaryLine(work, theme), ...work.rows.map((row) => rowLine(row, theme)));
    if (work.omitted) lines.push(`  ${theme.fg("muted", `… ${work.omitted} more`)}`);
  }
  if (lines.length) blocks.push(new Lines(lines));

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
