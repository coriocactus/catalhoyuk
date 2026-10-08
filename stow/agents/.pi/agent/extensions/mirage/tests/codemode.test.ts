import assert from "node:assert/strict";
import { test } from "node:test";
import { OPEN_FILE_EVENT, type OpenFileRequest } from "../../shared/protocol.ts";
import { themes, tui } from "../../test/pi.ts";
import { assistant } from "../../test/transcript.ts";
import { fixture, mouse, paint, plain, type Result, result, root, ToolGroups } from "./fixture.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const HEADER = "Script completed\nWall time 0.4 seconds\nOutput:\n";
const FAILED = "Script failed\nWall time 0.1 seconds\nOutput:\n";
const CODE = 'const files = await tools.read({ path: "a.txt" });\nreturn files.length;';

/** What codemode returns: Pi's header, the script output, and its `details.calls`. */
function script(output: string, calls: object[] = [], header = HEADER): Result {
  return {
    content: [
      { type: "text", text: header },
      { type: "text", text: output },
    ],
    details: { calls },
  };
}

/** Nested tool_execution_* events, as Pi emits them for calls a script makes. */
function events(f: Fixture, parent: string) {
  const send = (type: string, value: object) =>
    f.pi.event(`tool_execution_${type}`, { type, parentToolCallId: parent, ...value }, f.ctx);
  return {
    start: (id: string, toolName: string, args: object) =>
      send("start", { toolCallId: `${parent}/${id}`, toolName, args }),
    update: (id: string, toolName: string, partialResult: Result) =>
      send("update", { toolCallId: `${parent}/${id}`, toolName, args: {}, partialResult }),
    end: (id: string, toolName: string, output: Result, isError = false, durationMs?: number) =>
      send("end", { toolCallId: `${parent}/${id}`, toolName, result: output, isError, durationMs }),
  };
}

const lineOf = (view: { render(width: number): string[] }, needle: string) =>
  view.render(160).findIndex((line) => tui.stripTerminalSequences(line).includes(needle));

