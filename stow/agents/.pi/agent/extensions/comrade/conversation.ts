// Where a comrade's conversation is kept, and what a later run needs to continue it.
import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Details, record } from "./details.ts";
import type { Previous } from "./request.ts";

/** Where comrade #id's conversation is saved: beside the caller's session, or in tmp without one. */
export function sessionFile(ctx: ExtensionContext, id: number): string {
  const callerFile = ctx.sessionManager.getSessionFile();
  const dir = callerFile
    ? join(dirname(callerFile), `${basename(callerFile, ".jsonl")}.comrades`)
    : join(tmpdir(), "pi-comrades", ctx.sessionManager.getSessionId());
  return join(dir, `comrade-${id}.jsonl`);
}

/**
 * Claims comrade #id's conversation file, so no other Pi on this session (a fork open beside
 * it) takes the number. Pi starts a session in an empty file as it would in a missing one.
 */
export function claim(file: string): boolean {
  // The user's alone: without a saved session, conversations go under a path anyone can guess.
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(file, "", { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** The conversation file holds a run: Pi wrote to it. A claimed, empty one was never started. */
export const saved = (file: string) => (statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 0;

/** How much of a conversation's start is read for its header, which Pi writes first. */
const HEADER_BYTES = 64 * 1024;

/**
 * The directory a conversation runs in, as its file's session header names it. Pi takes the
 * directory from there, whatever directory it was started in.
 */
export function conversationCwd(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(HEADER_BYTES);
    const head = buffer.subarray(0, readSync(fd, buffer, 0, HEADER_BYTES, 0)).toString("utf8");
    // As Pi reads it: blank and malformed lines are passed over, and the first entry is the header.
    for (const line of head.split("\n")) {
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const header = (typeof entry === "object" && entry !== null ? entry : {}) as {
        type?: unknown;
        id?: unknown;
        cwd?: unknown;
      };
      if (header.type !== "session" || typeof header.id !== "string") return undefined;
      return typeof header.cwd === "string" && header.cwd ? header.cwd : undefined;
    }
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** What continuing comrade #id needs, from its latest entry on this branch. */
export function conversation(id: number, ctx: ExtensionContext): Previous & { session: string } {
  let seen = false;
  let found: Partial<Details> | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    const details = record(entry);
    if (details?.id !== id) continue;
    seen = true;
    if (details.session && details.requested) found = details;
  }
  if (!seen) throw new Error(`No comrade #${id} on this branch of the conversation.`);
  const session = found?.session;
  const requested = found?.requested;
  if (!session || !requested)
    throw new Error(
      `Comrade #${id} cannot continue: it ran before comrades kept their conversations. Start a new comrade.`,
    );
  if (!saved(session))
    throw new Error(
      `Comrade #${id} cannot continue: its conversation was never saved, or was deleted (${session}). Start a new comrade.`,
    );
  return {
    id,
    session,
    ...(found?.title ? { title: found.title } : {}),
    provider: requested.provider,
    model: requested.model,
    // Missing settings fall back to the caller's, as for a new comrade.
    thinking: found?.thinking || undefined,
    tools: found?.tools,
    // Its row keeps the directory only when it was not the caller's: the header always names it.
    cwd: conversationCwd(session) ?? found?.cwd,
  };
}

export type Numbers = ReturnType<typeof createNumbers>;

/** Numbers comrades, each number held by its conversation file. */
export function createNumbers() {
  let next = 1;
  return {
    /** The next comrade number whose conversation file is free, claimed. */
    reserve(ctx: ExtensionContext): number {
      let id = next++;
      while (!claim(sessionFile(ctx, id))) id = next++;
      return id;
    },
    /** Numbers new comrades past every one of these. */
    past(ids: Iterable<number>): void {
      next = Math.max(0, ...ids) + 1;
    },
  };
}
