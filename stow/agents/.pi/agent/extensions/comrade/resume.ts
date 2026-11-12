// A comrade's run as its conversation file shows it: cut off, with the calls that may or may not
// have taken effect, or finished, with its answer. A call still running when Pi stopped gets only
// an error result, so a comrade that continues is told to check before repeating it.
import { closeSync, openSync, readSync, statSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { formatDuration } from "./view.ts";
import { Ledger } from "./work.ts";

/** How long ago a cut-off run must have stopped before the note warns that files may have changed. */
const STALE_MS = 10 * 60_000;
/** How much of a conversation's end is read: enough for its last run's messages. */
const TAIL_BYTES = 4 * 1024 * 1024;
/** How much of a long conversation's start is read for its header, which names its directory. */
const HEAD_BYTES = 64 * 1024;

export interface Interruption {
  /** The calls not finished cleanly when it stopped, as mirage names them: `$ npm test`. */
  calls: string[];
  /** When its conversation was last saved. */
  saved: number;
}

interface Block {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
  text?: unknown;
}
interface Message {
  role?: unknown;
  content?: unknown;
  stopReason?: unknown;
  toolCallId?: unknown;
  isError?: unknown;
  timestamp?: unknown;
  usage?: Partial<Usage>;
  provider?: unknown;
  model?: unknown;
  errorMessage?: unknown;
}
interface Entry {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  message?: Message;
  cwd?: unknown;
}

/**
 * The file's text, or when long, its first line (the session header) and its end, from the
 * first whole line within the tail.
 */
function text(file: string, whole = false): { text: string; saved: number } | undefined {
  let fd: number | undefined;
  try {
    const { size, mtimeMs } = statSync(file);
    fd = openSync(file, "r");
    const chunk = (length: number, position: number) => {
      const buffer = Buffer.alloc(length);
      const count = readSync(fd as number, buffer, 0, length, position);
      return buffer.subarray(0, count).toString("utf8");
    };
    if (whole || size <= TAIL_BYTES) return { text: chunk(size, 0), saved: mtimeMs };
    const head = chunk(HEAD_BYTES, 0);
    const tail = chunk(TAIL_BYTES, size - TAIL_BYTES);
    return {
      text: `${head.slice(0, head.indexOf("\n") + 1)}${tail.slice(tail.indexOf("\n") + 1)}`,
      saved: mtimeMs,
    };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The conversation's messages on its current branch, and the directory it ran in. */
function read(
  file: string,
  whole = false,
): { messages: Message[]; cwd?: string; saved: number } | undefined {
  const content = text(file, whole);
  if (!content) return undefined;
  const entries: Entry[] = [];
  for (const line of content.text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry === "object" && entry !== null) entries.push(entry);
    } catch {
      // A line cut short by a killed process.
    }
  }
  // The current branch: from the last entry back to the root, or the tail's start.
  const byId = new Map(
    entries.flatMap((entry) => (typeof entry.id === "string" ? [[entry.id, entry]] : [])),
  );
  const branch: Entry[] = [];
  let entry = entries.findLast((candidate) => typeof candidate.id === "string");
  while (entry && branch.length < entries.length) {
    branch.unshift(entry);
    entry = typeof entry.parentId === "string" ? byId.get(entry.parentId) : undefined;
  }
  // The conversation proper: Pi's system and extensions' custom messages aside.
  const messages = branch.flatMap((item) =>
    item.type === "message" &&
    item.message &&
    ["user", "assistant", "toolResult"].includes(item.message.role as string)
      ? [item.message]
      : [],
  );
  const header = entries.find((item) => item.type === "session")?.cwd;
  return {
    messages,
    cwd: typeof header === "string" ? header : undefined,
    saved: content.saved,
  };
}

const blocks = (message: Message): Block[] =>
  Array.isArray(message.content) ? (message.content as Block[]) : [];
const replies = (messages: Message[], before = messages.length) =>
  messages.slice(0, before).findLastIndex((message) => message.role === "assistant");

/**
 * The comrade's last run, if it was cut off: its task came with no reply yet, or its last reply
 * asked for tools and no answer came after them, ended in an error (Pi was retrying, or gave
 * up), or was itself aborted. The calls named are those of the last reply that ran any, without
 * a result or with an error one, which is what Pi records for a call it aborts.
 */
export function interruption(file: string): Interruption | undefined {
  const conversation = read(file);
  if (!conversation?.messages.length) return undefined;
  const { messages, saved } = conversation;
  if (messages.at(-1)?.role === "user") return { calls: [], saved };
  let last = replies(messages);
  let reply = messages[last];
  if (!reply) return undefined;
  // An aborted or failed reply's own calls never ran. Pi stops a run mid-call by aborting the
  // calls, then the reply it was about to request, so the calls cut off are the reply's before.
  if (reply.stopReason === "aborted" || reply.stopReason === "error") {
    const before = replies(messages, last);
    if (
      before < 0 ||
      messages[before].stopReason !== "toolUse" ||
      !messages.slice(before + 1, last).every((message) => message.role === "toolResult")
    )
      return { calls: [], saved };
    last = before;
    reply = messages[before];
  } else if (reply.stopReason !== "toolUse") return undefined;
  const results = new Map(
    messages
      .slice(last + 1)
      .flatMap((message) =>
        message.role === "toolResult" && typeof message.toolCallId === "string"
          ? [[message.toolCallId, message]]
          : [],
      ),
  );
  const ledger = new Ledger(conversation.cwd ?? process.cwd());
  for (const block of blocks(reply)) {
    if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
    const result = results.get(block.id);
    if (result && result.isError !== true) continue;
    ledger.start(block.id, typeof block.name === "string" ? block.name : "tool", block.arguments);
  }
  ledger.close();
  return { calls: ledger.snapshot(false).rows.map((row) => row.label), saved };
}

/** A run its conversation shows finished: what the caller would have read, had it been there. */
export interface Finished {
  text: string;
  stopReason: string;
  turns: number;
  calls: number;
  usage: Usage;
  model?: string;
  /** When its last message was saved, which ends what it did. */
  ended?: number;
}

/**
 * The run that started at `since`, if its conversation shows it finished: its last reply ended
 * the run, with its answer. Pi exited before the answer came back.
 */
export function finished(file: string, since: number): Finished | undefined {
  const messages = read(file)?.messages;
  if (!messages) return undefined;
  const first = messages.findIndex(
    (message) =>
      message.role === "user" &&
      typeof message.timestamp === "number" &&
      message.timestamp >= since,
  );
  if (first < 0) return undefined;
  const run = messages.slice(first);
  const last = run.at(-1);
  if (last?.role !== "assistant" || (last.stopReason !== "stop" && last.stopReason !== "length"))
    return undefined;
  const usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  let turns = 0;
  let calls = 0;
  let answer = "";
  for (const message of run) {
    if (message.role !== "assistant") continue;
    turns++;
    calls += blocks(message).filter((block) => block?.type === "toolCall").length;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
      usage[key] += message.usage?.[key] ?? 0;
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
      usage.cost[key] += message.usage?.cost?.[key] ?? 0;
    const said = blocks(message)
      .flatMap((block) =>
        block?.type === "text" && typeof block.text === "string" ? [block.text] : [],
      )
      .join("\n")
      .trim();
    if (said) answer = said;
  }
  if (!answer) return undefined;
  return {
    text: answer,
    stopReason: last.stopReason,
    turns,
    calls,
    usage,
    ...(typeof last.provider === "string" && typeof last.model === "string"
      ? { model: `${last.provider}/${last.model}` }
      : {}),
    ...(typeof last.timestamp === "number" ? { ended: last.timestamp } : {}),
  };
}

/**
 * What a comrade continuing after a cut-off run reads first: the calls that may or may not have
 * taken effect, and how long ago that was if long enough for files to have changed.
 */
export function interruptionNote(
  cut: Interruption | undefined,
  reason?: string,
  now = Date.now(),
): string {
  const parts = [`Your previous run was cut off before it finished${reason ? `: ${reason}` : ""}.`];
  if (cut?.calls.length)
    parts.push(
      `These calls had not finished cleanly when it stopped, so each may or may not have taken effect: ${cut.calls
        .map((call) => `\`${call}\``)
        .join(", ")}. Check what they did before repeating any that change files or run commands.`,
    );
  const age = cut ? now - cut.saved : 0;
  if (age >= STALE_MS)
    parts.push(`That was ${formatDuration(age)} ago, so files may have changed since.`);
  return `[${parts.join(" ")}]`;
}

/**
 * The messages of the run that started at `since` and ended at `until`, from its first prompt on,
 * as its conversation saved them: for its row to show what it did, read whole when it is opened.
 */
export function runMessages(
  file: string,
  since: number,
  until = Number.POSITIVE_INFINITY,
): AgentMessage[] | undefined {
  const messages = read(file, true)?.messages;
  if (!messages) return undefined;
  // Its comrade's Pi runs on this machine's clock, and saves the prompt after the run started,
  // and its last message before the run ended: no slack, which would reach into a neighbour.
  const first = messages.findIndex(
    (message) =>
      message.role === "user" &&
      typeof message.timestamp === "number" &&
      message.timestamp >= since,
  );
  if (first < 0) return undefined;
  // Up to its end: a later run of the same comrade follows in the same file.
  const after = messages.findIndex(
    (message, index) =>
      index > first && typeof message.timestamp === "number" && message.timestamp > until,
  );
  return messages.slice(first, after < 0 ? undefined : after) as unknown as AgentMessage[];
}
