// What ends a group where Pi draws something between calls, and what does not where it draws
// nothing: a compaction's summary, system messages, and custom messages it does not display.
import assert from "node:assert/strict";
import { test } from "node:test";
import { TRANSCRIPT_VIEW } from "../../shared/transcript.ts";
import { assistant } from "../../test/transcript.ts";
import {
  assistantStart,
  fixture,
  type Message,
  plain,
  result,
  root,
  ToolGroups,
} from "./fixture.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const timestamp = "2025-01-01T00:00:00.000Z";

/** A turn's call and its result, as session entries. */
function turn(id: string, name: string, args: Record<string, string>, parentId: string | null) {
  const call = { type: "toolCall" as const, id, name, arguments: args };
  return [
    {
      type: "message",
      id: `${id}-call`,
      parentId,
      timestamp,
      message: { ...assistant("", [call]), stopReason: "toolUse" },
    },
    {
      type: "message",
      id: `${id}-result`,
      parentId: `${id}-call`,
      timestamp,
      message: {
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        ...result("ok"),
        isError: false,
      },
    },
  ];
}

const kept = turn("a", "read", { path: "a.ts" }, null);
const compaction = {
  type: "compaction",
  id: "compaction",
  parentId: "a-result",
  timestamp,
  summary: "Earlier work",
  firstKeptEntryId: "a-call",
  tokensBefore: 150000,
};

/** The next assistant turn while Pi works: a call alone, as with hidden thinking. */
async function nextTurn(f: Fixture, id: string) {
  const call = { type: "toolCall" as const, id, name: "bash", arguments: { command: "make" } };
  await f.pi.event("message_start", { message: assistantStart }, f.ctx);
  await f.pi.event("message_update", { message: assistant("", [call]) }, f.ctx);
  return f.call("bash", id, { command: "make" });
}

/** What rearview announces before Pi draws the transcript, in one mounted transcript. */
function announcer(f: Fixture) {
  const scope = {};
  return (entries: unknown[]) =>
    f.pi.events.emit(TRANSCRIPT_VIEW, {
      sessionId: "test",
      cwd: f.dir,
      entries,
      expanded: false,
      scope,
    });
}

test("after a compaction while Pi works, the next call starts a group below its summary", async () => {
  const f = await fixture({ busy: true });
  // Pi puts the compaction first in the session's context, then draws it below the kept entries.
  await f.rebuild("session_compact", [compaction, ...kept]);
  const read = f.call("read", "a", { path: "a.ts" });
  read.result(result("ok"));
  const next = await nextTurn(f, "b");
  assert.notEqual(next.view.row.group, read.view.row.group);
  assert.equal(plain(read.view), "✓ Read a.ts ▸");
  assert.match(plain(next.view), /Running 1 command ▸$/);
});

test("so it does when rearview announces the transcript Pi draws after the compaction", async () => {
  const f = await fixture({ busy: true });
  const announce = announcer(f);
  announce(kept);
  await f.rebuild("session_compact", [compaction, ...kept]);
  announce([compaction, ...kept]);
  const read = f.call("read", "a", { path: "a.ts" });
  read.result(result("ok"));
  const next = await nextTurn(f, "b");
  assert.notEqual(next.view.row.group, read.view.row.group);
});

test("once Pi draws the whole transcript again, its summary first, calls join across it", async () => {
  const tree = await fixture({ busy: true });
  await tree.rebuild("session_compact", [compaction, ...kept]);
  await tree.rebuild("session_tree", [compaction, ...kept]);
  const read = tree.call("read", "a", { path: "a.ts" });
  read.result(result("ok"));
  assert.equal((await nextTurn(tree, "b")).view.row.group, read.view.row.group);

  // A turn after the compaction, then a setting that makes Pi draw the whole transcript again.
  const f = await fixture({ busy: true });
  const announce = announcer(f);
  announce(kept);
  await f.rebuild("session_compact", [compaction, ...kept]);
  announce([compaction, ...kept]);
  (await nextTurn(f, "b")).result(result("ok"));
  announce([compaction, ...kept, ...turn("b", "bash", { command: "make" }, "compaction")]);
  const first = f.call("read", "a", { path: "a.ts" });
  assert.equal(f.call("bash", "b", { command: "make" }).view.row.group, first.view.row.group);
  assert.equal((await nextTurn(f, "c")).view.row.group, first.view.row.group);
});

test("a message Pi does not draw separates nothing: a system message, or a hidden custom one", () => {
  const model = new ToolGroups();
  const add = (id: string) => {
    const row = model.addCall(id, "read", { path: `${id}.ts` }, root);
    assert(row, `${id} row`);
    return row;
  };
  const send = (value: object) => {
    const message = value as unknown as Message;
    model.startMessage(message, root);
    model.finishMessage(message, root);
  };
  const first = add("a");
  // A change of tools while Pi works, and an extension's message not to display.
  send({ role: "system", content: "", toolsAdded: [], timestamp: 1 });
  send({ role: "custom", customType: "note", content: "hidden", display: false, timestamp: 1 });
  assert.equal(add("b").group, first.group);
  send({ role: "custom", customType: "note", content: "shown", display: true, timestamp: 1 });
  assert.notEqual(add("c").group, first.group, "a custom message Pi displays is a boundary");
});

test("rebuilt from the session, a hidden custom message between calls separates nothing", async () => {
  const f = await fixture();
  const note = {
    type: "custom_message",
    id: "note",
    parentId: "a-result",
    timestamp,
    customType: "note",
    content: "hidden",
    display: false,
  };
  await f.rebuild("session_start", [...kept, note, ...turn("b", "read", { path: "b.ts" }, "note")]);
  assert.equal(plain(f.call("read", "a", { path: "a.ts" }).view), "✓ Explored 2 files ▸");
});
