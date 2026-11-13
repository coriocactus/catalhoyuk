// Where a comrade's conversation is kept, and what a later run needs to continue it.
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Details, record } from "./details.ts";
import type { Previous } from "./request.ts";

/** Where comrade #id's conversation is saved: beside the caller's session, or in tmp without one. */
export function sessionFile(ctx: ExtensionContext, id: number): string {
  const parent = ctx.sessionManager.getSessionFile();
  const dir = parent
    ? join(dirname(parent), `${basename(parent, ".jsonl")}.comrades`)
    : join(tmpdir(), "pi-comrades", ctx.sessionManager.getSessionId());
  return join(dir, `comrade-${id}.jsonl`);
}

/**
 * Claims comrade #id's conversation file, so no other Pi on this session (a fork open beside
 * it) takes the number. Pi starts a session in an empty file as it would in a missing one.
 */
export function claim(file: string): boolean {
  mkdirSync(dirname(file), { recursive: true });
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

/** What continuing comrade #id needs, from its latest record on this branch. */
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
    session,
    ...(found?.title ? { title: found.title } : {}),
    provider: requested.provider,
    model: requested.model,
    // Missing settings fall back to the caller's, as for a new comrade.
    thinking: found?.thinking || undefined,
    tools: found?.tools,
    cwd: found?.cwd,
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
