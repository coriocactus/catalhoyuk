// Comrade against the installed Pi rather than the stand-in: the task on stdin, the flags, the
// session file, attached files, the nested guard, and the JSON event stream Comrade reads are
// Pi's own. An offline provider stands in for the model only.
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

const { run } = await load<typeof import("../run.ts")>("../run.ts", import.meta.url);
type Request = import("../run.ts").Request;
type Progress = import("../run.ts").Progress;

const here = (name: string) => fileURLToPath(new URL(name, import.meta.url));

test("a comrade runs in the installed Pi: task, tools, files, session and events", async (t) => {
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
  const watch = (progress: Progress) => {
    if (states.at(-1) !== progress.activity.state) states.push(progress.activity.state);
  };

  // A task that would be a file reference and a flag on a command line, a tool call it asks
  // for, then the answer.
  const task = `#read ${notes}\n@notes.md --version`;
  const first = await run(invocation, { ...base, task }, undefined, watch);
  assert.equal(first.exitCode, 0, first.stderr);
  assert.equal(first.errorMessage, undefined);
  assert.equal(first.stopReason, "stop");
  const seen: Seen = JSON.parse(first.text);
  assert.equal(seen.first, `#read ${notes}`, "the task reached the model from stdin");
  assert.deepEqual(seen.tools, ["read"], "only the tools asked for, and never comrade");
  assert.equal(seen.read, 1);
  assert.equal(first.model, "comrade-fixture/fixture");
  assert.equal(first.turns, 2);
  assert.equal(first.calls, 1);
  assert.deepEqual(first.work.tallies, [
    { kind: "read", calls: 1, failed: 0, files: 1, added: 0, removed: 0 },
  ]);
  // The progress line's states come from Pi's event names, in Pi's order. (`starting` is the
  // row's own, shown before Pi reports anything.)
  assert.deepEqual(
    states,
    ["waiting", "calling", "running", "waiting", "writing"],
    `states: ${states.join(" → ")}`,
  );
  assert(existsSync(session), "Pi kept the conversation where it was told to");
  assert.match(readFileSync(session, "utf8"), /"type":"session"/);

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
  // Pi trims the task and appends the first block to its last line, with nothing between.
  assert.equal(again.first, `second<file name="${notes}">`);
  assert.equal(again.users, 2, "the comrade still has its first task");
  assert.equal(again.files, 1);
  assert.deepEqual(again.tools, []);
  assert.equal(second.turns, 1);
});
