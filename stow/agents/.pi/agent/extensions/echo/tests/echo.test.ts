import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fake } from "../../test/fake-pi.ts";
import { load } from "../../test/pi.ts";

const { default: install } = await load<typeof import("../index.ts")>(
  "../index.ts",
  import.meta.url,
);
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-echo-"));
  const directory = join(root, "echo");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  let command: Command | undefined;
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    install(
      fake<ExtensionAPI>({
        registerCommand(name, options) {
          assert.equal(name, "echo");
          assert.equal(command, undefined, "only one command is registered");
          command = options;
        },
      }),
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
  assert(command);
  assert(command.getArgumentCompletions);
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  let editor = "existing draft";
  const ctx = fake<ExtensionCommandContext>({
    hasUI: true,
    ui: {
      setEditorText(text) {
        editor = text;
      },
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
  });
  return {
    root,
    directory,
    command,
    ctx,
    notifications,
    complete: command.getArgumentCompletions,
    get editor() {
      return editor;
    },
    write(name: string, content = name) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, name), content);
    },
  };
}

test("completion offers sorted direct Markdown names and filters by prefix", async (t) => {
  const f = fixture(t);
  f.write("review.md");
  f.write("plan.md");
  f.write("review carefully.md");
  f.write("notes.txt");
  f.write(".hidden.md");
  mkdirSync(join(f.directory, "nested.md"));
  writeFileSync(join(f.directory, "nested.md", "inside.md"), "not a direct child");
  const items = (names: string[]) => names.map((name) => ({ value: name, label: name }));
  assert.deepEqual(await f.complete(""), items(["plan", "review", "review carefully"]));
  assert.deepEqual(await f.complete("rev"), items(["review", "review carefully"]));
  assert.deepEqual(await f.complete("review c"), items(["review carefully"]));
  assert.equal(await f.complete("missing"), null);
});

test("contents replace the editor verbatim, without sending a message", async (t) => {
  const f = fixture(t);
  const content = "---\ndescription: literal\n---\n# 日本語\n\nKeep $1 and $ARGUMENTS.  \n";
  f.write("review carefully.md", content);
  await f.command.handler(" review carefully ", f.ctx);
  assert.equal(f.editor, content);
  assert.deepEqual(f.notifications, [{ message: "Loaded echo: review carefully", type: "info" }]);
});

test("additions, edits and removals are visible without a reload", async (t) => {
  const f = fixture(t);
  assert.equal(await f.complete(""), null);
  f.write("live.md", "first");
  assert.deepEqual(await f.complete(""), [{ value: "live", label: "live" }]);
  await f.command.handler("live", f.ctx);
  assert.equal(f.editor, "first");
  f.write("live.md", "second");
  await f.command.handler("live", f.ctx);
  assert.equal(f.editor, "second");
  rmSync(join(f.directory, "live.md"));
  assert.equal(await f.complete(""), null);
  await f.command.handler("live", f.ctx);
  assert.equal(f.editor, "second");
  assert.equal(f.notifications.at(-1)?.type, "warning");
});

test("empty snippets are valid and clear the editor", async (t) => {
  const f = fixture(t);
  f.write("empty.md", "");
  await f.command.handler("empty", f.ctx);
  assert.equal(f.editor, "");
  assert.deepEqual(f.notifications, [{ message: "Loaded echo: empty", type: "info" }]);
});

test("symlinked snippets work, including targets outside the snippet directory", async (t) => {
  const f = fixture(t);
  mkdirSync(f.directory);
  writeFileSync(join(f.root, "source.md"), "symlink contents");
  symlinkSync(join(f.root, "source.md"), join(f.directory, "linked.md"));
  assert.deepEqual(await f.complete(""), [{ value: "linked", label: "linked" }]);
  await f.command.handler("linked", f.ctx);
  assert.equal(f.editor, "symlink contents");
});

test("no argument explains usage without changing the editor", async (t) => {
  const f = fixture(t);
  await f.command.handler("  ", f.ctx);
  assert.equal(f.editor, "existing draft");
  assert.equal(f.notifications[0]?.type, "info");
  assert(f.notifications[0]?.message.includes(f.directory));
});

test("unknown names and arbitrary paths cannot load files", async (t) => {
  const f = fixture(t);
  f.write("valid.md");
  writeFileSync(join(f.root, "outside.md"), "must not load");
  for (const name of ["unknown", "../outside", join(f.root, "outside"), "valid.md"]) {
    await f.command.handler(name, f.ctx);
    assert.equal(f.editor, "existing draft");
    assert.equal(f.notifications.at(-1)?.type, "warning");
  }
});

test("missing directory and read failures are quiet during completion, reported on use", async (t) => {
  const f = fixture(t);
  assert.equal(await f.complete(""), null);
  await f.command.handler("missing", f.ctx);
  assert.equal(f.editor, "existing draft");
  assert.equal(f.notifications.at(-1)?.type, "error");
  assert(f.notifications.at(-1)?.message.includes(f.directory));
  mkdirSync(f.directory);
  symlinkSync(join(f.root, "missing.md"), join(f.directory, "broken.md"));
  await f.command.handler("broken", f.ctx);
  assert.equal(f.editor, "existing draft");
  assert.equal(f.notifications.at(-1)?.type, "error");
});

test("non-UI modes do nothing", async (t) => {
  const f = fixture(t);
  await f.command.handler("anything", fake<ExtensionCommandContext>({ hasUI: false }));
});
