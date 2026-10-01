import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { FileReference, FileToolName } from "../shared/protocol.ts";
import {
  type CallStatus,
  isModelCall,
  isPlaceholder,
  previewArgs,
  rebuiltDiff,
  type SavedCall,
  savedCalls,
  scriptCalls,
} from "./nested.ts";

export type ToolName = FileToolName | "bash" | "codemode";
/**
 * Row kinds. Calls inside scripts may use any tool (`tool`) or the script's `models` API
 * (`model`).
 */
export type ToolKind = ToolName | "tool" | "model";
export type ToolArgs = Readonly<Record<string, unknown>>;
export type ToolStatus = "pending" | CallStatus;
type Expansion = { epoch: number; value: boolean };
type Fence = { kind: "hard" | "thinking" | "none" };

export interface ToolRow {
  id: string;
  name: string;
  kind: ToolKind;
  args: ToolArgs;
  cwd: string;
  file?: FileReference;
  group: ToolGroup;
  /** The script that made this call. */
  parent?: ToolRow;
  /** Calls a script made, in start order. */
  calls?: ToolRow[];
  /** The toggle for a script's source. */
  source?: ScriptSource;
  result?: AgentToolResult<unknown>;
  status: ToolStatus;
  hasImages: boolean;
  revision: number;
  expansion?: Expansion;
  /** A call this runtime did not see run: Pi saved its arguments and status, not its output. */
  saved?: boolean;
  /**
   * Shown in place of arguments Pi did not keep: their `details.calls` preview, or a model
   * reference.
   */
  preview?: string;
  /** Size in bytes of arguments Pi did not keep. */
  omittedBytes?: number;
  cost?: number;
}

export interface ToolGroup {
  rows: ToolRow[];
  revision: number;
  expansion?: Expansion;
}

export interface ScriptSource {
  script: ToolRow;
  expansion?: Expansion;
}

export type Expandable = ToolGroup | ToolRow | ScriptSource;

export const TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "codemode",
] satisfies ToolName[]);
/** Built-in tools whose calls keep their own kind inside scripts. */
const BUILT_IN_KINDS: ReadonlySet<string> = new Set(["read", "bash", "edit", "write"]);

export function normalizeArgs(value: unknown): ToolArgs {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? ({ ...value } as ToolArgs)
    : {};
}

export function isFailed(row: ToolRow): boolean {
  return row.status === "error" || row.status === "cancelled";
}

export function isComplete(row: ToolRow): boolean {
  return row.status === "success" || isFailed(row);
}

/** Calls a script made through tools, not its `models` calls. */
export function toolCalls(row: ToolRow): ToolRow[] {
  return row.calls?.filter((call) => call.kind !== "model") ?? [];
}

function kindOf(name: string): ToolKind {
  if (isModelCall(name)) return "model";
  if (BUILT_IN_KINDS.has(name)) return name as ToolName;
  return "tool";
}

/** Keeps the content and details that rendering uses, never `structuredContent` or usage. */
function retained(result: AgentToolResult<unknown>): AgentToolResult<unknown> {
  return {
    content: Array.isArray(result?.content) ? result.content : [],
    details: result?.details,
  };
}

/** Owns group membership, normalized snapshots, and expansion choices. No TUI or I/O. */
export class ToolGroups {
  readonly rows = new Map<string, ToolRow>();
  /** Calls inside scripts, by their own ids, such as `<script id>/<n>`. */
  private readonly nested = new Map<string, ToolRow>();
  private readonly seen = new Set<string>();
  private readonly managed: (name: string) => boolean;
  private tail?: ToolGroup;
  private allExpanded = false;
  private thinkingHidden = false;
  private sequence: (ToolRow | Fence)[] = [];
  private messageFence?: Fence;
  epoch = 0;

  /** `managed` decides which top-level tools join groups. Any other call is a boundary. */
  constructor(managed: (name: string) => boolean = () => true) {
    this.managed = (name) => TOOL_NAMES.has(name) && managed(name);
  }

  reset(): void {
    this.rows.clear();
    this.nested.clear();
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
    if (!this.managed(name)) {
      if (!this.seen.has(id)) {
        this.sequence.push({ kind: "hard" });
        this.tail = undefined;
      }
      this.seen.add(id);
      return undefined;
    }
    this.seen.add(id);
    const group: ToolGroup = this.tail ?? { rows: [], revision: 0 };
    const keepOpen = this.groupVisible(group);
    const row = this.createRow(id, name, name as ToolName, cwd, group);
    group.rows.push(row);
    if (keepOpen) group.expansion = { epoch: this.epoch, value: true };
    this.rows.set(id, row);
    this.sequence.push(row);
    this.tail = group;
    this.updateCall(row, args, cwd);
    return row;
  }

