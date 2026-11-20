// Runs a comrade in a process with no file descriptors left, as a long-lived Pi with many
// watchers and servers can be. Run it under a low `ulimit -n`. It prints the run's error as JSON,
// or dies of the error event Node emits when it cannot start a process with pipes.
import { closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "../../test/pi.ts";

const { run } = await load<typeof import("../run.ts")>("../run.ts", import.meta.url);
const cwd = tmpdir();
const held: number[] = [];
try {
  for (;;) held.push(openSync("/dev/null", "r"));
} catch {
  // None left.
}
const outcome = await run(
  { command: process.execPath, args: ["-e", "0"] },
  {
    task: "Survey the parser",
    provider: "anthropic",
    model: "claude-opus-5-5",
    thinking: "off",
    tools: [],
    files: [],
    session: join(cwd, "comrade-none.jsonl"),
    cwd,
    trusted: false,
  },
  undefined,
  () => {},
);
for (const fd of held) closeSync(fd);
process.stdout.write(JSON.stringify({ error: outcome.errorMessage }));
