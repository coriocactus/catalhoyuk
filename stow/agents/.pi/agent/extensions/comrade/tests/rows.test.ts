// A comrade's rows as Pi builds them: a call's row that spins only while Pi works, listings that
// follow a resumed run and say how an older one stood, and rows from damaged saved details.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { fake, type Tool } from "../../test/fake-pi.ts";
import { core, themes } from "../../test/pi.ts";
import { fixture, render } from "./fixture.ts";

type Result = Awaited<ReturnType<Tool["execute"]>>;
type RenderContext = Parameters<NonNullable<Tool["renderResult"]>>[3];
type Listing = import("../details.ts").Listing;

const SPIN = "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]";
const noHints = { keyHint: () => "", keyText: () => "" };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } };
const context = (toolCallId: string, expanded = false) =>
  fake<RenderContext>({
    args: { title: "Check the notes", task: "Check the notes" },
    state: {},
    toolCallId,
    isPartial: false,
    expanded,
    isError: false,
    outputPad: 0,
    invalidate() {},
  });

test("a call left without a result in a saved session is still, and asks for no frames", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const { tool } = fixture(t, "echo");
  let frames = 0;
  const ui = fake<TUI>({ requestRender: () => void frames++ });
  // As Pi rebuilds a session: the call's row, as if its task still streamed in, and no result.
  const args = { title: "Review the diff", task: "Review it" };
  const row = new core.ToolExecutionComponent(
    "comrade",
    "saved",
    args,
    { outputPad: 0 },
    tool,
    ui,
    "/tmp",
  );
  assert.equal(render(row), "\n… Comrade  Review the diff");
  t.mock.timers.tick(5000);
  assert.equal(frames, 0);
});

test("a call spins while its task streams in and while it runs, as long as Pi works", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const { tool, ctx } = fixture(t, "echo");
  let working = true;
  ctx.isIdle = () => !working;
  let frames = 0;
  const ui = fake<TUI>({ requestRender: () => void frames++ });
  const args = { title: "Review the diff" };
  const row = new core.ToolExecutionComponent(
    "comrade",
    "live",
    args,
    { outputPad: 0 },
    tool,
    ui,
    "/tmp",
  );
  assert.equal(render(row), "\n⠋ Comrade  Review the diff");
  // Nothing else draws a frame: the spinner asks for them.
  t.mock.timers.tick(240);
  assert(frames > 0);
  row.updateArgs({ ...args, task: "Review it" });
  row.setArgsComplete();
  row.markExecutionStarted();
  assert.match(render(row), new RegExp(`^\n${SPIN} Comrade  Review the diff$`));
  // Pi stops working: the row comes to rest, and asks for nothing more.
  working = false;
  t.mock.timers.tick(80);
  assert.equal(render(row), "\n… Comrade  Review the diff");
  const rested = frames;
  t.mock.timers.tick(5000);
  assert.equal(frames, rested);
});

test("the newest listing follows a resumed run by its start row", async (t) => {
  const { call, comrades, pi } = fixture(t, "hang");
  await call({ task: "Long job", background: true }, undefined, undefined, "start");
  const listed = await comrades({});
  const list = pi.tools.get("comrades");
  assert(list?.renderResult);
  const details = listed.details as Listing;
  // As listed before Pi exited: the run it resumes was another, but its start row is the same.
  const before = {
    ...listed,
    details: { ...details, listed: details.listed.map((item) => ({ ...item, run: "earlier" })) },
  };
  assert.match(
    render(
      list.renderResult(before, { expanded: false, isPartial: false }, themes.theme, context("l")),
    ),
    new RegExp(`^${SPIN} Comrade #1  Long job  background · \\d+s ▸$`),
  );
  await comrades({ stop: [1] });
});

test("an older listing's line says how long a wait had lasted when it was made", (t) => {
  const { entryRenderers } = fixture(t, "echo");
  const renderer = entryRenderers.get("comrades");
  assert(renderer);
  const at = Date.now() - 26 * 3_600_000;
  const run = (id: number) => ({
    details: {
      model: "a/b",
      thinking: "high",
      tools: ["read"],
      turns: 2,
      calls: 0,
      usage,
      id,
      task: `Job ${id}`,
      background: true,
      started: at - 60_000,
      activity: { state: "waiting", since: at - 48_000 },
    },
    run: `run-${id}`,
    row: `row-${id}`,
  });
  // As a session file holds a listing: its renderer checks what it reads.
  const entry = (id: string, data: object) =>
    fake<SessionEntry>({ type: "custom", id, customType: "comrades", data } as never);
  const draw = (listing: SessionEntry) => {
    assert(listing.type === "custom");
    return render(renderer(listing, { expanded: false, ...noHints }, themes.theme));
  };
  draw(entry("newer", { listed: [run(8)], at: Date.now() }));
  assert.match(
    draw(entry("older", { listed: [run(8), run(9)], at })),
    /^ · Comrades #8, #9 {2}#8 waiting 48s · #9 waiting 48s · \$0\.02 {2}▸$/,
  );
});

test("a row drawn from damaged saved details draws plainly instead of throwing", (t) => {
  const { tool, renderers } = fixture(t, "echo");
  const whole = {
    model: "a/b",
    thinking: "high",
    tools: ["read"],
    turns: 1,
    calls: 1,
    usage,
    id: 1,
  };
  for (const details of [
    { ...whole, work: {} },
    { ...whole, reason: 5 },
    { ...whole, cwd: 5 },
  ])
    for (const expanded of [false, true]) {
      const result = fake<Result>({ content: [{ type: "text", text: "What it said." }], details });
      const row = tool.renderResult?.(
        result,
        { expanded, isPartial: false },
        themes.theme,
        context("call", expanded),
      );
      assert.match(
        render(row),
        /^✗ Comrade {2}Check the notes {2}failed [▸▾]\n {2}What it said\./,
        JSON.stringify(details),
      );
    }
  const renderer = renderers.get("comrade");
  assert(renderer);
  const message = (details: object, expanded: boolean) =>
    render(
      renderer(
        {
          role: "custom",
          customType: "comrade",
          content: "[comrade #1 finished] Check the notes\n\nThe answer.",
          display: true,
          timestamp: 0,
          details: details as never,
        },
        { expanded, outputPad: 0, ...noHints },
        themes.theme,
      ),
    );
  const delivery = { ...whole, task: "Check the notes", status: "finished" };
  assert.equal(message(delivery, false), "✓ Comrade #1  Check the notes  $0.01 ▸");
  for (const details of [
    { id: 1, task: "Check the notes", status: "finished", turns: 2 },
    { ...delivery, task: 5 },
  ]) {
    assert.equal(message(details, false), "✓ Comrade  …  ▸", JSON.stringify(details));
    assert.match(message(details, true), /\n {2}The answer\.$/, JSON.stringify(details));
  }
});
