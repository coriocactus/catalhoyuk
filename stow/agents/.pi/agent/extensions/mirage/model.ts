import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { FileReference, FileToolName } from "../shared/protocol.ts";

export type ToolName = FileToolName | "bash";
export type ToolArgs = Readonly<Record<string, unknown>>;
export type ToolStatus = "pending" | "running" | "success" | "error";
type Expansion = { epoch: number; value: boolean };
type Fence = { kind: "hard" | "thinking" | "none" };

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

/** Owns group membership, normalized snapshots, and expansion choices. No TUI or I/O. */
export class ToolGroups {
  readonly rows = new Map<string, ToolRow>();
  private readonly seen = new Set<string>();
  private tail?: ToolGroup;
  private allExpanded = false;
  private thinkingHidden = false;
  private sequence: (ToolRow | Fence)[] = [];
  private messageFence?: Fence;
  epoch = 0;

  reset(): void {
    this.rows.clear();
    this.seen.clear();
    this.boundary();
    this.sequence = [];
    this.epoch++;
  }

  boundary(): void {
    this.sequence.push({ kind: "hard" });
    this.tail = undefined;
    this.messageFence = undefined;
  }

  private separates(fence: Fence): boolean {
    return fence.kind === "hard" || (fence.kind === "thinking" && !this.thinkingHidden);
  }

  setThinkingHidden(hidden: boolean): void {
    if (this.thinkingHidden === hidden) return;
    this.thinkingHidden = hidden;
    this.regroup();
  }

  startMessage(message: AgentMessage, cwd: string): void {
    if (message.role === "assistant") {
      // Optimistic: a streaming call joins the run at once. Visible commentary
      // or thinking arriving later turns this fence into a separator.
      this.messageFence = { kind: "none" };
      this.sequence.push(this.messageFence);
    } else if (message.role !== "toolResult") {
      this.boundary();
    }
    this.observe(message, cwd);
  }

  finishMessage(message: AgentMessage, cwd: string): void {
    this.observe(message, cwd);
    if (message.role !== "assistant") return;
    this.messageFence = undefined;
    if (["error", "aborted", "length"].includes(message.stopReason)) this.boundary();
  }

  /** Classify the in-flight message before adding its calls, so fences precede rows. */
  private classify(message: Extract<AgentMessage, { role: "assistant" }>): void {
    const fence = this.messageFence;
    if (!fence) return;
    const kind = ["error", "aborted", "length"].includes(message.stopReason)
      ? "hard"
      : message.content.some((block) => block.type === "text" && block.text.trim())
        ? "hard"
        : message.content.some((block) => block.type === "thinking" && block.thinking.trim())
          ? "thinking"
          : "none";
    if (kind === fence.kind) return;
    const before = this.separates(fence);
    fence.kind = kind;
    if (before === this.separates(fence)) return;
    // Usually nothing follows the fence yet, so this only changes the tail.
    if (this.sequence.at(-1) === fence)
      this.tail = this.separates(fence) ? undefined : this.lastRunGroup();
    else this.regroup();
  }

  private lastRunGroup(): ToolGroup | undefined {
    for (let i = this.sequence.length - 1; i >= 0; i--) {
      const item = this.sequence[i];
      if ("id" in item) return item.group;
      if (this.separates(item)) return undefined;
    }
    return undefined;
  }

  addCall(id: string, name: string, args: unknown, cwd: string): ToolRow | undefined {
    const existing = this.rows.get(id);
    if (existing) {
      this.updateCall(existing, args, cwd);
      return existing;
    }
    if (!TOOL_NAMES.has(name)) {
      if (!this.seen.has(id)) {
        this.sequence.push({ kind: "hard" });
        this.tail = undefined;
      }
      this.seen.add(id);
      return undefined;
    }
    this.seen.add(id);
    const tool = name as ToolName;
    const group: ToolGroup = this.tail ?? { rows: [], revision: 0 };
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
    this.sequence.push(row);
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
    row.hasImages = result.content.some((part) => part.type === "image");
    this.changed(row);
  }

  observe(message: AgentMessage, cwd: string): void {
    if (message.role === "assistant") {
      this.classify(message);
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

  /** Reconstruct the loaded range without invalidating existing components or local choices. */
  replace(source: ToolGroups): void {
    const retained = new Map<string, ToolRow>();
    for (const snapshot of source.rows.values()) {
      const row = this.rows.get(snapshot.id) ?? snapshot;
      if (row !== snapshot) {
        row.args = snapshot.args;
        row.file = snapshot.file;
        row.result = snapshot.result;
        row.status = snapshot.status;
        row.hasImages = snapshot.hasImages;
        row.revision++;
      } else {
        row.group.expansion = undefined;
      }
      retained.set(row.id, row);
    }
    this.rows.clear();
    for (const [id, row] of retained) this.rows.set(id, row);
    this.seen.clear();
    for (const id of source.seen) this.seen.add(id);
    this.sequence = source.sequence.map((item) =>
      "id" in item ? (retained.get(item.id) ?? item) : item,
    );
    this.messageFence = undefined;
    this.regroup();
  }

  /**
   * Publish row identities for native page construction, but do not change the
   * live sequence until construction succeeds. A failed page can be discarded.
   * No persisted snapshot is allowed to overwrite a live/streaming row.
   */
  stagePrepend(source: ToolGroups): { commit(): void; rollback(): void } {
    const added = new Set<string>();
    const seen = new Set<string>();
    for (const row of source.rows.values()) {
      if (this.rows.has(row.id)) continue;
      row.group.expansion = undefined;
      this.rows.set(row.id, row);
      added.add(row.id);
    }
    // Rendering an archived call must never append a fence to the live range.
    for (const id of source.seen) {
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      seen.add(id);
    }
    let settled = false;
    return {
      commit: () => {
        if (settled) return;
        settled = true;
        const records = source.sequence.filter((item) => !("id" in item) || added.has(item.id));
        this.sequence = [...records, ...this.sequence];
        this.regroup();
      },
      rollback: () => {
        if (settled) return;
        settled = true;
        for (const id of added) this.rows.delete(id);
        for (const id of seen) this.seen.delete(id);
      },
    };
  }

  /** Visibility/range changes replay fences; streaming updates stay incremental. */
  private regroup(): void {
    const runs: ToolRow[][] = [];
    let run: ToolRow[] | undefined;
    for (const item of this.sequence) {
      if (!("id" in item)) {
        if (this.separates(item)) run = undefined;
        continue;
      }
      if (!run) {
        run = [];
        runs.push(run);
      }
      run.push(item);
    }
    // Capture old visibility before changing any group membership.
    const assignments = runs.map((rows) => ({
      rows,
      group: rows[0].group.rows[0] === rows[0] ? rows[0].group : { rows: [], revision: 0 },
      open: rows.some((row) => this.groupVisible(row.group)),
    }));
    const tailRow = run?.at(-1);
    for (const { rows, group, open } of assignments) {
      group.rows = rows;
      group.expansion = { epoch: this.epoch, value: open };
      group.revision++;
      for (const row of rows) row.group = group;
    }
    this.tail = tailRow?.group;
  }

  private changed(row: ToolRow): void {
    row.revision++;
    row.group.revision++;
  }
}