test("a script joins its run; its calls count in the summary and expand with live output", async () => {
  const f = await fixture();
  let opened: OpenFileRequest | undefined;
  f.pi.events.on(OPEN_FILE_EVENT, (data) => {
    const request = data as OpenFileRequest;
    request.accepted = true;
    opened = request;
  });
  const before = f.call("read", "direct-read", { path: "direct.txt" });
  before.result(result("DIRECT_BODY"));
  const run = f.call("codemode", "script", { code: CODE }, false);
  assert.equal(run.view.row.group, before.view.row.group, "a script does not split its run");
  assert.equal(plain(before.view), "… Read 1 file, run 1 script ▸");
  run.context.executionStarted = true;
  run.redraw();
  const nested = events(f, "script");
  const redraws = f.invalidations;
  await nested.start("1", "read", { path: "a.txt" });
  await nested.start("2", "bash", { command: "npm test" });
  assert(f.invalidations > redraws, "events redraw the script's row");
  await nested.update("2", "bash", result("STREAMING"));
  assert.equal(plain(before.view), "… Reading 2 files, running 1 command ▸");
  await nested.end("1", "read", result("NESTED_READ_BODY"));
  await nested.end("2", "bash", result("NESTED_COMMAND_FAILED"), true);
  await nested.start("3", "edit", { path: "e.txt", edits: [] });
  await nested.end("3", "edit", result("done", { diff: "-1 old\n+1 new\n+2 more" }));
  run.result(script("SCRIPT_OUTPUT"));
  const summary = "✓ Read 2 files, ran 1 command, edited 1 file (+2 −1) ▸";
  assert.equal(plain(before.view), summary);
  assert.equal(plain(run.view), "", "the group renders once, at its first call");

  before.view.handleMouse(mouse(0));
  assert.equal(
    plain(before.view),
    [
      summary.replace("▸", "▾"),
      "  ✓ Read direct.txt ▸",
      "  ✓ Script: read 1 file, ran 1 command, edited 1 file (+2 −1) ▸",
    ].join("\n"),
  );
  before.view.handleMouse(mouse(0, 2));
  const open = plain(before.view);
  assert.match(open, /^ {4}JavaScript, 2 lines ▸$/m);
  assert.match(open, /^ {4}✓ Read a\.txt ▸$/m);
  assert.match(open, /^ {4}\$ npm test ▸$/m);
  assert.match(open, /^ {4}✓ Edited e\.txt \+2 −1 ▸$/m);
  assert.match(open, /^ {4}SCRIPT_OUTPUT$/m, "the script's output follows its calls");
  assert(!open.includes("Script completed"), "Pi's header is dropped");
  assert(!open.includes("NESTED_READ_BODY") && !open.includes("tools.read"));
  const failed = before.view.render(160)[lineOf(before.view, "npm test")];
  assert(failed.startsWith(`    ${paint(themes.theme, "red", "$")} npm test`));

  before.view.handleMouse(mouse(0, lineOf(before.view, "JavaScript")));
  assert.match(plain(before.view), /^ {6}const files = await tools\.read/m);
  before.view.handleMouse(mouse(0, lineOf(before.view, "Read a.txt")));
  assert.match(plain(before.view), /^ {6}NESTED_READ_BODY$/m);
  before.view.handleMouse(mouse(0, lineOf(before.view, "npm test")));
  assert.match(plain(before.view), /^ {6}NESTED_COMMAND_FAILED$/m);
  before.view.handleMouse(mouse(0, lineOf(before.view, "Edited e.txt")));
  assert.match(plain(before.view), /^ {6}-1 old\n {6}\+1 new/m);
  for (const width of [0, 1, 2, 10, 24, 40]) {
    for (const line of before.view.render(width)) assert(tui.visibleWidth(line) <= width);
  }

  const y = lineOf(before.view, "Read a.txt");
  before.view.handleMouse(
    mouse(tui.stripTerminalSequences(before.view.render(160)[y]).indexOf("a.txt"), y),
  );
  assert.deepEqual(opened, { path: "a.txt", cwd: f.dir, tool: "read", accepted: true });
  f.expand(true);
  assert.match(plain(before.view), /NESTED_COMMAND_FAILED/);
  f.expand(false);
  assert.equal(plain(before.view), summary);

  const after = f.call("write", "after", { path: "w.txt", content: "x" });
  after.result(result("written"));
  assert.match(plain(before.view), /edited 1 file \(\+2 −1\), wrote 1 file \(\+1\) ▸$/);
});

test("single scripts: model calls, cancelled calls, failures, and scripts without tool calls", async () => {
  const f = await fixture();
  const run = f.call("codemode", "solo", { code: "return 1;" });
  assert.equal(plain(run.view), "… Script ▸");
  const nested = events(f, "solo");
  await nested.start("1", "read", { path: "slow.txt" });
  run.result(
    {
      content: [],
      details: {
        calls: [
          { id: "solo/?", name: "read", args: '{"path":"slow.txt"}', status: "running" },
          {
            id: "solo/models.classify/1",
            name: "models.classify",
            args: "typesafe/jev-latest",
            status: "ok",
            cost: 0.0012,
          },
        ],
      },
    },
    false,
    true,
  );
  assert.equal(plain(run.view), "… Script: exploring 1 file ▸", "placeholders add no rows");
  run.result(
    script(
      "PARTIAL_OUTPUT\nScript error:\nTimeoutError",
      [
        { id: "solo/?", name: "read", args: '{"path":"slow.txt"}', status: "cancelled" },
        {
          id: "solo/models.classify/1",
          name: "models.classify",
          args: "typesafe/jev-latest",
          status: "ok",
          cost: 0.0012,
        },
      ],
      FAILED,
    ),
    true,
  );
  assert.equal(plain(run.view), "✗ Script: explored 1 file ▸");
  assert(run.view.render(160)[0].startsWith(paint(themes.theme, "red", "✗")));
  run.view.handleMouse(mouse(0));
  const open = plain(run.view);
  assert.match(open, /^ {2}✗ Read slow\.txt ▸$/m, "cut-off calls are cancelled");
  assert.match(open, /^ {2}✓ models\.classify typesafe\/jev-latest \$0\.0012 ▸$/m);
  assert.match(open, /^ {2}PARTIAL_OUTPUT\n {2}Script error:\n {2}TimeoutError$/m);
  const cancelled = run.view.render(160)[lineOf(run.view, "slow.txt")];
  assert(cancelled.startsWith(`  ${themes.theme.fg("muted", "✗")}`), "cancelled is muted");
  const error = run.view.render(160)[lineOf(run.view, "TimeoutError")];
  assert(error.includes(paint(themes.theme, "red", "").split("\x1b[39m")[0]), "errors are red");
  run.view.handleMouse(mouse(0, lineOf(run.view, "slow.txt")));
  assert.match(plain(run.view), /Cancelled when the script ended\./);

  await f.pi.event("user_bash");
  const quiet = f.call("codemode", "quiet", { code: "return 2;" });
  quiet.result(script("2"));
  assert.equal(plain(quiet.view), "✓ Script ▸");
  const read = f.call("read", "quiet-read", { path: "r.txt" });
  read.result(result("r"));
  assert.equal(plain(quiet.view), "✓ Ran 1 script, read 1 file ▸");
});

