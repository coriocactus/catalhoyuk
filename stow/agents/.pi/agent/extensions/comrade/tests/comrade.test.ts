import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionToolContext,
  MessageRenderer,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { fake, fakePi, type Tool } from "../../test/fake-pi.ts";
import { load, themes, tui } from "../../test/pi.ts";

const {
  default: install,
  currentPi,
  register,
  watchParent,
} = await load<typeof import("../index.ts")>("../index.ts", import.meta.url);
type Details = import("../index.ts").Details;
type Delivery = import("../index.ts").Delivery;
type Sent = Parameters<ExtensionAPI["sendMessage"]>;
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Result = Awaited<ReturnType<Tool["execute"]>>;
type RenderContext = Parameters<NonNullable<Tool["renderResult"]>>[3];

const standIn = fileURLToPath(new URL("./stand-in.ts", import.meta.url));
const models = [
  "anthropic/claude-opus-5-5",
  "anthropic/claude-fable-5-1",
  // OpenRouter's id for the same model is the text `anthropic/claude-fable-5-1`.
  "openrouter/anthropic/claude-fable-5-1",
  "openrouter/google/gemini-4-argon",
  "openrouter/google/gemini-4-argon:batch",
  // A provider whose own id contains a slash.
  "corp/proxy/big-model",
].map((ref) => {
  const slash = ref.indexOf("/");
  const split = ref.startsWith("corp/proxy/") ? "corp/proxy".length : slash;
  return fake<Model<Api>>({ provider: ref.slice(0, split), id: ref.slice(split + 1) });
});
const current = models[0];
const toolNames = ["read", "bash", "edit", "write", "grep", "find", "ls", "codemode"];

