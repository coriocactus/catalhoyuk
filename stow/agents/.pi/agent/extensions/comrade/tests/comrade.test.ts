import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { fake, fakePi, type Tool } from "../../test/fake-pi.ts";
import { load, themes, tui } from "../../test/pi.ts";
import { fixture, models, render, standIn, toolNames } from "./fixture.ts";

const {
  default: install,
  currentPi,
  watchParent,
} = await load<typeof import("../index.ts")>("../index.ts", import.meta.url);
const resume = await load<typeof import("../resume.ts")>("../resume.ts", import.meta.url);
const { interruption, interruptionNote, finished } = resume;
const { isConversationMessage, lean, steering } = await load<typeof import("../run.ts")>(
  "../run.ts",
  import.meta.url,
);
const runs = await load<typeof import("../runs.ts")>("../runs.ts", import.meta.url);
type Details = import("../index.ts").Details;
type Delivery = import("../index.ts").Delivery;
type Sent = Parameters<ExtensionAPI["sendMessage"]>;
type Result = Awaited<ReturnType<Tool["execute"]>>;
type RenderContext = Parameters<NonNullable<Tool["renderResult"]>>[3];

/** A background comrade's start, as the session records it. */
const started = (id: number, task: string) => ({
  type: "message",
  message: { role: "toolResult", toolName: "comrade", details: { id, task } },
});

const body = (sent: Sent) => {
  const [message] = sent;
  assert(typeof message.content === "string");
  return message.content;
};
const delivery = (sent: Sent) => sent[0].details as Delivery;

const text = (result: Result) => {
  const [first] = result.content;
  assert(first?.type === "text");
  return first.text;
};
const details = (result: Result) => result.details as Details;
/** The run line that ends the result of every comrade that ran. */
const RUN = /\n\n\[comrade #\d+: [^\n]*\]$/;
/** A result's text without its run line. */
const answer = (result: Result) => text(result).replace(RUN, "");

test("comrade sends the task verbatim as its prompt and the run settings as Pi flags", async (t) => {
  const { call, cwd, updates } = fixture(t, "echo");
  const task = `@notes.md -- $(rm -rf ~) "double" 'single' ✓ é\n  second line`;
  const result = await call({ task });
  assert.equal(result.isError, undefined);
  const echoed = JSON.parse(answer(result));
  assert.equal(echoed.task, task);
  assert.deepEqual(echoed.args, [
    "--mode",
    "rpc",
    "--session",
    join(cwd, "parent.comrades", "comrade-1.jsonl"),
    "--provider",
    "anthropic",
    "--model",
    "claude-opus-5-5",
    "--thinking",
    "xhigh",
    "--tools",
    "read,grep,find,ls",
    "--approve",
  ]);
  assert.equal(echoed.cwd, cwd);
  // The parent's pid, which the comrade watches.
  assert.equal(echoed.nested, String(process.pid));

  assert.deepEqual(details(result).work, {
    tallies: [{ kind: "read", calls: 1, failed: 0, files: 1, added: 0, removed: 0 }],
    rows: [],
    omitted: 0,
  });
  assert.equal(details(result).turns, 2);
  assert.deepEqual(result.usage, {
    input: 200,
    output: 20,
    cacheRead: 100,
    cacheWrite: 0,
    totalTokens: 320,
    cost: { input: 0.02, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.022 },
  });
  assert.deepEqual(
    updates.map((update) => [details(update).calls, details(update).turns]),
    // Shown before the comrade starts, once its Pi has started, when its run starts, once Pi
    // has saved its prompt, on each turn, and on each call's start, end and result.
    [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 1],
      [1, 1],
      [1, 1],
      [1, 1],
      [1, 2],
    ],
  );
});

test("explicit settings override the caller's; an empty tool list means no tools", async (t) => {
  const { call } = fixture(t, "echo", { trusted: false });
  const result = await call({
    task: "✓",
    model: "anthropic/claude-fable-5-1",
    thinking: "low",
    tools: [],
  });
  const { args } = JSON.parse(answer(result));
  assert.deepEqual(args.slice(4), [
    "--provider",
    "anthropic",
    "--model",
    "claude-fable-5-1",
    "--thinking",
    "low",
    "--no-tools",
    "--no-approve",
  ]);
});

test("invalid requests are rejected before anything starts", async (t) => {
  // Starting anything would report this missing command instead of rejecting.
  const { call } = fixture(t, "echo", { command: "/nonexistent/pi" });
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ task: " \n ", title: "Blank" }, /needs a task/],
    [{ task: "x", tools: ["read", "comrade"] }, /cannot start comrades/],
    [{ task: "x", tools: ["comrades"] }, /cannot start comrades/],
    [
      { task: "x", tools: ["rgrep"] },
      /Unknown tool "rgrep" for comrade\. Active: read, bash, edit, write, grep, find, ls, codemode\./,
    ],
    [{ task: "x", tools: ["zz*"] }, /Unknown tool "zz\*"/],
    [{ task: "x", tools: ["-bash"] }, /Unknown tool "-bash"/],
    [{ task: "x", tools: ["read,bash"] }, /Unknown tool "read,bash"/],
  ];
  for (const [params, error] of cases) await assert.rejects(call(params), error);
});

test("a long answer is truncated and saved in full beside the comrade's conversation", async (t) => {
  const { call, cwd, remember } = fixture(t, "long");
  const result = await call({ task: "x" });
  const file = details(result).answer;
  assert.equal(file, join(cwd, "parent.comrades", "comrade-1.answer.md"));
  assert.match(text(result), /^line 1\n/);
  assert.match(
    answer(result),
    /\[Answer truncated: 2000 of 3000 lines .*Full answer: .*comrade-1\.answer\.md\]$/,
  );
  assert.equal(readFileSync(file, "utf8").split("\n").length, 3000);
  // A later run of the same comrade keeps the earlier answer.
  remember(result);
  const again = await call({ task: "x", to: 1 });
  assert.equal(details(again).answer, join(cwd, "parent.comrades", "comrade-1.answer.2.md"));
});

test("failures are errors that say why", async (t) => {
  const outcomes: [string, RegExp, { command?: string }?][] = [
    ["error", /^Comrade failed: 529 overloaded$/],
    ["crash", /^pi exited with code 1\nError: Model .* not found$/],
    ["silent", /^Comrade finished without an answer\.$/],
    // Pi refuses the prompt before any run, as without credentials.
    ["rejected", /^Comrade failed: No API key found for anthropic$/],
    // An extension command took the prompt: nothing ran.
    ["handled", /^Comrade finished without an answer\.$/],
    ["echo", /^Could not start pi: .*ENOENT/, { command: "/nonexistent/pi" }],
  ];
  for (const [scenario, message, options] of outcomes) {
    const result = await fixture(t, scenario, options).call({ task: "✓" });
    assert.equal(result.isError, true, scenario);
    assert.match(answer(result), message, scenario);
  }
});

test("aborting stops the comrade process", async (t) => {
  const { call } = fixture(t, "hang");
  const controller = new AbortController();
  const started = Date.now();
  const result = await call({ task: "x" }, controller.signal, () => controller.abort());
  assert.equal(result.isError, true);
  assert.equal(text(result), "Comrade #1 stopped.");
  assert(Date.now() - started < 4000, "stopped by SIGTERM, not the SIGKILL fallback");
  // An already-aborted signal starts nothing.
  const again = await call({ task: "x" }, controller.signal);
  assert.equal(text(again), "Comrade #2 stopped.");
});

test("comrades do not offer comrade", () => {
  process.env.PI_COMRADE = "1";
  try {
    const pi = fakePi();
    install(pi.api);
    assert.equal(pi.tools.size, 0);
  } finally {
    delete process.env.PI_COMRADE;
  }
});

test("a comrade's calls are summarised like mirage's groups, with the ones worth naming", async (t) => {
  const { call } = fixture(t, "busy");
  const work = details(await call({ task: "✓" })).work;
  assert.deepEqual(work?.tallies, [
    { kind: "read", calls: 4, failed: 1, files: 3, added: 0, removed: 0 },
    { kind: "search", calls: 1, failed: 0, files: 0, added: 0, removed: 0 },
    { kind: "edit", calls: 1, failed: 0, files: 1, added: 2, removed: 1 },
    { kind: "write", calls: 1, failed: 0, files: 1, added: 2, removed: 0 },
    { kind: "command", calls: 4, failed: 2, files: 0, added: 0, removed: 0 },
  ]);
  assert.deepEqual(
    work?.rows.map((row) => [row.status, row.label, row.error ?? row.times ?? row.added]),
    [
      ["error", "$ false", "exit code 1"],
      ["error", "Read /tmp/d.ts", "ENOENT: no such file or directory"],
      ["cancelled", "$ sleep 9", undefined],
      ["success", "Edited /tmp/a.ts", 2],
      ["success", "Wrote /tmp/c.md", 2],
      ["success", "$ npm test …", 2],
    ],
  );
  assert.equal(work?.current, undefined, "a finished comrade has no current call");
});

test("one line at rest, three while running, and its work behind Ctrl+O or a click", async (t) => {
  // A frozen clock holds the spinner on its first frame.
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const { tool, call, updates } = fixture(t, "busy");
  const args = {
    title: "Review the diff",
    task: `Review the diff in ${homedir()}/notes\nwith care`,
  };
  const state = {};
  let redraws = 0;
  const context = (isPartial: boolean, expanded = false, isError = false) =>
    fake<RenderContext>({
      args,
      state,
      toolCallId: "call",
      isPartial,
      expanded,
      isError,
      argsComplete: true,
      executionStarted: true,
      durationMs: isPartial ? undefined : 754_000,
      outputPad: 0,
      invalidate: () => redraws++,
    });
  const component = (value: Result, isPartial: boolean, expanded = false, isError = false) =>
    tool.renderResult?.(
      value,
      { expanded, isPartial },
      themes.theme,
      context(isPartial, expanded, isError),
    );
  const call_ = () => render(tool.renderCall?.(args, themes.theme, context(true)));
  const result_ = (value: Result, isPartial: boolean, expanded = false, isError = false) =>
    render(component(value, isPartial, expanded, isError));

  // Before any result, the call slot is the header, named by its title.
  assert.equal(call_(), "⠋ Comrade  Review the diff");
  // Drawn as Pi draws it while the comrade works: when the edit is under way.
  let running: string[] = [];
  const result = await call(args, undefined, () => {
    const update = updates.at(-1);
    if (update && details(update).work?.current === "Editing /tmp/a.ts" && !running.length)
      running = [result_(update, true), result_(update, true, true)];
  });
  // Running: the call it runs, and with nothing said in this turn, its tokens so far.
  assert.equal(
    running[0],
    ["⠋ Comrade #1  Review the diff  $0.01 · 0s ▸", "  ⠋ Editing /tmp/a.ts", "  ↑150 ↓10"].join(
      "\n",
    ),
  );
  // Expanded, its task and then its calls, which Pi started together, as they stand.
  assert.equal(
    running[1],
    [
      "⠋ Comrade #1  Review the diff  $0.01 · 0s ▾",
      "",
      `  │ Review the diff in ${homedir()}/notes`,
      "  │ with care",
      "",
      "  ✓ Read /tmp/a.ts",
      "  ✓ Read /tmp/b.ts",
      "  ✓ Read /tmp/a.ts",
      "  ✓ grep TODO /tmp",
      "  ⠋ Editing /tmp/a.ts",
      "  ⠋ Writing /tmp/c.md",
      "  ⠋ npm test …",
      "  ⠋ npm test …",
      "  ⠋ false",
      "  ⠋ Reading /tmp/d.ts",
      "  ⠋ sleep 9",
    ].join("\n"),
  );
  // From then on the result slot owns the header, and the call slot is redrawn empty.
  await Promise.resolve();
  assert.equal(redraws, 1);
  assert.equal(call_(), "");

  assert.equal(result_(result, false), "✓ Comrade #1  Review the diff  $0.02 · 12m 34s ▸");
  // Ended: its task, what it did in order, and its answer. The call Pi never finished is
  // cancelled.
  assert.equal(
    result_(result, false, true),
    [
      "✓ Comrade #1  Review the diff  $0.02 · 12m 34s ▾",
      "",
      `  │ Review the diff in ${homedir()}/notes`,
      "  │ with care",
      "",
      "  ✓ Read /tmp/a.ts",
      "  ✓ Read /tmp/b.ts",
      "  ✓ Read /tmp/a.ts",
      "  ✓ grep TODO /tmp",
      "  ✓ Edited /tmp/a.ts +2 −1",
      "  ✓ Wrote /tmp/c.md +2",
      "  $ npm test …",
      "  $ npm test …",
      "  $ false  exit code 1",
      "  ✗ Read /tmp/d.ts  ENOENT: no such file or directory",
      "  $ sleep 9",
      "",
      "  Done.",
    ].join("\n"),
  );

  // Its header is Pi's to open and close, as any tool row's: the row leaves the click to Pi.
  const row = component(result, false);
  assert(row?.handleMouse);
  // Pi draws a row before it can be clicked.
  row.render(120);
  assert.equal(row.handleMouse({ type: "click", button: "left", x: 3, y: 0 } as never), undefined);

  const stopped = {
    content: [{ type: "text" as const, text: "Comrade stopped." }],
    details: { ...details(result), stopped: true },
  };
  assert.equal(
    result_(stopped, false, false, true),
    "✗ Comrade #1  Review the diff  stopped · $0.02 · 12m 34s ▸",
  );

  const rejected = {
    content: [{ type: "text" as const, text: "comrade needs a task.\nPass one." }],
    details: {},
  };
  assert.equal(
    result_(rejected, false),
    "✗ Comrade  Review the diff  failed ▸\n  comrade needs a task.",
  );
  assert.match(result_(rejected, false, true), /comrade needs a task\.\n {2}Pass one\.\n/);
});

test("a call Pi never finished, in a session opened again, is still", (t) => {
  const { tool } = fixture(t, "echo");
  const args = { title: "Review the diff", task: "Review it" };
  const drawn = render(
    tool.renderCall?.(
      args,
      themes.theme,
      fake<RenderContext>({
        args,
        state: {},
        toolCallId: "orphan",
        argsComplete: true,
        executionStarted: false,
        invalidate() {},
      }),
    ),
  );
  assert.equal(drawn, "… Comrade  Review the diff");
});

test("a row without a title is named by its task's first line, dim", async (t) => {
  const { tool, call } = fixture(t, "echo");
  // A blank title, or a row saved before titles: nothing refuses it.
  const args = { task: "Two files are attached.\nRead them.", title: " " };
  const result = await call(args);
  assert.equal(details(result).title, undefined);
  assert.match(
    render(
      tool.renderResult?.(
        result,
        { expanded: false, isPartial: false },
        themes.theme,
        fake<RenderContext>({
          args,
          state: {},
          isPartial: false,
          expanded: false,
          durationMs: 1000,
          invalidate() {},
        }),
      ),
    ),
    /^✓ Comrade #1 {2}Two files are attached\. {2}\$0\.02 · 1\.0s ▸$/,
  );
});

