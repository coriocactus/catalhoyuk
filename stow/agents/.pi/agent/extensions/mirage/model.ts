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

/** Pi's own tools that mirage draws in their own words. */
export type ToolName = FileToolName | "bash" | "codemode" | SearchToolName;
/** Pi's own tools that search or list files. */
export type SearchToolName = "grep" | "find" | "ls";
/**
 * Call kinds: Pi's own tools by name, any other tool (`tool`), and a script's `models` calls
 * (`model`).
 */
export type ToolKind = ToolName | "tool" | "model";
/** The kind mirage draws a tool's calls as, or undefined for a tool it leaves to its renderer. */
export type ToolKinds = (name: string) => ToolKind | undefined;
export type ToolArgs = Readonly<Record<string, unknown>>;
export type ToolStatus = "pending" | CallStatus;
type Expansion = { epoch: number; value: boolean };
type Boundary = { kind: "hard" | "thinking" | "none" };

export interface ToolCallState {
  id: string;
  name: string;
  kind: ToolKind;
  args: ToolArgs;
  cwd: string;
  file?: FileReference;
  group: ToolGroup;
  /** The script that made this call. */
  parent?: ToolCallState;
  /** Calls a script made, in start order. */
  calls?: ToolCallState[];
  /** The toggle for a script's source. */
  source?: ScriptSource;
  result?: AgentToolResult<unknown>;
  status: ToolStatus;
  /** Execution time Pi recorded for the final result. */
  durationMs?: number;
  hasImages: boolean;
  revision: number;
  expansion?: Expansion;
  /** A call this runtime did not see run: Pi saved its arguments and status, not its output. */
  saved?: boolean;
  /**
   * A call its session left unfinished, as when Pi was killed while it ran: nothing will end it,
   * so it is no longer in progress.
   */
  abandoned?: boolean;
  /**
   * Shown in place of arguments Pi did not keep: their `details.calls` preview, or a model
   * reference.
   */
  preview?: string;
  /** Size in bytes of arguments Pi did not keep. */
  omittedBytes?: number;
  /** Pi's `argumentsError`: the model's arguments were not valid JSON, so `args` is empty. */
  invalidArguments?: boolean;
  cost?: number;
}

export interface ToolGroup {
  rows: ToolCallState[];
  revision: number;
  expansion?: Expansion;
}

export interface ScriptSource {
  script: ToolCallState;
  expansion?: Expansion;
}

export type Expandable = ToolGroup | ToolCallState | ScriptSource;

/** What Pi records with a final result besides its content. */
export interface ResultRecord {
  durationMs?: number;
  /** A script's saved `nestedCalls`. */
  nestedCalls?: unknown;
}

