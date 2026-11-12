// What a comrade did, folded from its tool events into a small record: counts per kind, and
// the calls worth naming (failures, changed files, commands). The record its row saves stays a
// few KB however many calls the comrade makes; what the comrade said and every call it made
// are in its own conversation. Wording follows mirage's group summaries.
import { homedir } from "node:os";
import { resolve } from "node:path";

export type Kind = "read" | "search" | "command" | "edit" | "write" | "script" | "tool";
export type Status = "success" | "error" | "cancelled";
/** A call still running, which only live rows show. */
export type Live = Status | "running";

export interface Tally {
  kind: Kind;
  calls: number;
  failed: number;
  /** Distinct paths, for file kinds. */
  files: number;
  added: number;
  removed: number;
}

export interface Row {
  kind: Kind;
  status: Status;
  label: string;
  added?: number;
  removed?: number;
  /** How often a command ran. */
  times?: number;
  error?: string;
  /** A failed command's exit code, which Pi appends to its output: shown instead of its error. */
  code?: string;
}

export interface Work {
  tallies: Tally[];
  /** Failed and cancelled calls, then changed files, then distinct commands. */
  rows: Row[];
  /** Rows beyond those kept. */
  omitted: number;
  /** The latest call, for the running row. Not kept once the comrade ends. */
  current?: string;
  /** The latest calls, oldest first, for the running row. Not kept once the comrade ends. */
  recent?: (Omit<Row, "status"> & { status: Live })[];
}

const KEPT_ROWS = 20;
/** The latest calls a running row can show. */
const RECENT = 8;
const KINDS: Record<string, Kind> = {
  read: "read",
  edit: "edit",
  write: "write",
  bash: "command",
  powershell: "command",
  grep: "search",
  find: "search",
  ls: "search",
  codemode: "script",
};
const FILE_KINDS: ReadonlySet<Kind> = new Set(["read", "edit", "write"]);
const VERBS = {
  read: { running: "Reading", success: "Read", failed: "Read" },
  edit: { running: "Editing", success: "Edited", failed: "Edit" },
  write: { running: "Writing", success: "Wrote", failed: "Write" },
};

export const emptyWork = (): Work => ({ tallies: [], rows: [], omitted: 0 });

// biome-ignore lint/suspicious/noControlCharactersInRegex: strip control bytes from child text.
const CONTROLS = /[\x00-\x1f\x7f]+/g;
const clip = (value: string, length: number) =>
  value.length > length ? `${value.slice(0, length - 1)}…` : value;
const oneLine = (value: string) => value.replace(CONTROLS, " ").replace(/\s+/g, " ").trim();
const firstLine = (value: string) => oneLine(value.split("\n").find((line) => line.trim()) ?? "");
const text = (value: unknown) => (typeof value === "string" ? value : "");

export function homePath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Pi's own count of a diff's changed lines, as mirage counts them. */
export function diffCounts(value: string): { added: number; removed: number } {
  let added = 0,
    removed = 0;
  for (const line of value.split("\n")) {
    if (/^\+\s*\d+ /.test(line)) added++;
    else if (/^-\s*\d+ /.test(line)) removed++;
  }
  return { added, removed };
}

/** Lines in a write's content. Pi reports no diff for writes. */
export function writtenLines(content: string): number {
  if (!content) return 0;
  const lines = content.split("\n").length;
  return content.endsWith("\n") ? lines - 1 : lines;
}

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : noun.endsWith("h") ? "es" : "s"}`;

/** `Explored 4 files, ran 2 searches, edited 1 file (+3 −1)`, in first-appearance order. */
export function summary(tallies: readonly Tally[]): string {
  const kinds = new Set(tallies.map((tally) => tally.kind));
  const exploring = [...kinds].every((kind) => kind === "read" || kind === "search");
  return tallies
    .map((tally, index) => {
      const allFailed = tally.calls > 0 && tally.failed === tally.calls;
      const changes = [
        tally.added ? `+${tally.added}` : "",
        tally.removed ? `−${tally.removed}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      let phrase: string;
      if (tally.kind === "read")
        phrase = `${exploring ? "explored" : "read"} ${plural(tally.files, "file")}`;
      else if (tally.kind === "edit")
        phrase = `${allFailed ? "edit" : "edited"} ${plural(tally.files, "file")}`;
      else if (tally.kind === "write")
        phrase = `${allFailed ? "write" : "wrote"} ${plural(tally.files, "file")}`;
      else if (tally.kind === "search") phrase = `ran ${plural(tally.calls, "search")}`;
      else if (tally.kind === "command") phrase = `ran ${plural(tally.calls, "command")}`;
      else if (tally.kind === "script") phrase = `ran ${plural(tally.calls, "script")}`;
      else phrase = `called ${plural(tally.calls, "tool")}`;
      if (changes) phrase += ` (${changes})`;
      return index ? phrase : phrase[0].toUpperCase() + phrase.slice(1);
    })
    .join(", ");
}

