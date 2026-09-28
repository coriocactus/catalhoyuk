// Real Pi + Vim over a PTY, with xterm.js's headless VT engine. No model/network calls.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { colours } from "../../mirage/colours.ts";
import { HeadlessTerminal } from "../headless-terminal.ts";
import { cli, version } from "../pi-package.ts";

const here = dirname(fileURLToPath(import.meta.url));
const extensions = resolve(here, "../..");
const root = mkdtempSync(join(tmpdir(), "pi-xterm-terminal-"));
const config = join(root, "config");
mkdirSync(config);
const snippets = join(config, "echo");
mkdirSync(snippets);
writeFileSync(join(snippets, "review.md"), "ECHO_INITIAL_CONTENT\n");
const executable = (name: string, source: string) => {
  const path = join(root, name);
  writeFileSync(path, `#!/bin/sh\n${source}\n`, { mode: 0o700 });
  return path;
};
// Syntax stays on; omit personal plugins to isolate terminal handoff.
const editor = executable(
  "vim",
  'printf "%s" "$$" > "$DISPLAY_FIXTURE_DIR/vim-pid"\nexec /usr/bin/vim -u NONE -i NONE -n -c "syntax on" "$@"',
);
const shell = executable("shell", 'export DISPLAY_FIXTURE_SHELL=shell-kept\nexec /bin/bash "$@"');
writeFileSync(
  join(config, "settings.json"),
  JSON.stringify({
    lastChangelogVersion: version,
    theme: "dark",
    tuiMode: "fullscreen",
    quietStartup: true,
    hideThinkingBlock: true,
    outputPad: 1,
    terminal: { hyperlinks: true, images: "kitty", imageWidthCells: 8, trueColor: true },
    enableInstallTelemetry: false,
    showCacheMissNotices: false,
    shellPath: shell,
    shellCommandPrefix:
      "export DISPLAY_FIXTURE_PREFIX=prefix-kept DISPLAY_FIXTURE_ERROR=ERROR_BODY_MARKER",
  }),
);
const filename = "a-日本語.ts";
writeFileSync(join(root, filename), "const VIM_BUSY_TARGET = true;\n");
writeFileSync(join(root, "b.txt"), "READ_B_RESULT\n");
writeFileSync(join(root, "archived.txt"), "ARCHIVED_VIM_TARGET\n");
writeFileSync(join(root, "edited.txt"), "before\n");
writeFileSync(join(root, "edited-other.txt"), "before-second\n");
writeFileSync(
  join(root, "picture.png"),
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
    "base64",
  ),
);
const gate = join(root, "release-background");
const fixture = join(root, "session.jsonl");
const timestamp = new Date().toISOString();
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
interface Entry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message: Record<string, unknown>;
}
const archive = Array.from(
  { length: 126 },
  (_, i): Entry => ({
    type: "message",
    id: `archive-${i}`,
    parentId: i ? `archive-${i - 1}` : null,
    timestamp,
    message: {
      role: "assistant",
      content: [{ type: "text", text: `ARCHIVE_${String(i).padStart(3, "0")}` }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-4o",
      usage,
      stopReason: "stop",
      timestamp: Date.now(),
    },
  }),
);
// A tool run split by the first page boundary (76..125 | 26..75): one group.
archive[74].message.content = [
  { type: "toolCall", id: "archive-seam-read", name: "read", arguments: { path: "seam.txt" } },
];
archive[76].message.content = [
  {
    type: "toolCall",
    id: "archive-seam-bash",
    name: "bash",
    arguments: { command: "echo ARCHIVED_SEAM" },
  },
];
for (const [i, id, name] of [
  [75, "archive-seam-read", "read"],
  [77, "archive-seam-bash", "bash"],
] as const)
  archive[i].message = {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text: "ARCHIVED_SEAM_RESULT" }],
    isError: false,
    timestamp: Date.now(),
  };
const seamHeader = "Read 1 file, ran 1 command";
archive[80].message.content = [
  { type: "toolCall", id: "archive-read-a", name: "read", arguments: { path: "archived.txt" } },
  { type: "toolCall", id: "archive-read-b", name: "read", arguments: { path: "b.txt" } },
];
for (const [i, id] of [
  [81, "archive-read-a"],
  [82, "archive-read-b"],
] as const)
  archive[i].message = {
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text: "ARCHIVED_READ_RESULT" }],
    isError: false,
    timestamp: Date.now(),
  };
