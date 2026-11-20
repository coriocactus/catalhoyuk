// Calls that never get a result: those of a failed turn, those an agent left when it stopped, and
// saved ones whose session ended while they ran. None stays in progress.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { NESTED_ROWS_EVENT, type NestedRowsRequest } from "../../shared/nested.ts";
import { themes, tui } from "../../test/pi.ts";
import { assistant } from "../../test/transcript.ts";
import {
  assistantStart,
  firstText,
  fixture,
  mouse,
  plain,
  type Result,
  result,
  root,
  ToolGroups,
} from "./fixture.ts";

const call = (id: string, name: string, args: Record<string, string>) => ({
  type: "toolCall" as const,
  id,
  name,
  arguments: args,
});
const reply = (
  stopReason: AssistantMessage["stopReason"],
  ...calls: ReturnType<typeof call>[]
) => ({
  ...assistant("", calls),
  stopReason,
});
const lineOf = (lines: readonly string[], needle: string) =>
  lines.findIndex((line) => tui.stripTerminalSequences(line).includes(needle));

test("the calls of an aborted or failed turn fail with the error Pi shows for them", () => {
  const model = new ToolGroups();
  for (const [stopReason, id, text] of [
    ["aborted", "aborted-call", "Operation aborted"],
    ["error", "failed-call", "Overloaded"],
  ] as const) {
    const message = {
      ...reply(stopReason, call(id, "write", { path: "a.ts" })),
      errorMessage: "Overloaded",
    };
    model.startMessage(assistantStart, root);
    model.finishMessage(message, root);
    const row = model.rows.get(id);
    assert.equal(row?.status, "error", stopReason);
    assert.equal(firstText(row?.result as Result), text);
  }
});

test("an agent's calls left in progress are cancelled once it stops, and an aborted reply's fail", async () => {
  const f = await fixture();
  const request: NestedRowsRequest = {};
  f.pi.events.emit(NESTED_ROWS_EVENT, request);
  assert(request.rows, "mirage answers");
  let running = true;
  const transcript = request.rows.transcript(f.dir, () => (running ? "⠋" : undefined));
  transcript.add(
    reply(
      "toolUse",
      call("command", "bash", { command: "sleep 100" }),
      call("read", "read", { path: "a.ts" }),
    ),
  );
  const row = () => {
    const found = transcript.row("command", themes.theme);
    assert(found, "the command leads its group");
    return found;
  };
  assert.equal(plain(row()), "⠋ Running 1 command, reading 1 file ▸");
  // The agent was stopped. The asker asks for its rows again, as comrade does when a run ends.
  running = false;
  const stopped = row();
  assert.equal(plain(stopped), "✗ Ran 1 command, read 1 file ▸");
  stopped.handleMouse?.(mouse(0));
  stopped.handleMouse?.(mouse(0, lineOf(stopped.render(160), "Read a.ts")));
  assert.match(plain(stopped), /✗ Read a\.ts ▾\n {4}Cancelled when the agent stopped\./);

  // A reply aborted while the agent still runs: its call never runs.
  const aborted = request.rows.transcript(f.dir, () => "⠋");
  aborted.add(reply("aborted", call("write", "write", { path: "a.ts", content: "x" })));
  const write = aborted.row("write", themes.theme);
  assert(write);
  assert.equal(plain(write), "✗ Write a.ts ▸");
});

test("a saved call that never ended rests while Pi works, instead of spinning", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const f = await fixture({ busy: true });
  const entries = [
    {
      type: "message",
      id: "m",
      message: reply("toolUse", call("old", "bash", { command: "make" })),
    },
    { type: "message", id: "u", message: { role: "user", content: "next", timestamp: 1 } },
  ];
  // Pi draws the saved transcript before session_start, as on /resume and /reload.
  const old = f.call("bash", "old", { command: "make" }, false);
  await f.rebuild("session_start", entries);
  old.redraw();
  assert.equal(plain(old.view), "… Running 1 command ▸");
  const redraws = f.invalidations;
  t.mock.timers.tick(800);
  assert.equal(f.invalidations, redraws, "nothing asks Pi to draw it again");

  // Drawn after session_start, as when a page of history is loaded.
  await f.rebuild("session_tree", entries);
  assert.equal(
    plain(f.call("bash", "old", { command: "make" }, false).view),
    "… Running 1 command ▸",
  );
});

test("beside a call in progress, a saved call that never ended still rests", async () => {
  const f = await fixture({ busy: true });
  await f.rebuild("session_start", [
    {
      type: "message",
      id: "m",
      message: reply("toolUse", call("old", "bash", { command: "make" })),
    },
  ]);
  const old = f.call("bash", "old", { command: "make" }, false);
  f.call("read", "new", { path: "a.ts" });
  f.expand(true);
  const lines = old.view.render(160).map((line) => tui.stripTerminalSequences(line));
  assert.match(lines[0], /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Running 1 command, reading 1 file ▾$/, "the group spins");
  assert.equal(lines[lineOf(lines, "make")], "  $ make ▾", "the saved call rests on its $");
  assert.match(lines[lineOf(lines, "a.ts")], /^ {2}[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Reading a\.ts ▾$/);
});

test("a call of an aborted turn stays failed when the transcript is rebuilt", async () => {
  const f = await fixture();
  const write = f.call("write", "write", { path: "a.ts", content: "x" }, false);
  // Pi gives each call of an aborted turn its error as it draws it.
  write.result(result("Operation aborted"), true);
  await f.rebuild("session_start", [
    { type: "message", id: "u", message: { role: "user", content: "write it", timestamp: 1 } },
    {
      type: "message",
      id: "m",
      message: reply("aborted", call("write", "write", { path: "a.ts", content: "x" })),
    },
  ]);
  assert.equal(plain(write.view), "✗ Write a.ts ▸");
  write.view.handleMouse(mouse(0));
  assert.match(plain(write.view), /\n {2}Operation aborted$/);
});
