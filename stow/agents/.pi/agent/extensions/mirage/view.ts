import { basename } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatReadLineRange,
  getLanguageFromPath,
  highlightCode,
  type Theme,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getCapabilities,
  getImageDimensions,
  getOsc8LinkAtColumn,
  hyperlink,
  imageFallback,
  stripTerminalSequences,
  Text,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { RowAnchor } from "../shared/anchors.ts";
import { paint } from "../shared/colours.ts";
import {
  diffCounts,
  exitCode,
  formatCost,
  formatDuration,
  homePath,
  writtenLines,
} from "../shared/format.ts";
import type { FileReference } from "../shared/protocol.ts";
import { CONTENT_START, findMarker } from "../shared/selection.ts";
import {
  type Expandable,
  inProgress,
  isComplete,
  isFailed,
  type SearchToolName,
  type ToolCallState,
  type ToolGroup,
  type ToolGroups,
  toolCalls,
} from "./model.ts";
import { scriptOutput } from "./nested.ts";
import { type ShellPaint, showCommand } from "./shell.ts";
import { colouredDiff } from "./style.ts";

/** What the link that marks a filename for hit testing points to. */
const FILE_LINK = "mirage:file:";
// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC 8 links use ESC/BEL delimiters.
const FILE_LINK_OPEN = /\x1b\]8;[^;\x07\x1b]*;mirage:file:[^\x07\x1b]*(?:\x07|\x1b\\)/g;
/**
 * A file call on its own. A call is in progress from its first argument to its result, so one
 * whose arguments still stream already says `Reading`, as one Pi runs does.
 */
const FILE_VERBS = {
  read: {
    pending: "Reading",
    running: "Reading",
    success: "Read",
    error: "Read",
    cancelled: "Read",
  },
  edit: {
    pending: "Editing",
    running: "Editing",
    success: "Edited",
    error: "Edit",
    cancelled: "Edit",
  },
  write: {
    pending: "Writing",
    running: "Writing",
    success: "Wrote",
    error: "Write",
    cancelled: "Write",
  },
};
/** Pi's searching tools, a call on its own: `Searched "parseList" in src`. */
const SEARCH_VERBS: Record<SearchToolName, Record<ToolCallState["status"], string>> = {
  grep: {
    pending: "Searching",
    running: "Searching",
    success: "Searched",
    error: "Search",
    cancelled: "Search",
  },
  find: {
    pending: "Finding",
    running: "Finding",
    success: "Found",
    error: "Find",
    cancelled: "Find",
  },
  ls: {
    pending: "Listing",
    running: "Listing",
    success: "Listed",
    error: "List",
    cancelled: "List",
  },
};
type Verbs = { running: string; success: string; error?: string };
const RUN: Verbs = { running: "Running", success: "Ran" };
/**
 * What a group's summary counts calls under, and how it words each. `grep` and `find` are both
 * searches; any other tool counts under its family: an MCP tool's server, or the tool.
 */
const GROUP_VERBS: Record<
  "read" | "image" | "edit" | "write" | "bash" | "codemode" | "search" | "ls" | "tool",
  Verbs
> = {
  read: { running: "Exploring", success: "Explored" },
  image: { running: "Viewing", success: "Viewed", error: "View" },
  bash: RUN,
  edit: FILE_VERBS.edit,
  write: FILE_VERBS.write,
  codemode: RUN,
  search: RUN,
  ls: { running: "Listing", success: "Listed" },
  tool: { running: "Calling", success: "Called" },
};
const NOUNS = { bash: "command", codemode: "script", search: "search", ls: "directory" } as const;
/** Kinds whose calls a summary counts as files explored, so reads among them say `Explored`. */
const EXPLORING: ReadonlySet<string> = new Set(["read", "image", "search", "ls"]);
/** Argument names that say what a call to an unfamiliar tool is about, in this order. */
const SUBJECTS = ["command", "path", "pattern", "url", "query"];

const plural = (count: number, noun: string) =>
  `${count} ${count === 1 ? noun : noun.endsWith("y") ? `${noun.slice(0, -1)}ies` : noun.endsWith("h") ? `${noun}es` : `${noun}s`}`;

/** A tool as a row names it: an MCP tool by its server and name, `docs · search`. */
export function toolTitle(name: string): string {
  const parts = name.split("__");
  return parts[0] === "mcp" && parts.length >= 3
    ? `${parts[1]} · ${parts.slice(2).join("__")}`
    : name;
}

/** What a file call counts as in a summary: its file, or itself when it names none. */
const fileKey = (row: ToolCallState) =>
  row.file ? JSON.stringify([row.file.cwd, row.file.path]) : row.id;

/** Pi's `read` reads these as images, which it attaches to the model's context. */
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|bmp)$/i;
/**
 * Whether a read is of an image: by its name, or by an image in its result. A result can lack
 * the image Pi read, when Pi could not shrink it to fit, so the name decides on its own too.
 */
const isImage = (row: ToolCallState) =>
  row.kind === "read" && (row.hasImages || IMAGE_FILE.test(row.file?.path ?? ""));
const IMAGE_VERBS: Record<ToolCallState["status"], string> = {
  pending: "Viewing",
  running: "Viewing",
  success: "Viewed",
  error: "View",
  cancelled: "View",
};