function fixture(
  t: TestContext,
  scenario: string,
  {
    trusted = true,
    /** A function is called again for each run. */
    command = process.execPath as string | (() => string),
    mode = "tui" as ExtensionToolContext["mode"],
    entries = [] as SessionEntry[],
    sessionId = "session",
    reason = "startup",
    /** The caller's session file, beside which comrades keep theirs. Null: an unsaved session. */
    parent = "parent.jsonl" as string | null,
    /** The current branch, when it is not every entry. */
    branch = undefined as SessionEntry[] | undefined,
    /** Tools this Pi has but does not offer the model, which a comrade cannot have either. */
    inactive = [] as string[],
    /** The session's scoped models (`enabledModels`). Empty: no scope. */
    scoped = [] as Model<Api>[],
    /** The models with credentials, which a session with no scope may use. */
    available = models,
  } = {},
) {
  const pi = fakePi();
  const sent: Sent[] = [];
  const waiting: (() => void)[] = [];
  const commands = new Map<string, Command>();
  const renderers = new Map<string, MessageRenderer<Delivery>>();
  const notices: string[] = [];
  const api: ExtensionAPI = {
    ...pi.api,
    sendMessage: ((...message: Sent) => {
      sent.push(message);
      for (const wake of waiting.splice(0)) wake();
    }) as ExtensionAPI["sendMessage"],
    registerCommand: (name, options) => commands.set(name, options),
    registerMessageRenderer: ((type: string, renderer: MessageRenderer<Delivery>) =>
      renderers.set(type, renderer)) as ExtensionAPI["registerMessageRenderer"],
    getAllTools: () =>
      [...toolNames, ...pi.tools.keys()].map((name) =>
        fake<ReturnType<ExtensionAPI["getAllTools"]>[number]>({ name }),
      ),
    // Active in the caller: everything but what `inactive` names.
    getActiveTools: () =>
      [...toolNames, ...pi.tools.keys()].filter((name) => !inactive.includes(name)),
  };
  register(
    api,
    typeof command === "function"
      ? () => ({ command: command(), args: [standIn, scenario] })
      : { command, args: [standIn, scenario] },
  );
  const tool = pi.tools.get("comrade");
  const list = pi.tools.get("comrades");
  assert(tool && list, "comrade and comrades registered");
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "comrade-test-")));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const working: (string | undefined)[] = [];
  const keys = new Set<(data: string) => unknown>();
  let pending = false;
  const ui = {
    setStatus: () => assert.fail("comrade must not add a footer status"),
    notify: (message: string) => void notices.push(message),
    setWorkingMessage: (message?: string) => void working.push(message),
    onTerminalInput: (handler: (data: string) => unknown) => {
      keys.add(handler);
      return () => keys.delete(handler);
    },
  };
  const ctx = fake<ExtensionToolContext>({
    cwd,
    mode,
    ui,
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => branch ?? entries,
      getSessionId: () => sessionId,
      getSessionFile: () => (parent === null ? undefined : join(cwd, parent)),
    },
    model: current,
    thinkingLevel: "xhigh",
    scopedModels: scoped.map((model) => ({ model })),
    modelRegistry: {
      find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
      getAvailable: () => available,
    },
    isProjectTrusted: () => trusted,
    hasPendingMessages: () => pending,
  });
  const updates: Result[] = [];
  const call = (
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: () => void,
    toolCallId = "call",
  ) =>
    tool.execute(
      toolCallId,
      params,
      signal,
      (update) => {
        updates.push(update);
        onUpdate?.();
      },
      ctx,
    ) as Promise<Result>;
  pi.emit("session_start", { reason }, ctx);
  t.after(() => pi.emit("session_shutdown", { reason: "quit" }, ctx));
  const comrades = (params: Record<string, unknown>) =>
    list.execute("list", params, undefined, undefined, ctx) as Promise<Result>;
  /** Resolves once `count` messages have been sent. */
  const delivered = async (count: number) => {
    while (sent.length < count) await new Promise<void>((wake) => waiting.push(wake));
    return sent;
  };
  const slash = (args: string) => {
    const comrades = commands.get("comrades");
    assert(comrades, "/comrades registered");
    return comrades.handler(args, fake<ExtensionCommandContext>({ ui }));
  };
  const shutdown = (why = "quit") => pi.emit("session_shutdown", { reason: why }, ctx);
  /** The agent tries to end its turn. Resolves when Pi may let it. */
  const settle = () => pi.event("agent_before_settle", {}, ctx);
  const press = (data: string) => {
    for (const handler of keys) handler(data);
  };
  const typed = () => {
    pending = true;
  };
  /** Records a comrade's row in the session, as Pi does once the call returns. */
  const remember = (result: Result) =>
    entries.push(
      fake<SessionEntry>({
        type: "message",
        message: { role: "toolResult", toolName: "comrade", details: result.details },
      } as never),
    );
  return {
    pi,
    ctx,
    remember,
    entries,
    tool,
    cwd,
    call,
    updates,
    sent,
    delivered,
    slash,
    notices,
    renderers,
    shutdown,
    comrades,
    settle,
    press,
    typed,
    working,
    keys,
  };
}

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

