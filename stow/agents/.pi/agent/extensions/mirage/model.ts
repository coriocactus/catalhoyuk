import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { FileReference, FileToolName } from "../shared/protocol.ts";

export type ToolName = FileToolName | "bash";
export type ToolArgs = Readonly<Record<string, unknown>>;
export type ToolStatus = "pending" | "running" | "success" | "error";
type Expansion = { epoch: number; value: boolean };

export interface ToolRow {
  id: string;
  name: ToolName;
  args: ToolArgs;
  file?: FileReference;
  group: ToolGroup;
  result?: AgentToolResult<unknown>;
  status: ToolStatus;
  hasImages: boolean;
  revision: number;
  expansion?: Expansion;
}

export interface ToolGroup {
  name: ToolName;
  rows: ToolRow[];
  revision: number;
  expansion?: Expansion;
}

const TOOL_NAMES: ReadonlySet<string> = new Set(["read", "bash", "edit", "write"]);

export function normalizeArgs(value: unknown): ToolArgs {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? ({ ...value } as ToolArgs)
    : {};
}

export function isComplete(row: ToolRow): boolean {
  return row.status === "success" || row.status === "error";
}

function canJoin(group: ToolGroup | undefined, name: ToolName): group is ToolGroup {
  return (
    !!group &&
    group.name === name &&
    (name === "read" || name === "bash" || name === "edit") &&
    !group.rows.some((row) => row.hasImages)
  );
}

/** Owns group membership, normalized snapshots, and expansion choices. No TUI or I/O. */
export class ToolGroups {
  readonly rows = new Map<string, ToolRow>();
  private readonly seen = new Set<string>();
  private tail?: ToolGroup;
  private mergeCandidate?: ToolGroup;
  private allExpanded = false;
  epoch = 0;

  reset(): void {
    this.rows.clear();
    this.seen.clear();
    this.boundary();
    this.epoch++;
  }

  boundary(): void {
    this.tail = undefined;
    this.mergeCandidate = undefined;
  }

  startMessage(message: AgentMessage, cwd: string): void {
    if (message.role === "assistant") {
      this.mergeCandidate = this.tail;
      this.tail = undefined;
    } else if (message.role !== "toolResult") {
      this.boundary();
    }
    this.observe(message, cwd);
  }

  finishMessage(message: AgentMessage, cwd: string): void {
    this.observe(message, cwd);
    if (message.role !== "assistant") return;
    const previous = this.mergeCandidate;
    this.mergeCandidate = undefined;
    // Commentary/thinking may arrive after a tool call but render before it.
    if (
      !previous ||
      message.stopReason === "error" ||
      message.stopReason === "aborted" ||
      message.content.some((block) => block.type !== "toolCall")
    )
      return;
    const first = message.content[0];
    const current = first?.type === "toolCall" ? this.rows.get(first.id)?.group : undefined;
    if (
      !current ||
      current === previous ||
      !canJoin(previous, current.name) ||
      current.rows.some((row) => row.hasImages)
    )
      return;
    const keepOpen = this.groupVisible(previous) || this.groupVisible(current);
    for (const row of current.rows) row.group = previous;
    previous.rows.push(...current.rows);
    if (keepOpen) previous.expansion = { epoch: this.epoch, value: true };
    previous.revision++;
    if (this.tail === current) this.tail = previous;
    current.rows = [];
    current.revision++;
  }

  addCall(id: string, name: string, args: unknown, cwd: string): ToolRow | undefined {
    const existing = this.rows.get(id);
    if (existing) {
      this.updateCall(existing, args, cwd);
      return existing;
    }
    if (!TOOL_NAMES.has(name)) {
      if (!this.seen.has(id)) this.tail = undefined;
      this.seen.add(id);
      return undefined;
    }
    this.seen.add(id);
    const tool = name as ToolName;
    const group: ToolGroup = canJoin(this.tail, tool)
      ? this.tail
      : { name: tool, rows: [], revision: 0 };
    const keepOpen = this.groupVisible(group);
    const row: ToolRow = {
      id,
      name: tool,
      args: {},
      group,
      status: "pending",
      hasImages: false,
      revision: 0,
    };
    group.rows.push(row);
    if (keepOpen) group.expansion = { epoch: this.epoch, value: true };
    this.rows.set(id, row);
    this.tail = group;
    this.updateCall(row, args, cwd);
    return row;
  }

  private updateCall(row: ToolRow, value: unknown, cwd: string): void {
    row.args = normalizeArgs(value);
    const path = row.args.path ?? row.args.file_path;
    row.file =
      row.name !== "bash" && typeof path === "string" && path.length > 0
        ? { path, cwd, tool: row.name }
        : undefined;
    this.changed(row);
  }

  markStarted(row: ToolRow): void {
    if (row.status !== "pending") return;
    row.status = "running";
    this.changed(row);
  }

  updateResult(
    row: ToolRow,
    result: AgentToolResult<unknown>,
    partial: boolean,
    failed: boolean,
  ): void {
    row.result = result;
    row.status = failed ? "error" : partial ? "running" : "success";
    if (!row.hasImages && result.content.some((part) => part.type === "image")) {
      row.hasImages = true;
      this.isolateImage(row);
    }
    this.changed(row);
  }

  observe(message: AgentMessage, cwd: string): void {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") this.addCall(block.id, block.name, block.arguments, cwd);
      }
    } else if (message.role === "toolResult") {
      const row = this.rows.get(message.toolCallId);
      if (row)
        this.updateResult(
          row,
          { content: message.content, details: message.details },
          false,
          message.isError,
        );
    }
  }

  setAllExpanded(value: boolean): void {
    if (value === this.allExpanded) return;
    this.allExpanded = value;
    this.epoch++;
  }

  expanded(item: ToolGroup | ToolRow): boolean {
    return item.expansion?.epoch === this.epoch ? item.expansion.value : this.allExpanded;
  }

  toggle(item: ToolGroup | ToolRow): void {
    item.expansion = { epoch: this.epoch, value: !this.expanded(item) };
    if ("group" in item) this.changed(item);
    else item.revision++;
  }

  private groupVisible(group: ToolGroup): boolean {
    return group.rows.length === 1
      ? this.expanded(group.rows[0])
      : group.rows.length > 1 && this.expanded(group);
  }

  /** Pi owns inline images outside our component. Never hide their filename in a group. */
  private isolateImage(row: ToolRow): void {
    const previous = row.group;
    if (previous.rows.length === 1) return;
    const expanded = this.expanded(previous);
    const position = previous.rows.indexOf(row);
    const pieces = [
      previous.rows.slice(0, position),
      [row],
      previous.rows.slice(position + 1),
    ].filter((rows) => rows.length);
    const groups = pieces.map((rows): ToolGroup => {
      const group: ToolGroup = {
        name: previous.name,
        rows,
        revision: 0,
        expansion: { epoch: this.epoch, value: expanded },
      };
      for (const member of rows) {
        if (rows.length === 1 && !expanded && member.status !== "error") {
          member.expansion = { epoch: this.epoch, value: false };
        }
        member.group = group;
      }
      return group;
    });
    const last = groups.at(-1);
    if (this.tail === previous) this.tail = last;
    if (this.mergeCandidate === previous) this.mergeCandidate = last;
    previous.rows = [];
    previous.revision++;
  }

  private changed(row: ToolRow): void {
    row.revision++;
    row.group.revision++;
  }
}
