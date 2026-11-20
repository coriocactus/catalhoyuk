// A background comrade whose Pi exited while it ran, as reconciling finds it when its session
// next starts: its start row, its run record, and its conversation as Pi left it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { TestContext } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Tool } from "../../test/fake-pi.ts";
import { load } from "../../test/pi.ts";
import { fixture } from "./fixture.ts";

const runs = await load<typeof import("../runs.ts")>("../runs.ts", import.meta.url);
type Result = Awaited<ReturnType<Tool["execute"]>>;
type Details = import("../index.ts").Details;

/** Resolves once `ready` holds, and fails if it does not within five seconds. */
export const until = async (ready: () => boolean) => {
  for (let i = 0; i < 500 && !ready(); i++) await new Promise((wake) => setTimeout(wake, 10));
  assert(ready(), "in time");
};

/** A comrade's start row as Pi saves it: the call's details, under its tool call id. */
export const startRow = (result: Result, toolCallId = "call") =>
  ({
    type: "message",
    message: { role: "toolResult", toolName: "comrade", toolCallId, details: result.details },
  }) as unknown as SessionEntry;

/** The file of the conversation a comrade's call ran in. */
export const conversationOf = (result: Result) => (result.details as Details).session ?? "";

/** A background comrade whose Pi exited mid-call. `params` adds to the call that started it. */
export async function cutMidCall(t: TestContext, params: Record<string, unknown> = {}) {
  const first = fixture(t, "hang");
  const started = await first.call({ task: "Survey the parser", background: true, ...params });
  const session = conversationOf(started);
  await until(() => runs.readRuns(session)[0]?.phase === "asked");
  // Leaving the session waits for its comrades to stop, and Pi records, as each stops, the
  // aborted call and the reply it would have requested.
  await first.pi.event("session_shutdown", { reason: "quit" }, first.ctx);
  assert.match(readFileSync(session, "utf8"), /"stopReason":"aborted"/);
  return { started, session };
}