  private createRow(
    id: string,
    name: string,
    kind: ToolKind,
    cwd: string,
    group: ToolGroup,
    parent?: ToolRow,
  ): ToolRow {
    const row: ToolRow = {
      id,
      name,
      kind,
      args: {},
      cwd,
      group,
      parent,
      status: "pending",
      hasImages: false,
      revision: 0,
    };
    if (kind === "codemode") {
      row.calls = [];
      row.source = { script: row };
    }
    return row;
  }

  private updateCall(row: ToolRow, value: unknown, cwd: string): void {
    row.args = normalizeArgs(value);
    row.cwd = cwd;
    const path = row.args.path ?? row.args.file_path;
    row.file =
      (row.kind === "read" || row.kind === "edit" || row.kind === "write") &&
      typeof path === "string" &&
      path.length > 0
        ? { path, cwd, tool: row.kind }
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
    record?: unknown,
  ): void {
    this.applyResult(row, result, partial, failed);
    if (row.kind === "codemode") this.updateScript(row, row.result?.details, record, !partial);
    this.changed(row);
  }

  private applyResult(
    row: ToolRow,
    result: AgentToolResult<unknown>,
    partial: boolean,
    failed: boolean,
  ): void {
    row.result = retained(result);
    if (failed) row.status = "error";
    else if (partial) row.status = "running";
    else row.status = "success";
    row.hasImages = row.result.content.some((part) => part.type === "image");
  }

  /** A live call inside a script started. Returns the script to redraw. */
  startNested(
    parentId: string,
    id: string,
    name: string,
    args: unknown,
    cwd: string,
  ): ToolRow | undefined {
    const script = this.scriptOf(parentId);
    if (!script) return undefined;
    const row = this.nestedRow(script, id, name, cwd);
    row.saved = false;
    row.preview = undefined;
    row.omittedBytes = undefined;
    row.status = "running";
    this.updateCall(row, args, cwd);
    return script;
  }

  /** A live call inside a script reported output. Returns the script to redraw. */
  updateNested(
    id: string,
    result: AgentToolResult<unknown>,
    partial: boolean,
    failed: boolean,
  ): ToolRow | undefined {
    const row = this.nested.get(id);
    if (!row?.parent) return undefined;
    row.saved = false;
    this.applyResult(row, result, partial, failed);
    this.changed(row);
    return row.parent;
  }

  /** Finds the script a call belongs to. Calls made by a script's calls belong to the script. */
  private scriptOf(id: string): ToolRow | undefined {
    let row = this.rows.get(id) ?? this.nested.get(id);
    while (row?.parent) row = row.parent;
    return row?.kind === "codemode" ? row : undefined;
  }

  private nestedRow(script: ToolRow, id: string, name: string, cwd: string): ToolRow {
    const existing = this.nested.get(id);
    if (existing?.parent === script) return existing;
    const row = this.createRow(id, name, kindOf(name), cwd, script.group, script);
    row.status = "running";
    script.calls?.push(row);
    this.nested.set(id, row);
    return row;
  }

  /**
   * Merges the script's `details.calls` and its saved `nestedCalls` into its calls. Calls seen
   * live keep their outputs. `details.calls` adds `models` calls and final statuses, and
   * `nestedCalls` adds calls this runtime never saw. Calls still running when the script ends
   * become cancelled.
   */
  private updateScript(script: ToolRow, details: unknown, record: unknown, final: boolean): void {
    const saved = new Map(savedCalls(record).map((call) => [call.id, call]));
    const remaining = new Map(saved);
    const listed = scriptCalls(details);
    for (const call of listed) if (!isPlaceholder(call.id)) remaining.delete(call.id);
    for (const call of listed) {
      if (isModelCall(call.name)) {
        const row = this.nestedRow(script, call.id, call.name, script.cwd);
        if (row.preview !== call.preview || row.cost !== call.cost) {
          row.preview = call.preview;
          row.cost = call.cost;
          this.changed(row);
        }
        this.settle(row, call.status, call.error);
        continue;
      }
      let match = saved.get(call.id);
      if (!match && isPlaceholder(call.id)) {
        match = [...remaining.values()].find((entry) => entry.name === call.name);
        if (match) remaining.delete(match.id);
      }
      const id = match?.id ?? (isPlaceholder(call.id) ? undefined : call.id);
      if (!id) continue; // Still running: its live events supply the row.
      const row = this.nestedRow(script, id, call.name, script.cwd);
      if (match) this.restore(row, match);
      else if (row.saved !== false && !Object.keys(row.args).length) {
        // Without `nestedCalls`, the `details.calls` preview is the only copy of the arguments.
        const args = previewArgs(call.preview);
        row.saved = true;
        if (args) this.updateCall(row, args, row.cwd);
        else row.preview = call.preview;
      }
      this.settle(row, call.status, call.error);
    }
    for (const call of remaining.values()) {
      const row = this.nestedRow(script, call.id, call.name, script.cwd);
      this.restore(row, call);
      this.settle(row, call.status, call.error);
    }
    if (final)
      for (const row of script.calls ?? [])
        if (!isComplete(row)) this.settle(row, "cancelled", undefined);
  }