test("the header keeps how it went in view by cutting the title, narrow by dropping the cost", async (t) => {
  const { tool, call } = fixture(t, "echo");
  const args = { task: "✓ ".repeat(80) };
  const result = await call({ ...args, model: "anthropic/claude-fable-5-1" });
  const line = tool.renderResult?.(
    result,
    { expanded: false, isPartial: false },
    themes.theme,
    fake<RenderContext>({
      args,
      state: {},
      isPartial: false,
      expanded: false,
      isError: false,
      durationMs: 1500,
      invalidate() {},
    }),
  );
  const header = (width: number) => {
    line?.invalidate();
    const [raw] = line?.render(width) ?? [];
    // A full reset would clear any colour behind the row from the cut onwards.
    assert(!raw.includes("\x1b[0m"), JSON.stringify(raw));
    const plain = tui.stripTerminalSequences(raw);
    assert(tui.visibleWidth(plain) <= width, plain);
    return plain;
  };
  // Wide, the model the caller did not use is named after the title, which a row keeps short.
  assert.match(
    header(120),
    /^✓ Comrade #1 {2}(✓ ){29}✓… {2}claude-fable-5-1 {2}\$0\.02 · 1\.5s ▸$/,
  );
  // Narrower, the title gives way, then the model, then the cost.
  assert.match(header(70), /✓… {2}\$0\.02 · 1\.5s ▸$/);
  assert.equal(tui.visibleWidth(header(70)), 70);
  assert.match(header(40), /✓… {2}1\.5s ▸$/);
});

test("a background comrade returns at once, then its answer arrives and wakes the agent", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const { tool, call, delivered, renderers, entries } = fixture(t, "echo");
  const args = { task: "✓ survey the parser\nin detail", background: true };
  const result = await call(args);
  assert.equal(
    text(result),
    "Comrade #1 started in the background. Keep working. Its answer will arrive as a [comrade #1 …] message, and if you finish first, your turn waits for it. Check on it or stop it with the comrades tool.",
  );
  assert.equal(details(result).id, 1);
  const startRow = () =>
    tool.renderResult?.(
      result,
      { expanded: false, isPartial: false },
      themes.theme,
      fake<RenderContext>({
        args,
        state: {},
        toolCallId: "call",
        isPartial: false,
        expanded: false,
        isError: false,
        durationMs: 3,
        invalidate() {},
      }),
    );
  // Its start row is one line, spinning while the comrade runs: the widget shows its progress.
  // Its clock ticks while its run goes on.
  assert.equal(render(startRow()), "⠋ Comrade #1  ✓ survey the parser  background · 0s ▸");

  const [message] = await delivered(1);
  // Then it is history, dim, and once the session holds the answer, says how it went.
  assert.equal(render(startRow()), "↗ Comrade #1  ✓ survey the parser  background ▸");
  entries.push(
    fake<SessionEntry>({
      type: "message",
      message: {
        role: "toolResult",
        toolName: "comrade",
        toolCallId: "call",
        details: result.details,
      },
    } as never),
    saved(message),
  );
  assert.equal(render(startRow()), "↗ Comrade #1  ✓ survey the parser  background · finished ▸");
  assert.deepEqual(message[1], { deliverAs: "followUp", triggerTurn: true });
  assert.equal(message[0].customType, "comrade");
  assert.match(body(message), /^\[comrade #1 finished\] ✓ survey the parser\n\n\{"args"/);
  assert.equal(delivery(message).status, "finished");
  assert.equal(delivery(message).turns, 2);

  const renderer = renderers.get("comrade");
  assert(renderer);
  const shown = (expanded: boolean) =>
    render(
      renderer(
        { ...message[0], role: "custom", display: true, timestamp: 0, details: delivery(message) },
        { expanded, outputPad: 0, keyHint: () => "", keyText: () => "" },
        themes.theme,
      ),
    ).trim();
  assert.match(shown(false), /^✓ Comrade #1 {2}✓ survey the parser {2}\$0\.02 · \d+\.\ds ▸$/);
  assert.match(
    shown(true),
    /^✓ Comrade #1 .* ▾\n\n {2}│ ✓ survey the parser\n\n {2}✓ Read \/tmp\/notes\.md\n\n {2}\{"args".*\}$/s,
  );
});

test("/comrades lists and stops background comrades without waking the agent", async (t) => {
  const { call, slash, delivered, notices } = fixture(t, "hang");
  await call({ task: "first", background: true });
  await call({ task: "second", background: true });
  await slash("");
  assert.match(
    notices.at(-1) ?? "",
    /^#1 · first · .*\n#2 · second · .*\n2 running · \$0\.00 so far$/,
  );

  await slash("stop #1");
  const [first] = await delivered(1);
  assert.deepEqual(first[1], { deliverAs: "followUp", triggerTurn: false });
  assert.equal(body(first), "[comrade #1 stopped] first\n\nStopped by the user.");

  await slash("stop all");
  const [, second] = await delivered(2);
  assert.equal(delivery(second).status, "stopped");
  await slash("");
  assert.equal(notices.at(-1), "No comrades running.");
  await slash("stop 9");
  assert.equal(notices.at(-1), "No running comrade 9");
  await slash("pause");
  assert.equal(notices.at(-1), "Usage: /comrades [stop <n|all>]");
});

test("at most four background comrades run; shutdown stops them silently", async (t) => {
  const { call, sent, shutdown } = fixture(t, "hang");
  for (let i = 0; i < 4; i++) await call({ task: `job ${i}`, background: true });
  await assert.rejects(call({ task: "one more", background: true }), /4 background comrades/);
  shutdown();
  await new Promise((wake) => setTimeout(wake, 300));
  assert.equal(sent.length, 0, "nothing is delivered into a closed session");
});

test("comrades lost when Pi exited are reported, and numbering continues past them", async (t) => {
  const entries = [
    started(7, "Survey the parser"),
    started(8, "Read the docs"),
    { type: "custom_message", customType: "comrade", details: { id: 8 } },
  ] as unknown as SessionEntry[];
  const { call, sent } = fixture(t, "echo", { entries });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0][1], { deliverAs: "followUp", triggerTurn: false });
  assert.equal(
    body(sent[0]),
    "[comrade #7 lost] Survey the parser\n\nPi exited or switched sessions while this comrade ran, so its answer will not arrive.",
  );
  const result = await call({ task: "✓", background: true });
  assert.equal(details(result).id, 9);
});