test("saved scripts rebuild calls from Pi's record, without a store() boundary", async () => {
  const f = await fixture();
  const call = (id: string, name: string, args: object) => ({
    type: "toolCall",
    id,
    name,
    arguments: args,
  });
  const message = (value: object) => ({ type: "message", message: value });
  const toolResult = (id: string, name: string, value: Result, extra: object = {}) =>
    message({ role: "toolResult", toolCallId: id, toolName: name, ...value, ...extra });
  const entries = [
    message(assistant("", [call("saved-read", "read", { path: "first.txt" }) as never])),
    toolResult("saved-read", "read", result("FIRST"), { isError: false }),
    message(assistant("", [call("saved-script", "codemode", { code: CODE }) as never])),
    // Written by store() while the script runs, before its result.
    { type: "custom", customType: "codemode-store", data: { set: { k: 1 }, delete: [] } },
    toolResult(
      "saved-script",
      "codemode",
      script("SAVED_OUTPUT", [
        { id: "saved-script/1", name: "read", args: "{}", status: "ok" },
        { id: "saved-script/2", name: "edit", args: "{}", status: "ok" },
        { id: "saved-script/models.classify/1", name: "models.classify", args: "m", status: "ok" },
        { id: "saved-script/?", name: "bash", args: '{"command":"sleep"}', status: "cancelled" },
      ]),
      {
        isError: false,
        nestedCalls: {
          complete: false,
          calls: [
            { id: "saved-script/1", name: "read", arguments: { path: "a.txt" }, status: "ok" },
            {
              id: "saved-script/2",
              name: "edit",
              arguments: { path: "e.txt", edits: [{ oldText: "old", newText: "new\nmore" }] },
              status: "ok",
            },
            {
              id: "saved-script/3",
              name: "bash",
              arguments: { command: "sleep" },
              status: "unfinished",
            },
            {
              id: "saved-script/4",
              name: "write",
              argumentsBytes: 9000,
              status: "error",
              error: "EACCES",
            },
            {
              id: "saved-script/5",
              name: "mcp__docs__search",
              arguments: { q: "x" },
              status: "ok",
            },
          ],
        },
      },
    ),
    // Only a later call in the same run shows whether the store() entry split it.
    message(assistant("", [call("after-script", "bash", { command: "echo after" }) as never])),
    toolResult("after-script", "bash", result("AFTER"), { isError: false }),
  ];
  const before = JSON.stringify(entries);
  await f.rebuild("session_start", entries);
  const view = f.call("read", "saved-read", { path: "first.txt" }).view;
  assert.equal(f.call("codemode", "saved-script", { code: CODE }).view.render(160).length, 0);
  const summary =
    "✓ Read 2 files, edited 1 file (+2 −1), ran 2 commands, write 1 file, called 1 tool ▸";
  assert.equal(plain(view), summary);
  view.handleMouse(mouse(0));
  plain(view);
  view.handleMouse(mouse(0, 2));
  const open = plain(view);
  for (const row of [
    /^ {4}✓ Read a\.txt ▸$/m,
    /^ {4}✓ Edited e\.txt \+2 −1 ▸$/m,
    /^ {4}✓ models\.classify m ▸$/m,
    /^ {4}\$ sleep ▸$/m,
    /^ {4}✗ Write 9000 bytes of arguments ▸$/m,
    /^ {4}✓ mcp__docs__search \{"q":"x"\} ▸$/m,
    /^ {4}SAVED_OUTPUT$/m,
  ])
    assert.match(open, row);
  f.expand(true);
  const expanded = plain(view);
  assert.match(expanded, /Read a\.txt ▾\n {6}Output not kept in session\./);
  assert.match(expanded, /-1 old\n {6}\+1 new\n {6}\+2 more\n {6}Rebuilt from saved arguments/);
  assert.match(expanded, /EACCES/);
  assert.match(expanded, /Cancelled when the script ended\./);
  f.expand(false);
  assert.equal(JSON.stringify(entries), before, "grouping is presentation-only");
});

