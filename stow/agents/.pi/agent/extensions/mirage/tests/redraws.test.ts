// A nested call's event and a click change the model before mirage asks Pi to draw the row
// again. Pi invalidates the row first, but only what changed is drawn afresh: the calls beside
// it keep what was built for them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { tui } from "../../test/pi.ts";
import { component, fixture, internals, mouse, plain, result } from "./fixture.ts";

/** A view's private caches, which show what a frame built again. */
interface Caches {
  row: { group: { rows: object[] } };
  drawnCalls: WeakMap<object, object>;
  bodies: Map<string, { component: object }>;
  made: Map<string, object>;
}

const caches = (row: object) => internals(row).rendererState.view as unknown as Caches;

test("a nested call's event draws again only what changed in its script's group", async () => {
  const f = await fixture({ busy: true });
  f.expand(true);
  const code = 'await tools.read({ path: "a.ts" });';
  const script = component("codemode", "script", { code }, f.tool("codemode"), f.dir);
  script.markExecutionStarted();
  const read = component("read", "read", { path: "b.ts" }, f.tool("read"), f.dir);
  read.updateResult({ ...result("const b = 1;"), isError: false });
  const nested = (type: string, value: object) =>
    f.pi.event(`tool_execution_${type}`, { parentToolCallId: "script", ...value }, f.ctx);
  await nested("start", { toolCallId: "script/1", toolName: "read", args: { path: "a.ts" } });
  const output = result("const a = 1;");
  await nested("end", { toolCallId: "script/1", toolName: "read", result: output, isError: false });
  await nested("start", { toolCallId: "script/2", toolName: "bash", args: { command: "make" } });
  plain(script);
  const view = caches(script);
  const [, readRow] = view.row.group.rows;
  const drawn = view.drawnCalls.get(readRow);
  const body = view.bodies.get("read")?.component;
  const highlighted = view.made.get("read");
  const finished = view.bodies.get("script/1")?.component;
  assert(drawn && body && highlighted && finished, "the script leads its group, drawn whole");

  const partialResult = result("BUILDING");
  await nested("update", { toolCallId: "script/2", toolName: "bash", partialResult });
  assert.match(plain(script), /BUILDING/, "the nested command's output is drawn");
  assert.equal(view.drawnCalls.get(readRow), drawn, "the finished read is not drawn again");
  assert.equal(view.bodies.get("read")?.component, body, "nor laid out again");
  assert.equal(view.made.get("read"), highlighted, "nor highlighted again");
  assert.equal(view.bodies.get("script/1")?.component, finished, "nor the script's finished call");
});

test("a click draws again only the call it expands or collapses", async () => {
  const f = await fixture();
  f.expand(true);
  const reads = ["a", "b", "c"].map((id) => {
    const row = component("read", id, { path: `${id}.ts` }, f.tool("read"), f.dir);
    row.updateResult({ ...result(`const ${id} = 1;`), isError: false });
    return row;
  });
  const leader = reads[0];
  const lines = leader.render(160);
  const view = caches(leader);
  const [first] = view.row.group.rows;
  const drawn = view.drawnCalls.get(first);
  const body = view.bodies.get("a")?.component;
  assert(drawn && body, "the group is drawn expanded");

  const y = lines.findIndex((line) => tui.stripTerminalSequences(line).includes("Read c.ts"));
  leader.handleMouse({ ...mouse(2, y), height: lines.length });
  assert(!plain(leader).includes("const c = 1;"), "the call clicked collapsed");
  assert.match(plain(leader), /const a = 1;/);
  assert.equal(view.drawnCalls.get(first), drawn, "the calls beside it are not drawn again");
  assert.equal(view.bodies.get("a")?.component, body);
});
