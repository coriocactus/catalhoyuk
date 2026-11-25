// A clicked link to a text file opens in the editor, at the line it names; every other link goes
// to Pi's opener, as before.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fake, fakePi } from "../../test/fake-pi.ts";
import { load, tui } from "../../test/pi.ts";

const { default: installInspector } = await load<typeof import("../index.ts")>(
  "../index.ts",
  import.meta.url,
);
const { fileLink, isTextFile } = await load<typeof import("../links.ts")>(
  "../links.ts",
  import.meta.url,
);

type CustomFactory = Parameters<ExtensionContext["ui"]["custom"]>[0];
type FactoryArgs = Parameters<CustomFactory>;
type Notice = Parameters<ExtensionContext["ui"]["notify"]>;

const root = mkdtempSync(join(tmpdir(), "pi-inspector-links-"));
after(() => rmSync(root, { recursive: true, force: true }));

const waitFor = async (predicate: () => boolean, what: string) => {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${what}`);
};

test("a file link names its path, and the line its fragment names", () => {
  assert.deepEqual(fileLink("file:///tmp/notes.md"), { path: "/tmp/notes.md" });
  assert.deepEqual(fileLink("file:///tmp/a%20b.md#L120"), { path: "/tmp/a b.md", line: 120 });
  assert.deepEqual(fileLink("file:///tmp/a.ts#120"), { path: "/tmp/a.ts", line: 120 });
  assert.deepEqual(fileLink("file:///tmp/a.ts#L12-L20"), { path: "/tmp/a.ts", line: 12 });
  assert.deepEqual(fileLink("file://localhost/tmp/a.ts#top"), { path: "/tmp/a.ts" });
  // Not a local file.
  assert.equal(fileLink("https://pi.dev"), undefined);
  assert.equal(fileLink("file://server/share/a.ts"), undefined);
  assert.equal(fileLink("not a url"), undefined);
});

test("a text file has no NUL byte and is valid UTF-8 where it starts", async () => {
  const file = (name: string, content: string | Buffer) => {
    const path = join(root, name);
    writeFileSync(path, content);
    return path;
  };
  assert(await isTextFile(file("notes.md", "# Notes\n\nCafé ☕ 日本語\n")));
  assert(await isTextFile(file("empty", "")));
  // A character cut where the reading stops is still text.
  assert(await isTextFile(file("long.txt", `${"x".repeat(7999)}é and more`)));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  assert(!(await isTextFile(file("picture.png", png))));
  assert(!(await isTextFile(file("latin1.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9])))));
  assert(!(await isTextFile(file("nul.txt", "text\0more"))));
});

/** Inspector in a session, its editor a script that logs how it was run, and a screen of Pi's. */
async function clicking() {
  const dir = mkdtempSync(join(root, "session-"));
  const pi = fakePi();
  const notices: Notice[] = [];
  let edits = 0;
  installInspector(pi.api);
  const ctx = fake<ExtensionContext>({
    mode: "tui",
    cwd: dir,
    ui: {
      notify: (...args) => notices.push(args),
      getEditorText: () => "draft",
      setEditorText() {},
      custom: async <T>(factory: CustomFactory) => {
        let result: unknown;
        await factory(
          fake<FactoryArgs[0]>({ stop() {}, start() {}, requestRender() {} }),
          fake<FactoryArgs[1]>({}),
          fake<FactoryArgs[2]>({}),
          (value) => {
            result = value;
          },
        );
        edits++;
        return result as T;
      },
    },
  });
  const log = join(dir, "editor.log");
  const editor = join(dir, "editor");
  writeFileSync(editor, `#!/bin/sh\nprintf "%s\\n" "$@" > "${log}"\n`, { mode: 0o700 });
  const opened: string[] = [];
  // Pi's own screen, with the opener its options give it, which the patch wraps.
  const screen = Object.assign(Object.create(tui.TuiAltScreen.prototype), {
    openUrl: (url: string) => void opened.push(url),
  }) as { openUrl(url: string): void; handleSelectionMouseEvent(event: object): void };
  // A middle-button press, which Pi's selection ignores once the opener is wrapped.
  const press = () => screen.handleSelectionMouseEvent({ button: 1, release: false, x: 0, y: 0 });
  const oldVisual = process.env.VISUAL;
  const oldWrite = process.stdout.write;
  process.env.VISUAL = editor;
  process.stdout.write = function (
    this: typeof process.stdout,
    chunk: unknown,
    ...rest: unknown[]
  ) {
    return chunk === "\x1b[2J\x1b[H" ? true : Reflect.apply(oldWrite, this, [chunk, ...rest]);
  } as typeof process.stdout.write;
  await pi.event("session_start", {}, ctx);
  return {
    pi,
    ctx,
    dir,
    screen,
    press,
    opened,
    notices,
    editorRuns: () => edits,
    editorArgs: () => readFileSync(log, "utf8").trimEnd().split("\n"),
    async done() {
      await pi.event("session_shutdown");
      process.stdout.write = oldWrite;
      if (oldVisual === undefined) delete process.env.VISUAL;
      else process.env.VISUAL = oldVisual;
    },
  };
}