test("commands end with the execution time Pi recorded, live, in scripts, and after reload", async () => {
  const f = await fixture();
  const direct = f.call("bash", "timed", { command: "make" });
  direct.result(result("BUILDING"), false, true);
  plain(direct.view);
  direct.view.handleMouse(mouse(0));
  assert(!plain(direct.view).includes("Took"), "no time while running");
  direct.context.durationMs = 1234;
  direct.result(result("BUILT"));
  assert.match(plain(direct.view), /\n {2}BUILT\n {2}Took 1\.2s$/);
  const took = direct.view.render(160).at(-1) ?? "";
  assert(took.includes(themes.theme.fg("muted", "Took 1.2s")), "muted, like Pi's bash rows");

  await f.pi.event("user_bash");
  const run = f.call("codemode", "timed-script", { code: CODE });
  const nested = events(f, "timed-script");
  await nested.start("1", "bash", { command: "npm test" });
  await nested.end("1", "bash", result("FAILED_TESTS"), true, 61_000);
  await nested.start("2", "bash", { command: "npm run lint" });
  await nested.end("2", "bash", result("LINTED"));
  await nested.start("3", "read", { path: "a.txt" });
  await nested.end("3", "read", result("READ_BODY"), false, 5);
  run.result(
    script("OUT", [
      { id: "timed-script/1", name: "bash", args: "{}", status: "error", durationMs: 99 },
      { id: "timed-script/2", name: "bash", args: "{}", status: "ok", durationMs: 450 },
      { id: "timed-script/3", name: "read", args: "{}", status: "ok", durationMs: 5 },
    ]),
  );
  f.expand(true);
  const open = plain(run.view);
  assert.match(open, /FAILED_TESTS\n *Took 1m 1s/, "failed commands keep their time");
  assert.match(open, /LINTED\n *Took 0\.5s/, "details.calls fill in a time events lacked");
  assert.equal(open.match(/Took/g)?.length, 2, "only commands show a time");
  f.expand(false);

  const message = (value: object) => ({ type: "message", message: value });
  const call = (id: string, name: string, args: Record<string, string>) =>
    message(assistant("", [{ type: "toolCall", id, name, arguments: args }]));
  await f.rebuild("session_start", [
    call("saved-bash", "bash", { command: "make" }),
    message({
      role: "toolResult",
      toolCallId: "saved-bash",
      toolName: "bash",
      ...result("MADE"),
      isError: false,
      durationMs: 2500,
    }),
    call("saved-timed", "codemode", { code: CODE }),
    message({
      role: "toolResult",
      toolCallId: "saved-timed",
      toolName: "codemode",
      ...script("OUT"),
      isError: false,
      nestedCalls: {
        complete: true,
        calls: [
          {
            id: "saved-timed/1",
            name: "bash",
            arguments: { command: "make test" },
            status: "ok",
            durationMs: 3_725_000,
          },
        ],
      },
    }),
  ]);
  const view = f.call("bash", "saved-bash", { command: "make" }).view;
  f.expand(true);
  const saved = plain(view);
  assert.match(saved, /MADE\n *Took 2\.5s/);
  assert.match(saved, /Output not kept in session\.\n *Took 1h 2m 5s/);
});

