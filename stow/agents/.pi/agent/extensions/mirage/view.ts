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
import type { FileReference } from "../shared/protocol.ts";
import { isComplete, type ToolGroup, type ToolGroups, type ToolRow } from "./model.ts";

import { colouredDiff, paint } from "./style.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC 8 links use ESC/BEL delimiters.
const FILE_LINK_OPEN = /\x1b\]8;[^;\x07\x1b]*;mirage:file:[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const FILE_VERBS = {
  read: { pending: "Read", running: "Reading", success: "Read", error: "Read" },
  edit: { pending: "Edit", running: "Editing", success: "Edited", error: "Edit" },
  write: { pending: "Write", running: "Writing", success: "Wrote", error: "Write" },
};
const GROUP_VERBS = {
  read: { pending: "Explore", running: "Exploring", success: "Explored" },
  bash: { pending: "Run", running: "Running", success: "Ran" },
  edit: FILE_VERBS.edit,
  write: FILE_VERBS.write,
};
export type ToggleTarget = ToolGroup | ToolRow;
type GroupState = Pick<ToolGroups, "epoch" | "expanded"> & { rows: ReadonlyMap<string, ToolRow> };
interface ViewActions {
  toggle(target: ToggleTarget): void;
  openFile(file: FileReference): void;
  outputPad(): number;
  renderImages(width: number): string[];
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

function diff(row: ToolRow): string {
  const details = row.result?.details;
  return details && typeof details === "object" && "diff" in details ? text(details.diff) : "";
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

  constructor(
    readonly row: ToolRow,
    private readonly model: GroupState,
    private readonly actions: ViewActions,
  ) {}

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
      const expanded = this.model.expanded(this.row);
      this.header(this.rowLabel(this.row), this.row, contentWidth);
      if (expanded) this.body(this.row, contentWidth);
    } else {
      const expanded = this.model.expanded(group);
      const completed = group.rows.every(isComplete);
      const running = group.rows.some((row) => row.status === "running");
      const count =
        group.name === "bash"
          ? group.rows.length
          : new Set(
              group.rows.map((row) =>
                row.file ? JSON.stringify([row.file.cwd, row.file.path]) : row.id,
              ),
            ).size;
      const verb = GROUP_VERBS[group.name][completed ? "success" : running ? "running" : "pending"];
      const noun = group.name === "bash" ? "command" : "file";
      const failures = group.rows.filter((row) => row.status === "error").length;
      const status = this.status(
        failures ? "error" : completed ? "success" : "pending",
        group.name === "bash",
      );
      const error = failures ? paint(this.theme, "red", ` (${failures} failed)`) : "";
      this.header(
        `${status} ${verb} ${count} ${noun}${count === 1 ? "" : "s"}${this.editSummary(group.rows)}${error}`,
        group,
        contentWidth,
      );
      for (const row of group.rows) {
        // Failed calls remain discoverable even when their parent group is closed.
        if (!expanded && row.status !== "error") continue;
        const detailExpanded = this.model.expanded(row);
        this.header(`  ${this.rowLabel(row)}`, row, contentWidth);
        if (detailExpanded) this.body(row, contentWidth, 4);
      }
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

  private arrow(expanded: boolean): string {
    return this.theme.fg("dim", expanded ? "▾" : "▸");
  }

  private status(status: ToolRow["status"], command = false): string {
    return status === "error"
      ? paint(this.theme, "red", command ? "$" : "✗")
      : status === "success"
        ? paint(this.theme, "green", command ? "$" : "✓")
        : this.theme.fg("muted", command ? "$" : "…");
  }

  private rowLabel(row: ToolRow): string {
    let label: string;
    if (row.name === "bash") {
      label = clean(text(row.args.command)).replace(/\s+/g, " ").trim() || "…";
    } else {
      let filename = "…";
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
      label = `${FILE_VERBS[row.name][row.status]} ${filename}`;
      if (row.name === "read" && typeof row.args.offset === "number")
        label += this.theme.fg("dim", `:${row.args.offset}`);
      if (row.hasImages) label += this.theme.fg("dim", " (image)");
      if (row.name === "edit") label += this.editSummary([row]);
    }
    return `${this.status(row.status, row.name === "bash")} ${label}`;
  }

  private editSummary(rows: readonly ToolRow[]): string {
    let added = 0,
      removed = 0;
    for (const row of rows) {
      if (row.name !== "edit" || row.status !== "success") continue;
      const counts = diffCounts(diff(row));
      added += counts.added;
      removed += counts.removed;
    }
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

  private body(row: ToolRow, width: number, padding = 2): void {
    if (width <= 0) return;
    const indent = Math.min(padding, Math.max(0, width - 1));
    const bodyWidth = Math.max(1, width - indent);
    const imageLines =
      row.hasImages && getCapabilities().images && this.showImages
        ? this.actions.renderImages(bodyWidth)
        : [];
    let cached = this.bodies.get(row.id);
    if (!cached || cached.revision !== row.revision) {
      let output = clean(
        row.result?.content
          .filter((part) => part.type === "text")
          .map((part) => text(part.text))
          .join("\n") ?? "",
      );
      if (row.status === "error") {
        output = paint(this.theme, "red", output || "Tool failed.");
      } else if (row.name === "edit" && diff(row)) {
        output = colouredDiff(this.theme, clean(diff(row)));
      } else if (row.name === "write") {
        output = this.code(clean(text(row.args.content)), row.file?.path);
      } else if (row.name === "read") {
        output = this.code(output, row.file?.path);
      } else if (row.name === "bash") {
        output =
          this.theme.fg("dim", `$ ${clean(text(row.args.command))}`) +
          (output ? `\n${this.theme.fg("toolOutput", output)}` : "");
      }
      if (imageLines.length === 0) {
        for (const part of row.result?.content ?? []) {
          if (part.type === "image")
            output += `\n${imageFallback(part.mimeType, getImageDimensions(part.data, part.mimeType) ?? undefined)}`;
        }
      }
      cached = { revision: row.revision, component: new Text(output, 0, 0) };
      this.bodies.set(row.id, cached);
    }
    for (const line of [...cached.component.render(bodyWidth), ...imageLines]) {
      this.targets.set(this.rawLines.length, row);
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