archive[83].message.content = [
  { type: "toolCall", id: "archive-image", name: "read", arguments: { path: "picture.png" } },
];
archive[84].message = {
  role: "toolResult",
  toolCallId: "archive-image",
  toolName: "read",
  content: [
    {
      type: "image",
      data: readFileSync(join(root, "picture.png")).toString("base64"),
      mimeType: "image/png",
    },
  ],
  isError: false,
  timestamp: Date.now(),
};
const renderedArchive = () =>
  new Set(
    existsSync(join(root, "history-rendered"))
      ? readFileSync(join(root, "history-rendered"), "utf8").trim().split("\n").filter(Boolean)
      : [],
  );
writeFileSync(
  fixture,
  `${[
    { type: "session", version: 3, id: randomUUID(), timestamp, cwd: root },
    ...archive,
    {
      type: "message",
      id: "00000001",
      parentId: archive.at(-1)?.id,
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Fixture ready" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-4o",
        usage,
        stopReason: "stop",
        timestamp: Date.now(),
      },
    },
    {
      type: "compaction",
      id: "checkpoint",
      parentId: "00000001",
      timestamp,
      summary: "HISTORY_CHECKPOINT",
      firstKeptEntryId: "00000001",
      tokensBefore: 10000,
    },
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n")}\n`,
);

// Exercise disabling the extension without editing installed or personal files.
const historyWrapper = join(root, "history.ts");
writeFileSync(
  historyWrapper,
  `
import { existsSync } from "node:fs";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import history from ${JSON.stringify(join(extensions, "rearview/index.ts"))};
export default function (pi) {
  const prototype = InteractiveMode.prototype;
  const key = Symbol.for("fixture.original-history");
  prototype[key] ??= prototype.renderSessionEntries;
  if (!existsSync(${JSON.stringify(join(root, "disable-history"))})) history(pi);
}
`,
);
const args = [
  cli,
  "--offline",
  "--session",
  fixture,
  "--no-extensions",
  // Match the directories' discovery order: echo, inspector, interupt, mirage, rearview.
  "-e",
  join(extensions, "echo/index.ts"),
  "-e",
  join(extensions, "inspector/index.ts"),
  "-e",
  join(extensions, "interupt/index.ts"),
  "-e",
  join(extensions, "mirage/index.ts"),
  "-e",
  historyWrapper,
  "-e",
  join(here, "offline-provider.ts"),
  "--provider",
  "display-fixture",
  "--model",
  "fixture",
  "--no-context-files",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
];
const env: Record<string, string | undefined> = {
  ...process.env,
  PI_CODING_AGENT_DIR: config,
  PI_OFFLINE: "1",
  PI_TELEMETRY: "0",
  EDITOR: editor,
  VISUAL: editor,
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  TERM_PROGRAM: "xterm",
  DISPLAY_FIXTURE_DIR: root,
};
delete env.TMUX;
delete env.TMUX_PANE;

function cpuSeconds(pid: number): number {
  return execFileSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" })
    .trim()
    .split(":")
    .reduce((sum, part) => sum * 60 + Number(part), 0);
}