test("a link to a text file opens in the editor at its line; others go to Pi's opener", async () => {
  const c = await clicking();
  try {
    c.press();
    const notes = join(c.dir, "notes.md");
    writeFileSync(notes, "one\ntwo\nthree\n");
    c.screen.openUrl(`${pathToFileURL(notes).href}#L3`);
    await waitFor(() => c.editorRuns() === 1, "the editor");
    assert.deepEqual(c.editorArgs(), ["+3", "--", notes]);
    assert.deepEqual(c.opened, [], "Pi's opener is not asked");
    // Without a line, the file opens where the editor opens it.
    c.screen.openUrl(pathToFileURL(notes).href);
    await waitFor(() => c.editorRuns() === 2, "the editor again");
    assert.deepEqual(c.editorArgs(), ["--", notes]);
    // A file that is not text, a directory, a missing file, and a web page: Pi's opener.
    const picture = join(c.dir, "picture.png");
    writeFileSync(picture, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]));
    const folder = join(c.dir, "folder");
    mkdirSync(folder);
    const others = [picture, folder, join(c.dir, "missing.md")].map(
      (path) => pathToFileURL(path).href,
    );
    for (const url of others) {
      c.screen.openUrl(url);
      await waitFor(() => c.opened.includes(url), url);
    }
    c.screen.openUrl("https://pi.dev");
    assert.equal(c.opened.at(-1), "https://pi.dev", "a web page goes straight to Pi's opener");
    assert.equal(c.editorRuns(), 2);
    assert.deepEqual(c.notices, []);
  } finally {
    await c.done();
  }
  // With no session to show the editor, every link goes to Pi's opener.
  const late = pathToFileURL(join(c.dir, "notes.md")).href;
  c.screen.openUrl(late);
  assert.equal(c.opened.at(-1), late);
});

test("a reloaded inspector takes the links of a screen an earlier one wrapped", async () => {
  const first = await clicking();
  first.press();
  await first.done();
  const second = await clicking();
  try {
    const notes = join(second.dir, "notes.md");
    writeFileSync(notes, "text\n");
    first.screen.openUrl(`${pathToFileURL(notes).href}#L1`);
    await waitFor(() => second.editorRuns() === 1, "the reloaded inspector's editor");
    assert.deepEqual(first.opened, []);
  } finally {
    await second.done();
  }
});

test("a screen without Pi's link opener is left alone, with one warning", async () => {
  const c = await clicking();
  try {
    const bare = Object.create(tui.TuiAltScreen.prototype) as {
      handleSelectionMouseEvent(event: object): void;
    };
    for (let i = 0; i < 2; i++) bare.handleSelectionMouseEvent({ button: 1, release: false });
    await waitFor(() => c.notices.length > 0, "the warning");
    await delay(10);
    assert.equal(c.notices.length, 1);
    assert.match(String(c.notices[0][0]), /link opener changed/);
    assert.equal(c.notices[0][1], "warning");
  } finally {
    await c.done();
  }
});