test("rebuilds keep outputs and expansion of calls seen running", async () => {
  const f = await fixture();
  const run = f.call("codemode", "live", { code: CODE });
  const nested = events(f, "live");
  await nested.start("1", "read", { path: "a.txt" });
  await nested.end("1", "read", result("LIVE_BODY"));
  await nested.start("2", "edit", { path: "e.txt" });
  await nested.end("2", "edit", result("done", { diff: "-1 a\n+1 b" }));
  run.result(script("OUT", [{ id: "live/1", name: "read", args: "{}", status: "ok" }]));
  plain(run.view);
  run.view.handleMouse(mouse(0));
  run.view.handleMouse(mouse(0, lineOf(run.view, "a.txt")));
  assert.match(plain(run.view), /LIVE_BODY/);
  const entries = [
    {
      type: "message",
      message: assistant("", [
        { type: "toolCall", id: "live", name: "codemode", arguments: { code: CODE } },
      ]),
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "live",
        toolName: "codemode",
        ...script("OUT"),
        isError: false,
        nestedCalls: {
          complete: true,
          calls: [
            { id: "live/1", name: "read", arguments: { path: "a.txt" }, status: "ok" },
            { id: "live/2", name: "edit", arguments: { path: "e.txt" }, status: "ok" },
          ],
        },
      },
    },
  ];
  for (const event of ["session_tree", "session_compact", "session_start"]) {
    await f.rebuild(event, entries);
    const view = f.call("codemode", "live", { code: CODE }).view;
    assert.match(plain(view), /LIVE_BODY/, `${event} keeps the live output and expansion`);
    assert.match(plain(view), /Edited e\.txt \+1 −1/);
    assert(!plain(view).includes("Output not kept"));
  }
});

test("calls inside scripts follow their script through regrouping, prepends and nesting", () => {
  const model = new ToolGroups();
  const scriptRow = model.addCall("s", "codemode", { code: "x" }, root);
  assert(scriptRow);
  assert.equal(model.startNested("s", "s/1", "custom_orchestrator", {}, root), scriptRow);
  assert.equal(model.startNested("s/1", "s/1/1", "read", { path: "deep" }, root), scriptRow);
  assert.deepEqual(
    scriptRow.calls?.map((row) => [row.id, row.kind]),
    [
      ["s/1", "tool"],
      ["s/1/1", "read"],
    ],
    "calls by calls flatten into their script",
  );
  assert.equal(model.startNested("unknown", "u/1", "read", {}, root), undefined);
  assert.equal(model.updateNested("u/1", result("x"), false, false), undefined);
  const read = model.addCall("r", "read", { path: "r" }, root);
  assert(read);
  assert.equal(read.group, scriptRow.group);
  model.setThinkingHidden(true);
  const thinking = assistant("", [{ type: "thinking", thinking: "t" }]);
  model.startMessage(thinking, root);
  model.finishMessage(thinking, root);
  model.addCall("after", "bash", {}, root);
  model.setThinkingHidden(false);
  for (const call of scriptRow.calls ?? []) assert.equal(call.group, scriptRow.group);
  const before = model.rows.get("after")?.group.revision ?? 0;
  model.updateNested("s/1/1", result("BODY"), false, false);
  assert.equal(model.rows.get("after")?.group.revision, before, "only the script's group redraws");

  const older = new ToolGroups();
  const old = older.addCall("old", "codemode", {}, root);
  assert(old);
  older.updateResult(old, script("", []), false, false, {
    nestedCalls: {
      complete: true,
      calls: [{ id: "old/1", name: "read", arguments: { path: "o" }, status: "ok" }],
    },
  });
  const staged = model.stagePrepend(older);
  staged.rollback();
  assert.equal(model.startNested("old/1", "old/1/1", "read", {}, root), undefined);
  model.stagePrepend(older).commit();
  assert(model.startNested("old/1", "old/1/1", "read", {}, root), "prepended calls are indexed");
});