interface Call {
  kind: Kind;
  tool: string;
  path?: string;
  detail: string;
  written: number;
  status?: Status;
  added: number;
  removed: number;
  error?: string;
}

/** A call as it starts: its kind, path and the detail its label shows. */
function callOf(tool: string, args: unknown, cwd: string): Call {
  const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const kind = KINDS[tool] ?? "tool";
  const rawPath = text(record.path).replace(/^@/, "");
  const path = rawPath ? clip(resolve(cwd, rawPath), 300) : undefined;
  let detail: string;
  // A command's first line, marked when more follow: joined, its lines could read as one.
  if (kind === "command") {
    const command = text(record.command).trim();
    const more = firstLine(command) !== oneLine(command) ? " …" : "";
    detail = clip(firstLine(command), 120 - more.length) + more;
  } else if (tool === "grep" || tool === "find") detail = clip(oneLine(text(record.pattern)), 80);
  else if (kind === "tool" || kind === "script") {
    const key = ["command", "path", "pattern", "url", "query"].find(
      (name) => typeof record[name] === "string",
    );
    detail = clip(oneLine(key ? text(record[key]) : JSON.stringify(args ?? {})), 80);
  } else detail = "";
  return {
    kind,
    tool,
    path,
    detail,
    written: kind === "write" ? writtenLines(text(record.content)) : 0,
    added: 0,
    removed: 0,
  };
}

/**
 * One call as a row, in mirage's single-row wording: for a call mirage does not draw, or for
 * every call where mirage is not loaded. `status` absent: still running. `details` is its
 * result's, which hold an edit's diff.
 */
export function callRow(
  tool: string,
  args: unknown,
  cwd: string,
  status?: Status,
  error?: string,
  details?: unknown,
): Omit<Row, "status"> & { status: Live } {
  const call = { ...callOf(tool, args, cwd), status };
  const ledger = new Ledger(cwd);
  // What an edit or write that went through changed, as mirage counts it.
  let changes = { added: 0, removed: 0 };
  if (status === "success" && call.kind === "edit")
    changes = diffCounts(text((details as { diff?: unknown } | undefined)?.diff));
  else if (status === "success" && call.kind === "write") changes.added = call.written;
  const code =
    call.kind === "command" && error
      ? /Command exited with code (\d+)\s*$/.exec(error)?.[1]
      : undefined;
  return {
    kind: call.kind,
    status: status ?? "running",
    label: ledger.labelOf(call),
    ...(changes.added ? { added: changes.added } : {}),
    ...(changes.removed ? { removed: changes.removed } : {}),
    ...(code ? { code } : error ? { error: clip(firstLine(error), 120) } : {}),
  };
}

export class Ledger {
  private readonly calls = new Map<string, Call>();
  private readonly tallies = new Map<Kind, Tally & { paths: Set<string> }>();
  private readonly failures: Row[] = [];
  private readonly changed = new Map<string, Row>();
  private readonly commands = new Map<string, Row>();
  private latest?: Call;
  private readonly recent: Call[] = [];
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  start(id: string, tool: string, args: unknown): void {
    const call = callOf(tool, args, this.cwd);
    const { kind, path } = call;
    this.calls.set(id, call);
    this.latest = call;
    this.recent.push(call);
    if (this.recent.length > RECENT) this.recent.shift();
    const tally = this.tallies.get(kind) ?? {
      kind,
      calls: 0,
      failed: 0,
      files: 0,
      added: 0,
      removed: 0,
      paths: new Set<string>(),
    };
    tally.calls++;
    if (path && FILE_KINDS.has(kind)) tally.paths.add(path);
    tally.files = tally.paths.size;
    this.tallies.set(kind, tally);
  }

