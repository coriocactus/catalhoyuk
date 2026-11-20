// Where a follow-up runs, and what trust it is given there: a comrade's conversation runs in the
// directory its file names, whatever directory its Pi is started in.
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import type { Tool } from "../../test/fake-pi.ts";
import { fixture } from "./fixture.ts";

type Result = Awaited<ReturnType<Tool["execute"]>>;
type Details = import("../index.ts").Details;

/** What reached the stand-in's echo: its flags, and the directory its Pi ran in. */
const echoed = (result: Result) => {
  const [first] = result.content;
  assert(first?.type === "text");
  const text = first.text.replace(/\n\n\[comrade #\d+: [^\n]*\]$/, "");
  return JSON.parse(text) as { args: string[]; cwd: string };
};

/** A directory outside the caller's, as the file system names it. */
const outside = (t: TestContext) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "comrade-outside-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("a follow-up of a comrade run elsewhere runs there again, untrusted", async (t) => {
  const { call, remember } = fixture(t, "echo");
  const elsewhere = outside(t);
  const first = await call({ task: "x", cwd: elsewhere });
  assert(echoed(first).args.includes("--no-approve"));
  remember(first);
  const again = echoed(await call({ task: "y", to: 1 }));
  assert.equal(again.cwd, elsewhere);
  assert(again.args.includes("--no-approve"));
  assert(!again.args.includes("--approve"));
});

test("a follow-up runs where its conversation's file says, though its row kept no directory", async (t) => {
  const { call, remember } = fixture(t, "echo");
  const elsewhere = outside(t);
  const first = await call({ task: "x", cwd: elsewhere });
  // A row keeps the directory only when it was not the caller's at the time.
  remember({ ...first, details: { ...(first.details as Details), cwd: undefined } });
  const again = echoed(await call({ task: "y", to: 1 }));
  assert.equal(again.cwd, elsewhere);
  assert(again.args.includes("--no-approve"), "the caller's trust is not given elsewhere");
});

test("a follow-up naming another directory is refused before anything starts", async (t) => {
  const { call, remember, cwd } = fixture(t, "echo");
  const elsewhere = outside(t);
  const first = await call({ task: "x", cwd: elsewhere });
  remember(first);
  const conversation = (first.details as Details).session ?? "";
  const before = readFileSync(conversation, "utf8");
  await assert.rejects(
    call({ task: "y", to: 1, cwd: "." }),
    new RegExp(
      `^Error: Comrade #1 runs in ${literal(elsewhere)}, and a follow-up runs where its conversation does\\. Start a new comrade to work in ${literal(cwd)}\\.$`,
    ),
  );
  assert.equal(readFileSync(conversation, "utf8"), before, "nothing ran");
  // Naming its own directory moves nothing.
  const same = echoed(await call({ task: "y", to: 1, cwd: elsewhere }));
  assert.equal(same.cwd, elsewhere);
  assert(same.args.includes("--no-approve"));
  // Nor can it continue once that directory is gone.
  rmSync(elsewhere, { recursive: true, force: true });
  await assert.rejects(
    call({ task: "z", to: 1 }),
    new RegExp(
      `^Error: Comrade #1 cannot continue: its directory ${literal(elsewhere)} is gone\\. Start a new comrade\\.$`,
    ),
  );
});

test("a directory inside the caller's only through a symlink is not trusted", async (t) => {
  const { call, cwd } = fixture(t, "echo");
  const elsewhere = outside(t);
  symlinkSync(elsewhere, join(cwd, "vendor"));
  mkdirSync(join(cwd, "packages"));
  const linked = echoed(await call({ task: "x", cwd: "vendor" }));
  assert.equal(linked.cwd, elsewhere);
  assert(linked.args.includes("--no-approve"), "no project-local files load from elsewhere");
  const inside = echoed(await call({ task: "x", cwd: "packages" }));
  assert(inside.args.includes("--approve"));
});

test("the directory that holds a session's conversations is the user's alone", async (t) => {
  const { call } = fixture(t, "echo");
  const result = await call({ task: "x" });
  const directory = dirname((result.details as Details).session ?? "");
  assert.equal(statSync(directory).mode & 0o777, 0o700);
});
