import { homedir } from "node:os";
import { sep } from "node:path";
import { getLanguageFromPath, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
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
import type { FileReference } from "../shared/protocol.ts";
import {
  type Expandable,
  isComplete,
  isFailed,
  type ToolGroup,
  type ToolGroups,
  type ToolKind,
  type ToolRow,
  toolCalls,
} from "./model.ts";
import { scriptOutput } from "./nested.ts";

import { colouredDiff, paint } from "./style.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC 8 links use ESC/BEL delimiters.
const FILE_LINK_OPEN = /\x1b\]8;[^;\x07\x1b]*;mirage:file:[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const FILE_VERBS = {
  read: { pending: "Read", running: "Reading", success: "Read", error: "Read", cancelled: "Read" },
  edit: {
    pending: "Edit",
    running: "Editing",
    success: "Edited",
    error: "Edit",
    cancelled: "Edit",
  },
  write: {
    pending: "Write",
    running: "Writing",
    success: "Wrote",
    error: "Write",
    cancelled: "Write",
  },
};
const GROUP_VERBS: Record<
  Exclude<ToolKind, "model">,
  { pending: string; running: string; success: string; error?: string }
> = {
  read: { pending: "Explore", running: "Exploring", success: "Explored" },
  bash: { pending: "Run", running: "Running", success: "Ran" },
  edit: FILE_VERBS.edit,
  write: FILE_VERBS.write,
  codemode: { pending: "Run", running: "Running", success: "Ran" },
  tool: { pending: "Call", running: "Calling", success: "Called" },
};
const NOUNS = { bash: "command", codemode: "script", tool: "tool" } as const;
export type ToggleTarget = Expandable;
type GroupState = Pick<ToolGroups, "epoch" | "expanded"> & { rows: ReadonlyMap<string, ToolRow> };
interface ViewActions {
  toggle(target: ToggleTarget): void;
  openFile(file: FileReference): void;
  outputPad(): number;
  renderImages(row: ToolRow, width: number): string[];
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

function details(row: ToolRow): Record<string, unknown> | undefined {
  const value = row.result?.details;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function diff(row: ToolRow): string {
  return text(details(row)?.diff);
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** What a call inside a script shows when Pi did not keep its arguments. */
function argumentsNote(row: ToolRow): string {
  if (row.preview) return oneLine(row.preview);
  return row.omittedBytes === undefined ? "" : `${row.omittedBytes} bytes of arguments`;
}

/** Formats a cost as Pi does: cents from one cent up, two significant digits below a cent. */
function formatCost(cost: number): string {
  return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

/**
 * Counts the lines in a write's content. Pi reports no diff for writes, and an overwrite's old
 * content is unknown.
 */
export function writtenLines(content: string): number {
  if (!content) return 0;
  const lines = content.split("\n").length;
  return content.endsWith("\n") ? lines - 1 : lines;
}

export function diffCounts(value: string): { added: number; removed: number } {
  let added = 0,
    removed = 0;
  for (const line of value.split("\n")) {
    if (/^\+\s*\d+ /.test(line)) added++;
    else if (/^-\s*\d+ /.test(line)) removed++;
  }
  return { added, removed };
}

/** What a group's summary counts: a script's tool calls, or the script when it made none. */
function leaves(rows: readonly ToolRow[]): ToolRow[] {
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
  private targets = new Map<number, ToggleTarget>();
  private files = new Map<string, FileReference>();
  private cache?: {
    group: ToolGroup;
    width: number;
    padding: number;
    revision: number;
    epoch: number;
    lines: string[];
  };
  private bodies = new Map<string, { revision: number; component: Text }>();
  readonly row: ToolRow;
  private readonly model: GroupState;
  private readonly actions: ViewActions;

  constructor(row: ToolRow, model: GroupState, actions: ViewActions) {
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
    this.cache = undefined;
    // Keep hit targets for the last painted frame until render replaces them.
    // Clearing them here swallows clicks during asynchronous theme/grammar loads.
    this.bodies.clear();
  }

  render(width: number): string[] {
    const group = this.row.group;
    if (this.model.rows.get(this.row.id) !== this.row || group.rows[0] !== this.row) return [];
    const padding = Math.min(this.actions.outputPad(), Math.max(0, Math.floor((width - 1) / 2)));
    const contentWidth = Math.max(0, width - padding * 2);
    if (
      this.cache?.group === group &&
      this.cache.width === width &&
      this.cache.padding === padding &&
      this.cache.revision === group.revision &&
      this.cache.epoch === this.model.epoch
    )
      return this.cache.lines;

    this.rawLines = [];
    this.targets.clear();
    this.files.clear();
    if (group.rows.length === 1) {
      this.entry(this.row, 0, contentWidth);
    } else {
      const expanded = this.model.expanded(group);
      const commandsOnly = group.rows.every((row) => row.kind === "bash");
      // Like Amp: a group is red only when every call failed. Individual failures
      // show on their own rows once the group is opened.
      let state: ToolRow["status"] = "success";
      if (!group.rows.every(isComplete)) state = "pending";
      else if (group.rows.every(isFailed)) state = "error";
      const status = this.status(state, commandsOnly);
      this.header(`${status} ${this.summary(leaves(group.rows))}`, group, contentWidth);
      if (expanded) for (const row of group.rows) this.entry(row, 2, contentWidth);
    }
    // Hit testing uses these padded lines, including after invalidation until
    // the next render. Reserve the same inset on the right as Pi.
    this.rawLines = this.rawLines.map((line) => " ".repeat(padding) + line);
    const lines = this.rawLines.map((line) => line.replace(FILE_LINK_OPEN, ""));
    this.cache = {
      group,
      width,
      padding,
      revision: group.revision,
      epoch: this.model.epoch,
      lines,
    };
    return lines;
  }

  capture(line: number, width: number): RowAnchor | undefined {
    if (!this.render(width).length) return undefined;
    // The summary line stays put when a merge or expansion changes the group.
    if (line <= 0) return { key: this.row, offset: line, top: true };
    const target = this.targets.get(line);
    if (!target) return undefined;
    let key: object = target;
    if ("rows" in target) key = this.row;
    else if ("script" in target) key = target.script;
    const start = [...this.targets].find(([, value]) => value === target)?.[0] ?? 0;
    return { key, offset: line - start };
  }

  locate(anchor: RowAnchor, width: number): number | undefined {
    if (
      !this.render(width).length ||
      !this.row.group.rows.some(
        (row) => row === anchor.key || row.calls?.includes(anchor.key as ToolRow),
      )
    )
      return undefined;
    if (anchor.top) return anchor.offset;
    const lines = [...this.targets]
      .filter(([, target]) => target === anchor.key)
      .map(([line]) => line);
    // A collapsed group represents every member on its summary line.
    if (!lines.length) return 0;
    return lines[0] + Math.min(anchor.offset, lines.length - 1);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "click" || event.button !== "left") return undefined;
    const target = this.targets.get(event.y);
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

  /** One call: its header, then its output or, for a script, its calls and output. */
  private entry(row: ToolRow, indent: number, width: number): void {
    this.header(`${" ".repeat(indent)}${this.rowLabel(row)}`, row, width);
    if (!this.model.expanded(row)) return;
    if (row.kind === "codemode") this.script(row, indent + 2, width);
    else this.body(row, width, indent + 2);
  }

  private arrow(expanded: boolean): string {
    return this.theme.fg("dim", expanded ? "▾" : "▸");
  }

  private status(status: ToolRow["status"], command = false): string {
    if (status === "error") return paint(this.theme, "red", command ? "$" : "✗");
    if (status === "success") return paint(this.theme, "green", command ? "$" : "✓");
    if (command) return this.theme.fg("muted", "$");
    return this.theme.fg("muted", status === "cancelled" ? "✗" : "…");
  }

  private rowLabel(row: ToolRow): string {
    let label: string;
    if (row.kind === "bash") {
      label = oneLine(text(row.args.command)) || argumentsNote(row) || "…";
    } else if (row.kind === "codemode") {
      const summary = this.summary(toolCalls(row), true);
      label = summary ? `Script: ${summary}` : "Script";
    } else if (row.kind === "tool" || row.kind === "model") {
      // Headers truncate anyway: clean only what one line can show.
      const args =
        row.kind === "model" || !Object.keys(row.args).length
          ? argumentsNote(row)
          : oneLine(json(row.args).slice(0, 400));
      label = oneLine(row.name);
      if (args) label += ` ${this.theme.fg("dim", args)}`;
      if (row.cost) label += ` ${this.theme.fg("dim", formatCost(row.cost))}`;
    } else {
      const note = argumentsNote(row);
      let filename = note ? this.theme.fg("dim", note) : "…";
      if (row.file) {
        const path = row.file.path;
        const home = homedir();
        const display = path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
        const url = `mirage:file:${encodeURIComponent(row.id)}`;
        this.files.set(url, row.file);
        filename = hyperlink(
          this.theme.underline(paint(this.theme, "blue", clean(display).replace(/\n/g, " "))),
          url,
        );
      }
      label = `${FILE_VERBS[row.kind][row.status]} ${filename}`;
      if (row.kind === "read" && typeof row.args.offset === "number")
        label += this.theme.fg("dim", `:${row.args.offset}`);
      if (row.hasImages) label += this.theme.fg("dim", " (image)");
      if (row.kind === "edit" || row.kind === "write") label += this.changeSummary([row]);
    }
    return `${this.status(row.status, row.kind === "bash")} ${label}`;
  }

  /** `Read 2 files, ran 1 command`: counts per kind, in first-call order. */
  private summary(rows: readonly ToolRow[], lower = false): string {
    const kinds = [...new Set(rows.flatMap((row) => (row.kind === "model" ? [] : [row.kind])))];
    return kinds
      .map((kind, index) => {
        const members = rows.filter((row) => row.kind === kind);
        let state: "pending" | "running" | "success" = "pending";
        if (members.every(isComplete)) state = "success";
        else if (members.some((row) => row.status === "running")) state = "running";
        const verbs = kind === "read" && kinds.length > 1 ? FILE_VERBS.read : GROUP_VERBS[kind];
        // All-failed edits/writes did not happen: use the failed-row verb.
        const word = verbs.error && members.every(isFailed) ? verbs.error : verbs[state];
        const verb = index || lower ? word.toLowerCase() : word;
        // Commands, scripts and other tools count per call. File tools count distinct files.
        const counted = kind === "bash" || kind === "codemode" || kind === "tool";
        const count = counted
          ? members.length
          : new Set(
              members.map((row) =>
                row.file ? JSON.stringify([row.file.cwd, row.file.path]) : row.id,
              ),
            ).size;
        const noun = counted ? NOUNS[kind] : "file";
        return `${verb} ${count} ${noun}${count === 1 ? "" : "s"}${this.changeSummary(members, true)}`;
      })
      .join(", ");
  }

  /**
   * Sums successful edits' diffs and writes' lines. Rows show coloured `+A −R`. Group
   * summaries, like Amp, show plain `(+A −R)` in grey brackets.
   */
  private changeSummary(rows: readonly ToolRow[], group = false): string {
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

  private header(label: string, target: ToggleTarget, width: number): void {
    this.targets.set(this.rawLines.length, target);
    const arrow = this.arrow(this.model.expanded(target));
    // Keep the caret visible even when the filename or command is truncated.
    this.rawLines.push(
      width > 2 ? `${truncateToWidth(label, width - 2)} ${arrow}` : truncateToWidth(arrow, width),
    );
  }

  /** A script: its source behind its own toggle, the calls it made, then its output. */
  private script(row: ToolRow, indent: number, width: number): void {
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
          () => highlightCode(source, "javascript").join("\n"),
          row.source,
          width,
          indent + 2,
        );
    }
    for (const call of row.calls ?? []) this.entry(call, indent, width);
    this.body(row, width, indent);
  }

  private body(row: ToolRow, width: number, padding = 2): void {
    if (width <= 0) return;
    const indent = Math.min(padding, Math.max(0, width - 1));
    const bodyWidth = Math.max(1, width - indent);
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
      const unkept = this.theme.fg("dim", "Output not kept in session.");
      if (row.status === "error") {
        output = paint(this.theme, "red", output || "Tool failed.");
      } else if (row.status === "cancelled") {
        output = this.theme.fg("muted", output || "Cancelled when the script ended.");
      } else if (row.kind === "edit" && diff(row)) {
        output = colouredDiff(this.theme, clean(diff(row)));
        if (details(row)?.rebuilt)
          output += `\n${this.theme.fg("dim", "Rebuilt from saved arguments, with line numbers relative to the replaced text.")}`;
      } else if (row.kind === "write") {
        output = this.code(clean(text(row.args.content)), row.file?.path);
      } else if (row.kind === "bash") {
        output =
          this.theme.fg("dim", `$ ${clean(text(row.args.command))}`) +
          (output ? `\n${this.theme.fg("toolOutput", output)}` : "") +
          (missing ? `\n${unkept}` : "");
      } else if (row.kind === "model") {
        output = this.theme.fg("dim", "Result returned to the script.");
      } else if (missing) {
        output = unkept;
      } else if (row.kind === "read") {
        output = this.code(output, row.file?.path);
      } else if (row.kind === "codemode" || row.kind === "tool") {
        output = this.theme.fg("toolOutput", output);
      }
      if (imageLines.length === 0) {
        for (const part of row.result?.content ?? []) {
          if (part.type === "image")
            output += `\n${imageFallback(part.mimeType, getImageDimensions(part.data, part.mimeType) ?? undefined)}`;
        }
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
    if (!cached || cached.revision !== revision) {
      cached = { revision, component: new Text(build(), 0, 0) };
      this.bodies.set(key, cached);
    }
    return cached.component;
  }

  private addLines(lines: readonly string[], target: ToggleTarget, indent: number): void {
    for (const line of lines) {
      this.targets.set(this.rawLines.length, target);
      this.rawLines.push(" ".repeat(indent) + line);
    }
  }

  private code(source: string, path?: string): string {
    const language = path ? getLanguageFromPath(path) : undefined;
    return language
      ? highlightCode(source, language).join("\n")
      : this.theme.fg("toolOutput", source);
  }
}
