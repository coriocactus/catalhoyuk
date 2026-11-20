// One run of a comrade's Pi, against the stand-in: the order its prompts reach Pi in, how its
// end is read, and what stands of it however its Pi exits.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { load } from "../../test/pi.ts";
import { fixture, standIn } from "./fixture.ts";

const { Channel, run, steering } = await load<typeof import("../run.ts")>(
  "../run.ts",
  import.meta.url,
);
type Request = import("../run.ts").Request;
type Outcome = import("../run.ts").Outcome;

const invocation = (scenario: string) => ({ command: process.execPath, args: [standIn, scenario] });
/** A run's request, its conversation in a directory of its own. */
function request(t: TestContext, task = "Survey the parser"): Request {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "comrade-run-")));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return {
    task,
    provider: "anthropic",
    model: "claude-opus-5-5",
    thinking: "off",
    tools: [],
    files: [],
    session: join(cwd, "comrade-1.jsonl"),
    cwd,
    origin: cwd,
    trusted: false,
  };
}
/** What the comrade was told in the run, in order. */
const told = (outcome: Outcome) =>
  outcome.messages.flatMap((message) =>
    message.role !== "user"
      ? []
      : [
          typeof message.content === "string"
            ? message.content
            : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
        ],
  );

test("a steer sent before the comrade's Pi has started reaches it once Pi has the task", async (t) => {
  // Pi loses a prompt that reaches it, idle, before it has answered the one before.
  const channel = new Channel();
  const held = channel.steer("Only the lexer");
  const outcome = await run(invocation("echo"), request(t), undefined, () => {}, channel);
  await held;
  assert.deepEqual(told(outcome), ["Survey the parser", steering("Only the lexer")]);
});

test("a steer waiting to be sent is refused when Pi refuses the task", async (t) => {
  const channel = new Channel();
  const refused = assert.rejects(channel.steer("Then the lexer"), /^Error: Pi exited$/);
  const outcome = await run(invocation("rejected"), request(t), undefined, () => {}, channel);
  assert.equal(outcome.errorMessage, "No API key found for anthropic");
  await refused;
});

test("a run whose answer and end reach the host in one chunk ends", async (t) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  const outcome = await run(invocation("burst"), request(t), controller.signal, () => {});
  clearTimeout(timer);
  assert.equal(outcome.aborted, false, "it ended by itself");
  assert.equal(outcome.text, "Done at once.");
  assert.equal(outcome.exitCode, 0);
});

test("an answer stands however its Pi exits once the run has settled", async (t) => {
  const result = await fixture(t, "dirtyexit").call({ task: "✓" });
  assert.equal(result.isError, undefined);
  const [first] = result.content;
  assert(first?.type === "text");
  assert.match(first.text, /^All done\.\n\n\[comrade #1: /);
});

test("a timeout longer than a timer holds does not stop the comrade at once", async (t) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  const outcome = await run(
    invocation("hang"),
    { ...request(t), timeoutMs: 30 * 24 * 60 * 60_000 },
    controller.signal,
    () => {},
  );
  clearTimeout(timer);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.aborted, true);
});

test("what a comrade waits on reaches its row on one line, without escape codes", async (t) => {
  const details = new Set<string>();
  await run(invocation("escapes"), request(t), undefined, (progress) => {
    if (progress.activity.detail) details.add(progress.activity.detail);
  });
  assert.deepEqual([...details], ["1/3 · bad [2Jgateway", "re ]0;x ad"]);
});

test("a Pi out of file descriptors fails the run rather than crashing", () => {
  // In a process of its own, whose descriptors are few, so using them up costs nothing else.
  const script = fileURLToPath(new URL("./no-descriptors.ts", import.meta.url));
  const result = spawnSync(
    "/bin/sh",
    ["-c", 'ulimit -n 256 && exec "$0" "$1"', process.execPath, script],
    {
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).error, /^Could not start pi: spawn .*EMFILE$/);
});
