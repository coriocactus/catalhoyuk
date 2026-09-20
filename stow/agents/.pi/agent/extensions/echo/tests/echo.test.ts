import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type {
  AutocompleteProviderFactory,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { fake, fakePi } from "../../test/fake-pi.ts";
import { load } from "../../test/pi.ts";

const { default: install } = await load<typeof import("../index.ts")>(
  "../index.ts",
  import.meta.url,
);

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-echo-"));
  const directory = join(root, "echo");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const pi = fakePi();
  const wrappers: AutocompleteProviderFactory[] = [];
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    install(pi.api);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const ctx = fake<ExtensionContext>({
    mode: "tui",
    ui: {
      addAutocompleteProvider(factory) {
        wrappers.push(factory);
      },
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
  });
  return {
    root,
    directory,
    pi,
    wrappers,
    async provider(current = fake<AutocompleteProvider>({})) {
      await pi.event("session_start", {}, ctx);
      assert.equal(wrappers.length, 1);
      return wrappers[0](current);
    },
    notifications,
    write(name: string, content = name) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, name), content);
    },
  };
}

const options = () => ({ signal: new AbortController().signal });

async function complete(provider: AutocompleteProvider, prefix: string) {
  const text = `@@${prefix}`;
  return (await provider.getSuggestions([text], 0, text.length, options()))?.items ?? null;
}

async function expand(provider: AutocompleteProvider, lines: string[], line: number, col: number) {
  const suggestions = await provider.getSuggestions(lines, line, col, options());
  assert(suggestions?.items.length);
  return provider.applyCompletion(lines, line, col, suggestions.items[0], suggestions.prefix);
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
  const provider = await f.provider();
  const items = (names: string[]) => names.map((name) => ({ value: name, label: name }));
  assert.deepEqual(await complete(provider, ""), items(["plan", "review", "review carefully"]));
  assert.deepEqual(await complete(provider, "rev"), items(["review", "review carefully"]));
  assert.deepEqual(await complete(provider, "review c"), items(["review carefully"]));
  assert.equal(await complete(provider, "missing"), null);
});

test("inline insertion preserves contents verbatim, without sending a message", async (t) => {
  const f = fixture(t);
  const content = "---\ndescription: literal\n---\n# 日本語\n\nKeep $1 and $ARGUMENTS.  \n";
  f.write("review carefully.md", content);
  const provider = await f.provider();
  const result = await expand(provider, ["@@review c"], 0, 10);
  assert.equal(result.lines.join("\n"), content);
  assert.deepEqual(f.notifications, []);
});

test("additions, edits and removals are visible without a reload", async (t) => {
  const f = fixture(t);
  const provider = await f.provider();
  assert.equal(await complete(provider, ""), null);
  f.write("live.md", "first");
  assert.deepEqual(await complete(provider, ""), [{ value: "live", label: "live" }]);
  assert.deepEqual((await expand(provider, ["@@live"], 0, 6)).lines, ["first"]);
  f.write("live.md", "second");
  assert.deepEqual((await expand(provider, ["@@live"], 0, 6)).lines, ["second"]);
  rmSync(join(f.directory, "live.md"));
  assert.equal(await complete(provider, ""), null);
  assert.deepEqual(f.notifications, []);
});

test("symlinked snippets work, including targets outside the snippet directory", async (t) => {
  const f = fixture(t);
  mkdirSync(f.directory);
  writeFileSync(join(f.root, "source.md"), "symlink contents");
  symlinkSync(join(f.root, "source.md"), join(f.directory, "linked.md"));
  const provider = await f.provider();
  assert.deepEqual(await complete(provider, ""), [{ value: "linked", label: "linked" }]);
  assert.deepEqual((await expand(provider, ["@@linked"], 0, 8)).lines, ["symlink contents"]);
});

test("@@ completion matches names, including spaces, at the cursor", async (t) => {
  const f = fixture(t);
  f.write("review.md");
  f.write("review carefully.md");
  const provider = await f.provider();
  for (const text of ["@@", "Before @@rev", "\t@@review"]) {
    const result = await provider.getSuggestions([text], 0, text.length, options());
    assert.deepEqual(
      result?.items.map((item) => item.value),
      ["review", "review carefully"],
    );
    assert.equal(result?.prefix, text.slice(text.indexOf("@@")));
  }
  const result = await provider.getSuggestions(["@@review c trailing"], 0, 10, options());
  assert.deepEqual(result, {
    prefix: "@@review c",
    items: [{ value: "review carefully", label: "review carefully" }],
  });
});

