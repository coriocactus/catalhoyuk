// Comrade against the installed Pi rather than the stand-in: the prompt command, the flags, the
// session file, attached files, the nested guard, messages sent while it runs, and the RPC
// records Comrade reads are Pi's own. An offline provider stands in for the model only.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cli, load, version } from "../../test/pi.ts";
import type { Seen } from "./offline-pi.ts";

const { Channel, run, steering } = await load<typeof import("../run.ts")>(
  "../run.ts",
  import.meta.url,
);
const { interruption, finished } = await load<typeof import("../resume.ts")>(
  "../resume.ts",
  import.meta.url,
);
type Request = import("../run.ts").Request;
type Progress = import("../run.ts").Progress;

const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));

test("a comrade runs in the installed Pi: task, tools, files, session, messages and events", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "comrade-pi-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Pi's own files stay untouched: an empty agent directory, no network, no telemetry.
  const config = join(root, "config");
  mkdirSync(config);
  writeFileSync(
    join(config, "settings.json"),
    JSON.stringify({
      lastChangelogVersion: version,
      quietStartup: true,
      enableInstallTelemetry: false,
    }),
  );
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const notes = join(cwd, "notes.md");
  writeFileSync(notes, "NOTES\n");
  const invocation = {
    command: process.execPath,
    args: [
      cli,
      "--no-extensions",
      "-e",
      here("./offline-pi.ts"),
      // Comrade itself, which in a comrade registers nothing.
      "-e",
      here("../index.ts"),
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
    ],
    env: { ...process.env, PI_CODING_AGENT_DIR: config, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
  };
  const session = join(root, "comrades", "comrade-1.jsonl");
  const base: Request = {
    task: "",
    provider: "comrade-fixture",
    model: "fixture",
    thinking: "off",
    tools: ["read"],
    files: [],
    session,
    cwd,
    origin: cwd,
    trusted: false,
  };
  const states: string[] = [];
  // What a running row shows of each call: its label and status, as they change.
  const calls: string[] = [];
  const watch = (progress: Progress) => {
    if (states.at(-1) !== progress.activity.state) states.push(progress.activity.state);
    const latest = progress.work.recent?.at(-1);
    const seen = latest && `${latest.status} ${latest.label}`;
    if (seen && calls.at(-1) !== seen) calls.push(seen);
  };

  // A task that would be a file reference and a flag on a command line, a tool call it asks
  // for, then the answer.
  const task = `#read ${notes}\n@notes.md --version`;
  const first = await run(invocation, { ...base, task }, undefined, watch);
  assert.equal(first.exitCode, 0, first.stderr);
  assert.equal(first.errorMessage, undefined);
  assert.equal(first.stopReason, "stop");
  const seen: Seen = JSON.parse(first.text);
  assert.equal(seen.first, `#read ${notes}`, "the task reached the model, verbatim");
  assert.deepEqual(seen.tools, ["read"], "only the tools asked for, and never comrade");
  assert.equal(seen.read, 1);
  assert.equal(first.model, "comrade-fixture/fixture");
  assert.equal(first.turns, 2);
  assert.equal(first.calls, 1);
  assert.deepEqual(first.work.tallies, [
    { kind: "read", calls: 1, failed: 0, files: 1, added: 0, removed: 0 },
  ]);
  // The progress line's states come from Pi's event names, in Pi's order. (`starting` is the
  // row's own, shown once its Pi has started and before Pi reports anything.)
  assert.deepEqual(
    states,
    ["starting", "waiting", "calling", "running", "waiting", "writing"],
    `states: ${states.join(" → ")}`,
  );
  assert(existsSync(session), "Pi kept the conversation where it was told to");
  assert.match(readFileSync(session, "utf8"), /"type":"session"/);
  assert.deepEqual(calls, [`running Reading ${notes}`, `success Read ${notes}`]);
  assert.equal(first.said, first.text, "its whole answer is one line: the last thing it said");
  assert.equal(typeof first.pid, "number");
  assert.equal(first.asked, true, "Pi reported saving the prompt");
  // Its conversation shows it finished, with the answer that came back.
  assert.equal(interruption(session), undefined);
  assert.equal(finished(session, 0)?.text, first.text);

  // Attached files reach the prompt, an empty tool list is no tools, and the same session
  // file continues the conversation.
  const second = await run(
    invocation,
    { ...base, task: "second", tools: [], files: [notes], followUp: true },
    undefined,
    () => {},
  );
  assert.equal(second.exitCode, 0, second.stderr);
  const again: Seen = JSON.parse(second.text);
  assert.equal(again.first, "second");
  assert.equal(again.users, 2, "the comrade still has its first task");
  assert.equal(again.files, 1);
  assert.deepEqual(again.tools, []);
  assert.equal(second.turns, 1);

  // A message sent while the comrade waits for its first reply reaches it before the next.
  const channel = new Channel();
  let told = false;
  const third = await run(
    invocation,
    { ...base, task: `#read ${notes}\n#slow`, session: join(root, "comrades", "comrade-2.jsonl") },
    undefined,
    (progress) => {
      if (told || progress.activity.state !== "waiting" || progress.turns) return;
      told = true;
      void channel.steer("Also: turn left");
    },
    channel,
  );
  assert.equal(third.exitCode, 0, third.stderr);
  const steered: Seen = JSON.parse(third.text);
  assert.equal(
    steered.first,
    steering("Also: turn left").split("\n")[0],
    "the message arrived after the read",
  );
  assert.equal(steered.users, 2);
  assert.equal(steered.read, 1);
  assert.equal(channel.open, false, "closed once the comrade has ended");

  // A message sent as the comrade gives its answer is not lost, however the timing falls: Pi
  // takes it into the run, or starts a run with it once settled.
  const late = new Channel();
  let sent = false;
  const fifth = await run(
    invocation,
    { ...base, task: "answer at once", session: join(root, "comrades", "comrade-4.jsonl") },
    undefined,
    (progress) => {
      if (sent || !progress.turns) return;
      sent = true;
      void late.steer("One more thing");
    },
    late,
  );
  assert.equal(fifth.exitCode, 0, fifth.stderr);
  assert.equal(fifth.turns, 2);
  const after: Seen = JSON.parse(fifth.text);
  assert.equal(after.users, 2);
  assert.equal(after.first, steering("One more thing").split("\n")[0]);

  // Stopped mid-command, as when the Pi that started it exits: its conversation names the call
  // that may or may not have taken effect.
  const controller = new AbortController();
  const cut = join(root, "comrades", "comrade-3.jsonl");
  const fourth = await run(
    invocation,
    { ...base, task: "#bash sleep 30", tools: ["bash"], session: cut },
    controller.signal,
    (progress) => {
      if (progress.work.current?.startsWith("$")) controller.abort();
    },
  );
  assert.equal(fourth.aborted, true);
  assert.deepEqual(interruption(cut)?.calls, ["$ sleep 30"]);
});
