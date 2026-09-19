import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const PAGE_SIZE = 50;
export type EntryLookup = (id: string) => SessionEntry | undefined;
export interface HistoryBatch {
  readonly entries: SessionEntry[];
  readonly from: string;
  readonly next: string | null;
  readonly visited: string[];
}

/** The current context puts the latest compaction first, out of chronological order. */
export function historyBoundary(entries: readonly SessionEntry[]): string | null {
  const first = entries[0]?.type === "compaction" && entries.length > 1 ? entries[1] : entries[0];
  return first?.parentId ?? null;
}

/** A bounded initial view, extended backward to include calls for retained results. */
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
      if (messages.length - start >= size && calls.size === 0) break;
    }
  }
  return [...(checkpoint ? [checkpoint] : []), ...messages.slice(start)];
}

/** Entries newly evicted from an already displayed range, on the same ancestry. */
export function historyGap(
  newBoundary: string | null,
  oldBoundary: string | null,
  lookup: EntryLookup,
  visible: ReadonlySet<string>,
): SessionEntry[] | undefined {
  const entries: SessionEntry[] = [],
    seen = new Set<string>();
  let cursor = newBoundary;
  while (cursor !== oldBoundary) {
    if (!cursor || seen.has(cursor)) return undefined;
    seen.add(cursor);
    const entry = lookup(cursor);
    if (!entry) return undefined;
    if (!visible.has(cursor)) entries.push(entry);
    cursor = entry.parentId;
  }
  return entries.reverse();
}

/** Walk only the requested ancestors. No full-tree scan, mutation, or model-context changes. */
export class HistoryCursor {
  private consumed = new Set<string>();
  constructor(
    public next: string | null,
    private readonly lookup: EntryLookup,
    private readonly visible: ReadonlySet<string>,
  ) {}

  prepare(size = PAGE_SIZE): HistoryBatch | undefined {
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
      if (this.visible.has(entry.id)) continue;
      entries.push(entry);
      if (entry.type === "message") {
        const message = entry.message;
        if (message.role === "toolResult") awaitingCalls.add(message.toolCallId);
        if (message.role === "assistant") {
          for (const block of message.content ?? []) {
            if (block.type === "toolCall") awaitingCalls.delete(block.id);
          }
        }
      }
      // Keep tool calls with their results, even when a batch crosses the nominal limit.
      if (entries.length >= size && awaitingCalls.size === 0) break;
      if (visited.size > size + 4096)
        throw new Error("Unbounded or malformed tool batch in session history.");
    }
    return { entries: entries.reverse(), from: this.next, next: cursor, visited: [...visited] };
  }

  commit(batch: HistoryBatch): void {
    if (this.next !== batch.from) throw new Error("Stale history batch.");
    for (const id of batch.visited) this.consumed.add(id);
    this.next = batch.next;
  }
}