export const TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "codemode",
  "grep",
  "find",
  "ls",
] satisfies ToolName[]);
/** Native tools whose calls keep their own kind inside scripts. */
const NATIVE_KINDS: ReadonlySet<string> = new Set([
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

/** Pi's own tools by name, and every other tool as `tool`: how a call is drawn in any case. */
export const everyKind: ToolKinds = (name) => (TOOL_NAMES.has(name) ? (name as ToolName) : "tool");
/** Only Pi's own tools that mirage draws in their own words. */
export const nativeKinds: ToolKinds = (name) =>
  TOOL_NAMES.has(name) ? (name as ToolName) : undefined;

export function normalizeArgs(value: unknown): ToolArgs {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? ({ ...value } as ToolArgs)
    : {};
}

export function isFailed(row: ToolCallState): boolean {
  return row.status === "error" || row.status === "cancelled";
}

export function isComplete(row: ToolCallState): boolean {
  return row.status === "success" || isFailed(row);
}

/** Whether a call is in progress: it has not ended, and something can still end it. */
export function inProgress(row: ToolCallState): boolean {
  return !isComplete(row) && !row.abandoned;
}

/** Calls a script made through tools, not its `models` calls. */
export function toolCalls(row: ToolCallState): ToolCallState[] {
  return row.calls?.filter((call) => call.kind !== "model") ?? [];
}

function kindOf(name: string): ToolKind {
  if (isModelCall(name)) return "model";
  if (NATIVE_KINDS.has(name)) return name as ToolName;
  return "tool";
}

function duration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
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
  readonly rows = new Map<string, ToolCallState>();
  /** Calls inside scripts, by their own ids, such as `<script id>/<n>`. */
  private readonly nested = new Map<string, ToolCallState>();
  private readonly kinds: ToolKinds;
  private tail?: ToolGroup;
  private allExpanded = false;
  private thinkingHidden = false;
  private sequence: (ToolCallState | Boundary)[] = [];
  private messageBoundary?: Boundary;
  epoch = 0;

  /**
   * `kinds` decides which top-level tools mirage draws, and as what. A call to any other tool is
   * a boundary. It is asked again whenever groups are formed: see reconsider().
   */
  constructor(kinds: ToolKinds = nativeKinds) {
    this.kinds = kinds;
  }

  /** Whether mirage draws this call, rather than another renderer: one that does not ends a group. */
  private drawn(row: ToolCallState): boolean {
    return this.kinds(row.name) !== undefined;
  }

  /**
   * Which tools mirage draws changed: groups are formed again, so a call to a tool it now draws
   * joins its neighbours, and one to a tool it no longer draws separates them.
   */
  reconsider(): void {
    for (const row of this.rows.values()) {
      const kind = this.kinds(row.name);
      if (kind && kind !== row.kind) {
        row.kind = kind;
        this.changed(row);
      }
    }
    this.regroup();
  }

  reset(): void {
    this.rows.clear();
    this.nested.clear();
    this.boundary();
    this.sequence = [];
    this.epoch++;
  }

  boundary(): void {
    this.sequence.push({ kind: "hard" });
    this.tail = undefined;
    this.messageBoundary = undefined;
  }

  private separates(boundary: Boundary): boolean {
    return boundary.kind === "hard" || (boundary.kind === "thinking" && !this.thinkingHidden);
  }

  setThinkingHidden(hidden: boolean): void {
    if (this.thinkingHidden === hidden) return;
    this.thinkingHidden = hidden;
    this.regroup();
  }

  startMessage(message: AgentMessage, cwd: string): void {
    if (message.role === "assistant") {
      // Optimistic: a streaming call joins the group at once. Visible commentary
      // or thinking arriving later makes this boundary end the group.
      this.messageBoundary = { kind: "none" };
      this.sequence.push(this.messageBoundary);
    } else if (
      message.role !== "toolResult" &&
      // Pi draws neither a system message, such as a change of tools while it works, nor a custom
      // message it is not to display.
      message.role !== "system" &&
      !(message.role === "custom" && !message.display)
    ) {
      this.boundary();
    }
    this.observe(message, cwd);
  }

  finishMessage(message: AgentMessage, cwd: string): void {
    this.observe(message, cwd);
    if (message.role !== "assistant") return;
    this.messageBoundary = undefined;
    if (["error", "aborted", "length"].includes(message.stopReason)) this.boundary();
    if (message.stopReason !== "aborted" && message.stopReason !== "error") return;
    // Pi runs no call of a failed turn, and shows each as failed with the turn's error. While it
    // retries, Pi says how often it tried instead, which only its own result for the call knows.
    const text =
      message.stopReason === "aborted" ? "Operation aborted" : message.errorMessage || "Error";
    for (const block of message.content) {
      const row = block.type === "toolCall" ? this.rows.get(block.id) : undefined;
      if (row && !isComplete(row)) this.end(row, "error", text);
    }
  }

  /** The agent these calls are from stopped: each call it left in progress is cancelled. */
  cancelUnfinished(text: string): void {
    for (const row of this.rows.values()) if (!isComplete(row)) this.end(row, "cancelled", text);
  }

  /** The calls replayed from a session that it left unfinished: nothing will end them now. */
  abandonUnfinished(): void {
    for (const row of this.rows.values()) if (!isComplete(row)) row.abandoned = true;
  }

  /** Ends a call that will never report back, with the text shown for it. */
  private end(row: ToolCallState, status: "error" | "cancelled", text: string): void {
    row.status = status;
    row.result = { content: [{ type: "text", text }], details: row.result?.details };
    row.hasImages = false;
    this.changed(row);
  }

  /** Classify the in-flight message before adding its calls, so boundaries precede calls. */
  private classify(message: Extract<AgentMessage, { role: "assistant" }>): void {
    const boundary = this.messageBoundary;
    if (!boundary) return;
    const kind = ["error", "aborted", "length"].includes(message.stopReason)
      ? "hard"
      : message.content.some((block) => block.type === "text" && block.text.trim())
        ? "hard"
        : message.content.some((block) => block.type === "thinking" && block.thinking.trim())
          ? "thinking"
          : "none";
    if (kind === boundary.kind) return;
    const before = this.separates(boundary);
    boundary.kind = kind;
    if (before === this.separates(boundary)) return;
    // Usually nothing follows the boundary yet, so this only changes the tail.
    if (this.sequence.at(-1) === boundary)
      this.tail = this.separates(boundary) ? undefined : this.trailingGroup();
    else this.regroup();
  }

  private trailingGroup(): ToolGroup | undefined {
    for (let i = this.sequence.length - 1; i >= 0; i--) {
      const item = this.sequence[i];
      if ("id" in item) return this.drawn(item) ? item.group : undefined;
      if (this.separates(item)) return undefined;
    }
    return undefined;
  }

  addCall(id: string, name: string, args: unknown, cwd: string): ToolCallState | undefined {
    const existing = this.rows.get(id);
    if (existing) {
      this.updateCall(existing, args, cwd);
      return this.drawn(existing) ? existing : undefined;
    }
    // Every call is kept, drawn or not: which tools mirage draws can change as Pi resolves their
    // renderers, and a call it does not draw holds its place as a boundary meanwhile.
    const kind = this.kinds(name);
    const group: ToolGroup = (kind && this.tail) || { rows: [], revision: 0 };
    const keepExpanded = kind !== undefined && this.groupVisible(group);
    const row = this.createRow(id, name, kind ?? "tool", cwd, group);
    group.rows.push(row);
    if (keepExpanded) group.expansion = { epoch: this.epoch, value: true };
    this.rows.set(id, row);
    this.sequence.push(row);
    this.tail = kind ? group : undefined;
    this.updateCall(row, args, cwd);
    return kind ? row : undefined;
  }

  private createRow(
    id: string,
    name: string,
    kind: ToolKind,
    cwd: string,
    group: ToolGroup,
    parent?: ToolCallState,
  ): ToolCallState {
    const row: ToolCallState = {
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

  private updateCall(row: ToolCallState, value: unknown, cwd: string): void {
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

  markStarted(row: ToolCallState): void {
    if (row.status !== "pending") return;
    row.status = "running";
    row.abandoned = false;
    this.changed(row);
  }

  updateResult(
    row: ToolCallState,
    result: AgentToolResult<unknown>,
    partial: boolean,
    failed: boolean,
    recorded: ResultRecord = {},
  ): void {
    this.applyResult(row, result, partial, failed, recorded.durationMs);
    if (row.kind === "codemode")
      this.updateScript(row, row.result?.details, recorded.nestedCalls, !partial);
    this.changed(row);
  }

  private applyResult(
    row: ToolCallState,
    result: AgentToolResult<unknown>,
    partial: boolean,
    failed: boolean,
    durationMs: number | undefined,
  ): void {
    row.result = retained(result);
    row.abandoned = false;
    if (failed) row.status = "error";
    else if (partial) row.status = "running";
    else row.status = "success";
    row.durationMs = partial ? undefined : duration(durationMs);
    row.hasImages = row.result.content.some((part) => part.type === "image");
  }

  /** A live call inside a script started. Returns the script to redraw. */
  startNested(
    parentId: string,
    id: string,
    name: string,
    args: unknown,
    cwd: string,
  ): ToolCallState | undefined {
    const script = this.scriptOf(parentId);
    if (!script) return undefined;
    const row = this.nestedCall(script, id, name, cwd);
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
    durationMs?: number,
  ): ToolCallState | undefined {
    const row = this.nested.get(id);
    if (!row?.parent) return undefined;
    row.saved = false;
    this.applyResult(row, result, partial, failed, durationMs);
    this.changed(row);
    return row.parent;
  }

  /** Finds the script a call belongs to. Calls made by a script's calls belong to the script. */
  private scriptOf(id: string): ToolCallState | undefined {
    let row = this.rows.get(id) ?? this.nested.get(id);
    while (row?.parent) row = row.parent;
    return row?.kind === "codemode" ? row : undefined;
  }

  private nestedCall(script: ToolCallState, id: string, name: string, cwd: string): ToolCallState {
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
  private updateScript(
    script: ToolCallState,
    details: unknown,
    record: unknown,
    final: boolean,
  ): void {
    const saved = new Map(savedCalls(record).map((call) => [call.id, call]));
    const remaining = new Map(saved);
    const listed = scriptCalls(details);
    for (const call of listed) if (!isPlaceholder(call.id)) remaining.delete(call.id);
    for (const call of listed) {
      if (isModelCall(call.name)) {
        const row = this.nestedCall(script, call.id, call.name, script.cwd);
        if (row.preview !== call.preview || row.cost !== call.cost) {
          row.preview = call.preview;
          row.cost = call.cost;
          this.changed(row);
        }
        this.settle(row, call.status, call.error, call.durationMs);
        continue;
      }
      let match = saved.get(call.id);
      if (!match && isPlaceholder(call.id)) {
        match = [...remaining.values()].find((entry) => entry.name === call.name);
        if (match) remaining.delete(match.id);
      }
      const id = match?.id ?? (isPlaceholder(call.id) ? undefined : call.id);
      if (!id) continue; // Still running: its live events supply the call.
      const row = this.nestedCall(script, id, call.name, script.cwd);
      if (match) this.loadSaved(row, match);
      else if (row.saved !== false && !Object.keys(row.args).length) {
        // Without `nestedCalls`, the `details.calls` preview is the only copy of the arguments.
        const args = previewArgs(call.preview);
        row.saved = true;
        if (args) this.updateCall(row, args, row.cwd);
        else row.preview = call.preview;
      }
      this.settle(row, call.status, call.error, call.durationMs ?? match?.durationMs);
    }
    for (const call of remaining.values()) {
      const row = this.nestedCall(script, call.id, call.name, script.cwd);
      this.loadSaved(row, call);
      this.settle(row, call.status, call.error, call.durationMs);
    }
    if (final)
      for (const row of script.calls ?? [])
        if (!isComplete(row)) this.settle(row, "cancelled", undefined, undefined);
  }

  /** Loads the saved arguments of a call this runtime did not see run. */
  private loadSaved(row: ToolCallState, call: SavedCall): void {
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
   * live stay; a saved duration fills in one the live events did not report.
   */
  private settle(
    row: ToolCallState,
    status: CallStatus,
    error: string | undefined,
    durationMs: number | undefined,
  ): void {
    if (status === "running") return; // Live events report progress.
    const recorded = duration(durationMs);
    if (recorded !== undefined && row.durationMs === undefined) {
      row.durationMs = recorded;
      this.changed(row);
    }
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
        if (block.type !== "toolCall") continue;
        const row = this.addCall(block.id, block.name, block.arguments, cwd);
        // Only the finished message says so. Renderers receive just the emptied arguments.
        const invalid = block.argumentsError !== undefined;
        if (row && invalid !== (row.invalidArguments === true)) {
          row.invalidArguments = invalid;
          this.changed(row);
        }
      }
    } else if (message.role === "toolResult") {
      const row = this.rows.get(message.toolCallId);
      if (row)
        this.updateResult(
          row,
          { content: message.content, details: message.details },
          false,
          message.isError,
          { durationMs: message.durationMs, nestedCalls: message.nestedCalls },
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

  /** Reconstruct the loaded range without invalidating existing rows or local choices. */
  replace(source: ToolGroups): void {
    const retainedRows = new Map<string, ToolCallState>();
    for (const snapshot of source.rows.values()) {
      const row = this.rows.get(snapshot.id) ?? snapshot;
      if (row !== snapshot) {
        // A call this runtime sees run stays in progress, whatever the snapshot left of it.
        row.abandoned = snapshot.abandoned === true && row.status !== "running";
        row.args = snapshot.args;
        row.cwd = snapshot.cwd;
        row.file = snapshot.file;
        row.invalidArguments = snapshot.invalidArguments;
        row.result = snapshot.result;
        row.status = snapshot.status;
        row.durationMs = snapshot.durationMs;
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
    this.sequence = source.sequence.map((item) =>
      "id" in item ? (retainedRows.get(item.id) ?? item) : item,
    );
    this.messageBoundary = undefined;
    this.regroup();
  }

  /** Saved calls never replace the outputs and expansion of live calls. */
  private mergeCalls(script: ToolCallState, snapshots: ToolCallState[]): ToolCallState[] {
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
        row.durationMs ??= snapshot.durationMs;
      } else {
        row.args = snapshot.args;
        row.file = snapshot.file;
        row.preview = snapshot.preview;
        row.omittedBytes = snapshot.omittedBytes;
        row.cost = snapshot.cost;
        row.status = snapshot.status;
        row.durationMs = snapshot.durationMs;
        row.result = snapshot.result;
      }
      row.revision++;
      return row;
    });
    return [...calls, ...live.values()];
  }

  /** No recursion: calls made by a script's calls belong to the script itself. */
  private indexCalls(row: ToolCallState): void {
    for (const call of row.calls ?? []) this.nested.set(call.id, call);
  }

  /**
   * Publish row identities for native page construction, but do not change the
   * live sequence until construction succeeds. A failed page can be discarded.
   * No persisted snapshot is allowed to overwrite a live/streaming row.
   */
  stagePrepend(source: ToolGroups): { commit(): void; rollback(): void } {
    const added = new Set<string>();
    for (const row of source.rows.values()) {
      if (this.rows.has(row.id)) continue;
      row.group.expansion = undefined;
      this.rows.set(row.id, row);
      this.indexCalls(row);
      added.add(row.id);
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
      },
    };
  }

  /** Visibility/range changes replay boundaries; streaming updates stay incremental. */
  private regroup(): void {
    const spans: ToolCallState[][] = [];
    let span: ToolCallState[] | undefined;
    for (const item of this.sequence) {
      if (!("id" in item)) {
        if (this.separates(item)) span = undefined;
        continue;
      }
      // A call mirage does not draw keeps a group of its own, which nothing shows.
      if (!this.drawn(item)) {
        span = undefined;
        if (item.group.rows[0] !== item || item.group.rows.length > 1)
          item.group = { rows: [item], revision: 0 };
        continue;
      }
      if (!span) {
        span = [];
        spans.push(span);
      }
      span.push(item);
    }
    // Capture old visibility before changing any group membership.
    const assignments = spans.map((rows) => ({
      rows,
      group: rows[0].group.rows[0] === rows[0] ? rows[0].group : { rows: [], revision: 0 },
      expanded: rows.some((row) => this.groupVisible(row.group)),
    }));
    const tailRow = span?.at(-1);
    for (const { rows, group, expanded } of assignments) {
      group.rows = rows;
      group.expansion = { epoch: this.epoch, value: expanded };
      group.revision++;
      for (const row of rows) {
        row.group = group;
        for (const call of row.calls ?? []) call.group = group;
      }
    }
    this.tail = tailRow?.group;
  }

  private changed(row: ToolCallState): void {
    row.revision++;
    if (row.parent) row.parent.revision++;
    row.group.revision++;
  }
}
