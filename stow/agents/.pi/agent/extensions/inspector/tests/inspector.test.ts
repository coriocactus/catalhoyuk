import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { type FileToolName, OPEN_FILE_EVENT, type OpenFileRequest } from "../../shared/protocol.ts";
import { fake, fakePi } from "../../test/fake-pi.ts";
import { core, load, tui } from "../../test/pi.ts";

const { default: installInspector } = await load<typeof import("../index.ts")>(
  "../index.ts",
  import.meta.url,
);
const { resolveToolFile } = await load<typeof import("../paths.ts")>(
  "../paths.ts",
  import.meta.url,
);

type CustomFactory = Parameters<ExtensionContext["ui"]["custom"]>[0];
type FactoryArgs = Parameters<CustomFactory>;
type Notice = Parameters<ExtensionContext["ui"]["notify"]>;
/** Private InteractiveMode dialog host: the real custom-component lifecycle. */
interface DialogHost {
  showExtensionCustom(this: object, factory: CustomFactory): Promise<unknown>;
}

const dialogs = core.InteractiveMode.prototype as unknown as DialogHost;
const root = mkdtempSync(join(tmpdir(), "pi-inspector-"));
after(() => rmSync(root, { recursive: true, force: true }));

const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error("Timed out waiting for editor lifecycle");
};
const firstText = (output: AgentToolResult<unknown>) => {
  const part = output.content[0];
  assert(part?.type === "text", "text result");
  return part.text;
};
const request = (path: string, cwd: string, tool: FileToolName = "read"): OpenFileRequest => ({
  path,
  cwd,
  tool,
  accepted: false,
});

test("filename resolution matches Pi, including Unicode spaces, URLs, and macOS fallbacks", async () => {
  const dir = mkdtempSync(join(root, "paths-"));
  writeFileSync(join(dir, "a b.txt"), "ASCII");
  writeFileSync(join(dir, "a\u00a0b.txt"), "NBSP");
  const args = { path: "a\u00a0b.txt" };
  const read = core.createReadToolDefinition(dir);
  const ctx = fake<ExtensionContext>({ cwd: dir });
  assert.equal(firstText(await read.execute("read", args, undefined, undefined, ctx)), "ASCII");
  for (const tool of ["read", "edit", "write"] as const) {
    const target = await resolveToolFile({ ...args, cwd: dir, tool });
    assert.equal(readFileSync(target, "utf8"), "ASCII");
    assert.equal(await resolveToolFile({ path: "@a b.txt", cwd: dir, tool }), target);
    assert.equal(
      await resolveToolFile({ path: pathToFileURL(target).href, cwd: dir, tool }),
      target,
    );
  }
  const screenshot = join(dir, "Screenshot 1.00\u202fPM.png");
  writeFileSync(screenshot, "screenshot");
  assert.equal(
    await resolveToolFile({ path: "Screenshot 1.00 PM.png", cwd: dir, tool: "read" }),
    screenshot,
  );
});

