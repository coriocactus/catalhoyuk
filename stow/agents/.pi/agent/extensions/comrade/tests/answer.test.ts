// What the caller reads of an answer: bounded however it is shaped, written to output only when
// it is an answer, and never lost because its whole could not be saved.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { load } from "../../test/pi.ts";

const { limit, respond } = await load<typeof import("../answer.ts")>(
  "../answer.ts",
  import.meta.url,
);
const { emptyProgress } = await load<typeof import("../details.ts")>(
  "../details.ts",
  import.meta.url,
);
type Outcome = import("../run.ts").Outcome;
type Request = import("../run.ts").Request;
type RunDetails = import("../view.ts").RunDetails;

/** The byte limit of a tool result, as Pi's own tools keep to. */
const MAX_BYTES = 50 * 1024;

const directory = (t: TestContext) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "comrade-answer-")));
  t.after(() => {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
};
const request = (dir: string, more: Partial<Request> = {}): Request => ({
  task: "t",
  provider: "p",
  model: "m",
  thinking: "off",
  tools: [],
  files: [],
  session: join(dir, "comrade-1.jsonl"),
  cwd: dir,
  trusted: false,
  ...more,
});
const outcome = (text: string, more: Partial<Outcome> = {}): Outcome => ({
  ...emptyProgress(),
  text,
  stopReason: "stop",
  stderr: "",
  exitCode: 0,
  aborted: false,
  timedOut: false,
  ...more,
});
const card = (more: Partial<RunDetails> = {}): RunDetails => ({
  model: "p/m",
  thinking: "off",
  tools: [],
  turns: 1,
  calls: 0,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
  ...more,
});
/** The text the caller reads, without the run line that ends it. */
const read = (text: string) => text.replace(/\n\n\[comrade #\d+: [^\n]*\]$/, "");

test("an answer written to output comes back bounded, however few its lines", (t) => {
  const dir = directory(t);
  const output = join(dir, "out.md");
  const line = "x".repeat(400_000);
  const one = respond(request(dir, { output }), outcome(line), card(), 1000, 1);
  assert.equal(readFileSync(output, "utf8"), line, "the file holds it whole");
  assert.equal(
    read(one.text),
    `Answer written to ${output} (1 line, 390.6KB). Its first line alone is over 50.0KB, so none of it is shown here.`,
  );
  // Twenty lines are few enough, but not at 30,000 bytes each.
  const twenty = Array.from({ length: 20 }, () => "y".repeat(30_000)).join("\n");
  const many = respond(request(dir, { output }), outcome(twenty), card(), 1000, 1);
  assert.match(
    read(many.text),
    /^Answer written to .* \(20 lines, 586\.0KB\)\. First 1 line:\n\ny+$/,
  );
  assert(Buffer.byteLength(many.text) < MAX_BYTES);
});

test("a run that timed out writes nothing to output, and says so", (t) => {
  const dir = directory(t);
  const output = join(dir, "MIGRATION.md");
  writeFileSync(output, "# The guide so far\n");
  const timedOut = outcome("Now I'll check the lexer.", { timedOut: true, aborted: true });
  const reply = respond(
    request(dir, { output, timeoutMs: 600_000 }),
    timedOut,
    card({ timedOut: true }),
    600_000,
    1,
  );
  assert.equal(readFileSync(output, "utf8"), "# The guide so far\n");
  assert.equal(
    read(reply.text),
    `[Comrade timed out after 10m 0s and was stopped. Its last text follows. It is not a final answer, so it was not written to ${output}.]\n\nNow I'll check the lexer.`,
  );
  assert.equal(reply.isError, true);
  assert.equal(reply.file, undefined);
  // A partial answer is an answer: it is written, and says what it is.
  const partial = respond(
    request(dir, { output }),
    outcome("The first half of an", { stopReason: "length" }),
    card({ stopReason: "length" }),
    1000,
    1,
  );
  assert.equal(readFileSync(output, "utf8"), "The first half of an");
  assert.match(read(partial.text), /^\[Comrade's answer is partial: .*\]\n\nAnswer written to /);
});

test("a first line over the byte limit still reaches the caller, cut where a character starts", (t) => {
  const dir = directory(t);
  // Three bytes a character: the limit falls inside one.
  const first = "✓".repeat(30_000);
  const cut = limit(`${first}\nsecond line`, join(dir, "comrade-1.jsonl"), 1);
  const [head, note] = cut.text.split("\n\n");
  assert.equal(head, "✓".repeat(Math.floor(MAX_BYTES / 3)));
  assert.equal(
    note,
    `[Answer truncated: part of line 1 of 2 (50.0KB of 87.9KB). Full answer: ${cut.file}]`,
  );
  assert.equal(readFileSync(cut.file ?? "", "utf8"), `${first}\nsecond line`);
});

test("an answer whose whole cannot be saved still reaches the caller, with why", (t) => {
  const dir = directory(t);
  chmodSync(dir, 0o500);
  const long = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n");
  const cut = limit(long, join(dir, "comrade-1.jsonl"), 1);
  assert.equal(cut.file, undefined);
  assert.match(
    cut.text,
    /^line 1\n[\s\S]*\nline 2000\n\n\[Answer truncated: 2000 of 3000 lines \([^)]+\)\. The full answer could not be saved: EACCES: [^\]]+\]$/,
  );
  // Nor where the caller asked it written: the answer still comes back, as an error.
  const reply = respond(
    request(dir, { output: join(dir, "out", "answer.md") }),
    outcome(long),
    card(),
    1000,
    1,
  );
  assert.equal(reply.isError, true);
  assert.match(reply.text, /^Could not write the answer to .*: EACCES: [^\n]*\n\nline 1\n/);
  assert.match(reply.text, /The full answer could not be saved: EACCES: /);
});