test("comrade sends the task verbatim on stdin and the run settings as Pi flags", async (t) => {
  const { call, cwd, updates } = fixture(t, "echo");
  const task = `@notes.md -- $(rm -rf ~) "double" 'single' ✓ é\n  second line`;
  const result = await call({ task });
  assert.equal(result.isError, undefined);
  const echoed = JSON.parse(answer(result));
  assert.equal(echoed.task, task);
  assert.deepEqual(echoed.args, [
    "--mode",
    "json",
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
    // Shown before the comrade starts, then on each call start and end and each turn.
    [
      [0, 0],
      [1, 0],
      [1, 0],
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
    [{ task: " \n " }, /needs a task/],
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

/** The start of every running row's second line: the comrade's model and tools. */
const M = "anthropic/claude-opus-5-5:xhigh · read, grep, find, ls · ";

const render = (component: Component | undefined, width = 120) => {
  assert(component);
  return component
    .render(width)
    .map((line) => tui.stripTerminalSequences(line).trimEnd())
    .join("\n");
};

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
      ["success", "$ npm test", 2],
    ],
  );
  assert.equal(work?.current, undefined, "a finished comrade has no current call");
});

test("one header line, a fixed progress line while running, and the rest behind Ctrl+O", async (t) => {
  // A frozen clock holds the spinner on its first frame.
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const { tool, call, updates, cwd } = fixture(t, "busy");
  const args = { task: `Review the diff in ${homedir()}/notes\nwith care` };
  const state = {};
  let redraws = 0;
  const context = (isPartial: boolean, expanded = false, isError = false) =>
    fake<RenderContext>({
      args,
      state,
      isPartial,
      expanded,
      isError,
      durationMs: isPartial ? undefined : 754_000,
      invalidate: () => redraws++,
    });
  const call_ = () => render(tool.renderCall?.(args, themes.theme, context(true)));
  const result_ = (value: Result, isPartial: boolean, expanded = false, isError = false) =>
    render(
      tool.renderResult?.(
        value,
        { expanded, isPartial },
        themes.theme,
        context(isPartial, expanded, isError),
      ),
      // Wide enough for the conversation's path in the temporary directory.
      expanded ? 400 : 120,
    );

  // Before any result, the call slot is the header.
  assert.equal(call_(), "⠋ Comrade  Review the diff in ~/notes");
  const result = await call(args);
  const editing = updates.find((update) => details(update).work?.current === "Editing /tmp/a.ts");
  assert(editing);
  assert.equal(
    result_(editing, true),
    `⠋ Comrade #1  Review the diff in ~/notes  0s\n${M}turn 1 · 5 calls · Editing /tmp/a.ts`,
  );
  // Ctrl+O while it runs shows the whole task, as sent, under the progress line.
  assert.equal(
    result_(editing, true, true),
    [
      "⠋ Comrade #1  Review the diff in ~/notes  0s",
      `${M}turn 1 · 5 calls · Editing /tmp/a.ts`,
      "",
      `│ Review the diff in ${homedir()}/notes`,
      "│ with care",
    ].join("\n"),
  );
  // From then on the result slot owns the header, and the call slot is redrawn empty.
  await Promise.resolve();
  assert.equal(redraws, 1);
  assert.equal(call_(), "");

  assert.equal(result_(result, false), "✓ Comrade #1  Review the diff in ~/notes  $0.01 · 12m 34s");
  assert.equal(
    result_(result, false, true).replace(cwd, "<cwd>"),
    [
      "✓ Comrade #1  Review the diff in ~/notes  $0.01 · 12m 34s",
      "",
      "anthropic/claude-opus-5-5:xhigh · read, grep, find, ls · 1 turn · ↑150 ↓10",
      "Conversation: <cwd>/parent.comrades/comrade-1.jsonl",
      "✓ Read 3 files, ran 1 search, edited 1 file (+2 −1), wrote 1 file (+2), ran 4 commands",
      "  $ false  exit code 1",
      "  ✗ Read /tmp/d.ts  ENOENT: no such file or directory",
      "  $ sleep 9",
      "  Edited /tmp/a.ts +2 −1",
      "  Wrote /tmp/c.md +2",
      "  $ npm test ×2",
      "",
      `│ Review the diff in ${homedir()}/notes`,
      "│ with care",
      "",
      "Done.",
    ].join("\n"),
  );

  const stopped = {
    content: [{ type: "text" as const, text: "Comrade stopped." }],
    details: { ...details(result), stopped: true },
  };
  assert.equal(
    result_(stopped, false, false, true),
    "✓ Comrade #1  Review the diff in ~/notes  $0.01 · 12m 34s"
      .replace("✓", "✗")
      .replace("  $", "  stopped · $"),
  );
  assert.match(result_(stopped, false, true, true), /\nStopped with Esc\.$/);

  const rejected = {
    content: [{ type: "text" as const, text: "comrade needs a task." }],
    details: {},
  };
  assert.match(
    result_(rejected, false),
    /^✗ Comrade {2}Review the diff in ~\/notes {2}failed\n\ncomrade needs a task\.$/,
  );
});

test("the header keeps cost and duration visible by cutting the task", async (t) => {
  const { tool, call } = fixture(t, "echo");
  const args = { task: "✓ ".repeat(80) };
  const result = await call(args);
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
  const [raw] = line?.render(40) ?? [];
  const header = tui.stripTerminalSequences(raw);
  assert.equal(tui.visibleWidth(header), 40);
  assert.match(header, /… {2}\$0\.02 · 1\.5s$/);
  // A full reset would clear the tool box's background from the cut onwards.
  assert(!raw.includes("\x1b[0m"), JSON.stringify(raw));
});

test("a background comrade returns at once, then its answer arrives and wakes the agent", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const { tool, call, delivered, renderers } = fixture(t, "echo");
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
  // Its start row spins, with its clock and progress, while the comrade runs.
  assert.equal(
    render(startRow()),
    `⠋ Comrade #1  ✓ survey the parser  background · 0s\n${M}starting`,
  );

  const [message] = await delivered(1);
  // Then it is one line again: the answer is in the delivered message.
  assert.equal(render(startRow()), "… Comrade #1  ✓ survey the parser  background");
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
  assert.match(shown(false), /^✓ Comrade #1 {2}✓ survey the parser {2}\$0\.02 · \d+\.\ds$/);
  assert.match(
    shown(true),
    /^✓ Comrade #1 .*\n\nanthropic\/claude-opus-5-5:xhigh · read, grep, find, ls · 2 turns · ↑300 ↓20\nConversation: .*\/comrade-1\.js.*\n✓ Explored 1 file\n\n\{"args"/,
  );
});

test("/comrades lists and stops background comrades without waking the agent", async (t) => {
  const { call, slash, delivered, notices } = fixture(t, "hang");
  await call({ task: "first", background: true });
  await call({ task: "second", background: true });
  await slash("");
  assert.match(notices.at(-1) ?? "", /^#1 .*· first\n#2 .*· second\n2 running · \$0\.00 so far$/);

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
    /^#1 .*· first\n#2 .*· second\n2 running · \$0\.00 so far$/,
  );

  const stopped = await comrades({ stop: [1, 9] });
  assert.equal(text(stopped), "Stopped comrade #1. No running comrade #9.");
  assert.equal(stopped.isError, false);
  assert.deepEqual(stopped.details, { stopped: [1] });
  assert.match(text(await comrades({})), /^#2 .*· second$/);

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
  assert.match(text(await after.comrades({})), /^#1 .*· survives$/);
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

  assert.match(draw(running, true), /^⠋ Comrade #1 {2}Spin {2}/);
  await Promise.resolve(); // the call slot's one-time redraw
  const before = redraws;
  t.mock.timers.tick(80);
  assert.equal(redraws, before + 1, "the timer redraws the running row");
  assert.match(draw(running, true), /^⠙ Comrade #1 {2}Spin {2}/, "the frame follows the clock");
  assert(
    (
      tool
        .renderResult?.(running, { expanded: false, isPartial: true }, themes.theme, context(true))
        ?.render(120)[0] ?? ""
    ).startsWith(themes.theme.fg("accent", "⠙")),
    "in Pi's accent colour",
  );

  assert.match(draw(result, false), /^✓ Comrade #1 {2}Spin {2}\$0\.02 · 1\.0s$/);
  const done = redraws;
  t.mock.timers.tick(800);
  assert.equal(redraws, done, "no redraws once it has finished");
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
  assert.match(text(await esc.comrades({})), /^#1 .*· first$/, "still running");

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
        isPartial: false,
        expanded,
        isError: Boolean(result.isError),
        durationMs: 1000,
        invalidate() {},
      }),
    ),
  );

test("files follow the task as @file arguments, resolved from the working directory", async (t) => {
  const { call, cwd } = fixture(t, "echo");
  writeFileSync(join(cwd, "notes.md"), "notes");
  // The same file twice, and one named from the home directory.
  const fromHome = standIn.startsWith(`${homedir()}/`)
    ? `~${standIn.slice(homedir().length)}`
    : standIn;
  const result = await call({ task: "✓", tools: [], files: ["notes.md", fromHome, "./notes.md"] });
  const { args, task } = JSON.parse(answer(result));
  assert.equal(task, "✓", "the task stays on stdin");
  assert.deepEqual(args.slice(-4), [
    "--no-tools",
    "--approve",
    `@${join(cwd, "notes.md")}`,
    `@${standIn}`,
  ]);
  assert.equal(details(result).files, 2);
  assert.match(row(tool(t), result, "✓", true), /· no tools · 2 files attached ·/);
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
    /\n\n\[comrade #1: anthropic\/claude-opus-5-5:xhigh · 1 turn · 11 calls · read 3 files, ran 1 search, edited 1 file \(\+2 −1\), wrote 1 file \(\+2\), ran 4 commands · ↑150 ↓10 · \$0\.01 · \d+\.\ds · stop\]$/,
  );
  assert.match(row(tool, result, "✓", true), /\n\nDone\.$/);
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
  assert.equal(row(tool, result, "✓"), "✓ Comrade #1  ✓  cut off · $0.01 · 1.0s");
  assert.match(row(tool, result, "✓", true), /\n\nThe first half of an$/);
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
  assert.equal(row(slow.tool, result, "x"), "✗ Comrade #1  x  timed out · $0.01 · 1.0s");
  assert.match(row(slow.tool, result, "x", true), /\n\nNotes so far\.$/);

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
    .split("\n")[1]
    ?.replace(/\b\d+s\b/g, "Ns");

test("the progress line says what the comrade is doing, from its event stream", async (t) => {
  const { tool, call, updates } = fixture(t, "stream");
  const result = await call({ task: "x" });
  assert.equal(answer(result), "Done.");
  const lines = updates.map((update) => progressOf(tool, update));
  const shown = lines.filter((line, index) => line !== lines[index - 1]);
  // The second line is the finished row's meta line, live: the model and tools, then the
  // turn, calls, tokens and what it is doing.
  assert.deepEqual(
    shown.map((line) => line.replace(M, "… ")),
    [
      "… starting",
      "… turn 1 · waiting",
      "… turn 1 · retrying · 1/3 · 529 overloaded",
      "… turn 1 · waiting",
      "… turn 1 · retrying",
      "… turn 1 · waiting",
      "… turn 1 · compacting its context",
      "… turn 1 · waiting",
      // Like Anthropic, the provider counted the input at the start, and no output yet.
      "… turn 1 · ↑1.0k · thinking",
      // Streamed text is reported at most every 250ms, so the deltas arrive as one update,
      // and their tokens are estimated, marked `~`.
      "… turn 1 · ↑1.0k ↓~2.0k · thinking",
      "… turn 1 · ↑1.0k ↓~2.0k · calling read",
      "… turn 1 · ↑1.0k ↓~2.1k · calling read",
      // The turn's message has ended: its usage is exact now, but its tools still belong to it.
      "… turn 1 · ↑150 ↓10 · calling read",
      "… turn 1 · 1 call · ↑150 ↓10 · Reading /tmp/a.ts",
      "… turn 1 · 1 call · ↑150 ↓10 · Read /tmp/a.ts",
      // A wait after the first turn says how long it has lasted.
      "… turn 2 · 1 call · ↑150 ↓10 · waiting Ns",
      "… turn 2 · 1 call · ↑150 ↓10 · writing",
      // Like Google, the provider counts as it goes: once its count has moved, it is shown.
      "… turn 2 · 1 call · ↑250 ↓~11 · writing",
      "… turn 2 · 1 call · ↑250 ↓14 · writing",
      "… turn 2 · 1 call · ↑300 ↓20 · writing",
    ],
  );
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
  assert.match(
    draw(),
    /^⠋ Comrade #1 {2}x {2}\$0\.02 · 0s\nanthropic\/claude-opus-5-5:xhigh · read, grep, find, ls · turn 3 · 1 call · ↑300 ↓20 · waiting 0s$/,
  );
  t.mock.timers.tick(12_500);
  assert.match(draw(), / {2}\$0\.02 · 12s\n.* · waiting 12s$/);
  t.mock.timers.tick(62_500);
  assert.match(draw(), / {2}\$0\.02 · 1m 15s\n/);
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
  assert.match(row(tool, second, "Now the lexer"), /^✓ Comrade #1 {2}Now the lexer {2}/);
  assert.match(
    row(tool, second, "Now the lexer", true),
    /\n\nfollow-up · anthropic\/claude-fable-5-1:low · no tools · /,
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

test("a follow-up needs a comrade on this branch that kept its conversation and is idle", async (t) => {
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
  await assert.rejects(
    call({ task: "x", to: 9 }),
    /^Error: Comrade #9 is still running in the background\. Wait for its answer, or stop it with the comrades tool\.$/,
  );
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
  assert.equal(head, "[comrade #1 finished] second");
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
    /^#1 · anthropic\/claude-opus-5-5:xhigh · turn 1 · starting · /,
  );
  // The hang scenario starts a read and never finishes it.
  for (let i = 0; i < 50 && !text(await comrades({})).includes("Reading"); i++)
    await new Promise((wake) => setTimeout(wake, 20));
  assert.match(text(await comrades({})), /^#1 · [^·]+ · turn 1 · Reading \/tmp\/forever\.md · /);
  await slash("");
  assert.match(notices.at(-1) ?? "", /^#1 · [^·]+ · turn 1 · Reading \/tmp\/forever\.md · /);
  await comrades({ stop: [1] });
});

test("a foreground comrade cannot be continued while it runs", async (t) => {
  const { call } = fixture(t, "hang");
  const controller = new AbortController();
  const running = call({ task: "slow" }, controller.signal);
  await new Promise((wake) => setTimeout(wake, 20));
  await assert.rejects(
    call({ task: "x", to: 1 }),
    /^Error: Comrade #1 is still running\. Wait for its answer\.$/,
  );
  controller.abort();
  assert.equal(text(await running), "Comrade #1 stopped.");
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
  assert.equal(startRow(first, "a"), "… Comrade #1  a  background");
  assert.match(startRow(second, "b"), /^⠋ Comrade #1 {2}b {2}background · 0s\n/);
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

test("a running job adopted from an older version shows its turn and calls", async (t) => {
  const { tool, call } = fixture(t, "busy");
  const result = await call({ task: "x" });
  // Older versions reported no activity.
  assert.equal(details(result).activity, undefined);
  const running = { ...result, details: { ...details(result), started: Date.now() } };
  assert.equal(progressOf(tool, running), `${M}turn 2 · 11 calls · ↑150 ↓10`);
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
  assert.match(row(tool, inside, "x", true), /· in \//);

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
  assert.doesNotMatch(row(tool, home, "x", true), /· in /);

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

test("the conversation's path is cut from its start, keeping the file name", async (t) => {
  const { tool, call } = fixture(t, "echo");
  const result = await call({ task: "✓" });
  const lines = tool
    .renderResult?.(
      result,
      { expanded: true, isPartial: false },
      themes.theme,
      fake<RenderContext>({
        args: { task: "✓" },
        state: {},
        isPartial: false,
        expanded: true,
        isError: false,
        durationMs: 1000,
        invalidate() {},
      }),
    )
    ?.render(60)
    .map((line) => tui.stripTerminalSequences(line));
  const conversation = lines?.find((line) => line.startsWith("Conversation: "));
  assert.match(conversation ?? "", /^Conversation: ….*\/parent\.comrades\/comrade-1\.jsonl$/);
  assert.equal(tui.visibleWidth(conversation ?? ""), 60);
});