test("real Pi dialog preserves newer drafts on Vim success, failure and session replacement", async (t) => {
  const oldVisual = process.env.VISUAL;
  const stdout = process.stdout.write;
  t.mock.method(
    process.stdout,
    "write",
    function (this: typeof process.stdout, chunk: unknown, ...args: unknown[]) {
      return chunk === "\x1b[2J\x1b[H" ? true : Reflect.apply(stdout, this, [chunk, ...args]);
    },
  );
  try {
    for (const scenario of [
      "success",
      "cleared-draft",
      "multiline-draft",
      "exit-error",
      "signal",
      "spawn-error",
      "new",
      "resume",
      "fork",
      "reload",
      "quit",
      "stubborn",
    ]) {
      await t.test(scenario, async () => {
        const dir = mkdtempSync(join(root, "draft-"));
        const path = join(dir, "literal.txt"),
          ready = join(dir, "ready"),
          gate = join(dir, "exit");
        writeFileSync(path, "safe\n");
        const editor = join(dir, "editor.mjs");
        writeFileSync(
          editor,
          `#!${process.execPath}\nimport { existsSync, readFileSync, writeFileSync } from 'node:fs';
process.on('SIGTERM', () => { ${scenario === "stubborn" ? "" : "setTimeout(() => process.exit(0), 80);"} });
writeFileSync(${JSON.stringify(ready)}, String(process.pid));
setInterval(() => { if (existsSync(${JSON.stringify(gate)})) {
  const code = readFileSync(${JSON.stringify(gate)}, 'utf8');
  if (code === 'signal') process.kill(process.pid, 'SIGKILL'); else process.exit(Number(code));
} }, 5);\n`,
          { mode: 0o700 },
        );
        process.env.VISUAL = scenario === "spawn-error" ? join(dir, "missing") : editor;
        let alive = true,
          finished = 0,
          starts = 0,
          stops = 0,
          staleAccesses = 0;
        const notices: Notice[] = [];
        const latest =
          scenario === "cleared-draft"
            ? ""
            : scenario === "multiline-draft"
              ? "LATEST_DRAFT\n日本語\n"
              : "LATEST_DRAFT";
        const failed = ["spawn-error", "exit-error", "signal"].includes(scenario);
        const makeEditor = (text: string) =>
          fake<EditorComponent>({
            getText: () => text,
            setText: (value) => {
              text = value;
            },
            render: () => [],
            invalidate() {},
          });
        const host = {
          editor: makeEditor("ORIGINAL_DRAFT"),
          editorContainer: new tui.Container(),
          keybindings: {},
          ui: {
            stop() {
              stops++;
              host.editor.setText(latest);
            },
            start() {
              assert(alive, "never restart an obsolete TUI");
              starts++;
            },
            requestRender() {},
            setFocus() {},
          },
        };
        const ui = fake<ExtensionContext["ui"]>({
          notify: (...args) => notices.push(args),
          getEditorText: () => host.editor.getText(),
          setEditorText: (text) => host.editor.setText(text),
          custom: <T>(factory: CustomFactory) =>
            dialogs.showExtensionCustom.call(host, factory).finally(() => {
              finished++;
            }) as Promise<T>,
        });
        const ctx = fake<ExtensionContext>({
          mode: "tui",
          get ui() {
            if (!alive) {
              staleAccesses++;
              throw new Error("stale context");
            }
            return ui;
          },
        });
        const pi = fakePi();
        installInspector(pi.api);
        let pid: number | undefined;
        try {
          await pi.event("session_start", {}, ctx);
          pi.events.emit(OPEN_FILE_EVENT, request(path, dir));
          if (scenario !== "spawn-error") {
            await waitFor(() => {
              try {
                pid = Number(readFileSync(ready, "utf8"));
                return pid > 0;
              } catch {
                return false;
              }
            });
          }
          const replacement = ["new", "resume", "fork", "reload", "quit", "stubborn"].includes(
            scenario,
          );
          if (replacement) {
            let settled = false;
            const shutdown = pi
              .event("session_shutdown", { reason: scenario === "stubborn" ? "quit" : scenario })
              .then(() => {
                settled = true;
              });
            await delay(10);
            assert(!settled, "shutdown waits for the editor and native dialog cleanup");
            await shutdown;
            assert.equal(finished, 1);
            assert.equal(host.editor.getText(), latest);
            assert.equal(starts, scenario === "quit" || scenario === "stubborn" ? 0 : 1);
            // Only now does Pi invalidate the outgoing runtime and replace its editor.
            alive = false;
            host.editor = makeEditor("REPLACEMENT_SESSION_DRAFT");
            await delay(100);
            assert.equal(host.editor.getText(), "REPLACEMENT_SESSION_DRAFT");
            assert.equal(staleAccesses, 0);
            assert.throws(() => process.kill(pid ?? 0, 0), { code: "ESRCH" });
          } else {
            if (scenario !== "spawn-error")
              writeFileSync(
                gate,
                scenario === "signal" ? "signal" : scenario === "exit-error" ? "7" : "0",
              );
            await waitFor(() => finished === 1 && (!failed || notices.length === 1));
            assert.equal(host.editor.getText(), latest);
            assert.equal(starts, 1);
          }
          assert.equal(stops, 1);
          assert.equal(notices.length, failed ? 1 : 0);
        } finally {
          if (pid) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }
          await pi.event("session_shutdown", { reason: "quit" });
        }
      });
    }
  } finally {
    if (oldVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = oldVisual;
  }
});