/** Which summary count a call falls under. */
function tallyOf(row: ToolCallState): string {
  if (isImage(row)) return "image";
  if (row.kind === "grep" || row.kind === "find") return "search";
  if (row.kind !== "tool") return row.kind;
  const parts = row.name.split("__");
  return parts[0] === "mcp" && parts.length >= 3 ? `server\0${parts[1]}` : `tool\0${row.name}`;
}
export type ToggleTarget = Expandable;
type GroupState = Pick<ToolGroups, "epoch" | "expanded"> & {
  rows: ReadonlyMap<string, ToolCallState>;
};
interface ViewActions {
  toggle(target: ToggleTarget): void;
  openFile(file: FileReference): void;
  outputPad(): number;
  renderImages(row: ToolCallState, width: number): readonly string[];
  /** The working spinner's current frame while Pi is working, for calls still in progress. */
  spinner?(): string | undefined;
  /** Told each time a frame draws the row with its spinner. */
  spun?(): void;
  /**
   * Whether Pi is redrawing the row for its spinner, or for a change the model already holds:
   * nothing drawn needs to be thrown away.
   */
  animating?(): boolean;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: Remove untrusted control bytes, preserving text line breaks.
const UNSAFE_CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;

function clean(value: string): string {
  return stripTerminalSequences(value)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(UNSAFE_CONTROLS, "");
}

function oneLine(value: string): string {
  return clean(value).replace(/\s+/g, " ").trim();
}

/** Output cut to the bounds Pi gives its own tools: its first 2000 lines or 50KB. */
const bounded = (output: string) =>
  truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });

/** A JSON object or array laid out two spaces deep, or undefined for any other output. */
function laidOut(output: string): string | undefined {
  const trimmed = output.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return value !== null && typeof value === "object" ? JSON.stringify(value, null, 2) : undefined;
  } catch {
    return undefined;
  }
}

