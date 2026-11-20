// Jobs and the session they run for: an answer that arrives once its session has been left
// belongs to that session, not to the one open by then.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fake } from "../../test/fake-pi.ts";
import { load } from "../../test/pi.ts";
import { fixture } from "./fixture.ts";
import { conversationOf, startRow, until } from "./interrupted.ts";

const runs = await load<typeof import("../runs.ts")>("../runs.ts", import.meta.url);

test("a job that ends after its session was left keeps its answer for that session", async (t) => {
  const first = fixture(t, "slowexit", { sessionId: "left" });
  const started = await first.call({ task: "Survey the parser", background: true });
  const session = conversationOf(started);
  // It has answered and settled, and its Pi takes a while to exit.
  await until(() => readFileSync(session, "utf8").includes("All done."));
  await new Promise((wake) => setTimeout(wake, 100));
  first.shutdown("new");
  // The next session starts in the same Pi before it has exited.
  const next = fake<ExtensionContext>({
    ...first.ctx,
    sessionManager: {
      ...first.ctx.sessionManager,
      getSessionId: () => "next",
      getEntries: () => [],
      getBranch: () => [],
    },
  });
  first.pi.emit("session_start", { reason: "new" }, next);
  await until(() => runs.readRuns(session)[0]?.answer !== undefined);
  assert.equal(first.sent.length, 0, "nothing reaches the next session");

  // Its own session delivers it when it next starts.
  const back = fixture(t, "echo", { sessionId: "left", entries: [startRow(started)] });
  assert.equal(back.sent.length, 1);
  assert.match(
    String(back.sent[0][0].content),
    /^\[comrade #1 finished\] Survey the parser\n\nAll done\./,
  );
});
