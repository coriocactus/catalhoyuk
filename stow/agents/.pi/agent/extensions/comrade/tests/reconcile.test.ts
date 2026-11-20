// Reconciling a background run that never answered, when its session next starts: which run
// records hold it back, and what an answer found in its conversation needs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { load } from "../../test/pi.ts";
import { fixture } from "./fixture.ts";
import { cutMidCall, startRow, until } from "./interrupted.ts";

const runs = await load<typeof import("../runs.ts")>("../runs.ts", import.meta.url);
type Delivery = import("../index.ts").Delivery;
type Sent = Parameters<ExtensionAPI["sendMessage"]>;

const delivery = (sent: Sent) => sent[0].details as Delivery;
/** A process id no process has: past the largest any system gives. */
const GONE = 2 ** 22 + 12345;

/** A comrade's Pi that has not yet noticed its host is gone. */
function outliving(t: TestContext) {
  const comrade = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"]);
  t.after(() => comrade.kill());
  return comrade;
}

test("a comrade another Pi resumed under a run of its own is left to that Pi", async (t) => {
  const { started, session } = await cutMidCall(t);
  // A fork's Pi resumed it, and replaced the start row's run record with its own.
  const [record] = runs.readRuns(session);
  runs.dropRuns(session, new Set([record.run]));
  runs.saveRun(session, { ...record, run: "resumed", owner: process.ppid, child: undefined });
  const again = fixture(t, "echo", { entries: [startRow(started)] });
  assert.equal(again.sent.length, 0, "not resumed here as well");
  assert.match(
    again.notices.at(-1) ?? "",
    /^Comrade #1 is still running in another Pi \(process \d+\)\.$/,
  );
});

test("a comrade whose Pi outlived its host is resumed once that Pi has exited", async (t) => {
  const { started, session } = await cutMidCall(t);
  // Its host crashed, and the comrade's Pi runs on for a moment.
  const comrade = outliving(t);
  runs.saveRun(session, { ...runs.readRuns(session)[0], owner: GONE, child: comrade.pid });
  const again = fixture(t, "echo", { entries: [startRow(started)] });
  await new Promise((wake) => setTimeout(wake, 1200));
  assert.equal(again.sent.length, 0, "not while it runs");
  assert.deepEqual(again.notices, []);
  comrade.kill();
  await until(() => again.sent.length > 0);
  assert.equal(delivery(again.sent[0]).status, "resumed");
  await again.delivered(2);
});

test("a comrade whose Pi outlives its host is left with a notice, or with its session", async (t) => {
  const { started, session } = await cutMidCall(t);
  const comrade = outliving(t);
  runs.saveRun(session, { ...runs.readRuns(session)[0], owner: GONE, child: comrade.pid });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const again = fixture(t, "echo", { entries: [startRow(started)] });
  for (let second = 0; second < 30; second++) t.mock.timers.tick(1000);
  assert.equal(again.sent.length, 0);
  assert.match(
    again.notices.at(-1) ?? "",
    /^Comrade #1 was not resumed: the Pi of its interrupted run \(process \d+\) is still running\. Continue it with to: 1\.$/,
  );

  // Its session ends while it waits: nothing is resumed into the next one.
  const third = fixture(t, "echo", { entries: [startRow(started)] });
  third.shutdown("new");
  comrade.kill();
  await once(comrade, "exit");
  for (let second = 0; second < 30; second++) t.mock.timers.tick(1000);
  assert.equal(third.sent.length, 0);
  assert.deepEqual(third.notices, []);
});

test("an answer in a comrade's conversation needs no attached file, and lasted until its last message", async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "comrade-attached-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const attached = join(dir, "notes.md");
  writeFileSync(attached, "notes\n");
  const { started, session } = await cutMidCall(t, { files: [attached] });
  const [record] = runs.readRuns(session);
  // Its comrade answered, but Pi exited before the answer came back.
  const kept = readFileSync(session, "utf8")
    .trimEnd()
    .split("\n")
    .filter((line) => !line.includes('"aborted"') && !line.includes("Operation aborted"));
  const reply = {
    type: "message",
    id: "late",
    parentId: JSON.parse(kept.at(-1) ?? "{}").id ?? null,
    message: {
      role: "assistant",
      stopReason: "stop",
      provider: "anthropic",
      model: "claude-opus-5-5",
      content: [{ type: "text", text: "The parser is fine." }],
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
      timestamp: record.started + 90_000,
    },
  };
  writeFileSync(session, `${[...kept, JSON.stringify(reply)].join("\n")}\n`);
  rmSync(attached);
  const again = fixture(t, "hang", { entries: [startRow(started)] });
  assert.equal(again.sent.length, 1);
  assert.equal(delivery(again.sent[0]).status, "finished");
  assert.equal(delivery(again.sent[0]).durationMs, 90_000);
});

test("a run record without a field it is read for is passed over, and its run still resumed", async (t) => {
  const { started, session } = await cutMidCall(t);
  const [record] = runs.readRuns(session);
  const { files: _files, ...fileless } = record;
  const damaged = [
    fileless,
    { ...record, files: [1] },
    { ...record, phase: "running" },
    { ...record, started: "yesterday" },
    { ...record, at: null },
    { ...record, background: "yes" },
    { ...record, child: "123" },
    { ...record, timeoutMs: "600" },
    { ...record, answer: { body: "The parser is fine." } },
  ];
  writeFileSync(runs.runsFile(session), JSON.stringify([...damaged, record]));
  assert.deepEqual(runs.readRuns(session), [record]);

  writeFileSync(runs.runsFile(session), JSON.stringify([{ ...fileless, phase: "starting" }]));
  const again = fixture(t, "echo", { entries: [startRow(started)] });
  assert.deepEqual(again.notices, []);
  assert.equal(delivery(again.sent[0]).status, "resumed");
  await again.delivered(2);
});

test("a resumed comrade runs where its conversation does, with the trust decided there", async (t) => {
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "comrade-outside-")));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
  const { started, session } = await cutMidCall(t, { cwd: elsewhere });
  // A row saved before follow-ups kept their directory names none, or the caller's own.
  const details = { ...(started.details as Record<string, unknown>), cwd: undefined };
  const again = fixture(t, "echo", { entries: [startRow({ ...started, details })] });
  const [, answer] = await again.delivered(2);
  const body = answer[0].content;
  assert(typeof body === "string");
  const echoed = JSON.parse(/\{"args".*\}/.exec(body)?.[0] ?? "{}") as {
    args: string[];
    cwd: string;
  };
  assert.equal(echoed.cwd, elsewhere);
  assert(echoed.args.includes("--no-approve"), "the caller's trust is not given elsewhere");
  assert.equal(readFileSync(session, "utf8").includes(elsewhere), true);
});