// The current PTY session. `running` tracks the one that still needs cleanup.
let terminal!: HeadlessTerminal;
let running: HeadlessTerminal | undefined;
function assertCommandHeader(needle: string, tone: keyof typeof colours, caret = "▸") {
  const header = terminal.locate(needle).row.text.trim();
  assert(header.startsWith("$ ") && header.endsWith(` ${caret}`), header);
  assert(!/[✓✗]/.test(header), "command headers use only $ for status");
  terminal.assertColour(header, colours[tone]);
}
function assertOutputPadding(padding: number) {
  assert.equal(terminal.locate("✓ Explored 2 files").x, padding);
  assert.equal(terminal.locate("✓ Edited ").x, padding);
  const command = terminal.screen.includes("$ Running 2 commands")
    ? "$ Running 2 commands"
    : "$ Ran 2 commands";
  assert.equal(terminal.locate(command).x, padding);
}
async function expandEditGroup() {
  terminal.click("Edited 2 files");
  await terminal.waitFor(
    (s) => s.includes("edited.txt") && s.includes("edited-other.txt"),
    "expand edit group into file rows",
  );
}
async function setOutputPadding(padding: number) {
  terminal.send("/settings\r");
  await terminal.waitFor((s) => s.includes("Enter/Space to change"), "open settings");
  terminal.send("output padding");
  await terminal.waitFor((s) => /Output padding\s+[01]/.test(s), "find output padding");
  terminal.send("\r");
  await terminal.waitFor(
    (s) => new RegExp(`Output padding\\s+${padding}\\b`).test(s),
    `set output padding to ${padding}`,
  );
  terminal.send("\x1b");
  await terminal.waitFor(
    (s) => !s.includes("Enter/Space to change") && s.includes("Explored 2 files"),
    "close settings",
  );
  assertOutputPadding(padding);
}
async function owners(label: string, count = 1) {
  terminal.send(`\x15/fixture-owners ${label}\r`);
  const marker = `OWNERS_${label}_H${count}_I1_P1_T1_R${count === 0 ? 1 : 0}`;
  await terminal.waitFor((s) => s.includes(marker), marker);
}
async function replace(command: string, reason: string) {
  const ready = join(root, "runtime-ready.json");
  const previous = readFileSync(ready, "utf8"),
    mark = terminal.mark();
  terminal.send(`\x15/${command}\r`);
  await terminal.waitFor(() => {
    const current = readFileSync(ready, "utf8");
    return current !== previous && JSON.parse(current).reason === reason && terminal.mark() > mark;
  }, command);
}
try {
  terminal = running = await HeadlessTerminal.start(process.execPath, args, {
    cwd: root,
    env,
    artifacts: root,
  });
  await terminal.waitFor((s) => s.includes("Fixture ready"), "startup");
  assert.equal(renderedArchive().size, 0, "archived messages are not rendered eagerly");
  const beforeEcho = readFileSync(fixture, "utf8");
  writeFileSync(join(snippets, "review.md"), "ECHO_EDITOR_DRAFT\nLiteral $1 stays\n");
  writeFileSync(join(snippets, "plan.md"), "ECHO_PLAN\n");
  terminal.send("ECHO_AFTER\x01ECHO_BEFORE @@rev");
  await terminal.waitFor(
    (s) => s.includes("@@rev") && s.includes("→ review"),
    "inline snippet completion inside a draft",
  );
  terminal.send("\t");
  await terminal.waitFor(
    (s) => s.includes("ECHO_BEFORE ECHO_EDITOR_DRAFT") && s.includes("ECHO_AFTER"),
    "first inline snippet preserves surrounding draft",
  );
  terminal.send("@@pl");
  await terminal.waitFor((s) => s.includes("→ plan"), "second inline snippet completion");
  terminal.send("\r");
  await terminal.waitFor(
    (s) => s.includes("ECHO_PLAN") && !s.includes("@@pl"),
    "Enter inserts a second snippet without submitting",
  );
  terminal.send("ECHO_CURSOR ");
  await terminal.waitFor(
    (s) => s.includes("ECHO_CURSOR ECHO_AFTER") && s.includes("Literal $1 stays"),
    "cursor follows the inserted snippets, before the original suffix",
  );
  // Clear all four lines without arming Pi's double-Ctrl+C exit.
  terminal.send(`\x05${"\x15".repeat(7)}`);
  await terminal.waitFor((s) => !s.includes("ECHO_EDITOR_DRAFT"), "clear combined unsent draft");
  assert.equal(readFileSync(fixture, "utf8"), beforeEcho, "echo never submits to the model");
  terminal.send("Run the fixture\r");
  // The second read's arguments are still streaming: it belongs to its group at once.
  let screen = await terminal.waitFor(
    (s) => /… Explore 2 files ▸/.test(s),
    "a loading call joins its group",
  );
  assert(!/… Read/.test(screen), "no loading call outside its group");
  writeFileSync(join(root, "release-pending"), "release");
  screen = await terminal.waitFor(
    (s) =>
      s.includes("Explored 2 files") &&
      s.includes("Running 2 commands") &&
      s.includes("Edited 2 files (+3 −2)"),
    "live groups and completed edits",
  );
  assert(!screen.includes("VIM_BUSY_TARGET") && !screen.includes("READ_B_RESULT"));
  terminal.assertColour("✓", colours.green);
  // Group summaries, like Amp: grey brackets (the caret's colour) around plain counts.
  const edits = terminal.locate("Edited 2 files (+3 −2)");
  const fg = (x: number) => edits.row.cells.find((cell) => cell.x === x)?.style.foreground;
  const open = edits.x + "Edited 2 files ".length;
  const caret = edits.row.cells.findLast((cell) => cell.text === "▸")?.style.foreground;
  assert.deepEqual(fg(open), caret, "grey summary brackets");
  assert.deepEqual(fg(open + 1), edits.cell.style.foreground, "plain summary counts");
  assert.notDeepEqual(fg(open), fg(open + 1));
  assert(!terminal.locate("+3").cell.style.underline, "diff counts are not underlined");
  assert(!screen.includes("edited.txt") && !screen.includes("edited-other.txt"));
  for (const label of ["Explored 2 files", "Edited 2 files", "Running 2 commands"]) {
    const row = terminal.locate(label).row;
    assert(row.text.trimEnd().endsWith(" ▸"), "tool carets trail the header text");
    assert(!row.cells.findLast((cell) => cell.text === "▸")?.style.underline);
  }
  assert(
    !terminal.rawSince().includes("mirage:file:"),
    "private filename links must not reach the terminal",
  );

  terminal.send("ESC_LAYOUT_DRAFT");
  await terminal.waitFor((s) => s.includes("ESC_LAYOUT_DRAFT"), "draft before interrupt hint");
  const hintAnchor = {
    draft: terminal.locate("ESC_LAYOUT_DRAFT").y,
    transcript: terminal.locate("Explored 2 files").y,
  };
  terminal.send("\x1b");
  await terminal.waitFor((s) => s.includes("Press Esc again"), "interrupt hint in editor border");
  assert.equal(terminal.locate("Press Esc again").y, hintAnchor.draft - 1);
  assert.equal(terminal.locate("ESC_LAYOUT_DRAFT").y, hintAnchor.draft);
  assert.equal(terminal.locate("Explored 2 files").y, hintAnchor.transcript);
  await terminal.waitFor((s) => !s.includes("Press Esc again"), "interrupt hint expires in place");
  assert.equal(terminal.locate("ESC_LAYOUT_DRAFT").y, hintAnchor.draft);
  assert.equal(terminal.locate("Explored 2 files").y, hintAnchor.transcript);
  terminal.send("\x15");
  await terminal.waitFor((s) => !s.includes("ESC_LAYOUT_DRAFT"), "clear layout test draft");

  assertOutputPadding(1);
  await setOutputPadding(0);
  await setOutputPadding(1); // Changes while a tool is running do not rebuild its rows.
  const liveAnchor = terminal.locate("Explored 2 files").y;
  terminal.send("\x1b[H");
  await terminal.waitFor(
    () => renderedArchive().size === 43,
    "page history while tools are running",
  );
  assert.equal(terminal.locate("Explored 2 files").y, liveAnchor);
  assert(
    terminal.screen.includes("Running 2 commands"),
    "paging does not disturb live pending tools",
  );

  terminal.click("Explored 2 files");
  await terminal.waitFor((s) => s.includes(filename) && s.includes("b.txt"), "expand read group");
  terminal.assertColour(filename, colours.blue);
  assert(terminal.locate("語.ts").cell.style.underline, "grouped Unicode filenames are underlined");
  terminal.send("BUSY_DRAFT_KEEP_ME");
  terminal.click("語.ts", true); // Select by terminal cells, not UTF-16 string offsets.
  await terminal.waitFor(
    (s) => s.includes("VIM_BUSY_TARGET") && !s.includes("LIVE_WORK_STARTED"),
    "Vim opens while Pi is busy",
  );
  assert(
    !existsSync(join(root, "background-done")),
    "background command remains gated until Vim is ready",
  );
  writeFileSync(join(root, "update-draft"), "change draft while Vim owns the terminal");
  writeFileSync(gate, "release");
  // File completion does not produce PTY output while Vim owns the terminal.
  const deadline = Date.now() + 15000;
  while (!existsSync(join(root, "draft-updated")) && Date.now() < deadline) await delay(25);
  assert(existsSync(join(root, "background-done")), "Pi finishes while Vim remains open");
  assert(existsSync(join(root, "draft-updated")), "background work updates the current draft");
  assert(
    terminal.screen.includes("VIM_BUSY_TARGET") && !terminal.screen.includes("BACKGROUND_FINISHED"),
  );
  terminal.send("Go// VIM_SAVED_WHILE_BUSY\x1b:wq\r");
  screen = await terminal.waitFor(
    (s) => s.includes("BACKGROUND_FINISHED") && s.includes("BUSY_DRAFT_UPDATED_WHILE_VIM_OPEN"),
    "return to Pi preserves the newer draft and background results",
  );
  assert(readFileSync(join(root, filename), "utf8").includes("VIM_SAVED_WHILE_BUSY"));
  const mixedHeader = "Wrote 1 file, read 1 file, ran 1 command";
  assert(
    screen.includes(mixedHeader),
    "mixed tool types share one summary across hidden reasoning",
  );
  assert(!screen.includes("FIXTURE_REASONING") && !screen.includes("Thinking..."));
  const beforeThinkingToggle = readFileSync(fixture, "utf8");
  terminal.send("\x14");
  await terminal.waitFor(
    (s) => s.includes("FIXTURE_REASONING") && !s.includes(mixedHeader),
    "visible thinking separates groups",
  );
  terminal.send("\x14");
  await terminal.waitFor(
    (s) => !s.includes("FIXTURE_REASONING") && s.includes(mixedHeader),
    "hidden thinking regroups without placeholders",
  );
  assert(!terminal.screen.includes("Thinking..."));
  assert.equal(
    readFileSync(fixture, "utf8"),
    beforeThinkingToggle,
    "thinking toggles do not edit saved messages",
  );
  assert(!terminal.rawSince().includes("\x1b_Ga=T"), "grouped images start hidden");
  terminal.click(mixedHeader);
  await terminal.waitFor(
    (s) =>
      s.includes("mixed.txt") && s.includes("picture.png (image)") && s.includes("MIXED_COMMAND"),
    "mixed group expands into individual calls, including the image",
  );
  terminal.assertColour("picture.png", colours.blue);
  assert(terminal.locate("picture.png").cell.style.underline, "clickable filenames are underlined");
  assert(!terminal.locate("(image)").cell.style.underline, "underline ends at the filename");
  assert(terminal.locate("picture.png").row.text.trimEnd().endsWith(" ▸"));
  let mark = terminal.mark();
  terminal.click("picture.png");
  await terminal.waitFor(
    () => terminal.rawSince(mark).includes("\x1b_Ga=T"),
    "expand a grouped image: Kitty transmission",
  );
  mark = terminal.mark();
  terminal.click("picture.png");
  await terminal.waitFor(
    () => terminal.rawSince(mark).includes("\x1b_Ga=d"),
    "collapse a grouped image: Kitty deletion",
  );
  terminal.click(mixedHeader);
  await terminal.waitFor((s) => !s.includes("mixed.txt"), "mixed group collapses");
  assert(screen.includes("Ran 2 commands") && !screen.includes("ERROR_BODY_MARKER"));
  assert(!screen.includes("failed"), "no failure count in summaries");
  assert(!screen.includes("DISPLAY_FIXTURE_ERROR"), "closed groups hide failed calls");
  assertCommandHeader("Ran 2 commands", "green"); // Red only when every call failed.
  terminal.click("Ran 2 commands");
  await terminal.waitFor((s) => s.includes("DISPLAY_FIXTURE_PREFIX"), "expand command group");
  assertCommandHeader("Ran 2 commands", "green", "▾");
  assertCommandHeader("DISPLAY_FIXTURE_PREFIX", "green");
  assertCommandHeader("DISPLAY_FIXTURE_ERROR", "red");
  terminal.click("DISPLAY_FIXTURE_ERROR");
  await terminal.waitFor(
    (s) => s.includes("ERROR_BODY_MARKER") && s.includes("Command exited with code 1"),
    "expand error",
  );
  terminal.assertColour("ERROR_BODY_MARKER", colours.red);
  terminal.click("DISPLAY_FIXTURE_ERROR");
  await terminal.waitFor((s) => !s.includes("ERROR_BODY_MARKER"), "collapse error");
  terminal.click("Ran 2 commands");
  await terminal.waitFor(
    (s) => !s.includes("DISPLAY_FIXTURE_PREFIX") && !s.includes("DISPLAY_FIXTURE_ERROR"),
    "collapse command group, including its failed call",
  );
  await expandEditGroup();
  assert(terminal.locate("edited.txt").cell.style.underline);
  assert(terminal.locate("edited-other.txt").row.text.includes("+2 −1 ▸"));
  terminal.assertColour("+2 −1", colours.green); // Rows keep coloured counts.
  terminal.assertColour("−1 ▸", colours.red);
  assert(!terminal.screen.includes("-1 before"), "file rows start with closed diffs");
  terminal.click("edited.txt");
  await terminal.waitFor(
    (s) => s.includes("-1 before") && s.includes("+1 after"),
    "expand one grouped numbered diff",
  );
  assert(!terminal.screen.includes("before-second"), "other diffs stay independently closed");
  terminal.assertColour("-1 before", colours.red);
  terminal.assertColour("+1 after", colours.green);
  assert(
    terminal.locate("before").cell.style.inverse && terminal.locate("after").cell.style.inverse,
    "word changes retain inverse highlighting",
  );
  terminal.click("edited.txt");
  await terminal.waitFor((s) => !s.includes("-1 before"), "collapse diff");
  terminal.click("Edited 2 files");
  await terminal.waitFor((s) => !s.includes("edited.txt"), "collapse edit group");

  mark = terminal.mark();
  terminal.send("\x0f");
  screen = await terminal.waitFor(
    (s) =>
      s.includes("READ_B_RESULT") &&
      s.includes("-1 before") &&
      s.includes("-1 before-second") &&
      s.includes("+2 extra") &&
      s.includes("STREAM_TWO") &&
      s.includes("ERROR_BODY_MARKER") &&
      terminal.rawSince(mark).includes("\x1b_Ga=T"),
    "Ctrl+O expands text and images",
  );
  assert(screen.includes("prefix-kept/shell-kept"));
  mark = terminal.mark();
  terminal.send("\x0f");
  await terminal.waitFor(
    (s) =>
      !s.includes("READ_B_RESULT") &&
      !s.includes("-1 before") &&
      !s.includes("ERROR_BODY_MARKER") &&
      terminal.rawSince(mark).includes("\x1b_Ga=d"),
    "Ctrl+O collapses text and images",
  );
  assert(!terminal.screen.includes("DISPLAY_FIXTURE_ERROR"), "failed calls collapse too");
  terminal.send("\x15"); // Clear the already-verified draft without arming double-Ctrl+C exit.
  await setOutputPadding(0);
  await setOutputPadding(1); // Idle changes rebuild the transcript; keep the same padding.
  terminal.send("BUSY_DRAFT_KEEP_ME");

  mark = terminal.mark();
  terminal.resize(120, 60);
  await terminal.waitFor(
    (s) =>
      terminal.mark() > mark && s.includes("Ran 2 commands") && s.includes("BACKGROUND_FINISHED"),
    "resize",
  );
  terminal.send("\x03/reload\r");
  screen = await terminal.waitFor((s) => s.includes("Reloaded"), "reload");
  assert(screen.includes("Explored 2 files") && !screen.includes("ERROR_BODY_MARKER"));
  assert(screen.includes(mixedHeader) && !screen.includes("Thinking..."));
  assertOutputPadding(1);
  assert(screen.includes("Edited 2 files (+3 −2)") && !screen.includes("edited.txt"));
  await expandEditGroup();
  terminal.click("edited.txt", true);
  await terminal.waitFor(
    (s) => s.includes("after") && !s.includes("BACKGROUND_FINISHED"),
    "Vim after reload",
  );
  terminal.send(":q\r");
  await terminal.waitFor((s) => s.includes("BACKGROUND_FINISHED"), "return after reload");
  await delay(500);
  const before = cpuSeconds(terminal.pid);
  await delay(2000);
  const cpu = cpuSeconds(terminal.pid) - before;
  assert(cpu < 0.6, `Excess Pi idle CPU: ${cpu}s/2s`);
  terminal.save();
  await terminal.close();
  running = undefined;
  writeFileSync(join(root, "history-rendered"), "");

  terminal = running = await HeadlessTerminal.start(process.execPath, args, {
    cwd: root,
    env,
    artifacts: root,
    name: "resume",
  });
  screen = await terminal.waitFor(
    (s) => s.includes("BACKGROUND_FINISHED") && s.includes("Ran 2 commands"),
    "resume saved session",
  );
  assert(screen.includes("Explored 2 files") && !screen.includes("ERROR_BODY_MARKER"));
  assert(screen.includes("Edited 2 files (+3 −2)") && !screen.includes("edited.txt"));
  assert(screen.includes(mixedHeader) && !screen.includes("Thinking..."));
  assert(!terminal.rawSince().includes("\x1b_Ga=T"), "resumed images start hidden");
  assertOutputPadding(1);
  terminal.click(mixedHeader);
  await terminal.waitFor((s) => s.includes("picture.png"), "resumed mixed group expands");
  terminal.click("picture.png");
  await terminal.waitFor(() => terminal.rawSince().includes("\x1b_Ga=T"), "resumed image expands");
  terminal.click("Ran 2 commands");
  await terminal.waitFor((s) => s.includes("DISPLAY_FIXTURE_ERROR"), "resumed command group");
  terminal.click("DISPLAY_FIXTURE_ERROR");
  await terminal.waitFor((s) => s.includes("ERROR_BODY_MARKER"), "resumed error expands");
  terminal.click("DISPLAY_FIXTURE_ERROR");
  await terminal.waitFor((s) => !s.includes("ERROR_BODY_MARKER"), "resumed error collapses");
  terminal.click("Ran 2 commands");
  terminal.click(mixedHeader);
  await terminal.waitFor(
    (s) => !s.includes("DISPLAY_FIXTURE_ERROR") && !s.includes("picture.png"),
    "collapse before paging",
  );
  assert.equal(renderedArchive().size, 0, "reload/resume still leave archives unrendered");
  terminal.send("/fixture-state before\r");
  await terminal.waitFor(
    (s) => s.includes("HISTORY_STATE_BEFORE"),
    "session snapshot before paging",
  );
  const persistedBeforePaging = readFileSync(fixture, "utf8");
  terminal.send("HISTORY_DRAFT_KEEP");
  await terminal.waitFor((s) => s.includes("HISTORY_DRAFT_KEEP"), "paging draft");
  const anchorY = terminal.locate("Fixture ready").y;
  terminal.send("\x1b[H");
  await terminal.waitFor(() => renderedArchive().size === 43, "first older batch");
  assert.equal(terminal.locate("Fixture ready").y, anchorY, "prepend keeps the viewport anchor");
  assert(renderedArchive().has("ARCHIVE_078") && !renderedArchive().has("ARCHIVE_073"));
  mark = terminal.mark();
  terminal.resize(120, 68);
  await terminal.waitFor(() => terminal.mark() > mark, "resize a paged transcript");
  assert.equal(renderedArchive().size, 43, "resize must not fetch another batch");
  terminal.send("\x1b[5~");
  await terminal.waitFor((s) => s.includes("ARCHIVE_"), "scroll within the loaded batch");
  assert.equal(renderedArchive().size, 43, "one Page Up does not reach the new top");
  terminal.send("\x1b[H");
  await terminal.waitFor(
    (s) => renderedArchive().size === 91 && s.includes(seamHeader),
    "second batch joins the run split by the page boundary",
  );
  assert(!terminal.screen.includes("echo ARCHIVED_SEAM"), "the seam call moved into its group");
  // Home showed the seam call at the top; its merged header keeps that place.
  // The message just before it, from the new page, must remain above the viewport.
  assert(terminal.locate(seamHeader).y <= 2, "the merged group stays at the previous top");
  assert(!terminal.screen.includes("ARCHIVE_073"), "the viewport did not jump into older rows");
  terminal.click(seamHeader);
  await terminal.waitFor(
    (s) => s.includes("seam.txt") && s.includes("echo ARCHIVED_SEAM"),
    "calls from both pages expand under one header",
  );
  terminal.click(seamHeader);
  await terminal.waitFor((s) => !s.includes("seam.txt"), "seam group collapses");
  assert(terminal.screen.includes("Explored 3 files"), "historical images group with their reads");
  assert(!terminal.screen.includes("ARCHIVED_READ_RESULT"), "historical results start collapsed");
  assert.equal(terminal.locate("✓ Explored 3 files").x, 1, "history also honors output padding");
  terminal.click("Explored 3 files");
  await terminal.waitFor((s) => s.includes("archived.txt"), "historical filenames expand");
  assert(terminal.locate("archived.txt").cell.style.underline);
  assert.equal(terminal.locate("archived.txt").row.text.indexOf("✓"), 3);
  terminal.click("archived.txt", true);
  await terminal.waitFor((s) => s.includes("ARCHIVED_VIM_TARGET"), "historical filename opens Vim");
  terminal.send(":q\r");
  await terminal.waitFor(
    (s) => s.includes(seamHeader) && s.includes("HISTORY_DRAFT_KEEP"),
    "return to the historical viewport and draft",
  );
  mark = terminal.mark();
  terminal.send("\x0f");
  await terminal.waitFor(
    (s) => s.includes("ARCHIVED_READ_RESULT") && terminal.rawSince(mark).includes("\x1b_Ga=T"),
    "Ctrl+O expands historical bodies and image",
  );
  terminal.send("\x0f");
  await terminal.waitFor(
    (s) => !s.includes("ARCHIVED_READ_RESULT"),
    "Ctrl+O collapses historical bodies",
  );
  terminal.send("\x1b[H");
  await terminal.waitFor(
    (s) => renderedArchive().size === 117 && s.includes("ARCHIVE_026"),
    "final older batch",
  );
  terminal.send("\x1b[H");
  await terminal.waitFor((s) => s.includes("ARCHIVE_000"), "beginning of the session");
  terminal.send("\x1b[H\x1b[5~\x1b[<64;10;10M");
  await delay(150);
  assert.equal(
    renderedArchive().size,
    117,
    "exhaustion never duplicates or drains further entries",
  );
  assert.equal(
    readFileSync(fixture, "utf8"),
    persistedBeforePaging,
    "paging never writes session history",
  );
  terminal.send("\x1b[F");
  await terminal.waitFor(
    (s) => s.includes("BACKGROUND_FINISHED") && s.includes("HISTORY_DRAFT_KEEP"),
    "return to live messages",
  );
  assert(
    terminal.screen.includes("Explored 2 files") &&
      !terminal.screen.includes("ARCHIVED_READ_RESULT"),
  );
  terminal.send("\x03/fixture-state after\r");
  await terminal.waitFor((s) => s.includes("HISTORY_STATE_AFTER"), "session snapshot after paging");
  assert.equal(
    readFileSync(join(root, "after.state.json"), "utf8"),
    readFileSync(join(root, "before.state.json"), "utf8"),
    "model context and branch are unchanged",
  );
  terminal.send("\x1b[H");
  await terminal.waitFor((s) => s.includes("ARCHIVE_000"), "loaded pages remain accessible");
  terminal.send("\x1b[F");
  await terminal.waitFor(
    (s) => s.includes("BACKGROUND_FINISHED"),
    "live view before lifecycle checks",
  );
  await owners("INITIAL");
  terminal.send("/fixture-replace\r");
  await terminal.waitFor(
    (s) => s.includes("REPLACEMENT_ARMED"),
    "arm replacement while Vim is open",
  );
  await expandEditGroup();
  terminal.click("edited.txt", true);
  await terminal.waitFor(
    (s) => s.includes("after") && !s.includes("REPLACEMENT_ARMED"),
    "Vim before replacement",
  );
  const vimPid = Number(readFileSync(join(root, "vim-pid"), "utf8"));
  writeFileSync(join(root, "replace-now"), "replace");
  await terminal.waitFor(
    (s) => s.includes("REPLACEMENT_SESSION_DRAFT"),
    "replacement draft and terminal survive editor shutdown",
  );
  assert.throws(() => process.kill(vimPid, 0), { code: "ESRCH" });
  await owners("VIM_REPLACEMENT");
  for (let i = 0; i < 2; i++) {
    await replace("new", "new");
    await owners(`NEW_${i}`);
  }
  await replace("fixture-resume", "resume");
  await owners("RESUME");
  await replace("fixture-fork", "fork");
  await owners("FORK");
  await replace("reload", "reload");
  await owners("RELOAD");
  terminal.send("@@pl");
  await terminal.waitFor((s) => s.includes("→ plan"), "inline snippets after reload");
  terminal.send("\t");
  await terminal.waitFor((s) => s.includes("ECHO_PLAN"), "inline insertion after reload");
  terminal.send("\x15\x15");
  await terminal.waitFor((s) => !s.includes("ECHO_PLAN"), "clear reloaded snippet draft");
  await replace("fixture-disable-history", "reload");
  await owners("DISABLED", 0);
  terminal.save();
  console.log(
    `PASS: xterm.js VT + real Pi/Vim; inline snippet composition without submission, groups, output padding, Unicode clicks, colours/underlines, interrupt hint without layout shifts, gated background work, newer/replacement drafts, saves, images, errors, Ctrl+O, resize, new/resume/fork/reload ownership and disable cleanup, bounded top paging/anchors, archived Vim/images, unchanged context. Pi idle CPU ${cpu.toFixed(2)}s/2s. Artifacts: ${root}`,
  );
} catch (error) {
  running?.save();
  console.error(`Terminal test failed. Artifacts: ${root}`);
  throw error;
} finally {
  writeFileSync(gate, "release");
  await running?.close();
}