  /** Restores the saved arguments of a call this runtime did not see run. */
  private restore(row: ToolRow, call: SavedCall): void {
    if (row.saved === false) return;
    row.saved = true;
    if (call.args) this.updateCall(row, call.args, row.cwd);
    else row.omittedBytes = call.omittedBytes;
    if (row.kind === "edit" && call.status === "success" && call.args) {
      const diff = rebuiltDiff(call.args);
      if (diff) row.result = { content: [], details: { diff, rebuilt: true } };
    }
  }

  /**
   * Applies a final status from `details.calls` or `nestedCalls`. Statuses and outputs seen
   * live stay.
   */
  private settle(row: ToolRow, status: CallStatus, error: string | undefined): void {
    if (status === "running") return; // Live events report progress.
    if (row.saved === false && isComplete(row)) return; // A live final status stays.
    const unchanged = row.status === status && (!error || row.result !== undefined);
    if (unchanged) return;
    row.status = status;
    if (error && (row.saved !== false || !row.result))
      row.result = { content: [{ type: "text", text: error }], details: row.result?.details };
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
          message.nestedCalls,
        );
    }
  }

  setAllExpanded(value: boolean): void {
    if (value === this.allExpanded) return;
    this.allExpanded = value;
    this.epoch++;
  }

  expanded(item: Expandable): boolean {
    return item.expansion?.epoch === this.epoch ? item.expansion.value : this.allExpanded;
  }

  toggle(item: Expandable): void {
    item.expansion = { epoch: this.epoch, value: !this.expanded(item) };
    if ("script" in item) this.changed(item.script);
    else if ("rows" in item) item.revision++;
    else this.changed(item);
  }

  private groupVisible(group: ToolGroup): boolean {
    return group.rows.length === 1
      ? this.expanded(group.rows[0])
      : group.rows.length > 1 && this.expanded(group);
  }

  /** Reconstruct the loaded range without invalidating existing components or local choices. */
  replace(source: ToolGroups): void {
    const retainedRows = new Map<string, ToolRow>();
    for (const snapshot of source.rows.values()) {
      const row = this.rows.get(snapshot.id) ?? snapshot;
      if (row !== snapshot) {
        row.args = snapshot.args;
        row.cwd = snapshot.cwd;
        row.file = snapshot.file;
        row.result = snapshot.result;
        row.status = snapshot.status;
        row.hasImages = snapshot.hasImages;
        if (snapshot.calls) row.calls = this.mergeCalls(row, snapshot.calls);
        row.revision++;
      } else {
        row.group.expansion = undefined;
      }
      retainedRows.set(row.id, row);
    }
    this.rows.clear();
    this.nested.clear();
    for (const [id, row] of retainedRows) {
      this.rows.set(id, row);
      this.indexCalls(row);
    }
    this.seen.clear();
    for (const id of source.seen) this.seen.add(id);
    this.sequence = source.sequence.map((item) =>
      "id" in item ? (retainedRows.get(item.id) ?? item) : item,
    );
    this.messageFence = undefined;
    this.regroup();
  }

  /** Saved calls never replace the outputs and expansion of calls seen running. */
  private mergeCalls(script: ToolRow, snapshots: ToolRow[]): ToolRow[] {
    const live = new Map((script.calls ?? []).map((call) => [call.id, call]));
    const calls = snapshots.map((snapshot) => {
      const row = live.get(snapshot.id);
      live.delete(snapshot.id);
      if (!row) {
        snapshot.parent = script;
        return snapshot;
      }
      if (row.saved === false) {
        if (!isComplete(row)) row.status = snapshot.status;
      } else {
        row.args = snapshot.args;
        row.file = snapshot.file;
        row.preview = snapshot.preview;
        row.omittedBytes = snapshot.omittedBytes;
        row.cost = snapshot.cost;
        row.status = snapshot.status;
        row.result = snapshot.result;
      }
      row.revision++;
      return row;
    });
    return [...calls, ...live.values()];
  }

  /** No recursion: calls made by a script's calls belong to the script itself. */
  private indexCalls(row: ToolRow): void {
    for (const call of row.calls ?? []) this.nested.set(call.id, call);
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
      this.indexCalls(row);
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
        for (const id of added) {
          for (const call of this.rows.get(id)?.calls ?? []) this.nested.delete(call.id);
          this.rows.delete(id);
        }
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
      for (const row of rows) {
        row.group = group;
        for (const call of row.calls ?? []) call.group = group;
      }
    }
    this.tail = tailRow?.group;
  }

  private changed(row: ToolRow): void {
    row.revision++;
    if (row.parent) row.parent.revision++;
    row.group.revision++;
  }
}