test("inline expansion composes snippets, preserves surrounding lines, and places the cursor", async (t) => {
  const f = fixture(t);
  f.write("review.md", "# Review\nKeep $1.\n");
  f.write("plan.md", "Plan");
  const provider = await f.provider();
  const original = ["before", "日本語 @@rev suffix", "after"];
  const first = await expand(provider, original, 1, "日本語 @@rev".length);
  assert.deepEqual(first, {
    lines: ["before", "日本語 # Review", "Keep $1.", " suffix", "after"],
    cursorLine: 3,
    cursorCol: 0,
  });
  assert.deepEqual(
    original,
    ["before", "日本語 @@rev suffix", "after"],
    "undo input is unmodified",
  );
  first.lines[first.cursorLine] = "@@pl suffix";
  const second = await expand(provider, first.lines, first.cursorLine, 4);
  assert.deepEqual(second, {
    lines: ["before", "日本語 # Review", "Keep $1.", "Plan suffix", "after"],
    cursorLine: 3,
    cursorCol: 4,
  });
  assert.deepEqual(f.notifications, []);
});

test("inline empty snippets remove only the trigger, without adding whitespace", async (t) => {
  const f = fixture(t);
  f.write("empty.md", "");
  const provider = await f.provider();
  assert.deepEqual(await expand(provider, ["before @@empty after"], 0, 14), {
    lines: ["before  after"],
    cursorLine: 0,
    cursorCol: 7,
  });
});

test("inline expansion reads current contents and leaves failed selections untouched", async (t) => {
  const f = fixture(t);
  f.write("live.md", "old");
  const provider = await f.provider();
  const lines = ["@@live"];
  const suggestions = await provider.getSuggestions(lines, 0, 6, options());
  assert(suggestions);
  const apply = () =>
    provider.applyCompletion(lines, 0, 6, suggestions.items[0], suggestions.prefix);
  f.write("live.md", "updated");
  assert.deepEqual(apply(), { lines: ["updated"], cursorLine: 0, cursorCol: 7 });
  rmSync(join(f.directory, "live.md"));
  assert.deepEqual(apply(), { lines, cursorLine: 0, cursorCol: 6 });
  assert.equal(f.notifications.at(-1)?.type, "error");
  symlinkSync(join(f.root, "missing.md"), join(f.directory, "live.md"));
  assert.deepEqual(apply(), { lines, cursorLine: 0, cursorCol: 6 });
  assert.equal(f.notifications.at(-1)?.type, "error");
  assert.deepEqual(
    provider.applyCompletion(lines, 0, 6, { value: "../outside", label: "outside" }, "@@live"),
    { lines, cursorLine: 0, cursorCol: 6 },
  );
});

test("@@ never falls back to file completion when missing, unmatched, or cancelled", async (t) => {
  const f = fixture(t);
  const provider = await f.provider();
  assert.equal(await provider.getSuggestions(["@@"], 0, 2, options()), null);
  f.write("review.md");
  assert.equal(await provider.getSuggestions(["@@missing"], 0, 9, options()), null);
  assert.equal(await provider.getSuggestions(["@@"], 0, 2, { signal: AbortSignal.abort() }), null);
  assert.equal(provider.shouldTriggerFileCompletion?.(["@@"], 0, 2), true);
  assert.deepEqual(f.notifications, []);
});

test("normal @files, commands, other providers and plain text delegate unchanged", async (t) => {
  const f = fixture(t);
  const nativeSuggestions = { prefix: "native", items: [{ value: "native", label: "native" }] };
  const nativeResult = { lines: ["native"], cursorLine: 0, cursorCol: 6 };
  const current = {
    triggerCharacters: ["#"],
    getSuggestions: t.mock.fn<AutocompleteProvider["getSuggestions"]>(
      async () => nativeSuggestions,
    ),
    applyCompletion: t.mock.fn<AutocompleteProvider["applyCompletion"]>(() => nativeResult),
    shouldTriggerFileCompletion: t.mock.fn(() => false),
  } satisfies AutocompleteProvider;
  const provider = await f.provider(current);
  assert.deepEqual(provider.triggerCharacters, ["#", "@"]);
  for (const text of ["@file", "/model", "#issue", "plain", "email@@host", "@@@no"]) {
    const lines = [text];
    const opts = options();
    assert.equal(await provider.getSuggestions(lines, 0, text.length, opts), nativeSuggestions);
    assert.deepEqual(current.getSuggestions.mock.calls.at(-1)?.arguments, [
      lines,
      0,
      text.length,
      opts,
    ]);
    assert.equal(provider.shouldTriggerFileCompletion?.(lines, 0, text.length), false);
  }
  const args: Parameters<AutocompleteProvider["applyCompletion"]> = [
    ["@f"],
    0,
    2,
    { value: "file", label: "file" },
    "@f",
  ];
  assert.equal(provider.applyCompletion(...args), nativeResult);
  assert.deepEqual(current.applyCompletion.mock.calls[0]?.arguments, args);
});

for (const mode of ["rpc", "print", "json"] as const) {
  test(`${mode} does not install inline terminal autocomplete`, async (t) => {
    const f = fixture(t);
    await f.pi.event("session_start", {}, { mode });
    assert.equal(f.wrappers.length, 0);
  });
}