test("background runs in the foreground where no later message could arrive", async (t) => {
  const { call, sent } = fixture(t, "echo", { mode: "print" });
  const result = await call({ task: "✓", background: true });
  assert.match(text(result), /^\(Ran in the foreground: .*\)\n\n\{"args"/);
  assert.equal(sent.length, 0);
});

test("the model is always provider/id, and the comrade runs it under that provider", async (t) => {
  const { call } = fixture(t, "echo");
  const flags = async (model: string, thinking?: string) => {
    const result = await call({ task: "✓", model, thinking });
    const { args } = JSON.parse(answer(result));
    return { args: args.slice(4, args.indexOf("--tools")), shown: details(result).model };
  };
  // Anthropic's model, even though OpenRouter's id for it is the same text.
  assert.deepEqual(await flags("anthropic/claude-fable-5-1"), {
    args: ["--provider", "anthropic", "--model", "claude-fable-5-1", "--thinking", "xhigh"],
    shown: "anthropic/claude-fable-5-1",
  });
  assert.deepEqual((await flags("openrouter/anthropic/claude-fable-5-1")).args.slice(0, 4), [
    "--provider",
    "openrouter",
    "--model",
    "anthropic/claude-fable-5-1",
  ]);
  // A :level suffix sets the thinking level, unless thinking is given.
  assert.deepEqual((await flags("openrouter/google/gemini-4-argon:high")).args, [
    "--provider",
    "openrouter",
    "--model",
    "google/gemini-4-argon",
    "--thinking",
    "high",
  ]);
  assert.equal(
    (await flags("openrouter/google/gemini-4-argon:high", "minimal")).args[5],
    "minimal",
  );
  // Colons that are not thinking levels belong to the id.
  assert.deepEqual((await flags("openrouter/google/gemini-4-argon:batch")).args.slice(2, 4), [
    "--model",
    "google/gemini-4-argon:batch",
  ]);
});

test("bare or unknown model names are refused, with the names to use", async (t) => {
  const { call } = fixture(t, "echo", { command: "/nonexistent/pi", scoped: models.slice(0, 2) });
  for (const model of [
    "haiku",
    "claude-fable-5-1",
    "gemini-4-argon",
    "anthropic/nope",
    "nope/claude-opus-5-5",
  ])
    await assert.rejects(
      call({ task: "x", model }),
      new RegExp(
        `^Error: Unknown model "${model}"\\. Pass comrade's model as provider/id, such as anthropic/claude-opus-5-5, anthropic/claude-fable-5-1\\.$`,
      ),
      model,
    );
});

test("only the enabled models are allowed, or with no scope, those with credentials", async (t) => {
  const scopedRun = fixture(t, "echo", { scoped: [models[1], models[3]] });
  for (const model of ["anthropic/claude-opus-5-5", "openrouter/anthropic/claude-fable-5-1:high"])
    await assert.rejects(
      scopedRun.call({ task: "x", model }),
      new RegExp(
        `^Error: Model "${model}" is not enabled here, so a comrade cannot use it\\. Enabled: anthropic/claude-fable-5-1, openrouter/google/gemini-4-argon\\.$`,
      ),
      model,
    );
  const run = async (call: typeof scopedRun.call, params: Record<string, unknown>) =>
    JSON.parse(answer(await call({ task: "✓", ...params }))).args.slice(4, 8);
  assert.deepEqual(await run(scopedRun.call, { model: "anthropic/claude-fable-5-1:high" }), [
    "--provider",
    "anthropic",
    "--model",
    "claude-fable-5-1",
  ]);
  // The caller's own model is its choice, even outside the scope.
  assert.deepEqual(await run(scopedRun.call, {}), [
    "--provider",
    "anthropic",
    "--model",
    "claude-opus-5-5",
  ]);

  const unscoped = fixture(t, "echo", { available: models.slice(0, 2) });
  await assert.rejects(
    unscoped.call({ task: "x", model: "openrouter/google/gemini-4-argon" }),
    /^Error: Model "openrouter\/google\/gemini-4-argon" is not available here, so a comrade cannot use it\. Available: anthropic\/claude-opus-5-5, anthropic\/claude-fable-5-1\.$/,
  );
  assert.deepEqual(
    (await run(unscoped.call, { model: "anthropic/claude-fable-5-1" }))[3],
    "claude-fable-5-1",
  );
});

test("the model parameter names the enabled models, and follows the scope as it changes", async (t) => {
  const { pi, ctx, tool } = fixture(t, "echo", { scoped: [models[1], models[3]] });
  const described = (registered = pi.tools.get("comrade")) => {
    assert(registered, "comrade registered");
    const schema = registered.parameters as { properties: { model: { description: string } } };
    return schema.properties.model.description;
  };
  // Before the session is known, it names none.
  assert.equal(
    described(tool),
    "provider/id of a model enabled in this Pi, exactly as Pi lists it, optionally with :thinking. Bare names are refused. Default: your model, or the comrade's with to.",
  );
  assert.equal(
    described(),
    "One of: anthropic/claude-fable-5-1, openrouter/google/gemini-4-argon. Optionally with :thinking. Default: your model, or the comrade's with to.",
  );
  const registered = pi.tools.get("comrade");
  await pi.event("before_agent_start", {}, ctx);
  assert.equal(pi.tools.get("comrade"), registered, "an unchanged scope registers nothing");
  // /scoped-models clears the scope: every model with credentials, the caller's as the example.
  Object.assign(ctx, { scopedModels: [] });
  await pi.event("before_agent_start", {}, ctx);
  assert.equal(
    described(),
    "provider/id of a model with credentials in this Pi, exactly as Pi lists it, such as anthropic/claude-opus-5-5, optionally with :thinking. Bare names are refused. Default: your model, or the comrade's with to.",
  );
});

test("the tools parameter names only the read-only tools active here", async (t) => {
  const inactive = ["grep", "find", "ls"];
  const { pi, ctx, tool } = fixture(t, "echo", { inactive });
  const described = (registered = pi.tools.get("comrade")) => {
    assert(registered, "comrade registered");
    const schema = registered.parameters as { properties: { tools: { description: string } } };
    return schema.properties.tools.description;
  };
  const rest =
    'Add "edit" and "write" to change files, "bash" to run commands. [] for none. Only tools active here.';
  // Before the session is known, it names none.
  assert.equal(
    described(tool),
    `Default: the read-only tools active here, or the comrade's with to. ${rest}`,
  );
  // Pi's default tool set has no grep, find or ls: naming them would invite a refused call.
  assert.equal(described(), `Default: read-only, ["read"], or the comrade's with to. ${rest}`);
  const registered = pi.tools.get("comrade");
  await pi.event("before_agent_start", {}, ctx);
  assert.equal(pi.tools.get("comrade"), registered, "unchanged tools register nothing");
  // /tools turns them on.
  inactive.splice(0);
  await pi.event("before_agent_start", {}, ctx);
  assert.equal(
    described(),
    `Default: read-only, ["read", "grep", "find", "ls"], or the comrade's with to. ${rest}`,
  );
  inactive.push("read", "grep", "find", "ls");
  await pi.event("before_agent_start", {}, ctx);
  assert.equal(
    described(),
    `Default: none, as no read-only tool is active here, or the comrade's with to. ${rest}`,
  );
});

test("tool patterns must match a tool this Pi has", async (t) => {
  const { call } = fixture(t, "echo");
  const { args } = JSON.parse(answer(await call({ task: "✓", tools: ["gr*", "bash"] })));
  assert.deepEqual(args.slice(10, 12), ["--tools", "gr*,bash"]);
});

test("the comrades tool lists and stops background comrades, and a stop sends no message", async (t) => {
  const { call, comrades, sent } = fixture(t, "hang");
  assert.equal(text(await comrades({})), "No background comrades are running.");
  await call({ task: "first", background: true });
  await call({ task: "second", background: true });
  assert.match(
    text(await comrades({})),
    /^#1 · first · .*\n#2 · second · .*\n2 running · \$0\.00 so far$/,
  );

  const stopped = await comrades({ stop: [1, 9] });
  assert.equal(text(stopped), "Stopped comrade #1. No running comrade #9.");
  assert.equal(stopped.isError, false);
  assert.deepEqual(stopped.details, { stopped: [1] });
  assert.match(text(await comrades({})), /^#2 · second · /);

  const missing = await comrades({ stop: [9] });
  assert.equal(missing.isError, true);
  await comrades({ stop: [2] });
  assert.equal(sent.length, 0, "the agent already knows; nothing wakes it");
});

test("a comrade the agent stopped is not reported lost later", (t) => {
  const entries = [
    started(5, "Wrong brief"),
    {
      type: "message",
      message: { role: "toolResult", toolName: "comrades", details: { stopped: [5] } },
    },
  ] as unknown as SessionEntry[];
  assert.equal(fixture(t, "echo", { entries }).sent.length, 0);
});

test("background comrades keep running across /reload and report to the reloaded extension", async (t) => {
  const before = fixture(t, "hang", { sessionId: "reloaded" });
  await before.call({ task: "survives", background: true });
  before.shutdown("reload");

  const after = fixture(t, "hang", {
    sessionId: "reloaded",
    reason: "reload",
    entries: [started(1, "survives")] as unknown as SessionEntry[],
  });
  assert.equal(after.sent.length, 0, "still running, so not lost");
  assert.match(text(await after.comrades({})), /^#1 · survives · /);
  assert.equal(details(await after.call({ task: "next", background: true })).id, 2);
  assert.equal(text(await after.comrades({ stop: [1, 2] })), "Stopped comrade #1, #2.");
  assert.equal(before.sent.length, 0);
});

test("a comrade that finishes during /reload is delivered once the extension is back", async (t) => {
  const before = fixture(t, "echo", { sessionId: "finished-while-parked" });
  await before.call({ task: "✓ quick", background: true });
  before.shutdown("reload");
  const parked = (globalThis as Record<symbol, Map<string, { done: Promise<void> }[]>>)[
    Symbol.for("comrade.parked-jobs.v1")
  ];
  await Promise.all((parked.get("finished-while-parked") ?? []).map((job) => job.done));

  const after = fixture(t, "echo", {
    sessionId: "finished-while-parked",
    reason: "reload",
    entries: [started(1, "✓ quick")] as unknown as SessionEntry[],
  });
  assert.equal(after.sent.length, 1);
  assert.match(body(after.sent[0]), /^\[comrade #1 finished\] ✓ quick\n\n\{"args"/);
  assert.deepEqual(after.sent[0][1], { deliverAs: "followUp", triggerTurn: true });
  assert.equal(before.sent.length, 0, "the outgoing extension delivers nothing");
});

test("leaving the session, rather than reloading, stops background comrades", async (t) => {
  const before = fixture(t, "hang", { sessionId: "left" });
  await before.call({ task: "abandoned", background: true });
  before.shutdown("new");
  const parked = (globalThis as Record<symbol, Map<string, unknown[]>>)[
    Symbol.for("comrade.parked-jobs.v1")
  ];
  assert.equal(parked.has("left"), false);
});

test("a file written and then edited keeps one row for each, as the summary counts them", async () => {
  const { Ledger } = await load<typeof import("../work.ts")>("../work.ts", import.meta.url);
  const ledger = new Ledger("/tmp");
  ledger.start("w", "write", { path: "notes.md", content: "a\nb\nc\n" });
  ledger.end("w", false, { content: [] });
  ledger.start("e", "edit", { path: "notes.md" });
  ledger.end("e", false, { content: [], details: { diff: "-2 b\n+2 B" } });
  assert.deepEqual(
    ledger.snapshot(false).rows.map((row) => [row.label, row.added, row.removed]),
    [
      ["Wrote /tmp/notes.md", 3, 0],
      ["Edited /tmp/notes.md", 1, 1],
    ],
  );
});

test("a running comrade spins with Pi's working spinner until its result arrives", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const { tool, call } = fixture(t, "echo");
  const args = { task: "Spin" };
  const state = {};
  let redraws = 0;
  const context = (isPartial: boolean) =>
    fake<RenderContext>({
      args,
      state,
      toolCallId: "spin",
      isPartial,
      expanded: false,
      isError: false,
      durationMs: isPartial ? undefined : 1000,
      invalidate: () => redraws++,
    });
  const result = await call(args);
  const running = { ...result, content: [{ type: "text" as const, text: "" }] };
  const draw = (value: Result, isPartial: boolean) =>
    render(
      tool.renderResult?.(value, { expanded: false, isPartial }, themes.theme, context(isPartial)),
    );

  const row = tool.renderResult?.(
    running,
    { expanded: false, isPartial: true },
    themes.theme,
    context(true),
  );
  assert.match(render(row), /^⠋ Comrade #1 {2}Spin {2}/);
  await Promise.resolve(); // the call slot's one-time redraw
  const before = redraws;
  // The row reads its frame from the clock each time Pi draws it. A frame drew it during the
  // interval, as Pi's own working indicator makes one do, so the timer asks for none.
  t.mock.timers.tick(80);
  assert.equal(redraws, before, "frames drawn for anything else turn the spinner");
  assert.match(render(row), /^⠙ Comrade #1 {2}Spin {2}/, "the frame follows the clock");
  assert((row?.render(120)[0] ?? "").startsWith(themes.theme.fg("accent", "⠙")), "in Pi's accent");
  // An interval in which no frame drew the row: the timer asks Pi to redraw it.
  t.mock.timers.tick(160);
  assert.equal(redraws, before + 1, "the timer asks Pi to redraw when nothing else does");
  // Pi then calls the renderer again, which keeps the row's one component.
  assert.equal(
    tool.renderResult?.(running, { expanded: false, isPartial: true }, themes.theme, {
      ...context(true),
      lastComponent: row,
    }),
    row,
  );

  assert.match(draw(result, false), /^✓ Comrade #1 {2}Spin {2}\$0\.02 · 1\.0s ▸$/);
  const done = redraws;
  t.mock.timers.tick(800);
  assert.equal(redraws, done, "no redraws once it has finished");
});

test("a run's work is built as its messages arrive, never again from the start", async () => {
  const { createTranscripts } = await load<typeof import("../transcripts.ts")>(
    "../transcripts.ts",
    import.meta.url,
  );
  const pi = fakePi();
  const transcripts = createTranscripts(pi.api);
  const said = (text: string) =>
    ({ role: "assistant", content: [{ type: "text", text }], stopReason: "toolUse" }) as never;
  const asks = (id: string) =>
    ({
      role: "assistant",
      content: [{ type: "toolCall", id, name: "grep", arguments: { pattern: id } }],
      stopReason: "toolUse",
    }) as never;
  const answers = (id: string) =>
    ({ role: "toolResult", toolCallId: id, isError: false, content: [] }) as never;
  const messages = [{ role: "user", content: "task" } as never, said("First."), asks("a")];
  transcripts.track("run", messages, true);
  const blocks = () => transcripts.blocksFor("run", () => undefined, "/tmp", themes.theme, true);
  const first = blocks();
  assert.deepEqual(
    first.map((block) => block.kind),
    ["text", "call"],
  );
  assert.equal(blocks(), first, "the same blocks until the run has done more");
  const [text, call] = first;
  assert(call.kind === "call" && call.row.status === "running");
  // Its result, and more work: the blocks grow, and the ones drawn stay the ones they were.
  messages.push(answers("a"), said("Second."));
  const second = blocks();
  assert.notEqual(second, first, "a row can tell that there is more to draw");
  assert.equal(second[0], text);
  assert.equal(second[1], call);
  assert.equal(call.row.status, "success", "a call's row says how it went once its result came");
  assert.deepEqual(
    second.map((block) => block.kind),
    ["text", "call", "text"],
  );
  // Ended, the calls left without a result were cut off: that changes them all, so it starts over.
  messages.push(asks("b"));
  transcripts.track("run", messages, false);
  const ended = transcripts.blocksFor("run", () => undefined, "/tmp", themes.theme, false);
  const cut = ended.at(-1);
  assert(cut?.kind === "call" && cut.row.status === "cancelled");
});

test("a turn waits for its background comrades, then continues with the answer", async (t) => {
  const { call, settle, sent, working, keys } = fixture(t, "echo");
  await call({ task: "✓ survey", background: true });
  await settle();
  // The answer is queued as a follow-up, which is what makes Pi continue the turn.
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0][1], { deliverAs: "followUp", triggerTurn: true });
  assert.equal(working[0], "Waiting for comrade #1");
  assert.equal(working.at(-1), undefined, "the working message is restored");
  assert.equal(keys.size, 0, "the Esc listener is removed");
});

test("Esc or a typed message ends the wait at once, and the comrades keep running", async (t) => {
  const esc = fixture(t, "hang");
  await esc.call({ task: "first", background: true });
  const waiting = esc.settle();
  await new Promise((wake) => setTimeout(wake, 50));
  esc.press("\x1b");
  const started = Date.now();
  await waiting;
  assert(Date.now() - started < 1000);
  assert.match(text(await esc.comrades({})), /^#1 · first · /, "still running");

  const typed = fixture(t, "hang");
  await typed.call({ task: "second", background: true });
  const waitingToo = typed.settle();
  typed.typed();
  await waitingToo;
  assert.equal(typed.sent.length, 0);
});

test("no wait without background comrades, or where Esc could not end it", async (t) => {
  const idle = fixture(t, "echo");
  await idle.settle();
  assert.deepEqual(idle.working, []);

  const rpc = fixture(t, "hang", { mode: "rpc" });
  await rpc.call({ task: "x", background: true });
  const started = Date.now();
  await rpc.settle();
  assert(Date.now() - started < 100, "RPC turns end as before");
});

test("a waiting turn continues with the first answer while other comrades still run", async (t) => {
  const { call, settle, sent, comrades } = fixture(t, "echo");
  await call({ task: "#scenario hang\nslow", background: true });
  await call({ task: "#scenario echo\n✓ quick", background: true });
  await settle();
  assert.equal(sent.length, 1, "the quick answer ended the wait");
  assert.match(text(await comrades({})), /^#1 /, "the slow one still runs");
});

test("an Esc key release does not end the wait, an Esc press does", async (t) => {
  const { call, settle, press, comrades } = fixture(t, "hang");
  await call({ task: "slow", background: true });
  let ended = false;
  const waiting = settle().then(() => {
    ended = true;
  });
  await new Promise((wake) => setTimeout(wake, 30));
  press("\x1b[27;1:3u"); // kitty: Esc released
  await new Promise((wake) => setTimeout(wake, 300));
  assert.equal(ended, false);
  press("\x1b");
  await waiting;
  assert.match(text(await comrades({})), /^#1 /);
});

test("jobs parked for a reload that nothing adopts are stopped", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { call, shutdown } = fixture(t, "hang", { sessionId: "orphaned" });
  await call({ task: "orphan", background: true });
  shutdown("reload");
  const parked = (globalThis as Record<symbol, Map<string, { done: Promise<void> }[]>>)[
    Symbol.for("comrade.parked-jobs.v1")
  ];
  const jobs = parked.get("orphaned") ?? [];
  assert.equal(jobs.length, 1);
  t.mock.timers.tick(10_000);
  assert.equal(parked.has("orphaned"), false);
  t.mock.timers.reset();
  await Promise.all(jobs.map((job) => job.done));
});

test("a provider id may contain a slash", async (t) => {
  const { call } = fixture(t, "echo");
  const { args } = JSON.parse(answer(await call({ task: "✓", model: "corp/proxy/big-model" })));
  assert.deepEqual(args.slice(4, 8), ["--provider", "corp/proxy", "--model", "big-model"]);
});

/** A finished row, as Pi draws it after the call returns. */
const row = (tool: Tool, result: Result, task: string, expanded = false) =>
  render(
    tool.renderResult?.(
      result,
      { expanded, isPartial: false },
      themes.theme,
      fake<RenderContext>({
        args: { task },
        state: {},
        toolCallId: "call",
        isPartial: false,
        expanded,
        isError: Boolean(result.isError),
        durationMs: 1000,
        invalidate() {},
      }),
    ),
  );

test("files follow the task as <file> blocks, as Pi's @file arguments build them", async (t) => {
  const { call, cwd } = fixture(t, "echo");
  writeFileSync(join(cwd, "notes.md"), "\uFEFFnotes");
  writeFileSync(join(cwd, "empty.md"), "");
  // A PNG's signature and header: enough for Pi to tell an image.
  const png = "89504e470d0a1a0a0000000d494844520000000100000001080600000000000000";
  writeFileSync(join(cwd, "pixel.png"), Buffer.from(png, "hex"));
  // The same file twice, one named from the home directory, an empty one, and an image.
  const fromHome = standIn.startsWith(`${homedir()}/`)
    ? `~${standIn.slice(homedir().length)}`
    : standIn;
  const files = ["notes.md", fromHome, "./notes.md", "empty.md", "pixel.png"];
  const result = await call({ task: "✓", tools: [], files });
  const { args, task, images } = JSON.parse(answer(result));
  assert.deepEqual(args.slice(-2), ["--no-tools", "--approve"], "RPC mode takes no @file");
  // Text inline without its byte-order mark, the empty file skipped, the image attached.
  assert(
    task.startsWith(`✓\n\n<file name="${join(cwd, "notes.md")}">\nnotes\n</file>\n`),
    task.slice(0, 200),
  );
  assert.deepEqual(
    [...task.matchAll(/<file name="([^"]+)">/g)].map((match) => match[1]),
    [join(cwd, "notes.md"), standIn, join(cwd, "pixel.png")],
  );
  assert(task.endsWith(`<file name="${join(cwd, "pixel.png")}"></file>`));
  assert.deepEqual(images, ["image/png"]);
  assert.equal(details(result).files, 4);
  assert.match(row(tool(t), result, "✓", true), /\n\n {2}│ ✓\n {2}4 files attached\n\n/);
});

/** A tool to render with: rendering does not depend on the scenario. */
const tool = (t: TestContext) => fixture(t, "echo").tool;

test("missing files, directories and bad output paths are rejected before anything starts", async (t) => {
  const { call, cwd } = fixture(t, "echo", { command: "/nonexistent/pi" });
  mkdirSync(join(cwd, "folder"));
  const cases: [Record<string, unknown>, RegExp][] = [
    [
      { task: "x", files: ["missing.md"] },
      /^Error: File "missing\.md" for comrade does not exist: .*\/missing\.md\.$/,
    ],
    [
      { task: "x", files: ["folder"] },
      /^Error: "folder" is not a file\. Pass comrade files, not directories\.$/,
    ],
    [
      { task: "x", output: "folder" },
      /^Error: comrade's output "folder" is a directory\. Pass a file path\.$/,
    ],
    [{ task: "x", output: " " }, /^Error: comrade's output needs a file path\.$/],
  ];
  for (const [params, error] of cases) await assert.rejects(call(params), error);
});

test("a run line ends the result for the calling model, and the row does not repeat it", async (t) => {
  const { tool, call } = fixture(t, "busy");
  const result = await call({ task: "✓" });
  assert.match(
    text(result),
    /\n\n\[comrade #1: anthropic\/claude-opus-5-5:xhigh · 2 turns · 11 calls · read 3 files, ran 1 search, edited 1 file \(\+2 −1\), wrote 1 file \(\+2\), ran 4 commands · ↑300 ↓20 · \$0\.02 · \d+\.\ds · stop\]$/,
  );
  const shown = row(tool, result, "✓", true);
  assert.match(shown, /\n\n {2}Done\.$/);
  assert.doesNotMatch(shown, /turn|calls|↑/);
  // Failures that ran end with it too.
  const failed = await fixture(t, "error").call({ task: "✓" });
  assert.match(text(failed), /^Comrade failed: 529 overloaded\n\n\[comrade #1: .* · error\]$/);
});

test("an answer cut off at the output limit says so first, and is not an error", async (t) => {
  const { tool, call } = fixture(t, "length");
  const result = await call({ task: "✓" });
  assert.equal(result.isError, undefined);
  assert.match(
    text(result),
    /^\[Comrade's answer is cut off: its last turn ended with stopReason "length", the model's output token limit\. It is not a final answer\.\]\n\nThe first half of an\n\n\[comrade #1: .* · length\]$/,
  );
  assert.equal(details(result).stopReason, "length");
  assert.equal(
    row(tool, result, "✓"),
    "! Comrade #1  ✓  cut off · $0.01 · 1.0s ▸\n  Reached its output token limit. The answer is partial.",
  );
  assert.match(row(tool, result, "✓", true), /\n\n {2}│ ✓\n\n {2}The first half of an$/);
});

test("output writes the whole answer to its file and returns the first lines and the path", async (t) => {
  const long = fixture(t, "long");
  const result = await long.call({ task: "x", output: "out/answer.md" });
  const file = join(long.cwd, "out", "answer.md");
  assert.equal(
    readFileSync(file, "utf8"),
    Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n"),
  );
  assert.match(
    answer(result),
    /^Answer written to .*\/out\/answer\.md \(3000 lines, [^)]+\)\. First 20 lines:\n\nline 1\n[\s\S]*\nline 20$/,
  );
  assert.equal(details(result).answer, file, "the row names the file; nothing is saved elsewhere");

  const short = fixture(t, "echo");
  const echoed = await short.call({ task: "✓", output: `${short.cwd}/a.md` });
  const written = readFileSync(join(short.cwd, "a.md"), "utf8");
  assert.equal(JSON.parse(written).task, "✓");
  // A short answer is returned whole after the path.
  assert(answer(echoed).startsWith(`Answer written to ${join(short.cwd, "a.md")} (1 line, `));
  assert(answer(echoed).endsWith(`):\n\n${written}`));
});

test("a comrade past its timeout is stopped, and its last text is marked as not final", async (t) => {
  const slow = fixture(t, "slow");
  const started = Date.now();
  const result = await slow.call({ task: "x", timeout: 1 });
  assert(Date.now() - started < 4000, "stopped by SIGTERM, not the SIGKILL fallback");
  assert.equal(result.isError, true);
  assert.match(
    text(result),
    /^\[Comrade timed out after 1\.0s and was stopped\. Its last text follows\. It is not a final answer\.\]\n\nNotes so far\.\n\n\[comrade #1: .* · timed out\]$/,
  );
  assert.equal(details(result).timedOut, true);
  assert.equal(details(result).stopped, undefined, "a timeout is not an Esc");
  assert.equal(
    row(slow.tool, result, "x"),
    "✗ Comrade #1  x  timed out · $0.01 · 1.0s ▸\n  Stopped at its 1.0s limit. Its last text is kept.",
  );
  // What it said, and the call it was stopped in.
  assert.match(
    row(slow.tool, result, "x", true),
    /\n\n {2}Notes so far\.\n\n {2}✗ Read \/tmp\/forever\.md$/,
  );

  const silent = await fixture(t, "hang").call({ task: "x", timeout: 1 });
  assert.match(text(silent), /^Comrade timed out after 1\.0s and was stopped\.\n\n\[comrade #1: /);
});

test("a background comrade past its timeout is delivered as failed", async (t) => {
  const { call, delivered } = fixture(t, "slow");
  await call({ task: "x", background: true, timeout: 1 });
  const [message] = await delivered(1);
  assert.deepEqual(message[1], { deliverAs: "followUp", triggerTurn: true });
  assert.equal(delivery(message).status, "failed");
  assert.equal(delivery(message).timedOut, true);
  assert.match(body(message), /^\[comrade #1 failed\] x\n\n\[Comrade timed out after 1\.0s/);
});

/** A running row's progress line, with its clocks as `Ns`. */
const progressOf = (tool: Tool, update: Result) =>
  render(
    tool.renderResult?.(
      update,
      { expanded: false, isPartial: true },
      themes.theme,
      fake<RenderContext>({
        args: { task: "x" },
        state: {},
        toolCallId: "call",
        isPartial: true,
        expanded: false,
        isError: false,
        invalidate() {},
      }),
    ),
  )
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .join(" | ")
    .replace(/\b\d+s\b/g, "Ns");

test("the progress line says what the comrade is doing, from its event stream", async (t) => {
  const { tool, call, updates } = fixture(t, "stream");
  // Drawn as each update arrives, as Pi draws it.
  const lines: string[] = [];
  const result = await call({ task: "x" }, undefined, () => {
    const update = updates.at(-1);
    if (update) lines.push(progressOf(tool, update).replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, "⠋"));
  });
  assert.equal(answer(result), "Done.");
  const shown = lines.filter((line, index) => line !== lines[index - 1]);
  // Two lines under the header: the call it runs, or what it waits on, or the last call it ran;
  // then the last complete thing it said, or until it has said anything, its tokens so far.
  assert.deepEqual(shown, [
    "starting | ",
    "waiting | ",
    "retrying · 1/3 · 529 overloaded | ",
    "waiting | ",
    "retrying | ",
    "waiting | ",
    "compacting its context | ",
    "waiting | ",
    // Like Anthropic, the provider counted the input at the start, and no output yet.
    "thinking | ↑1.0k",
    // Streamed text is reported at most every 250ms, so the deltas arrive as one update, and
    // their tokens are estimated, marked `~`. Its thinking has no complete sentence to show.
    "thinking | ↑1.0k ↓~2.0k",
    "calling read | ↑1.0k ↓~2.0k",
    "calling read | ↑1.0k ↓~2.1k",
    // The turn's message has ended, asking for the call: its usage is exact now.
    "calling read | ↑150 ↓10",
    "⠋ Reading /tmp/a.ts | ↑150 ↓10",
    "✓ Read /tmp/a.ts | ↑150 ↓10",
    // A wait after the first turn says how long it has lasted.
    "waiting Ns | ↑150 ↓10",
    "writing | ↑150 ↓10",
    // Like Google, the provider counts as it goes: once its count has moved, it is shown.
    "writing | ↑250 ↓~11",
    "writing | ↑250 ↓14",
    // Its reply, once whole, is what it said last; above it, the last call it ran.
    "✓ Read /tmp/a.ts | Done.",
  ]);
  assert.equal(details(result).activity, undefined, "a finished row keeps no activity");
});

test("a running comrade's clock ticks in whole seconds beside its cost", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const { tool, call } = fixture(t, "echo");
  const result = await call({ task: "x" });
  const running = {
    ...result,
    details: { ...details(result), started: 0, activity: { state: "waiting", since: 0 } },
  };
  const draw = () =>
    render(
      tool.renderResult?.(
        running,
        { expanded: false, isPartial: true },
        themes.theme,
        fake<RenderContext>({
          args: { task: "x" },
          state: {},
          toolCallId: "clock",
          isPartial: true,
          expanded: false,
          isError: false,
          invalidate() {},
        }),
      ),
    );
  assert.equal(draw(), "⠋ Comrade #1  x  $0.02 · 0s ▸\n  waiting 0s\n  ↑300 ↓20");
  t.mock.timers.tick(12_500);
  assert.match(draw(), / {2}\$0\.02 · 12s ▸\n {2}waiting 12s\n/);
  t.mock.timers.tick(62_500);
  assert.match(draw(), / {2}\$0\.02 · 1m 15s ▸\n/);
});

test("to: N continues a comrade's conversation, with its own model, thinking and tools", async (t) => {
  const { tool, call, remember, cwd } = fixture(t, "echo");
  const first = await call({
    task: "Read the parser",
    model: "anthropic/claude-fable-5-1",
    thinking: "low",
    tools: [],
  });
  remember(first);
  const conversation = join(cwd, "parent.comrades", "comrade-1.jsonl");
  assert.equal(details(first).session, conversation);

  const second = await call({ task: "Now the lexer", to: 1 });
  remember(second);
  const echoed = JSON.parse(answer(second));
  assert.equal(echoed.task, "Now the lexer", "only the new message is sent");
  assert.deepEqual(echoed.history, ["Read the parser"], "the comrade still has its brief");
  assert.deepEqual(echoed.args.slice(2, 11), [
    "--session",
    conversation,
    "--provider",
    "anthropic",
    "--model",
    "claude-fable-5-1",
    "--thinking",
    "low",
    "--no-tools",
  ]);
  assert.equal(details(second).id, 1);
  assert.equal(details(second).followUp, true);
  assert.match(text(second), /\n\n\[comrade #1: anthropic\/claude-fable-5-1:low · /);
  // It keeps its title, and says what it ran with that is not the caller's.
  assert.equal(details(second).title, "Read the parser");
  assert.match(
    row(tool, second, "Now the lexer"),
    /^✓ Comrade #1 {2}Read the parser {2}claude-fable-5-1:low {2}\$/,
  );
  // Opened, the follow-up's task and what it did then, not its earlier runs.
  assert.match(
    row(tool, second, "Now the lexer", true),
    /▾\n\n {2}│ Now the lexer\n\n {2}✓ Read \/tmp\/notes\.md\n\n {2}\{"args"/,
  );

  // Settings passed with the follow-up still win, and the conversation keeps growing.
  const thirdResult = await call({ task: "And the tests", to: 1, thinking: "high" });
  remember(thirdResult);
  const third = JSON.parse(answer(thirdResult));
  assert.deepEqual(third.history, ["Read the parser", "Now the lexer"]);
  assert.equal(third.args[third.args.indexOf("--thinking") + 1], "high");
  // They also apply to its later follow-ups.
  const fourth = JSON.parse(answer(await call({ task: "Summarise", to: 1 })));
  assert.equal(fourth.args[fourth.args.indexOf("--thinking") + 1], "high");

  // A new comrade has the next number and a conversation of its own.
  const fresh = await call({ task: "Unrelated" });
  assert.equal(details(fresh).id, 2);
  assert.deepEqual(JSON.parse(answer(fresh)).history, []);
  assert.equal(details(fresh).session, join(cwd, "parent.comrades", "comrade-2.jsonl"));
});

test("a follow-up needs a comrade on this branch that kept its conversation", async (t) => {
  const missing = "/nonexistent/comrade-8.jsonl";
  const entries = [
    started(7, "Ran before conversations were kept"),
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "comrade",
        details: { id: 8, session: missing, requested: { provider: "anthropic", model: "x" } },
      },
    },
  ] as unknown as SessionEntry[];
  const { call, comrades } = fixture(t, "hang", { entries });
  await assert.rejects(call({ task: "x", to: 5 }), /^Error: No comrade #5 on this branch/);
  await assert.rejects(
    call({ task: "x", to: 7 }),
    /^Error: Comrade #7 cannot continue: it ran before comrades kept their conversations\./,
  );
  await assert.rejects(
    call({ task: "x", to: 8 }),
    /^Error: Comrade #8 cannot continue: its conversation was never saved, or was deleted \(\/nonexistent\/comrade-8\.jsonl\)\./,
  );
  const running = await call({ task: "slow", background: true });
  assert.equal(details(running).id, 9, "numbered past every comrade the session has seen");
  await comrades({ stop: [9] });
});

test("a comrade continued in the background delivers each answer as #N", async (t) => {
  const { call, remember, delivered } = fixture(t, "echo");
  remember(await call({ task: "first", background: true }));
  await delivered(1);
  const again = await call({ task: "second", to: 1, background: true });
  assert.equal(details(again).id, 1);
  assert.equal(details(again).background, true);
  const [, message] = await delivered(2);
  assert.equal(delivery(message).status, "finished");
  assert.equal(delivery(message).followUp, true);
  const [head, json] = body(message).split("\n\n");
  // Named by the comrade's title, which its follow-up kept.
  assert.equal(head, "[comrade #1 finished] first");
  assert.deepEqual(JSON.parse(json).history, ["first"]);
});

test("only background runs that never answered are reported lost, run by run", (t) => {
  const background = (id: number, task: string) => ({
    type: "message",
    message: {
      role: "toolResult",
      toolName: "comrade",
      details: { id, task, background: true, session: "/tmp/x.jsonl" },
    },
  });
  const answered = (id: number) => ({
    type: "custom_message",
    customType: "comrade",
    details: { id },
  });
  const foreground = {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "comrade",
      details: { id: 4, session: "/tmp/y.jsonl", requested: { provider: "a", model: "b" } },
    },
  };
  const lost = (entries: object[]) =>
    fixture(t, "echo", { entries: entries as SessionEntry[] }).sent.map(body);
  assert.deepEqual(lost([foreground, background(3, "first"), answered(3)]), []);
  assert.deepEqual(lost([background(3, "first"), answered(3), background(3, "again")]), [
    "[comrade #3 lost] again\n\nPi exited or switched sessions while this comrade ran, so its answer will not arrive.",
  ]);
});

test("conversations are kept beside the caller's session, or in tmp without one", async (t) => {
  const { call, cwd } = fixture(t, "echo");
  // A number whose file exists is skipped, so no comrade continues another's conversation.
  mkdirSync(join(cwd, "parent.comrades"));
  writeFileSync(join(cwd, "parent.comrades", "comrade-1.jsonl"), "");
  const result = await call({ task: "✓" });
  assert.equal(details(result).id, 2);

  const sessionId = `no-parent-${process.pid}-${Date.now()}`;
  const dir = join(tmpdir(), "pi-comrades", sessionId);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const unsaved = await fixture(t, "echo", { parent: null, sessionId }).call({ task: "✓" });
  assert.equal(details(unsaved).session, join(dir, "comrade-1.jsonl"));
});

test("the comrades listing says what each background comrade is doing", async (t) => {
  const { call, comrades, slash, notices } = fixture(t, "hang");
  await call({ task: "slow", background: true });
  assert.match(
    text(await comrades({})),
    /^#1 · slow · anthropic\/claude-opus-5-5:xhigh · turn 1 · starting · /,
  );
  // The hang scenario starts a read and never finishes it.
  for (let i = 0; i < 50 && !text(await comrades({})).includes("Reading"); i++)
    await new Promise((wake) => setTimeout(wake, 20));
  assert.match(
    text(await comrades({})),
    /^#1 · slow · [^·]+ · turn 1 · Reading \/tmp\/forever\.md · /,
  );
  await slash("");
  assert.match(notices.at(-1) ?? "", /^#1 · slow · [^·]+ · turn 1 · Reading \/tmp\/forever\.md · /);
  await comrades({ stop: [1] });
});

test("a message to a running comrade reaches it, and its answer comes as it would have", async (t) => {
  const { tool, call, delivered, sent } = fixture(t, "steer");
  // Foreground: sent at once, before its Pi has even started, and held until it has.
  const running = call({ task: "Survey the parser" });
  const told = await call({ task: "Only the lexer", to: 1 }, undefined, undefined, "tell");
  assert.equal(
    text(told),
    "Sent to comrade #1. It reads your message once its current tool calls finish, before its next model request. Its answer returns from the call that started it.",
  );
  assert.deepEqual(told.details, { id: 1, steered: true, title: "Survey the parser" });
  // Its row names the comrade by its title, and the message, sent.
  assert.equal(
    row(tool, told, "Only the lexer"),
    '→ Comrade #1  Survey the parser  "Only the lexer"  sent ▸',
  );
  assert.match(row(tool, told, "Only the lexer", true), /sent ▾\n\n {2}│ Only the lexer$/);
  // Asked to cover its task and the message in its answer, which may be all that comes back.
  assert.equal(answer(await running), `Heard: ${steering("Only the lexer")}`);

  // Background: its answer arrives as its message.
  await call({ task: "Survey the tests", background: true });
  const later = await call({ task: "Only the slow ones", to: 2 });
  assert.match(text(later), /Its answer will arrive as a \[comrade #2 …\] message, as before\.$/);
  const [message] = await delivered(1);
  assert.match(
    body(message),
    /^\[comrade #2 finished\] Survey the tests\n\nHeard: \[A message from the agent that started you, .*\]\n\nOnly the slow ones\n\n/,
  );
  assert.equal(sent.length, 1);
});

test("a message to a running comrade carries only its task, and needs a comrade still running", async (t) => {
  const { call, comrades } = fixture(t, "hang");
  await call({ task: "slow", background: true });
  await assert.rejects(
    call({ task: "x", to: 1, model: "anthropic/claude-fable-5-1", tools: [] }),
    /^Error: Comrade #1 is running, so a message to it can carry only task\. Wait for its answer to change its model, tools\.$/,
  );
  await assert.rejects(call({ task: " ", to: 1 }), /needs a task/);
  await comrades({ stop: [1] });
});

test("a message the comrade had not read when it answered is taken before it settles", async (t) => {
  // Pi takes what is still queued before the run settles.
  const { call } = fixture(t, "deaf");
  const running = call({ task: "Survey the parser" });
  await call({ task: "Then the lexer", to: 1 });
  const result = await running;
  assert.equal(answer(result), `Heard late: ${steering("Then the lexer")}`);
  assert.equal(details(result).turns, 2);
});

test("a message on its way as the comrade settles starts a run of its own", async (t) => {
  const { call } = fixture(t, "late");
  const running = call({ task: "Survey the parser" });
  await call({ task: "Then the lexer", to: 1 });
  const result = await running;
  const echoed = JSON.parse(answer(result));
  assert.equal(echoed.task, steering("Then the lexer"));
  assert.deepEqual(echoed.history, ["Survey the parser"]);
  assert.equal(details(result).turns, 2);
});

test("a message an extension in the comrade takes instead is not reported as sent", async (t) => {
  const { call, comrades } = fixture(t, "ignored");
  await call({ task: "Survey the parser", background: true });
  await assert.rejects(
    call({ task: "Then the lexer", to: 1 }),
    /^Error: Comrade #1 did not take your message: an extension in its Pi took it instead\.$/,
  );
  await comrades({ stop: [1] });
});

test("Esc ends the wait for a message to be taken, not the comrade", async (t) => {
  const { call, comrades } = fixture(t, "hang");
  await call({ task: "slow", background: true });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    call({ task: "x", to: 1 }, controller.signal),
    /^Error: Stopped waiting for comrade #1 to take your message\. It may still reach it\.$/,
  );
  assert.match(text(await comrades({})), /^#1 /);
  await comrades({ stop: [1] });
});

test("a run that fails before it starts still ends, with why", async (t) => {
  const result = await fixture(t, "unstarted").call({ task: "✓" });
  assert.equal(answer(result), "Comrade failed: No model selected");
});

test("once a comrade has answered, its answer stands while its Pi shuts down", async (t) => {
  const began = Date.now();
  const result = await fixture(t, "slowexit").call({ task: "✓", timeout: 1 });
  assert.equal(result.isError, undefined);
  assert.equal(answer(result), "All done.");
  assert(Date.now() - began >= 1400, "it waited for Pi to exit, past the timeout");
});

test("an extension's dialog in a comrade is cancelled, as no one can answer it", async (t) => {
  const result = await fixture(t, "dialog").call({ task: "✓" });
  assert.deepEqual(JSON.parse(answer(result)), {
    type: "extension_ui_response",
    id: "ask-1",
    cancelled: true,
  });
});

test("comrades are numbered across branches, but continued only on the current one", async (t) => {
  const elsewhere = {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "comrade",
      details: { id: 5, session: "/tmp/x.jsonl", requested: { provider: "a", model: "b" } },
    },
  } as unknown as SessionEntry;
  const { call } = fixture(t, "echo", { entries: [elsewhere], branch: [] });
  await assert.rejects(call({ task: "x", to: 5 }), /^Error: No comrade #5 on this branch/);
  assert.equal(details(await call({ task: "✓" })).id, 6);
});

test("only the latest background run of a comrade shows live progress", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const { tool, call, remember, delivered, comrades } = fixture(t, "echo");
  const first = await call(
    { task: "#scenario echo\nfirst", background: true },
    undefined,
    undefined,
    "a",
  );
  remember(first);
  await delivered(1);
  const second = await call(
    { task: "#scenario hang\nsecond", to: 1, background: true },
    undefined,
    undefined,
    "b",
  );
  const startRow = (result: Result, toolCallId: string) =>
    render(
      tool.renderResult?.(
        result,
        { expanded: false, isPartial: false },
        themes.theme,
        fake<RenderContext>({
          args: { task: toolCallId },
          state: {},
          toolCallId,
          isPartial: false,
          expanded: false,
          isError: false,
          invalidate() {},
        }),
      ),
    );
  assert.equal(startRow(first, "a"), "↗ Comrade #1  #scenario echo  background ▸");
  assert.equal(startRow(second, "b"), "⠋ Comrade #1  #scenario echo  background · 0s ▸");
  await comrades({ stop: [1] });
});

test("nothing is reported after the result, even with streamed text pending", async (t) => {
  const { call, updates } = fixture(t, "unfinished");
  const result = await call({ task: "x" });
  assert.match(text(result), /^Comrade finished without an answer\.\n\n\[comrade #1: /);
  const count = updates.length;
  await new Promise((wake) => setTimeout(wake, 400));
  assert.equal(updates.length, count);
});

test("a running job adopted from an older version shows its calls", async (t) => {
  const { tool, call } = fixture(t, "busy");
  const result = await call({ task: "x" });
  // Older versions reported no activity.
  assert.equal(details(result).activity, undefined);
  const running = { ...result, details: { ...details(result), started: Date.now() } };
  // The last call it ran, and its tokens.
  assert.equal(progressOf(tool, running).replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, "⠋"), "⠋ sleep 9 | ↑300 ↓20");
});

test("a comrade can have only the tools active here, and the default shrinks to them", async (t) => {
  const { call } = fixture(t, "echo", { inactive: ["bash", "ls"] });
  await assert.rejects(
    call({ task: "x", tools: ["read", "bash"] }),
    /^Error: Tool "bash" is not active here, so a comrade cannot have it\. Active: read, edit, write, grep, find, codemode\.$/,
  );
  await assert.rejects(call({ task: "x", tools: ["b*"] }), /Tool "b\*" is not active here/);
  const { args } = JSON.parse(answer(await call({ task: "x" })));
  assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find");
  // With nothing active, the default is no tools.
  const none = fixture(t, "echo", { inactive: toolNames });
  const bare = JSON.parse(answer(await none.call({ task: "x" })));
  assert(bare.args.includes("--no-tools"));
  await assert.rejects(none.call({ task: "x", tools: ["read"] }), /Active: none\.$/);
});

test("a comrade's number is claimed with its empty conversation file, which Pi then starts", async (t) => {
  const { call, cwd, remember } = fixture(t, "echo");
  const first = call({ task: "one" });
  const second = call({ task: "two" });
  const ids = (await Promise.all([first, second])).map((result) => details(result).id);
  assert.deepEqual(ids, [1, 2]);
  // Another Pi on the same session cannot take a claimed number: the file is already there.
  assert(existsSync(join(cwd, "parent.comrades", "comrade-2.jsonl")));
  // A claimed file nothing ever ran in is not a conversation to continue.
  const rejected = fixture(t, "echo", { command: "/nonexistent/pi" });
  const failed = await rejected.call({ task: "x" });
  assert.equal(failed.isError, true);
  rejected.remember(failed);
  await assert.rejects(
    rejected.call({ task: "x", to: 1 }),
    /cannot continue: its conversation was never saved/,
  );
  // One that ran can be.
  remember(await first);
  assert.equal(details(await call({ task: "more", to: 1 })).id, 1);
});

test("cwd runs the comrade elsewhere, trusted only inside the caller's project", async (t) => {
  const { call, cwd, remember, tool } = fixture(t, "echo");
  mkdirSync(join(cwd, "packages", "a"), { recursive: true });
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "comrade-elsewhere-")));
  t.after(() => rmSync(elsewhere, { recursive: true, force: true }));

  const inside = await call({ task: "x", cwd: "packages/a" });
  const ran = JSON.parse(answer(inside));
  assert.equal(ran.cwd, join(cwd, "packages", "a"));
  assert(ran.args.includes("--approve"), "the caller's trust covers its own project");
  assert.equal(details(inside).cwd, join(cwd, "packages", "a"));
  // Named from the caller's directory, in its header.
  assert.match(row(tool, inside, "x"), /^✓ Comrade #1 {2}x {2}in packages\/a {2}\$/);

  const outside = await call({ task: "x", cwd: elsewhere });
  const away = JSON.parse(answer(outside));
  assert.equal(away.cwd, elsewhere);
  assert(away.args.includes("--no-approve"), "no project-local files load elsewhere");

  // A follow-up runs where the comrade ran, and the row says nothing of the caller's own cwd.
  remember(outside);
  const followUp = await call({ task: "y", to: 2 });
  assert.equal(JSON.parse(answer(followUp)).cwd, elsewhere);
  const home = await call({ task: "x" });
  assert.equal(details(home).cwd, undefined);
  assert.doesNotMatch(row(tool, home, "x", true), / in /);

  await assert.rejects(call({ task: "x", cwd: "missing" }), /cwd "missing" is not a directory/);
  await assert.rejects(call({ task: "x", cwd: "  " }), /cwd needs a directory path/);
  const file = join(cwd, "file.txt");
  writeFileSync(file, "");
  await assert.rejects(call({ task: "x", cwd: file }), /is not a directory/);
});

test("a comrade stops once its parent is gone", async (t) => {
  // A process that has exited: its pid names nothing now.
  const gone = spawnSync(process.execPath, ["-e", "0"]).pid;
  assert(gone);
  const stopped = new Promise<void>((resolve) => {
    const cancel = watchParent(gone, 5, resolve);
    t.after(cancel);
  });
  await stopped;
  // A living parent keeps it running; a missing or unusable pid is ignored.
  let stops = 0;
  const cancel = watchParent(process.pid, 5, () => stops++);
  await new Promise((wake) => setTimeout(wake, 30));
  cancel();
  assert.equal(stops, 0);
  for (const pid of [Number.NaN, 0, 1, 1.5]) watchParent(pid, 5, () => stops++);
  await new Promise((wake) => setTimeout(wake, 30));
  assert.equal(stops, 0);
});

test("comrades run this Pi's script, under a runtime of the same name on PATH once it is gone", () => {
  const script = "/pi/releases/1.5.2/dist/cli.js";
  const cellar = "/opt/homebrew/Cellar/node/26.13.0_2/bin/node";
  const present =
    (...paths: string[]) =>
    (path: string) =>
      paths.includes(path);
  assert.deepEqual(currentPi(cellar, script, present(cellar, script)), {
    command: cellar,
    args: [script],
  });
  // `brew upgrade node` deleted the running runtime.
  assert.deepEqual(currentPi(cellar, script, present(script)), { command: "node", args: [script] });
  // A compiled Pi is its own runtime; once it is gone, `pi` on PATH.
  const compiled = "/usr/local/bin/pi";
  assert.deepEqual(currentPi(compiled, "/$bunfs/root/pi", present(compiled)), {
    command: compiled,
    args: [],
  });
  assert.deepEqual(currentPi(compiled, "/$bunfs/root/pi", present()), { command: "pi", args: [] });
  assert.deepEqual(currentPi(cellar, undefined, present(cellar)), { command: "pi", args: [] });
});

test("the command that starts Pi is resolved again for each run", async (t) => {
  const commands = ["/nonexistent/node", process.execPath];
  const { call } = fixture(t, "echo", { command: () => commands.shift() ?? process.execPath });
  assert.match(answer(await call({ task: "✓" })), /^Could not start pi: .*ENOENT/);
  const second = await call({ task: "✓" });
  assert.notEqual(second.isError, true, answer(second));
});

test("a row never prints its conversation's path, nor the settings it shares with the caller", async (t) => {
  const { tool, call } = fixture(t, "busy");
  const result = await call({ task: "✓" });
  const expanded = row(tool, result, "✓", true);
  assert(!expanded.includes("comrade-1.jsonl"), expanded);
  assert(!expanded.includes("claude-opus-5-5"), "the caller's own model");
  assert(!expanded.includes("read, grep"), "the read-only default");
  assert.match(expanded, /\n\n {2}Done\.$/);
});

/** A comrade's start row as Pi saves it: the call's details, under its tool call id. */
const startRow = (result: Result, toolCallId = "call") =>
  ({
    type: "message",
    message: { role: "toolResult", toolName: "comrade", toolCallId, details: result.details },
  }) as unknown as SessionEntry;
/** A delivered message as Pi saves it. */
const saved = (message: Sent) =>
  ({
    type: "custom_message",
    customType: "comrade",
    content: message[0].content,
    display: true,
    details: message[0].details,
  }) as unknown as SessionEntry;
const until = async (ready: () => boolean) => {
  for (let i = 0; i < 500 && !ready(); i++) await new Promise((wake) => setTimeout(wake, 10));
  assert(ready(), "in time");
};
/** The comrade's run records, beside its conversation. */
const records = (result: Result) => runs.readRuns<Delivery>(details(result).session ?? "");
/** A background comrade whose Pi exited mid-call: its record, and its conversation as Pi left it. */
async function cutMidCall(t: TestContext, task = "Survey the parser") {
  const first = fixture(t, "hang");
  const started = await first.call({ task, background: true, timeout: 600 });
  await until(() => records(started)[0]?.phase === "asked");
  // Leaving the session waits for its comrades to stop, and Pi records, as each stops, the
  // aborted call and the reply it would have requested.
  await first.pi.event("session_shutdown", { reason: "quit" }, first.ctx);
  assert.match(readFileSync(details(started).session ?? "", "utf8"), /"stopReason":"aborted"/);
  return { first, started, session: details(started).session ?? "" };
}

test("a comrade's record says which Pi runs it, and goes once its answer is in the session", async (t) => {
  const { call, entries, pi, ctx } = fixture(t, "steer");
  // Foreground: recorded while it runs, gone once its call returns.
  const running = call({ task: "Survey the parser" });
  const file = join(ctx.cwd, "parent.comrades", "comrade-1.jsonl");
  await until(() => runs.readRuns(file)[0]?.phase === "asked");
  const [record] = runs.readRuns(file);
  assert.equal(record.owner, process.pid);
  assert.equal(typeof record.child, "number");
  assert.equal(record.background, false);
  await call({ task: "Only the lexer", to: 1 });
  await running;
  assert.deepEqual(runs.readRuns(file), []);

  // Background: kept with its answer until the session holds the message.
  const echo = fixture(t, "echo");
  const started = await echo.call({ task: "✓", background: true });
  const [message] = await echo.delivered(1);
  assert.equal(records(started)[0].phase, "done");
  assert.equal(
    records(started)[0].answer?.body,
    body(message).slice(body(message).indexOf("\n\n") + 2),
  );
  echo.entries.push(saved(message));
  await echo.pi.event("agent_settled", { aborted: false }, echo.ctx);
  assert.deepEqual(records(started), []);
  void entries;
  void pi;
});

test("an answer Pi exited before saving is delivered when the session next starts", async (t) => {
  // Sent, but the session never held it, as with an answer queued behind a turn Pi exited during.
  const first = fixture(t, "echo");
  const started = await first.call({ task: "✓ survey", background: true });
  const [message] = await first.delivered(1);
  first.shutdown();

  const again = fixture(t, "echo", { entries: [startRow(started)] });
  assert.equal(again.sent.length, 1, "delivered, not carried on");
  assert.equal(body(again.sent[0]), body(message));
  assert.deepEqual(again.sent[0][1], { deliverAs: "followUp", triggerTurn: false });
  assert.equal(delivery(again.sent[0]).run, "call");

  // Once the session holds it, its record goes.
  const third = fixture(t, "echo", { entries: [startRow(started), saved(message)] });
  assert.equal(third.sent.length, 0);
  assert.deepEqual(records(started), []);
});

test("an answer the session dropped from behind a turn is sent again once the agent is idle", async (t) => {
  const { call, delivered, sent, pi, ctx, entries } = fixture(t, "echo");
  await call({ task: "✓", background: true });
  const [message] = await delivered(1);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  // Esc, or Pi's dequeue key, which ends no turn: once the agent has settled, idle, a moment
  // later, the session does not hold it, so it is sent again, without starting a turn.
  await pi.event("agent_settled", { aborted: false }, ctx);
  assert.equal(sent.length, 1, "not at once: one sent as the agent settled is still on its way");
  t.mock.timers.tick(1000);
  assert.equal(sent.length, 2);
  assert.equal(body(sent[1]), body(message));
  assert.deepEqual(sent[1][1], { deliverAs: "followUp", triggerTurn: false });
  // Once the session holds it, it is not sent again.
  entries.push(saved(sent[1]));
  await pi.event("agent_settled", { aborted: true }, ctx);
  t.mock.timers.tick(1000);
  assert.equal(sent.length, 2);
});

test("an answer delivered on another branch is delivered here too, not run again", async (t) => {
  const first = fixture(t, "echo");
  const started = await first.call({ task: "✓ survey", background: true });
  const [message] = await first.delivered(1);
  first.entries.push(saved(message));
  await first.pi.event("agent_settled", { aborted: false }, first.ctx);
  // Back before the answer arrived, on a branch of its own.
  const again = fixture(t, "echo", {
    entries: [startRow(started), saved(message)],
    branch: [startRow(started)],
  });
  assert.equal(again.sent.length, 1);
  assert.equal(again.sent[0][0].content, message[0].content);
  assert.deepEqual(again.sent[0][1], { deliverAs: "followUp", triggerTurn: false });
  assert.equal(text(await again.comrades({})), "No background comrades are running.");
});

test("a background comrade Pi exited during carries on, told which calls may not have run", async (t) => {
  const { started } = await cutMidCall(t);
  const again = fixture(t, "echo", { entries: [startRow(started)] });
  const [resumed] = again.sent;
  assert.deepEqual(resumed[1], { deliverAs: "followUp", triggerTurn: false });
  assert.equal(
    body(resumed),
    "[comrade #1 resumed] Survey the parser\n\nPi exited while this comrade ran, so it carries on from where it stopped. Its answer will arrive as another [comrade #1 …] message.",
  );
  const renderer = again.renderers.get("comrade");
  assert(renderer);
  const shown = (message: Sent, expanded: boolean) =>
    render(
      renderer(
        { ...message[0], role: "custom", display: true, timestamp: 0, details: delivery(message) },
        { expanded, outputPad: 0, keyHint: () => "", keyText: () => "" },
        themes.theme,
      ),
    ).trim();
  assert.equal(shown(resumed, false), "↻ Comrade #1  Survey the parser  resumed ▸");
  assert.match(
    shown(resumed, true),
    /^↻ Comrade #1 {2}Survey the parser {2}resumed ▾\n {2}Pi exited while this comrade ran, so it carries on from where it stopped\. Its answer will arrive as another \[comrade\n {2}#1 …\] message\.$/,
  );
  const [, finished] = await again.delivered(2);
  assert.deepEqual(finished[1], { deliverAs: "followUp", triggerTurn: true });
  const [head, json] = body(finished).split("\n\n");
  assert.equal(head, "[comrade #1 finished] Survey the parser");
  const echoed = JSON.parse(json);
  assert.equal(
    echoed.task,
    "[Your previous run was cut off before it finished: the Pi that started you exited. These calls had not finished cleanly when it stopped, so each may or may not have taken effect: `Read /tmp/forever.md`. Check what they did before repeating any that change files or run commands.]\n\nCarry on with your task from where you stopped, and end with your final answer as before.",
  );
  assert.deepEqual(echoed.history, ["Survey the parser"], "the same conversation");
  assert.match(echoed.args.join(" "), /--model claude-opus-5-5 --thinking xhigh --tools read,grep/);
  assert.equal(delivery(finished).run, delivery(resumed).run);
  assert.equal(delivery(finished).resumed, true);
  // Opened, its answer shows what both runs did: the call it was cut off in, the note it was
  // sent, and what it did then.
  const both = shown(finished, true);
  assert.match(both, /\n {2}✗ Read \/tmp\/forever\.md {2}Operation aborted\n/);
  assert.match(both, /\n {2}│ \[Your previous run was cut off before it finished/);

  // Its answer is saved for a session that never held it, which delivers it.
  const later = fixture(t, "hang", { entries: [startRow(started), saved(resumed)] });
  assert.equal(body(later.sent[0]), body(finished));
  // Once it has answered here, it is done; and print mode never carries one on.
  const done = [startRow(started), saved(resumed), saved(finished)];
  assert.equal(fixture(t, "echo", { entries: done }).sent.length, 0);
  assert.equal(fixture(t, "echo", { entries: [startRow(started)], mode: "print" }).sent.length, 0);
});

test("a run whose prompt never reached the comrade is sent it again, even a resumed one", async (t) => {
  const { started, session } = await cutMidCall(t);
  // As if Pi had exited before the comrade's Pi saved its prompt.
  runs.updateRun(session, "call", { phase: "starting" });
  const again = fixture(t, "hang", { entries: [startRow(started)] });
  const [resumed] = again.sent;
  await until(() => runs.readRuns(session).some((record) => record.phase === "asked"));
  again.shutdown();
  const sentAgain = runs.readRuns(session).find((record) => record.run === delivery(resumed).run);
  assert.equal(sentAgain?.task, "Survey the parser", "its own task, again");

  // That run is cut off before its prompt reached the comrade too: its own prompt, once more.
  runs.updateRun(session, delivery(resumed).run ?? "", { phase: "starting" });
  const third = fixture(t, "echo", { entries: [startRow(started), saved(resumed)] });
  const [, finished] = await third.delivered(2);
  assert.equal(JSON.parse(body(finished).split("\n\n")[1]).task, "Survey the parser");
});

test("a run its conversation shows answered is delivered from there, without running again", async (t) => {
  const { started, session } = await cutMidCall(t);
  const [record] = runs.readRuns(session);
  // Its comrade answered, but Pi exited before the answer came back.
  const reply = {
    type: "message",
    id: "late",
    parentId: null,
    message: {
      role: "assistant",
      stopReason: "stop",
      provider: "anthropic",
      model: "claude-opus-5-5",
      content: [{ type: "text", text: "The parser is fine." }],
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { total: 0.5 },
      },
      timestamp: Date.now(),
    },
  };
  const lines = readFileSync(session, "utf8").trimEnd().split("\n");
  // Its last reply, in place of the aborted one.
  const kept = lines.filter(
    (line) => !line.includes('"aborted"') && !line.includes("Operation aborted"),
  );
  reply.parentId = JSON.parse(kept.at(-1) ?? "{}").id ?? null;
  writeFileSync(session, `${[...kept, JSON.stringify(reply)].join("\n")}\n`);
  const again = fixture(t, "hang", { entries: [startRow(started)] });
  assert.equal(again.sent.length, 1);
  assert.equal(delivery(again.sent[0]).status, "finished");
  assert.match(
    body(again.sent[0]),
    /^\[comrade #1 finished\] Survey the parser\n\nThe parser is fine\.\n\n\[comrade #1: anthropic\/claude-opus-5-5:xhigh · 2 turns · /,
  );
  assert.deepEqual(again.sent[0][1], { deliverAs: "followUp", triggerTurn: false });
  assert.equal(text(await again.comrades({})), "No background comrades are running.");
  assert.equal(record.phase, "asked");
});

test("a run cut off while Pi retried a failed request carries on", async (t) => {
  const { started, session } = await cutMidCall(t);
  const lines = readFileSync(session, "utf8").trimEnd().split("\n");
  const last = JSON.parse(lines.at(-1) ?? "{}");
  // The failed request Pi was about to retry, then the edit Pi records with it.
  last.message = {
    role: "assistant",
    stopReason: "error",
    errorMessage: "529 overloaded",
    content: [],
  };
  lines[lines.length - 1] = JSON.stringify(last);
  lines.push(JSON.stringify({ type: "context_edit", id: "edit", parentId: last.id }));
  writeFileSync(session, `${lines.join("\n")}\n`);
  const again = fixture(t, "echo", { entries: [startRow(started)] });
  const [, finished] = await again.delivered(2);
  assert.match(
    JSON.parse(body(finished).split("\n\n")[1]).task,
    /^\[Your previous run was cut off before it finished: the Pi that started you exited\. These calls had not finished cleanly .*`Read \/tmp\/forever\.md`.*\]\n\nCarry on with your task/,
  );
});

test("a run cut off more than a day ago is reported, not carried on", async (t) => {
  const { started, session } = await cutMidCall(t);
  const old = Date.now() - 25 * 3600_000;
  runs.saveRun(session, { ...runs.readRuns(session)[0], started: old });
  // Its record and its conversation last changed a day ago.
  const file = runs.runsFile(session);
  const record = JSON.parse(readFileSync(file, "utf8"));
  record[0].at = old;
  writeFileSync(file, JSON.stringify(record));
  utimesSync(session, old / 1000, old / 1000);
  const again = fixture(t, "echo", { entries: [startRow(started)] });
  assert.match(
    body(again.sent[0]),
    /^\[comrade #1 lost\] Survey the parser\n\nPi exited or switched sessions while this comrade ran, and it was not carried on: it stopped 25h 0m \d+s ago\. Its conversation is saved: continue it with to: 1\.$/,
  );
  assert.deepEqual(runs.readRuns(session), [], "reported once");
});

test("a run another Pi is running is left to it, and cannot be continued meanwhile", async (t) => {
  const { started, session } = await cutMidCall(t);
  // Another Pi, which is alive, owns it, and its comrade's Pi has not started yet.
  runs.saveRun(session, { ...runs.readRuns(session)[0], owner: process.ppid, child: undefined });
  const again = fixture(t, "echo", { entries: [startRow(started)] });
  assert.equal(again.sent.length, 0);
  assert.match(
    again.notices.at(-1) ?? "",
    /^Comrade #1 is still running in another Pi \(process \d+\)\.$/,
  );
  await assert.rejects(
    again.call({ task: "x", to: 1 }),
    /^Error: Comrade #1 is running in another Pi \(process \d+\)\. Wait for its answer there, or start a new comrade\.$/,
  );
  // Once that Pi is gone, it is this one's to carry on.
  runs.saveRun(session, { ...runs.readRuns(session)[0], owner: 2 ** 22 + 12345 });
  assert.equal(
    delivery(fixture(t, "echo", { entries: [startRow(started)] }).sent[0]).status,
    "resumed",
  );
});

test("a comrade that cannot carry on is reported, saying why and whether it can be continued", async (t) => {
  const { started } = await cutMidCall(t);
  const moved = {
    ...started,
    details: { ...(started.details as Details), cwd: "/nonexistent/dir" },
  };
  const again = fixture(t, "echo", { entries: [startRow(moved)] });
  assert.equal(
    body(again.sent[0]),
    "[comrade #1 lost] Survey the parser\n\nPi exited or switched sessions while this comrade ran, and it was not carried on: its directory /nonexistent/dir is gone. Its conversation is saved: continue it with to: 1.",
  );
});

test("a damaged record is passed over, and the other comrades still carry on", async (t) => {
  const one = await cutMidCall(t, "First");
  writeFileSync(runs.runsFile(one.session), '[{"run":"call"},');
  const two = await cutMidCall(t, "Second");
  const twoRow = startRow(
    { ...two.started, details: { ...(two.started.details as Details), id: 2 } },
    "call-2",
  );
  runs.saveRun(two.session, { ...runs.readRuns(two.session)[0], run: "call-2" });
  const again = fixture(t, "echo", { entries: [startRow(one.started), twoRow] });
  assert.deepEqual(
    again.sent.map((message) => [delivery(message).id, delivery(message).status]),
    [
      [1, "resumed"],
      [2, "resumed"],
    ],
  );
  await again.delivered(4);
});

test("a comrade continued in the foreground after Pi exited is not carried on as well", async (t) => {
  const { started } = await cutMidCall(t);
  const later = { ...(started.details as Details), background: undefined, followUp: true };
  const continued = startRow({ ...started, details: later }, "later");
  assert.equal(fixture(t, "echo", { entries: [startRow(started), continued] }).sent.length, 0);
});

/** A conversation as Pi saves it, cut off while a reply's calls ran. */
function cutOff(file: string, cwd: string) {
  const line = (entry: object) => JSON.stringify(entry);
  const call = (id: string, name: string, args: object) => ({
    type: "toolCall",
    id,
    name,
    arguments: args,
  });
  const result = (id: string, isError: boolean) => ({
    type: "message",
    id: `r-${id}`,
    parentId: id === "b" ? "a" : "r-b",
    message: { role: "toolResult", toolCallId: id, isError, content: [] },
  });
  writeFileSync(
    file,
    [
      line({ type: "session", version: 3, id: "s", cwd }),
      line({
        type: "message",
        id: "u",
        parentId: null,
        message: { role: "user", content: "go", timestamp: Date.now() },
      }),
      line({
        type: "message",
        id: "a",
        parentId: "u",
        message: {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            call("b", "read", { path: "b.ts" }),
            call("c", "bash", { command: "npm run deploy" }),
            call("d", "edit", { path: "src/a.ts" }),
          ],
        },
      }),
      // The read finished, the edit was aborted, the command never reported.
      line(result("b", false)),
      line({ ...result("d", true), parentId: "r-b" }),
      "",
    ].join("\n"),
  );
}

test("a comrade continued after a cut-off run first reads what may or may not have run", async (t) => {
  const { call, remember, cwd } = fixture(t, "echo");
  remember(await call({ task: "Deploy it" }));
  const conversation = join(cwd, "parent.comrades", "comrade-1.jsonl");
  cutOff(conversation, cwd);
  const hours = Date.now() / 1000 - 2 * 3600;
  utimesSync(conversation, hours, hours);
  const echoed = JSON.parse(answer(await call({ task: "Carry on", to: 1 })));
  assert.match(
    echoed.task,
    new RegExp(
      `^\\[Your previous run was cut off before it finished\\. These calls had not finished cleanly when it stopped, so each may or may not have taken effect: \`\\$ npm run deploy\`, \`Edit ${join(cwd, "src/a.ts").replaceAll("/", "\\/")}\`\\. Check what they did before repeating any that change files or run commands\\. That was 2h 0m \\d+s ago, so files may have changed since\\.\\]\\n\\nCarry on$`,
    ),
  );
});

test("a run is cut off when its last reply asked for tools or was aborted", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "comrade-cut-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "c.jsonl");
  const write = (...messages: object[]) =>
    writeFileSync(
      file,
      messages
        .map((message, index) =>
          JSON.stringify({
            type: "message",
            id: `${index}`,
            parentId: index ? `${index - 1}` : null,
            message,
          }),
        )
        .join("\n"),
    );
  const user = { role: "user", content: "go" };
  assert.equal(interruption(join(dir, "missing.jsonl")), undefined);
  write(user);
  assert.deepEqual(interruption(file)?.calls, [], "its task came, and no reply yet");
  write(user, { role: "assistant", stopReason: "stop", content: [] });
  assert.equal(interruption(file), undefined, "finished");
  write(user, { role: "assistant", stopReason: "length", content: [] });
  assert.equal(interruption(file), undefined, "cut off by its output limit, not by Pi");
  write(user, { role: "assistant", stopReason: "aborted", content: [] });
  assert.deepEqual(interruption(file)?.calls, [], "aborted while it wrote");
  const reply = {
    role: "assistant",
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "x", name: "ls", arguments: { path: "/tmp" } }],
  };
  write(user, reply, { role: "toolResult", toolCallId: "x", isError: false, content: [] });
  assert.deepEqual(interruption(file)?.calls, [], "between turns, with every call answered");
  write(user, reply);
  assert.deepEqual(interruption(file)?.calls, ["ls /tmp"]);
  // Pi stopped mid-call: it aborts the calls, then the reply it was about to request.
  const two = {
    ...reply,
    content: [
      { type: "toolCall", id: "r", name: "read", arguments: { path: "/etc/hosts" } },
      { type: "toolCall", id: "s", name: "bash", arguments: { command: "sleep 30" } },
    ],
  };
  const aborted = (id: string, text: string) => ({
    role: "toolResult",
    toolCallId: id,
    isError: true,
    content: [{ type: "text", text }],
  });
  const empty = { role: "assistant", stopReason: "aborted", content: [] };
  write(user, two, aborted("r", "Operation aborted"), aborted("s", "Command aborted"), empty);
  assert.deepEqual(interruption(file)?.calls, ["Read /etc/hosts", "$ sleep 30"]);
  // A call the aborted reply was still writing never ran.
  const writing = {
    ...empty,
    content: [{ type: "toolCall", id: "w", name: "bash", arguments: {} }],
  };
  write(user, reply, { role: "toolResult", toolCallId: "x", isError: false, content: [] }, writing);
  assert.deepEqual(interruption(file)?.calls, []);
  // A line cut short by a killed process is skipped.
  write(user, reply);
  writeFileSync(file, `${readFileSync(file, "utf8")}\n{"type":"mess`);
  assert.deepEqual(interruption(file)?.calls, ["ls /tmp"]);

  // A failed request Pi was retrying, and the entries Pi writes beside messages.
  write(
    user,
    reply,
    { role: "toolResult", toolCallId: "x", isError: false, content: [] },
    {
      role: "assistant",
      stopReason: "error",
      content: [],
    },
  );
  writeFileSync(
    file,
    `${readFileSync(file, "utf8")}\n${JSON.stringify({ type: "context_edit", id: "e", parentId: "3" })}\n${JSON.stringify({ type: "message", id: "c", parentId: "e", message: { role: "custom", content: "x" } })}`,
  );
  assert.deepEqual(interruption(file)?.calls, [], "cut off while Pi retried");

  // A run that finished: its answer, from the messages since it started.
  write(
    { ...user, timestamp: 1000 },
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "old" }] },
    { ...user, timestamp: 5000 },
    {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "y", name: "read", arguments: {} }],
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: { total: 0.1 },
      },
    },
    { role: "toolResult", toolCallId: "y", isError: false, content: [] },
    {
      role: "assistant",
      stopReason: "stop",
      provider: "p",
      model: "m",
      content: [{ type: "text", text: "new" }],
      usage: {
        input: 4,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 9,
        cost: { total: 0.2 },
      },
    },
  );
  const done = finished(file, 4000);
  assert.equal(done?.text, "new");
  assert.equal(done?.turns, 2);
  assert.equal(done?.calls, 1);
  assert.equal(done?.usage.output, 7);
  assert.equal(done?.model, "p/m");
  assert.equal(finished(file, 9000), undefined, "nothing asked since");

  assert.equal(interruptionNote(undefined), "[Your previous run was cut off before it finished.]");
  assert.equal(
    interruptionNote({ calls: ["$ make"], saved: 0 }, "it was stopped", 60_000),
    "[Your previous run was cut off before it finished: it was stopped. These calls had not finished cleanly when it stopped, so each may or may not have taken effect: `$ make`. Check what they did before repeating any that change files or run commands.]",
  );
});

const view = await load<typeof import("../view.ts")>("../view.ts", import.meta.url);
const { lastSaid } = await load<typeof import("../run.ts")>("../run.ts", import.meta.url);
const { cleanTitle } = await load<typeof import("../request.ts")>("../request.ts", import.meta.url);

test("a background comrade has a line in the widget above the editor until its answer is in", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const { call, widgets, delivered, entries, pi, ctx, settle, working, comrades } = fixture(
    t,
    "echo",
  );
  const result = await call({
    task: "#scenario hang\nSurvey",
    title: "Survey the parser",
    background: true,
  });
  const factory = widgets.at(-1);
  assert(factory, "set when a background comrade starts");
  let requested = 0;
  const widget = factory({ requestRender: () => requested++ }, themes.theme);
  const first = render(widget, 80);
  // One column in, as Pi's own lines are.
  assert.match(first, /^ • #1 {2}Survey the parser {2}starting {2,}\$0\.00 · 0s$/);
  assert.equal(tui.visibleWidth(first), 79, "its cost and clock at the right");
  // Its clock ticks once a second.
  t.mock.timers.tick(1000);
  assert.equal(requested, 1);
  assert.match(render(widget, 80), / {2}\$0\.00 · 1s$/);
  // Narrow, what it is doing goes first, then the title shrinks; the clock stays.
  assert.match(render(widget, 50), /^ • #1 {2}Survey the parser {2,}\$0\.00 · 1s$/);
  assert.match(render(widget, 30), /^ • #1 {2}Survey th… {2}\$0\.00 · 1s$/);
  // Narrower, the title goes, then the cost; the clock stays.
  assert.match(render(widget, 20), /^ • #1 {2,}\$0\.00 · 1s$/);
  assert.match(render(widget, 12), /^ • #1 {2,}1s$/);
  for (const width of [80, 50, 30, 20, 12])
    assert(tui.visibleWidth(render(widget, width)) < width, `fits ${width} columns`);
  // A turn waiting for it says which, the widget listing them all.
  void settle();
  await new Promise((wake) => setImmediate(wake));
  assert.equal(working.find(Boolean), "Waiting for comrade #1");
  t.mock.timers.reset();
  await comrades({ stop: [1] });
  assert.equal(widgets.at(-1), undefined, "gone once none runs");

  // A finished one stays, its answer queued, until the session holds it.
  const finished = fixture(t, "echo");
  await finished.call({ task: "Quick", background: true });
  const [message] = await finished.delivered(1);
  const line = finished.widgets.at(-1)?.({ requestRender() {} }, themes.theme);
  assert.match(render(line, 80), /^ ✓ #1 {2}Quick {2}finished · answer queued {2,}\$0\.02 · \d+s$/);
  finished.entries.push(saved(message));
  await finished.pi.event("agent_settled", { aborted: false }, finished.ctx);
  assert.equal(finished.widgets.at(-1), undefined);
  void result;
  void delivered;
  void entries;
  void pi;
  void ctx;
});

test("no widget where no one could see it", async (t) => {
  const { call, widgets, delivered } = fixture(t, "echo", { mode: "rpc" });
  await call({ task: "✓", background: true });
  await delivered(1);
  assert.deepEqual(widgets, []);
});

test("a delivered answer's row shows the task its start row was given, and opens on a click", async (t) => {
  const { call, delivered, renderers, entries } = fixture(t, "echo");
  const task = Array.from({ length: 9 }, (_, i) => `step ${i + 1}`).join("\n");
  const result = await call({ task, title: "Many steps", background: true });
  const [message] = await delivered(1);
  entries.push(
    fake<SessionEntry>({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call", name: "comrade", arguments: { task } }],
      },
    } as never),
    startRow(result),
  );
  const renderer = renderers.get("comrade");
  assert(renderer);
  const component = renderer(
    { ...message[0], role: "custom", display: true, timestamp: 0, details: delivery(message) },
    { expanded: false, outputPad: 0, keyHint: () => "", keyText: () => "" },
    themes.theme,
  );
  assert(component?.handleMouse);
  assert.match(render(component), /^✓ Comrade #1 {2}Many steps {2}\$0\.02 · [\d.]+s ▸$/);
  component.handleMouse({ type: "click", button: "left", x: 0, y: 0 } as never);
  const opened = render(component).split("\n");
  assert.match(opened[0], /▾$/);
  // Its first six lines, then a toggle for the rest.
  const toggle = opened.indexOf("  … 3 more lines ▸");
  assert.deepEqual(opened.slice(toggle - 6, toggle), [
    "  │ step 1",
    "  │ step 2",
    "  │ step 3",
    "  │ step 4",
    "  │ step 5",
    "  │ step 6",
  ]);
  component.handleMouse({ type: "click", button: "left", x: 2, y: toggle } as never);
  assert.match(render(component), /│ step 9\n {2}show fewer lines ▴/);
});

test("a running row says the call it runs and the last complete thing its comrade said", () => {
  const theme = themes.theme;
  const card = {
    title: "Review parser error paths",
    model: "anthropic/claude-opus-5-5",
    thinking: "xhigh",
    tools: ["read"],
    turns: 3,
    calls: 7,
    usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.12 } },
    activity: { state: "thinking" as const, since: 0, turn: 4 },
    said: "parseList swallows the error that parseBlock rethrows.",
    work: {
      tallies: [{ kind: "read" as const, calls: 7, failed: 0, files: 5, added: 0, removed: 0 }],
      rows: [],
      omitted: 0,
      recent: [
        { kind: "read" as const, status: "success" as const, label: "Read /src/a.ts" },
        {
          kind: "command" as const,
          status: "error" as const,
          label: "$ npm test",
          error: "exit code 1",
        },
        { kind: "read" as const, status: "running" as const, label: "Reading /src/b.ts" },
      ],
    },
  };
  const look = {
    phase: "running" as const,
    task: "Review it",
    expanded: false,
    id: 3,
    spinner: "⠋",
    durationMs: 61_000,
  };
  assert.equal(
    render(new view.CardView(look, card, "", theme, 1, { row() {} })),
    [
      " ⠋ Comrade #3  Review parser error paths  $0.12 · 1m 1s ▸",
      "   ⠋ Reading /src/b.ts",
      "   parseList swallows the error that parseBlock rethrows.",
    ].join("\n"),
  );
  // What it thought shows only where Pi shows thinking. Elsewhere, what it last wrote, or with
  // nothing written yet, its tokens.
  const thought = { ...card, saidThinking: true };
  assert.match(
    render(new view.CardView(look, thought, "", theme, 1)),
    /\n {3}⠋ Reading \/src\/b\.ts\n {3}↑1\.0k ↓100$/,
  );
  assert.match(
    render(new view.CardView(look, { ...thought, spoke: "The parser is next." }, "", theme, 1)),
    /\n {3}The parser is next\.$/,
  );
  assert.match(
    render(new view.CardView({ ...look, thinking: true }, thought, "", theme, 1)),
    /\n {3}parseList swallows the error that parseBlock rethrows\.$/,
  );
  // Between calls, what it waits on, over what it said, kept from an earlier turn, dimmer.
  const ended = {
    ...card,
    saidBefore: true,
    work: { ...card.work, recent: card.work.recent.slice(0, 2) },
  };
  const waiting = {
    ...ended,
    activity: { state: "waiting" as const, since: Date.now() - 61_500, turn: 5 },
  };
  const lines = new view.CardView(look, waiting, "", theme, 1).render(120);
  assert.deepEqual(lines.slice(1).map(tui.stripTerminalSequences), [
    "   waiting 1m 1s",
    "   parseList swallows the error that parseBlock rethrows.",
  ]);
  const fresh = new view.CardView(look, { ...waiting, saidBefore: false }, "", theme, 1);
  assert.notEqual(fresh.render(120)[2], lines[2], "a sentence from this turn is brighter");
  // A retry, in the warning colour, in place of what it waits on.
  const retrying = {
    ...ended,
    activity: { state: "retrying" as const, since: 0, detail: "1/3 · 529" },
  };
  assert.match(
    render(new view.CardView(look, retrying, "", theme, 0)),
    /\n {2}retrying · 1\/3 · 529\n {2}parseList/,
  );
  // While the words it is writing show below, the line above names the last call, not "writing".
  const writing = {
    ...ended,
    saidBefore: false,
    activity: { state: "writing" as const, since: 0, turn: 5 },
  };
  assert.match(
    render(new view.CardView(look, writing, "", theme, 0)),
    /\n {2}\$ npm test {2}exit code 1\n/,
  );
});

test("a running row shows the newest of what it said when not all of it fits", () => {
  assert.equal(view.fitted("I read it. Now the lexer.", 40), "I read it. Now the lexer.");
  assert.equal(
    view.fitted("I read the parser. Next the lexer, then the tests.", 34),
    "Next the lexer, then the tests.",
  );
  assert.equal(
    tui.stripTerminalSequences(view.fitted("One very long sentence about the parser.", 20)),
    "One very long sente…",
  );
});

test("an open row shows its task, then its work in order, mirage's rows among it", () => {
  const theme = themes.theme;
  const clicks: { x: number; y: number }[] = [];
  // Mirage's rows for a group of calls, as the nested rows service returns them.
  const rows = {
    render: () => ["⠋ Run 2 commands ▸"],
    invalidate() {},
    handleMouse: (event: { x: number; y: number }) => {
      clicks.push({ x: event.x, y: event.y });
      return { handled: true };
    },
  };
  const blocks: import("../view.ts").Block[] = [
    { kind: "thinking", text: "The parser first." },
    { kind: "text", text: "Reading the **parser**." },
    { kind: "call", row: { kind: "read", status: "success", label: "Read /src/a.ts" } },
    { kind: "message", text: "Also the lexer" },
    { kind: "rows", component: rows, calls: 2, running: 2 },
  ];
  const card = {
    title: "Review parser error paths",
    model: "anthropic/claude-opus-5-5",
    thinking: "xhigh",
    tools: ["read"],
    turns: 3,
    calls: 3,
    usage: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.12 } },
    activity: { state: "running" as const, since: 0, turn: 4 },
  };
  const look = {
    phase: "running" as const,
    task: "Review it",
    expanded: true,
    id: 3,
    spinner: "⠋",
    durationMs: 61_000,
    blocks,
  };
  const row = new view.CardView(look, card, "", theme, 1);
  assert.equal(
    render(row),
    [
      " ⠋ Comrade #3  Review parser error paths  $0.12 · 1m 1s ▾",
      "",
      "   │ Review it",
      "",
      "   The parser first.",
      "",
      "   Reading the parser.",
      "",
      "   ✓ Read /src/a.ts",
      "",
      "   │ Also the lexer",
      "",
      "   ⠋ Run 2 commands ▸",
    ].join("\n"),
  );
  // A click on mirage's rows is theirs, where they sit in the row.
  assert.deepEqual(row.handleMouse({ type: "click", button: "left", x: 5, y: 12 } as never), {
    handled: true,
  });
  assert.deepEqual(clicks, [{ x: 2, y: 0 }]);
  // Elsewhere, Pi's to open and close the row.
  assert.equal(row.handleMouse({ type: "click", button: "left", x: 5, y: 6 } as never), undefined);
  // Closed, it says the calls it runs, mirage's line for them without its caret, as a click
  // there opens the comrade, not the group.
  assert.equal(
    render(new view.CardView({ ...look, expanded: false }, card, "", theme, 1)),
    [
      " ⠋ Comrade #3  Review parser error paths  $0.12 · 1m 1s ▸",
      "   ⠋ Run 2 commands",
      "   ↑1.0k ↓100",
    ].join("\n"),
  );
});

test("what a comrade said is its last complete sentence or line, without Markdown's marks", () => {
  assert.equal(lastSaid("Reading the parser now"), undefined, "half a sentence");
  assert.equal(lastSaid("I read it. Now the lex"), "I read it.");
  assert.equal(lastSaid("I read it. All good: the not"), "I read it.", "a colon mid-line");
  assert.equal(lastSaid("I read it. Three issues:\n1. The"), "I read it. Three issues:");
  assert.equal(lastSaid("First line\n**Second** line\nthird, unfinished"), "Second line");
  assert.equal(lastSaid("## Plan\n- check `parse()` callers\n"), "check parse() callers");
  assert.equal(lastSaid("Done", true), "Done", "a whole text ends complete");
  assert.equal(lastSaid(`${"x".repeat(300)}. `)?.length, 200);
});

test("a title is one line of at most 60 characters", () => {
  assert.equal(cleanTitle("  Review\nthe   parser  "), "Review the parser");
  assert.equal(cleanTitle(" "), undefined);
  assert.equal(cleanTitle("x".repeat(80))?.length, 60);
});

test("a new comrade's title names its row, and a follow-up keeps it unless given another", async (t) => {
  const { call, remember } = fixture(t, "echo");
  const first = await call({ task: "x", title: "Map the lexer" });
  assert.equal(details(first).title, "Map the lexer");
  remember(first);
  const kept = await call({ task: "more", to: 1 });
  assert.equal(details(kept).title, "Map the lexer");
  remember(kept);
  const renamed = await call({ task: "now tests", to: 1, title: "Map the tests" });
  assert.equal(details(renamed).title, "Map the tests");
});

/** A finished comrade's row, opened, as Pi draws it. */
const opened = (tool: Tool, result: Result, task: string) =>
  tool.renderResult?.(
    result,
    { expanded: true, isPartial: false },
    themes.theme,
    fake<RenderContext>({
      args: { task },
      state: {},
      toolCallId: "call",
      isPartial: false,
      expanded: true,
      isError: false,
      durationMs: 1000,
      invalidate() {},
    }),
  );

test("a comrade's thinking shows only where Pi shows thinking", async (t) => {
  for (const hide of [true, false]) {
    const { tool, call } = fixture(t, "work", { settings: { hideThinkingBlock: hide } });
    const shown = render(opened(tool, await call({ task: "Check the notes" }), "Check the notes"));
    assert.equal(shown.includes("The notes come first."), !hide);
    assert(shown.includes("Reading the notes."));
  }
});

test("without mirage, a comrade's calls are a row each, in mirage's words", async (t) => {
  const { tool, call } = fixture(t, "work");
  const result = await call({ task: "Check the notes", title: "Check notes" });
  assert.match(
    render(opened(tool, result, "Check the notes")),
    /\n\n {2}✓ Read \/tmp\/notes\.md\n {2}\$ cd \/tmp && …\n {2}\$ false \(exit code: 1\)\n\n {2}All good/,
  );
});

test("after a restart, an opened row reads what its comrade did from its conversation", async (t) => {
  const first = fixture(t, "work");
  const started = await first.call({ task: "Check the notes", background: true });
  const [message] = await first.delivered(1);
  const foreground = await first.call({ task: "Check again" }, undefined, undefined, "again");
  // Pi opened again: nothing in memory, the session's entries and the comrades' conversations.
  const again = fixture(t, "echo", {
    entries: [startRow(started), saved(message), startRow(foreground, "again")],
  });
  const renderer = again.renderers.get("comrade");
  assert(renderer);
  const answer = render(
    renderer(
      { ...message[0], role: "custom", display: true, timestamp: 0, details: delivery(message) },
      { expanded: true, outputPad: 0, keyHint: () => "", keyText: () => "" },
      themes.theme,
    ),
  );
  assert.match(
    answer,
    /▾\n\n {2}│ Check the notes\n\n {2}The notes come first\.\n\n {2}Reading the notes\.\n\n {2}✓ Read \/tmp\/notes\.md\n/,
  );
  // A foreground row, its run alone, though its comrade's conversation holds others.
  const row = render(
    again.tool.renderResult?.(
      foreground,
      { expanded: true, isPartial: false },
      themes.theme,
      fake<RenderContext>({
        args: { task: "Check again" },
        state: {},
        toolCallId: "again",
        isPartial: false,
        expanded: true,
        isError: false,
        durationMs: 1000,
        invalidate() {},
      }),
    ),
  );
  assert.match(row, /▾\n\n {2}│ Check again\n\n {2}The notes come first\.\n/);
  assert.equal(row.match(/Reading the notes/g)?.length, 1);
});

test("a running row keeps a comrade's thinking to itself where Pi hides thinking", async (t) => {
  for (const hide of [true, false]) {
    const { tool, call, updates } = fixture(t, "thinks", { settings: { hideThinkingBlock: hide } });
    const lines: string[] = [];
    await call({ task: "Plan it" }, undefined, () => {
      const update = updates.at(-1);
      if (update) lines.push(progressOf(tool, update));
    });
    assert.equal(
      lines.some((line) => line.includes("The plan is a secret.")),
      !hide,
      `thinking hidden: ${hide}`,
    );
  }
});

test("a row that did not succeed says why in up to three lines until opened", () => {
  const theme = themes.theme;
  const note = `Tool "grep" is not active here, so a comrade cannot have it. Active: ${Array.from({ length: 30 }, (_, i) => `tool${i}`).join(", ")}.`;
  const look = { phase: "failed" as const, task: "x", title: "Review", expanded: false, note };
  const closed = render(new view.CardView(look, undefined, "", theme, 0), 60).split("\n");
  assert.equal(closed.length, 4);
  assert.match(closed[1], /^ {2}Tool "grep" is not active here, so a comrade cannot have/);
  assert.match(closed[3], /…$/);
  const open = render(new view.CardView({ ...look, expanded: true }, undefined, "", theme, 0), 60);
  assert(open.includes("tool29."), "whole once opened");
});

test("an open row shows its latest work, and the rest on a click", () => {
  const theme = themes.theme;
  const blocks = Array.from({ length: 30 }, (_, i) => ({
    kind: "text" as const,
    text: `Step ${i}.`,
  }));
  const look = { phase: "finished" as const, task: "x", expanded: true, blocks };
  const toggled: string[] = [];
  const toggles = { earlier: () => void toggled.push("earlier") };
  const row = new view.CardView(look, undefined, "", theme, 0, toggles);
  const lines = render(row).split("\n");
  const toggle = lines.indexOf("  … 6 earlier ▸");
  assert(toggle > 0, lines.join("\n"));
  assert(
    !lines.includes("  Step 5.") && lines.includes("  Step 6.") && lines.includes("  Step 29."),
  );
  assert.deepEqual(row.handleMouse({ type: "click", button: "left", x: 4, y: toggle } as never), {
    handled: true,
  });
  assert.deepEqual(toggled, ["earlier"]);
  const all = render(
    new view.CardView({ ...look, earlierOpen: true }, undefined, "", theme, 0, toggles),
  );
  assert(all.includes("  show only the latest ▴") && all.includes("  Step 0."));
});

test("a running group of one call is named as that call, not as mirage's group", () => {
  const theme = themes.theme;
  const rows = { render: () => ["✓ Ran 1 command ▸"], invalidate() {} };
  const last = {
    kind: "command" as const,
    status: "error" as const,
    label: "$ cd /src && …",
    code: "2",
  };
  const card = {
    model: "m",
    thinking: "off",
    tools: [],
    turns: 1,
    calls: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
    activity: { state: "running" as const, since: 0 },
  };
  const look = {
    phase: "running" as const,
    task: "x",
    expanded: false,
    spinner: "⠋",
    blocks: [{ kind: "rows" as const, component: rows, calls: 1, running: 0, last }],
  };
  assert.match(
    render(new view.CardView(look, card, "", theme, 0)),
    /\n {2}\$ cd \/src && … \(exit code: 2\)\n/,
  );
});

test("control bytes in what a comrade thought, or in a title, never reach the terminal", (t) => {
  const theme = themes.theme;
  const block = {
    kind: "thinking" as const,
    text: "Clear\x1b[2J the\tscreen\x07 \x1b]0;title\x07now.",
  };
  const look = { phase: "finished" as const, task: "x", expanded: true, blocks: [block] };
  const lines = new view.CardView(look, undefined, "", theme, 0).render(80);
  for (const line of lines) {
    for (const bad of ["\x1b[2J", "\x07", "\t", "\x1b]0;"])
      assert(!line.includes(bad), JSON.stringify(line));
  }
  const { tool } = fixture(t, "echo");
  const args = { title: "Bad\x1b[2J\ntitle", task: "x" };
  const drawn = tool.renderCall?.(
    args,
    theme,
    fake<RenderContext>({ args, state: {}, toolCallId: "c", argsComplete: false, invalidate() {} }),
  );
  const [header, ...rest] = drawn?.render(80) ?? [];
  assert.equal(rest.length, 0);
  assert(!header?.includes("\x1b[2J") && !header?.includes("\n"), JSON.stringify(header));
});

test("an opened row shows its own run of a conversation, not the run next to it", (t) => {
  const file = join(fixture(t, "echo").cwd, "comrade-1.jsonl");
  let parentId: string | null = null;
  const message = (role: string, text: string, timestamp: number) => {
    const entry = {
      type: "message",
      id: String(timestamp),
      parentId,
      message: { role, content: [{ type: "text", text }], timestamp },
    };
    parentId = entry.id;
    return JSON.stringify(entry);
  };
  writeFileSync(
    file,
    [
      JSON.stringify({ type: "session", version: 3, id: "s" }),
      message("user", "one", 1_000),
      message("assistant", "ANSWER ONE.", 1_500),
      // A follow-up started half a second after the first ended.
      message("user", "two", 2_000),
      message("assistant", "ANSWER TWO.", 2_500),
    ].join("\n"),
  );
  const texts = (since: number, until?: number) =>
    resume
      .runMessages(file, since, until)
      ?.map((m) => ((m as { content: { text: string }[] }).content[0] ?? { text: "" }).text);
  assert.deepEqual(texts(900, 1_600), ["one", "ANSWER ONE."]);
  assert.deepEqual(texts(1_900, 2_600), ["two", "ANSWER TWO."]);
  // A run refused before its prompt was saved has nothing of its own.
  assert.equal(texts(2_700, 2_800), undefined);
});

test("without mirage, a comrade's thinking follows Ctrl+T, which changes Pi's setting", async (t) => {
  const { tool, call, settings } = fixture(t, "work");
  const result = await call({ task: "Check the notes" });
  const row = opened(tool, result, "Check the notes");
  assert(render(row).includes("The notes come first."));
  settings.hideThinkingBlock = true;
  // One reading of the setting stands for a quarter of a second.
  await new Promise((wake) => setTimeout(wake, 300));
  assert(!render(row).includes("The notes come first."));
});

test("a running background comrade's open start row shows its work after /reload", async (t) => {
  const before = fixture(t, "hang", { sessionId: "reloaded-work" });
  const result = await before.call(
    { task: "survives", background: true },
    undefined,
    undefined,
    "s",
  );
  await until(() => records(result)[0]?.phase === "asked");
  before.shutdown("reload");
  const after = fixture(t, "hang", {
    sessionId: "reloaded-work",
    reason: "reload",
    entries: [startRow(result, "s")],
  });
  t.after(() => after.comrades({ stop: [1] }));
  await until(() => {
    const row = render(
      after.tool.renderResult?.(
        result,
        { expanded: true, isPartial: false },
        themes.theme,
        fake<RenderContext>({
          args: { task: "survives" },
          state: {},
          toolCallId: "s",
          isPartial: false,
          expanded: true,
          isError: false,
          invalidate() {},
        }),
      ),
    );
    return (
      /\n {2}⠋ Reading \/tmp\/forever\.md|\n {2}… Read/.test(row) || row.includes("forever.md")
    );
  });
});

test("outside the terminal, an answer is not sent again after the agent settles", async (t) => {
  const { call, delivered, sent, pi, ctx } = fixture(t, "echo", { mode: "rpc" });
  await call({ task: "✓", background: true });
  await delivered(1);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  await pi.event("agent_settled", { aborted: true }, ctx);
  t.mock.timers.tick(1000);
  assert.equal(sent.length, 1, "an RPC abort leaves it queued: sending it again doubles it");
});

test("a resumed run reported lost tells its start row so", async (t) => {
  const { started, session } = await cutMidCall(t);
  // Carried on, then cut off again, a day ago.
  const again = fixture(t, "hang", { entries: [startRow(started)] });
  const [resumed] = again.sent;
  const run = delivery(resumed).run ?? "";
  await until(() => runs.readRuns(session).some((r) => r.run === run && r.phase === "asked"));
  await again.pi.event("session_shutdown", { reason: "quit" }, again.ctx);
  const old = Date.now() - 25 * 3600_000;
  const file = runs.runsFile(session);
  const records = JSON.parse(readFileSync(file, "utf8")) as { started: number; at: number }[];
  for (const record of records) Object.assign(record, { started: old, at: old });
  writeFileSync(file, JSON.stringify(records));
  utimesSync(session, old / 1000, old / 1000);
  const entries = [startRow(started), saved(resumed)];
  const third = fixture(t, "echo", { entries });
  const [lost] = third.sent;
  assert.equal(delivery(lost).status, "lost");
  assert.equal(delivery(lost).row, "call");
  entries.push(saved(lost));
  const row = render(
    third.tool.renderResult?.(
      started,
      { expanded: false, isPartial: false },
      themes.theme,
      fake<RenderContext>({
        args: { task: "Survey the parser" },
        state: {},
        toolCallId: "call",
        isPartial: false,
        expanded: false,
        isError: false,
        invalidate() {},
      }),
    ),
  );
  assert.match(row, /background · lost/);
});

test("a run keeps its comrade's messages lean: no images, and long results cut", () => {
  const image = { type: "image" as const, data: "x".repeat(1000), mimeType: "image/png" };
  const prompt = lean(
    fake<Parameters<typeof lean>[0]>({
      role: "user",
      content: [{ type: "text", text: "Look" }, image],
      timestamp: 0,
    }),
  );
  assert.deepEqual((prompt as { content: unknown[] }).content, [{ type: "text", text: "Look" }]);
  // Cut where the cut would split an emoji in two: before it.
  const long = `${"a".repeat(31_999)}😀${"b".repeat(100)}`;
  const result = lean(
    fake<Parameters<typeof lean>[0]>({
      role: "toolResult",
      toolCallId: "r",
      toolName: "read",
      content: [{ type: "text", text: long }, image],
      isError: false,
      timestamp: 0,
    }),
  ) as { content: { type: string; text: string }[] };
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].text, `${"a".repeat(31_999)}\n…`);
});

test("a comrade's message is read only when it is in the shape its row draws", () => {
  const text = { type: "text", text: "Look" };
  const call = { type: "toolCall", id: "c", name: "read", arguments: { path: "a.ts" } };
  for (const message of [
    { role: "user", content: "Look" },
    { role: "user", content: [text, { type: "image", data: "x", mimeType: "image/png" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "Hm." }, text, call] },
    { role: "assistant", content: [] },
    { role: "toolResult", toolCallId: "c", content: [text] },
  ])
    assert(isConversationMessage(message), JSON.stringify(message));
  for (const message of [
    null,
    "a message",
    { role: "assistant" },
    { role: "assistant", content: "Look" },
    { role: "user", content: [null] },
    { role: "user", content: ["Look"] },
    { role: "assistant", content: [{ type: "text" }] },
    { role: "assistant", content: [{ type: "thinking", thinking: 1 }] },
    { role: "assistant", content: [{ type: "toolCall", name: "read" }] },
    { role: "toolResult", toolCallId: "c", content: [{ type: "text", text: 1 }] },
    { role: "toolResult", toolCallId: "c", content: [{ type: "image", data: "x" }] },
    { role: "toolResult", content: [text] },
    // Pi's other messages are not a comrade's conversation.
    { role: "custom", content: [text] },
  ])
    assert(!isConversationMessage(message), JSON.stringify(message));
  // A part of a type Pi does not declare is kept whole: nothing reads it.
  const novel = { role: "toolResult", toolCallId: "c", content: [{ type: "novel", size: 1 }] };
  assert(isConversationMessage(novel));
  assert.deepEqual(lean(novel), novel);
});

test("messages out of shape from a comrade's Pi are passed over, and its run goes on", async (t) => {
  const { call } = fixture(t, "misshapen");
  const result = await call({ task: "Carry on" });
  assert.equal(result.isError, undefined);
  assert.equal(answer(result), "Still here.");
  // Only the reply in shape is a turn.
  assert.equal(details(result).turns, 1);
});

test("a row whose saved record is not a run's shows its result's text, not a run", (t) => {
  const { tool } = fixture(t, "echo");
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } };
  const whole = { model: "a/b", thinking: "high", tools: ["read"], turns: 1, calls: 0, usage };
  const row = (details: object) =>
    render(
      tool.renderResult?.(
        fake<Result>({ content: [{ type: "text", text: "What it said." }], details }),
        { expanded: false, isPartial: false },
        themes.theme,
        fake<RenderContext>({
          args: { title: "Check the notes", task: "Check the notes" },
          state: {},
          toolCallId: "call",
          isPartial: false,
          expanded: false,
          isError: false,
          outputPad: 0,
          invalidate() {},
        }),
      ),
    );
  assert.equal(row(whole), "✓ Comrade  Check the notes  $0.01 ▸");
  // Each of these lacks a part that a row reads without asking whether it is there.
  for (const details of [
    { usage },
    { ...whole, tools: undefined },
    { ...whole, tools: [1] },
    { ...whole, turns: "1" },
    { ...whole, usage: { ...usage, cost: {} } },
    { ...whole, usage: null },
  ])
    assert.equal(
      row(details),
      "✗ Comrade  Check the notes  failed ▸\n  What it said.",
      JSON.stringify(details),
    );
});

test("without mirage, rows ask for it once, not on every draw", async (t) => {
  const { tool, call, pi } = fixture(t, "work");
  let asked = 0;
  pi.events.on("mirage:nested-rows", () => void asked++);
  const result = await call({ task: "Check the notes" });
  const row = opened(tool, result, "Check the notes");
  for (let i = 0; i < 5; i++) {
    row?.invalidate();
    render(row);
  }
  assert.equal(asked, 1);
});