test("Vim works while busy, keeps literal filenames safe, and handles cancellation/errors/shutdown", async () => {
  const dir = mkdtempSync(join(root, "busy-"));
  const pi = fakePi(),
    terminal: string[] = [],
    notices: Notice[] = [];
  let finished = 0;
  installInspector(pi.api);
  assert.equal(pi.tools.size, 0);
  const ctx = fake<ExtensionContext>({
    mode: "tui",
    cwd: dir,
    isIdle() {
      throw new Error("must not require idle");
    },
    ui: {
      notify: (...args) => notices.push(args),
      getEditorText: () => "draft",
      setEditorText() {},
      custom: async <T>(factory: CustomFactory) => {
        let result: unknown;
        try {
          await factory(
            fake<FactoryArgs[0]>({
              stop: () => terminal.push("stop"),
              start: () => terminal.push("start"),
              requestRender: () => terminal.push("render"),
            }),
            fake<FactoryArgs[1]>({}),
            fake<FactoryArgs[2]>({}),
            (value) => {
              result = value;
            },
          );
          return result as T;
        } finally {
          finished++;
        }
      },
    },
  });
  const path = join(dir, "-file space 日本語;$(echo unsafe).txt");
  writeFileSync(path, "safe\n");
  const editor = join(dir, "fake-editor"),
    log = join(dir, "editor.log");
  writeFileSync(editor, '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@" > "$VIM_TEST_LOG"\n', {
    mode: 0o700,
  });
  const oldVisual = process.env.VISUAL,
    oldLog = process.env.VIM_TEST_LOG,
    oldWrite = process.stdout.write;
  const open = () => {
    const value = request(path, dir);
    pi.events.emit(OPEN_FILE_EVENT, value);
    return value;
  };
  process.env.VISUAL = editor;
  process.env.VIM_TEST_LOG = log;
  process.stdout.write = function (
    this: typeof process.stdout,
    chunk: unknown,
    ...args: unknown[]
  ) {
    return chunk === "\x1b[2J\x1b[H" ? true : Reflect.apply(oldWrite, this, [chunk, ...args]);
  } as typeof process.stdout.write;
  try {
    await pi.event("session_start", {}, ctx);
    assert(open().accepted);
    await waitFor(() => finished === 1);
    assert.deepEqual(terminal, ["stop", "start", "render"]);
    assert.equal(readFileSync(log, "utf8"), [realpathSync(dir), "--", path, ""].join("\n"));
    assert.equal(notices.length, 0);
    process.env.VISUAL = join(dir, "missing-editor");
    open();
    await waitFor(() => notices.length === 1);
    assert.deepEqual(terminal.slice(-3), ["stop", "start", "render"]);
    assert.equal(notices[0][1], "error");
    pi.events.emit(OPEN_FILE_EVENT, request(dir, dir));
    await waitFor(() => notices.length === 2);
    assert.match(notices[1][0], /regular files/);
    writeFileSync(editor, "#!/bin/sh\nexec sleep 30\n", { mode: 0o700 });
    process.env.VISUAL = editor;
    terminal.length = 0;
    const before = finished;
    open();
    open();
    await waitFor(() => terminal.length > 0);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    await delay(100);
    clearInterval(timer);
    assert(ticks >= 3);
    await pi.event("session_shutdown");
    await waitFor(() => finished > before);
    assert.deepEqual(terminal, ["stop"]);
    assert(!open().accepted);
    await pi.event("session_start", {}, ctx);
    terminal.length = 0;
    open();
    await pi.event("session_shutdown");
    await delay(20);
    assert.deepEqual(terminal, [], "a stale request cannot take terminal ownership");
  } finally {
    await pi.event("session_shutdown");
    process.stdout.write = oldWrite;
    if (oldVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = oldVisual;
    if (oldLog === undefined) delete process.env.VIM_TEST_LOG;
    else process.env.VIM_TEST_LOG = oldLog;
  }
});
