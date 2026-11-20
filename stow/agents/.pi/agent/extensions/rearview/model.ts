import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const PAGE_SIZE = 50;
/**
 * How many entries past its size a page reaches for the calls of its results. A result whose call
 * is missing, as a malformed session can have, would otherwise take the page back to the root.
 */
const PAIRING_MARGIN = 100;
export type EntryLookup = (id: string) => SessionEntry | undefined;
export interface PreparedPage {
  readonly entries: SessionEntry[];
  readonly from: string;
  readonly next: string | null;
  readonly visited: string[];
}
/** The latest compaction, when the view leaves its summary for a page to draw. */
export interface Checkpoint {
  readonly entry: SessionEntry;
  /** The entry that Pi draws right below the summary, usually the first one the compaction kept. */
  readonly before: string;
}

/** The current context puts the latest compaction first, out of chronological order. */
export function historyBoundary(entries: readonly SessionEntry[]): string | null {
  const first = entries[0]?.type === "compaction" && entries.length > 1 ? entries[1] : entries[0];
  return first?.parentId ?? null;
}

/**
 * A bounded initial view, extended backward to include calls for retained results. Pi draws the
 * latest compaction's summary above the first entry it kept, so the view starts with the summary
 * only when it reaches that entry. Otherwise the page that reaches it draws the summary there.
 */
export function recentEntries(
  entries: readonly SessionEntry[],
  size = PAGE_SIZE,
  keepFrom?: string,
): SessionEntry[] {
  const checkpoint = entries[0]?.type === "compaction" ? entries[0] : undefined;
  const messages = checkpoint ? entries.slice(1) : entries;
  let start = keepFrom ? messages.findIndex((entry) => entry.id === keepFrom) : -1;
  if (start < 0) {
    start = messages.length;
    const calls = new Set<string>();
    while (start > 0) {
      const entry = messages[--start];
      if (entry.type === "message") {
        if (entry.message.role === "toolResult") calls.add(entry.message.toolCallId);
        if (entry.message.role === "assistant")
          for (const block of entry.message.content ?? []) {
            if (block.type === "toolCall") calls.delete(block.id);
          }
      }
      const over = messages.length - start - size;
      if (over >= 0 && (calls.size === 0 || over >= PAIRING_MARGIN)) break;
    }
  }
  return [...(checkpoint && start === 0 ? [checkpoint] : []), ...messages.slice(start)];
}

/** The latest compaction of `entries`, the current context, if `view` leaves its summary out. */
export function leftOutCheckpoint(
  entries: readonly SessionEntry[],
  view: readonly SessionEntry[],
): Checkpoint | undefined {
  const [entry, below] = entries;
  return entry?.type === "compaction" && below && view[0] !== entry
    ? { entry, before: below.id }
    : undefined;
}

/**
 * Whether Pi draws an entry above this one on its branch. The walk stops at the first entry that
 * draws, usually the parent. Settings, labels and the system prompt at a session's start draw
 * nothing.
 */
export function drawnAbove(entry: SessionEntry | undefined, lookup: EntryLookup): boolean {
  const seen = new Set<string>();
  let cursor = entry?.parentId ?? null;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const above = lookup(cursor);
    if (!above) return false;
    if (above.type === "message" ? above.message.role !== "system" : DRAWN.has(above.type))
      return true;
    cursor = above.parentId;
  }
  return false;
}
const DRAWN = new Set<SessionEntry["type"]>(["compaction", "branch_summary", "custom_message"]);

/**
 * Entries newly evicted from an already displayed range, on the same ancestry. `placed` is a
 * checkpoint that a page draws elsewhere.
 */
export function historyGap(
  newBoundary: string | null,
  oldBoundary: string | null,
  lookup: EntryLookup,
  visible: ReadonlySet<string>,
  placed?: string,
): SessionEntry[] | undefined {
  const entries: SessionEntry[] = [],
    seen = new Set<string>();
  let cursor = newBoundary;
  while (cursor !== oldBoundary) {
    if (!cursor || seen.has(cursor)) return undefined;
    seen.add(cursor);
    const entry = lookup(cursor);
    if (!entry) return undefined;
    if (!visible.has(cursor) && cursor !== placed) entries.push(entry);
    cursor = entry.parentId;
  }
  return entries.reverse();
}

/** Walk only the requested ancestors. No full-tree scan, mutation, or model-context changes. */
export class HistoryCursor {
  private consumed = new Set<string>();
  next: string | null;
  /** The summary that a page of this cursor draws above the entry it precedes in the context. */
  readonly checkpoint: Checkpoint | undefined;
  private readonly lookup: EntryLookup;
  private readonly visible: ReadonlySet<string>;

  constructor(
    next: string | null,
    lookup: EntryLookup,
    visible: ReadonlySet<string>,
    checkpoint?: Checkpoint,
  ) {
    this.next = next;
    this.lookup = lookup;
    this.visible = visible;
    this.checkpoint = checkpoint;
  }

  prepare(size = PAGE_SIZE): PreparedPage | undefined {
    if (!Number.isSafeInteger(size) || size < 1)
      throw new Error("History page size must be a positive integer.");
    if (!this.next) return undefined;
    const entries: SessionEntry[] = [],
      visited = new Set<string>(),
      awaitingCalls = new Set<string>();
    let cursor: string | null = this.next;
    while (cursor) {
      if (visited.has(cursor) || this.consumed.has(cursor))
        throw new Error("Cycle in session history.");
      visited.add(cursor);
      const entry = this.lookup(cursor);
      if (!entry) throw new Error(`Missing session history entry: ${cursor}`);
      cursor = entry.parentId;
      // The checkpoint sits on the branch below the entries it kept, but is drawn above them.
      if (this.visible.has(entry.id) || entry.id === this.checkpoint?.entry.id) continue;
      entries.push(entry);
      if (entry.id === this.checkpoint?.before) entries.push(this.checkpoint.entry);
      if (entry.type === "message") {
        const message = entry.message;
        if (message.role === "toolResult") awaitingCalls.add(message.toolCallId);
        if (message.role === "assistant") {
          for (const block of message.content ?? []) {
            if (block.type === "toolCall") awaitingCalls.delete(block.id);
          }
        }
      }
      // Keep tool calls with their results, even when a page crosses the nominal limit, but
      // only as far as the margin: pairing is best effort.
      const over = entries.length - size;
      if (over >= 0 && (awaitingCalls.size === 0 || over >= PAIRING_MARGIN)) break;
    }
    return { entries: entries.reverse(), from: this.next, next: cursor, visited: [...visited] };
  }

  commit(page: PreparedPage): void {
    if (this.next !== page.from) throw new Error("Stale history page.");
    for (const id of page.visited) this.consumed.add(id);
    this.next = page.next;
  }
}