function details(row: ToolCallState): Record<string, unknown> | undefined {
  const value = row.result?.details;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function diff(row: ToolCallState): string {
  return text(details(row)?.diff);
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** Shown in place of arguments a row cannot display: invalid, or not kept by Pi. */
function argumentsNote(row: ToolCallState): string {
  if (row.invalidArguments) return "invalid arguments";
  if (row.preview) return oneLine(row.preview);
  return row.omittedBytes === undefined ? "" : `${row.omittedBytes} bytes of arguments`;
}

/** Marks where a line's content starts, after its indent, for prose's bounded selection. */
const markStart = (line: string) => {
  const lead = line.length - line.trimStart().length;
  return `${line.slice(0, lead)}${CONTENT_START}${line.slice(lead)}`;
};

const keep = (value: string) => value;
/** Shell layout without colour, to ask whether a header left anything out. */
const PLAIN: ShellPaint = {
  command: keep,
  flag: keep,
  string: keep,
  variable: keep,
  operator: keep,
  redirect: keep,
  comment: keep,
  dim: keep,
};

/** The exit code of a failed command. */
function failureCode(row: ToolCallState): string | undefined {
  const output = (row.result?.content ?? [])
    .map((part) => (part.type === "text" ? text(part.text) : ""))
    .join("\n");
  return exitCode(output);
}

/** Lines at the top of a streaming write that are highlighted together, as Pi's own row does. */
const STREAM_BLOCK_LINES = 50;
/** Header lines a view remembers fitted to their width before it starts over: see `fit`. */
const FITTED_MAX = 512;
/** Lines of a streaming write laid out together: only the chunk that grows is wrapped again. */
const STREAM_CHUNK_LINES = 16;

/** What a group's summary counts: a script's tool calls, or the script when it made none. */
function leaves(rows: readonly ToolCallState[]): ToolCallState[] {
  return rows.flatMap((row) => {
    if (row.kind !== "codemode") return [row];
    const calls = toolCalls(row);
    return calls.length ? calls : [row];
  });
}

/** A cached projection. Rendering never mutates group membership or expansion state. */
export class ToolGroupView implements Component {
  private theme!: Theme;
  private showImages = true;
  private rawLines: string[] = [];
  /** Each drawn line's toggle, by line. */
  private targets: ToggleTarget[] = [];
  /**
   * The lines each call of the group drew last, with their toggles and links, and what they were
   * drawn from: a call that has not changed is not drawn again when another call in its group
   * does, such as a command printing beside finished reads.
   */
  private drawnCalls = new WeakMap<
    ToolCallState,
    {
      key: string;
      lines: string[];
      targets: ToggleTarget[];
      files: [string, FileReference][];
      linked: number[];
    }
  >();
  private files = new Map<string, FileReference>();
  private cache?: {
    group: ToolGroup;
    width: number;
    padding: number;
    revision: number;
    epoch: number;
    frame: string;
    lines: string[];
  };
  private bodies = new Map<string, { revision: number; text: string; component: Text }>();
  /** Each row's costly step, highlighting or colouring a diff: its last input and what it made. */
  private made = new Map<string, { input: string; variant: string; output: string }>();
  /** Writes whose content still streams: what is highlighted so far, line by line. */
  private streaming = new Map<
    string,
    { source: string; language: string; head: string; lines: string[] }
  >();
  /**
   * Header lines fitted to a width, by width and label. A call in progress has a new label each
   * spinner frame, but the frames repeat, and fitting a line to a width measures every character.
   */
  private fitted = new Map<string, string>();
  /** How many chunks each output drawn in chunks has: see chunked(). */
  private chunks = new Map<string, number>();
  /** The spinner frame this render paints, the same one its cache key records. */
  private frame = "";
  /** The padding every line starts with, as Pi's own rows have it. */
  private pad = "";
  /** The drawn lines with a filename link, which the lines Pi gets have without. */
  private linked: number[] = [];
  readonly row: ToolCallState;
  private readonly model: GroupState;
  private readonly actions: ViewActions;

  constructor(row: ToolCallState, model: GroupState, actions: ViewActions) {
    this.row = row;
    this.model = model;
    this.actions = actions;
  }

  configure(theme: Theme, showImages: boolean): void {
    if (theme !== this.theme || showImages !== this.showImages) this.invalidate();
    this.theme = theme;
    this.showImages = showImages;
  }

  invalidate(): void {
    // A spinner frame, or a change the model already holds, throws nothing away: render() reads
    // the frame from the clock, and draws afresh what changed, as its revision says.
    if (this.actions.animating?.()) return;
    this.cache = undefined;
    // Keep hit targets for the last painted frame until render replaces them.
    // Clearing them here swallows clicks during asynchronous theme/grammar loads.
    this.bodies.clear();
    this.made.clear();
    this.streaming.clear();
    this.chunks.clear();
    this.fitted.clear();
    this.drawnCalls = new WeakMap();
  }

  render(width: number): string[] {
    const group = this.row.group;
    if (this.model.rows.get(this.row.id) !== this.row || group.rows[0] !== this.row) return [];
    const padding = Math.min(this.actions.outputPad(), Math.max(0, Math.floor((width - 1) / 2)));
    const contentWidth = Math.max(0, width - padding * 2);
    // A group with calls in progress redraws for each spinner frame. A finished one stays cached.
    const frame = group.rows.some(inProgress) ? (this.actions.spinner?.() ?? "") : "";
    this.frame = frame;
    if (frame) this.actions.spun?.();
    if (
      this.cache?.group === group &&
      this.cache.width === width &&
      this.cache.padding === padding &&
      this.cache.revision === group.revision &&
      this.cache.epoch === this.model.epoch &&
      this.cache.frame === frame
    )
      return this.cache.lines;

    this.rawLines = [];
    this.targets = [];
    this.linked = [];
    this.files.clear();
    this.pad = " ".repeat(padding);
    if (group.rows.length === 1 && this.row.kind === "bash") {
      // A command on its own is counted as a group of one is: `Ran 1 command`.
      // Expanded, the command, then its output.
      const row = this.row;
      // A summary, so a tick or a cross: only a command's own line has the dollar.
      this.header(`${this.status(row.status)} ${this.summary([row])}`, row, contentWidth);
      if (this.model.expanded(row)) {
        const note = argumentsNote(row);
        if (text(row.args.command).trim()) this.commandHeader(row, 2, contentWidth, false);
        else if (note) this.addLines([this.theme.fg("dim", note)], row, 2);
        this.body(row, contentWidth, 2);
      }
    } else if (group.rows.length === 1) {
      this.entry(this.row, 0, contentWidth);
    } else {
      const expanded = this.model.expanded(group);
      // A group is red only when every call failed. Individual failures
      // show on their own lines once the group is expanded.
      let state: ToolCallState["status"] = "success";
      if (!group.rows.every(isComplete)) state = "pending";
      else if (group.rows.every(isFailed)) state = "error";
      const status = this.status(state);
      this.header(`${status} ${this.summary(leaves(group.rows))}`, group, contentWidth);
      if (expanded) for (const row of group.rows) this.drawnEntry(row, 2, contentWidth);
    }
    // Hit testing uses these padded lines, links included, until the next render. Pi gets them
    // without the links, which only hit testing reads.
    const lines = this.rawLines.slice();
    for (const line of this.linked) lines[line] = lines[line].replace(FILE_LINK_OPEN, "");
    this.cache = {
      group,
      width,
      padding,
      revision: group.revision,
      epoch: this.model.epoch,
      frame,
      lines,
    };
    return lines;
  }

  capture(line: number, width: number): RowAnchor | undefined {
    if (!this.render(width).length) return undefined;
    // The summary line stays put when a merge or expansion changes the group.
    if (line <= 0) return { key: this.row, offset: line, top: true };
    const target = this.targets[line];
    if (!target) return undefined;
    // A call's lines need not be together, as a script's are not around its nested calls: the
    // offset counts the lines of the same call above this one.
    const key = this.anchorKey(target);
    let offset = 0;
    for (let above = 0; above < line; above++)
      if (this.anchorKey(this.targets[above]) === key) offset++;
    return { key, offset };
  }

  locate(anchor: RowAnchor, width: number): number | undefined {
    if (
      !this.render(width).length ||
      !this.row.group.rows.some(
        (row) => row === anchor.key || row.calls?.includes(anchor.key as ToolCallState),
      )
    )
      return undefined;
    if (anchor.top) return anchor.offset;
    const lines = this.targets.flatMap((target, line) =>
      this.anchorKey(target) === anchor.key ? [line] : [],
    );
    // A collapsed group represents every member on its summary line.
    if (!lines.length) return 0;
    return lines[Math.min(anchor.offset, lines.length - 1)];
  }

  /** What a line is anchored to: its call, a script's source its script, a summary the leader. */
  private anchorKey(target: ToggleTarget): object {
    if ("rows" in target) return this.row;
    return "script" in target ? target.script : target;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.button !== "left") return undefined;
    const target = this.targets[event.y];
    if (!target) return undefined;
    const url = getOsc8LinkAtColumn(this.rawLines[event.y] ?? "", event.x);
    if (url) {
      const file = this.files.get(url);
      if (file) this.actions.openFile(file);
    } else {
      this.actions.toggle(target);
    }
    return { handled: true };
  }

  /**
   * One call of an expanded group, drawn again only when something it shows has changed: the
   * call (its revision counts its own and its script's changes, and its toggles), Ctrl+O, or the
   * width. A call in progress, and one with images, which bind and expand on their own, are
   * always drawn afresh.
   */
  private drawnEntry(row: ToolCallState, indent: number, width: number): void {
    // A call in progress changes with nearly every frame: it is only ever drawn afresh.
    const busy = !isComplete(row) || (row.calls?.some((call) => !isComplete(call)) ?? false);
    const images = row.hasImages || (row.calls?.some((call) => call.hasImages) ?? false);
    const key =
      busy || images
        ? undefined
        : `${row.revision}\0${indent}\0${width}\0${this.pad.length}\0${this.model.epoch}`;
    const kept = key === undefined ? undefined : this.drawnCalls.get(row);
    if (kept && kept.key === key) {
      const start = this.rawLines.length;
      for (const line of kept.linked) this.linked.push(start + line);
      for (let i = 0; i < kept.lines.length; i++) {
        this.targets.push(kept.targets[i]);
        this.rawLines.push(kept.lines[i]);
      }
      for (const [url, file] of kept.files) this.files.set(url, file);
      return;
    }
    const start = this.rawLines.length;
    const files = this.files.size;
    const links = this.linked.length;
    this.entry(row, indent, width);
    if (key === undefined) return;
    this.drawnCalls.set(row, {
      key,
      lines: this.rawLines.slice(start),
      targets: this.targets.slice(start, this.rawLines.length),
      files: [...this.files].slice(files),
      linked: this.linked.slice(links).map((line) => line - start),
    });
  }

  /** One call: its header, then its output or, for a script, its calls and output. */
  private entry(row: ToolCallState, indent: number, width: number): void {
    if (row.kind === "bash" && text(row.args.command).trim())
      this.commandHeader(row, indent, width);
    else this.header(`${" ".repeat(indent)}${this.rowLabel(row)}`, row, width);
    if (!this.model.expanded(row)) return;
    if (row.kind === "codemode") this.script(row, indent + 2, width);
    else this.body(row, width, indent + 2);
  }

  private arrow(expanded: boolean): string {
    return this.theme.fg("dim", expanded ? "▾" : "▸");
  }

  /** A status's mark. `abandoned`: a call nothing will end, which rests even while Pi works. */
  private status(status: ToolCallState["status"], command = false, abandoned = false): string {
    if (status === "error") return paint(this.theme, "red", command ? "$" : "✗");
    if (status === "success") return paint(this.theme, "green", command ? "$" : "✓");
    // In progress while Pi works: Pi's own working spinner, in its colour.
    if (this.frame && !abandoned && status !== "cancelled")
      return this.theme.fg("accent", this.frame);
    if (command) return this.theme.fg("muted", "$");
    return this.theme.fg("muted", status === "cancelled" ? "✗" : "…");
  }

  private rowLabel(row: ToolCallState): string {
    let label: string;
    if (row.kind === "bash") {
      const note = argumentsNote(row);
      // A note is not a command, so it is dim, as on file rows.
      label = oneLine(text(row.args.command)) || (note ? this.theme.fg("dim", note) : "…");
    } else if (row.kind === "codemode") {
      const summary = this.summary(toolCalls(row), true);
      label = summary ? `Script: ${summary}` : "Script";
    } else if (row.kind === "grep" || row.kind === "find" || row.kind === "ls") {
      label = this.searchLabel(row, row.kind);
    } else if (row.kind === "tool" || row.kind === "model") {
      // What the call is about, if an argument says so; else all of them, as one line. Headers
      // truncate anyway: clean only what one line can show.
      const subject = SUBJECTS.find((key) => typeof row.args[key] === "string");
      const args =
        row.kind === "model" || !Object.keys(row.args).length
          ? argumentsNote(row)
          : subject
            ? oneLine(text(row.args[subject]).slice(0, 400))
            : oneLine(json(row.args).slice(0, 400));
      label = oneLine(row.kind === "tool" ? toolTitle(row.name) : row.name);
      if (args) label += ` ${this.theme.fg("dim", args)}`;
      if (row.cost) label += ` ${this.theme.fg("dim", formatCost(row.cost))}`;
    } else if (isImage(row)) {
      // An image is viewed, not read, and is not a file to open in an editor: its name, no link.
      const note = argumentsNote(row);
      const name = row.file ? clean(basename(row.file.path)).replace(/\n/g, " ") : "";
      label = `${IMAGE_VERBS[row.status]} ${name || (note ? this.theme.fg("dim", note) : "…")}`;
    } else {
      const note = argumentsNote(row);
      let filename = note ? this.theme.fg("dim", note) : "…";
      if (row.file) {
        const display = homePath(row.file.path);
        const url = `${FILE_LINK}${encodeURIComponent(row.id)}`;
        this.files.set(url, row.file);
        filename = hyperlink(
          this.theme.underline(paint(this.theme, "blue", clean(display).replace(/\n/g, " "))),
          url,
        );
      }
      label = `${FILE_VERBS[row.kind][row.status]} ${filename}`;
      // Pi's own range label: `:40-89`, also for numeric strings; empty when malformed.
      const range = row.kind === "read" ? formatReadLineRange(row.args.offset, row.args.limit) : "";
      if (range) label += this.theme.fg("dim", range);
      if (row.kind === "edit" || row.kind === "write") label += this.changeSummary([row]);
    }
    return `${this.status(row.status, row.kind === "bash", row.abandoned)} ${label}`;
  }

  /**
   * `Read 2 files, ran 1 command`: counts per kind, in first-call order. Reads among only
   * searches and listings say `Explored`. Other tools count by family: `called 3 docs tools`,
   * `called source_check 2 times`.
   */
  private summary(rows: readonly ToolCallState[], lower = false): string {
    const counted = rows.filter((row) => row.kind !== "model");
    const tallies = [...new Set(counted.map(tallyOf))];
    const exploring = tallies.every((tally) => EXPLORING.has(tally));
    return tallies
      .map((tally, index) => {
        const members = counted.filter((row) => tallyOf(row) === tally);
        const kind = members[0].kind;
        const group: keyof typeof GROUP_VERBS =
          tally === "image"
            ? "image"
            : kind === "grep" || kind === "find"
              ? "search"
              : kind === "model"
                ? "tool"
                : kind;
        const verbs = group === "read" && !exploring ? FILE_VERBS.read : GROUP_VERBS[group];
        // While some are in progress, it counts those, and how many have finished.
        const going = members.filter((row) => !isComplete(row));
        const done = members.filter(isComplete);
        // All-failed edits/writes did not happen: use the failed-row verb.
        const word = going.length
          ? verbs.running
          : verbs.error && members.every(isFailed)
            ? verbs.error
            : verbs.success;
        const verb = index || lower ? word.toLowerCase() : word;
        const files =
          group === "read" || group === "image" || group === "edit" || group === "write";
        const howMany = (rows: readonly ToolCallState[], except = new Set<string>()) =>
          files
            ? // File tools count distinct files.
              new Set(rows.map(fileKey).filter((key) => !except.has(key))).size
            : rows.length;
        const count = howMany(going.length ? going : members);
        const finished = going.length ? howMany(done, new Set(going.map(fileKey))) : 0;
        const tail = finished ? this.theme.fg("dim", ` (${finished} finished)`) : "";
        let phrase: string;
        if (group === "tool") {
          const type = tally.slice(0, tally.indexOf("\0"));
          // A model can name a tool anything: one line of it, as the tool's own row shows.
          const name = oneLine(tally.slice(type.length + 1));
          phrase =
            type === "server"
              ? `${verb} ${plural(count, `${name} tool`)}`
              : count === 1
                ? `${verb} ${name}`
                : `${verb} ${name} ${count} times`;
        } else if (group === "image") phrase = `${verb} ${plural(count, "image")}`;
        else if (files)
          return `${verb} ${plural(count, "file")}${tail}${this.changeSummary(members, true)}`;
        // Commands, scripts, searches and listings count per call.
        else phrase = `${verb} ${plural(count, NOUNS[group])}`;
        return phrase + tail;
      })
      .join(", ");
  }

  /** `Searched "parseList" in src (*.ts)`, `Found "*.test.ts"`, `Listed packages/core`. */
  private searchLabel(row: ToolCallState, kind: SearchToolName): string {
    const verb = SEARCH_VERBS[kind][row.status];
    const dim = (value: string) => this.theme.fg("dim", value);
    const note = argumentsNote(row);
    const where = oneLine(text(row.args.path));
    const place = where ? homePath(where) : "";
    if (kind === "ls") return `${verb} ${place || (note ? dim(note) : ".")}`;
    const pattern = oneLine(text(row.args.pattern));
    let label = `${verb} ${pattern ? `"${pattern}"` : dim(note || "…")}`;
    if (place) label += dim(` in ${place}`);
    const glob = kind === "grep" ? oneLine(text(row.args.glob)) : "";
    if (glob) label += dim(` (${glob})`);
    return label;
  }

  /**
   * Sums successful edits' diffs and writes' lines. Rows show coloured `+A −R`. Group
   * summaries show plain `(+A −R)` in grey brackets.
   */
  private changeSummary(rows: readonly ToolCallState[], group = false): string {
    let added = 0,
      removed = 0;
    for (const row of rows) {
      if (row.status !== "success") continue;
      if (row.kind === "edit") {
        const counts = diffCounts(diff(row));
        added += counts.added;
        removed += counts.removed;
      } else if (row.kind === "write") {
        added += writtenLines(text(row.args.content));
      }
    }
    const parts = [added ? `+${added}` : "", removed ? `−${removed}` : ""].filter(Boolean);
    if (!parts.length) return "";
    if (group) return ` ${this.theme.fg("dim", "(")}${parts.join(" ")}${this.theme.fg("dim", ")")}`;
    return (
      (added ? ` ${paint(this.theme, "green", `+${added}`)}` : "") +
      (removed ? ` ${paint(this.theme, "red", `−${removed}`)}` : "")
    );
  }

  /** A command's own lines: a line per step, then where it ran and how it failed. */
  private commandHeader(row: ToolCallState, indent: number, width: number, caret = true): void {
    const shown = showCommand(clean(text(row.args.command)), this.shellPaint());
    const note = (value: string) => this.theme.italic(this.theme.fg("dim", value));
    const trailer: string[] = [];
    if (shown.cwd) trailer.push(note(`(in ${homePath(shown.cwd)})`));
    const code = row.status === "error" ? failureCode(row) : undefined;
    if (code !== undefined)
      trailer.push(`${note("(exit code: ")}${paint(this.theme, "red", code)}${note(")")}`);
    const pad = " ".repeat(indent);
    const lines = shown.lines.map((line, index) =>
      index ? `${pad}    ${line}` : `${pad}${this.status(row.status, true, row.abandoned)} ${line}`,
    );
    if (trailer.length) lines[lines.length - 1] += ` ${trailer.join(" ")}`;
    // Every line toggles the row. The caret ends the last one, unless a header above has it.
    for (const line of caret ? lines.slice(0, -1) : lines) {
      this.targets[this.rawLines.length] = row;
      this.rawLines.push(this.pad + markStart(this.fit(line, Math.max(0, width))));
    }
    if (caret) this.header(lines[lines.length - 1], row, width);
  }

  private shellPaint(): ShellPaint {
    const theme = this.theme;
    return {
      command: (value) => theme.bold(value),
      flag: (value) => theme.fg("syntaxFunction", value),
      string: (value) => theme.fg("syntaxString", value),
      variable: (value) => theme.fg("syntaxVariable", value),
      operator: (value) => theme.fg("syntaxOperator", value),
      redirect: (value) => theme.bold(value),
      comment: (value) => theme.fg("syntaxComment", value),
      dim: (value) => theme.fg("dim", value),
    };
  }

  private header(label: string, target: ToggleTarget, width: number): void {
    this.targets[this.rawLines.length] = target;
    if (label.includes(FILE_LINK)) this.linked.push(this.rawLines.length);
    const arrow = this.arrow(this.model.expanded(target));
    // Keep the caret visible even when the filename or command is truncated.
    this.rawLines.push(
      this.pad +
        markStart(width > 2 ? `${this.fit(label, width - 2)} ${arrow}` : this.fit(arrow, width)),
    );
  }

  /** A line cut to a width, remembered: see `fitted`. */
  private fit(line: string, width: number): string {
    const key = `${width}\0${line}`;
    let fitted = this.fitted.get(key);
    if (fitted === undefined) {
      if (this.fitted.size >= FITTED_MAX) this.fitted.clear();
      fitted = truncateToWidth(line, width);
      this.fitted.set(key, fitted);
    }
    return fitted;
  }

  /** A script: its source behind its own toggle, the calls it made, then its output. */
  private script(row: ToolCallState, indent: number, width: number): void {
    const source = clean(text(row.args.code)).trimEnd();
    if (source && row.source) {
      const count = source.split("\n").length;
      this.header(
        `${" ".repeat(indent)}${this.theme.fg("dim", `JavaScript, ${count} line${count === 1 ? "" : "s"}`)}`,
        row.source,
        width,
      );
      if (this.model.expanded(row.source))
        this.block(
          `${row.id}\0source`,
          row.revision,
          () =>
            this.once(`${row.id}\0source`, "javascript", source, () =>
              highlightCode(source, "javascript").join("\n"),
            ),
          row.source,
          width,
          indent + 2,
        );
    }
    for (const call of row.calls ?? []) this.entry(call, indent, width);
    this.body(row, width, indent);
  }

  private body(row: ToolCallState, width: number, padding = 2): void {
    if (width <= 0) return;
    const indent = Math.min(padding, Math.max(0, width - 1));
    const bodyWidth = Math.max(1, width - indent);
    // A write that went through, or is still streaming in, is drawn from its chunks: the finished
    // write keeps the lines it streamed, so finishing costs no new layout.
    // A saved write whose content Pi did not keep has none to draw.
    const unkeptContent = row.saved && typeof row.args.content !== "string";
    if (
      row.kind === "write" &&
      row.status !== "error" &&
      row.status !== "cancelled" &&
      !unkeptContent
    ) {
      this.addLines(this.chunked(row.id, this.writeLines(row), bodyWidth), row, indent);
      return;
    }
    // A command's output while it runs grows at its end, as a streaming write does.
    if (row.kind === "bash" && !isComplete(row) && !row.saved) {
      this.addLines(this.chunked(row.id, this.commandLines(row), bodyWidth), row, indent);
      return;
    }
    const imageLines =
      row.hasImages && getCapabilities().images && this.showImages
        ? this.actions.renderImages(row, bodyWidth)
        : [];
    const component = this.cachedText(row.id, row.revision, () => {
      let output =
        row.kind === "codemode"
          ? clean(scriptOutput(row.result))
          : clean(
              row.result?.content
                .filter((part) => part.type === "text")
                .map((part) => text(part.text))
                .join("\n") ?? "",
            );
      // Pi gives the output of a script's calls only to the script, and the session keeps
      // none of it.
      const missing = row.saved && !output && !isFailed(row);
      const unkept = this.theme.fg(
        "dim",
        `${row.kind === "write" ? "Content" : "Output"} not kept in session.`,
      );
      // A finished command is drawn whole, once, rather than in the chunks it grew in. Its header
      // shows the command unless it had to leave part of it out, whether it failed or not.
      let command = "";
      if (row.kind === "bash") {
        this.forgetChunks(row.id);
        const source = clean(text(row.args.command));
        if (source && (!source.trim() || showCommand(source, PLAIN).elided))
          command = this.theme.fg("dim", `$ ${source}`);
      }
      if (row.status === "error") {
        output = paint(this.theme, "red", output || "Tool failed.");
      } else if (row.status === "cancelled") {
        output = this.theme.fg("muted", output || "Cancelled when the script ended.");
      } else if (row.kind === "edit" && diff(row)) {
        const changes = clean(diff(row));
        output = this.once(row.id, "diff", changes, () => colouredDiff(this.theme, changes));
        if (details(row)?.rebuilt)
          output += `\n${this.theme.fg("dim", "Rebuilt from saved arguments, with line numbers relative to the replaced text.")}`;
      } else if (row.kind === "bash") {
        output = [output ? this.theme.fg("toolOutput", output) : "", missing ? unkept : ""]
          .filter(Boolean)
          .join("\n");
      } else if (row.kind === "model") {
        output = this.theme.fg("dim", "Result returned to the script.");
      } else if (missing) {
        output = unkept;
      } else if (row.kind === "read") {
        output = this.code(row.id, output, row.file?.path);
        // Pi keeps this out of the result's text, so only its renderer, which this replaces, shows it.
        const blind = oneLine(text(details(row)?.imageUnsupportedByModel));
        if (blind)
          output += `\n${this.theme.fg("warning", `[${blind} does not support images; it saw a placeholder instead]`)}`;
      } else if (row.kind === "tool") {
        output = this.toolOutput(row.id, output);
      } else if (
        row.kind === "codemode" ||
        row.kind === "grep" ||
        row.kind === "find" ||
        row.kind === "ls"
      ) {
        // A script's, and Pi's searches and listings. Colouring nothing would still emit escape
        // codes, and an empty line.
        if (output) output = this.theme.fg("toolOutput", output);
      }
      if (command) output = output ? `${command}\n${output}` : command;
      if (imageLines.length === 0) {
        for (const part of row.result?.content ?? []) {
          if (part.type === "image")
            output += `\n${imageFallback(part.mimeType, getImageDimensions(part.data, part.mimeType) ?? undefined)}`;
        }
      }
      // Like Pi's bash and codemode rows: the recorded execution time, which survives reloads.
      if (
        (row.kind === "bash" || row.kind === "codemode") &&
        row.durationMs !== undefined &&
        isComplete(row)
      ) {
        const took = this.theme.fg("muted", `Took ${formatDuration(row.durationMs)}`);
        output = output ? `${output}\n${took}` : took;
      }
      return output;
    });
    this.addLines([...component.render(bodyWidth), ...imageLines], row, indent);
  }

  private block(
    key: string,
    revision: number,
    build: () => string,
    target: ToggleTarget,
    width: number,
    padding: number,
  ): void {
    if (width <= 0) return;
    const indent = Math.min(padding, Math.max(0, width - 1));
    const component = this.cachedText(key, revision, build);
    this.addLines(component.render(Math.max(1, width - indent)), target, indent);
  }

  private cachedText(key: string, revision: number, build: () => string): Text {
    let cached = this.bodies.get(key);
    if (cached?.revision === revision) return cached.component;
    const text = build();
    // A revision counts events, not changes: Pi reports a result the row already showed again
    // when it records it. Text that came out the same keeps its component, and the lines that
    // component wrapped.
    if (cached?.text === text) cached.revision = revision;
    else {
      cached = { revision, text, component: new Text(text, 0, 0) };
      this.bodies.set(key, cached);
    }
    return cached.component;
  }

  /** A row's costly step, done again only when its input is no longer what it was. */
  private once(key: string, variant: string, input: string, make: () => string): string {
    const known = this.made.get(key);
    if (known?.input === input && known.variant === variant) return known.output;
    const output = make();
    this.made.set(key, { input, variant, output });
    return output;
  }

  private addLines(lines: readonly string[], target: ToggleTarget, indent: number): void {
    for (const line of lines) {
      this.targets[this.rawLines.length] = target;
      // The indent is mirage's layout. The line's own leading space is content, such as code's.
      // Text that prose wrapped already marks its lines, continuation lines included.
      this.rawLines.push(
        `${this.pad}${" ".repeat(indent)}${findMarker(line) ? "" : CONTENT_START}${line}`,
      );
    }
  }

  /**
   * Code that grows by appending, as a write's content does while it streams. Each frame
   * highlights only its new lines, so a long write costs each line once, not once per frame.
   * Its first lines are also highlighted together, so a comment or string that spans lines is
   * coloured whole; they stop changing once the content is longer. The finished write keeps
   * these lines, as Pi's own row does.
   */
  private streamedCode(key: string, source: string, path?: string): string[] {
    const language = (path ? getLanguageFromPath(path) : undefined) ?? "";
    let known = this.streaming.get(key);
    if (!known || known.language !== language || !source.startsWith(known.source)) {
      this.forgetStream(key);
      known = { source: "", language, head: "", lines: [] };
      this.streaming.set(key, known);
    }
    const lines = source.split("\n");
    const paint = (line: string) =>
      language ? (highlightCode(line, language)[0] ?? "") : this.theme.fg("toolOutput", line);
    // The last line known may still have been growing: redo it and every line after it.
    for (let i = Math.max(0, known.lines.length - 1); i < lines.length; i++)
      known.lines[i] = paint(lines[i]);
    known.lines.length = lines.length;
    const head = lines.slice(0, STREAM_BLOCK_LINES).join("\n");
    if (language && head !== known.head) {
      const block = highlightCode(head, language);
      for (let i = 0; i < block.length; i++) known.lines[i] = block[i];
      known.head = head;
    }
    known.source = source;
    return known.lines;
  }

  /**
   * A write's content while it streams, laid out in chunks of lines, each its own text. Only the
   * chunk that grew is wrapped again: the content grows at its end, so a long write costs each
   * line's wrapping about once, not once per frame.
   */
  private chunked(key: string, lines: readonly string[], width: number): string[] {
    const drawn: string[] = [];
    for (let start = 0, chunk = 0; start < lines.length; start += STREAM_CHUNK_LINES, chunk++) {
      const part = lines.slice(start, start + STREAM_CHUNK_LINES);
      const content = part.join("\n");
      // A text of blank lines draws none: blank lines of code are still lines.
      if (!content.trim()) {
        for (const _ of part) drawn.push("");
        continue;
      }
      const name = `${key}\0chunk\0${chunk}`;
      let cached = this.bodies.get(name);
      if (cached?.text !== content) {
        cached = { revision: 0, text: content, component: new Text(content, 0, 0) };
        this.bodies.set(name, cached);
      }
      for (const line of cached.component.render(width)) drawn.push(line);
      this.chunks.set(key, Math.max(this.chunks.get(key) ?? 0, chunk + 1));
    }
    return drawn;
  }

  /** An output no longer drawn in chunks: its chunks' texts. */
  private forgetChunks(key: string): void {
    const count = this.chunks.get(key) ?? 0;
    for (let chunk = 0; chunk < count; chunk++) this.bodies.delete(`${key}\0chunk\0${chunk}`);
    this.chunks.delete(key);
  }

  /**
   * A write's lines, highlighted: as they streamed in, or once highlighted whole for a write this
   * view did not see stream, such as one loaded from history.
   */
  private writeLines(row: ToolCallState): string[] {
    const content = clean(text(row.args.content));
    const known = this.streaming.get(row.id);
    if (!isComplete(row) || (known?.source === content && known.language))
      return this.streamedCode(row.id, content, row.file?.path);
    const language = (row.file?.path ? getLanguageFromPath(row.file.path) : undefined) ?? "";
    if (known?.source !== content || known.language !== language) {
      this.forgetStream(row.id);
      const lines = language
        ? highlightCode(content, language)
        : content.split("\n").map((line) => this.theme.fg("toolOutput", line));
      this.streaming.set(row.id, { source: content, language, head: "", lines });
    }
    return this.streaming.get(row.id)?.lines ?? [];
  }

  /** A running command's lines: its command if its header left part of it out, then its output. */
  private commandLines(row: ToolCallState): string[] {
    const command = clean(text(row.args.command));
    const elided = !command.trim() || showCommand(command, PLAIN).elided;
    const output = clean(
      row.result?.content
        .filter((part) => part.type === "text")
        .map((part) => text(part.text))
        .join("\n") ?? "",
    );
    return [
      ...(elided && command ? [this.theme.fg("dim", `$ ${command}`)] : []),
      ...(output ? output.split("\n").map((line) => this.theme.fg("toolOutput", line)) : []),
    ];
  }

  /** A write that is no longer streaming: what was kept to draw it as it grew. */
  private forgetStream(key: string): void {
    this.forgetChunks(key);
    this.streaming.delete(key);
  }

  /**
   * The output of a tool Pi does not bound, as Pi bounds its own: its first 2000 lines or 50KB,
   * then a note of how much more there was. JSON is laid out and highlighted, and bounded as it is
   * drawn: laid out, a line of JSON can become thousands.
   */
  private toolOutput(key: string, output: string): string {
    if (!output) return "";
    let cut = bounded(output);
    const laid = cut.truncated ? undefined : laidOut(output);
    if (laid !== undefined) cut = bounded(laid);
    const more = cut.truncated
      ? `\n${this.theme.fg("dim", `Showing the first ${cut.outputLines} of ${cut.totalLines} lines.`)}`
      : "";
    const shown = cut.content;
    if (laid === undefined) return this.theme.fg("toolOutput", shown) + more;
    return this.once(key, "json", shown, () => highlightCode(shown, "json").join("\n")) + more;
  }

  private code(key: string, source: string, path?: string): string {
    const language = path ? getLanguageFromPath(path) : undefined;
    return language
      ? this.once(key, language, source, () => highlightCode(source, language).join("\n"))
      : this.theme.fg("toolOutput", source);
  }
}