  end(id: string, isError: boolean, result: unknown): void {
    const call = this.calls.get(id);
    if (!call) return;
    this.calls.delete(id);
    const value =
      typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
    if (isError) {
      const content = Array.isArray(value.content) ? value.content : [];
      const message = content
        .map((part) =>
          part && typeof part === "object" ? text((part as { text?: unknown }).text) : "",
        )
        .join("\n");
      this.fail(call, "error", clip(firstLine(message), 120));
      return;
    }
    call.status = "success";
    const tally = this.tallies.get(call.kind);
    if (call.kind === "edit") {
      const details = value.details as { diff?: unknown } | undefined;
      ({ added: call.added, removed: call.removed } = diffCounts(text(details?.diff)));
    } else if (call.kind === "write") call.added = call.written;
    if ((call.kind === "edit" || call.kind === "write") && call.path) {
      if (tally) {
        tally.added += call.added;
        tally.removed += call.removed;
      }
      // One row per file and kind, so a write and a later edit of it stay apart, as in the summary.
      const key = `${call.kind}:${call.path}`;
      const row = this.changed.get(key) ?? {
        kind: call.kind,
        status: "success",
        label: `${VERBS[call.kind].success} ${homePath(call.path)}`,
        added: 0,
        removed: 0,
      };
      row.added = (row.added ?? 0) + call.added;
      row.removed = (row.removed ?? 0) + call.removed;
      this.changed.set(key, row);
    } else if (call.kind === "command") {
      const label = `$ ${call.detail}`;
      const row = this.commands.get(label) ?? {
        kind: call.kind,
        status: "success",
        label,
        times: 0,
      };
      row.times = (row.times ?? 0) + 1;
      this.commands.set(label, row);
    }
  }

  /** Calls still running when the comrade exits were cut off. */
  close(): void {
    for (const call of this.calls.values()) this.fail(call, "cancelled");
    this.calls.clear();
  }

  snapshot(running = true): Work {
    const rows = [...this.failures, ...this.changed.values(), ...this.commands.values()];
    const work: Work = {
      tallies: [...this.tallies.values()].map(({ paths: _paths, ...tally }) => tally),
      rows: rows.slice(0, KEPT_ROWS).map((row) => ({ ...row })),
      omitted: Math.max(0, rows.length - KEPT_ROWS),
    };
    if (running && this.latest) work.current = this.label(this.latest);
    if (running && this.recent.length)
      work.recent = this.recent.map((call) => ({
        kind: call.kind,
        status: call.status ?? "running",
        label: this.label(call, false),
        ...(call.added ? { added: call.added } : {}),
        ...(call.removed ? { removed: call.removed } : {}),
        ...(call.error ? { error: call.error } : {}),
      }));
    return work;
  }

  private fail(call: Call, status: "error" | "cancelled", error?: string): void {
    call.status = status;
    call.error = error || undefined;
    const tally = this.tallies.get(call.kind);
    if (tally) tally.failed++;
    this.failures.push({
      kind: call.kind,
      status,
      label: this.label(call),
      error: error || undefined,
    });
  }

  /** A call's label without its line counts. */
  labelOf(call: Call): string {
    return this.label(call, false);
  }

  /**
   * Mirage's single-row forms: `Read ~/p`, `Editing ~/p`, `$ cmd`, `grep pattern ~/dir`. Edits
   * and writes end with their line counts unless `counts` is false.
   */
  private label(call: Call, counts = true): string {
    const path = call.path ? homePath(call.path) : "";
    if (call.kind === "read" || call.kind === "edit" || call.kind === "write") {
      const verbs = VERBS[call.kind];
      const verb = !call.status
        ? verbs.running
        : call.status === "success"
          ? verbs.success
          : verbs.failed;
      const changes = counts
        ? [call.added ? `+${call.added}` : "", call.removed ? `−${call.removed}` : ""]
            .filter(Boolean)
            .join(" ")
        : "";
      return [verb, path, changes].filter(Boolean).join(" ");
    }
    if (call.kind === "command") return `$ ${call.detail}`;
    if (call.kind === "search") return [call.tool, call.detail, path].filter(Boolean).join(" ");
    return [call.tool, call.detail].filter(Boolean).join(" ");
  }
}
