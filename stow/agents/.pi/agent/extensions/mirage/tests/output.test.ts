// What a call's expanded output shows: a command its header left part of, failed or not, other
// tools' JSON within Pi's bounds, and tool names a model made up, cleaned.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, mouse, plain, result } from "./fixture.ts";

test("a failed command whose lines left part of it out repeats it whole above its output", async () => {
  const f = await fixture();
  const command = "python3 - <<'EOF'\nimport sys\nprint('boom')\nsys.exit(3)\nEOF";
  const row = f.call("bash", "heredoc", { command });
  plain(row.view);
  row.view.handleMouse(mouse(0));
  const bodies = (row.view as unknown as { bodies: Map<string, unknown> }).bodies;
  const chunks = () => [...bodies.keys()].filter((key) => key.startsWith("heredoc\0chunk"));
  row.result(result("boom"), false, true);
  plain(row.view);
  assert(chunks().length, "a running command's output is laid out in chunks");
  row.result(result("boom\n\nCommand exited with code 3"), true);
  assert.match(
    plain(row.view),
    /^ {2}\$ python3 - <<'EOF' … 3 lines \(exit code: 3\)\n {2}\$ python3 - <<'EOF'\n {2}import sys\n {2}print\('boom'\)\n {2}sys\.exit\(3\)\n {2}EOF\n {2}boom$/m,
  );
  assert.deepEqual(chunks(), [], "the chunks it grew in are forgotten once it has failed");
});

test("another tool's JSON is bounded as it is drawn, laid out", async () => {
  const f = await fixture();
  const row = f.call("some_tool", "json", { query: "q" });
  // One line of 48KB, within Pi's bounds as it comes, and 24,002 lines once laid out.
  row.result(result(JSON.stringify(Array.from({ length: 24000 }, () => 0))));
  plain(row.view);
  row.view.handleMouse(mouse(0));
  const lines = plain(row.view).split("\n");
  assert.equal(lines.length, 1 + 2000 + 1, "its header, the first 2000 lines, and a note");
  assert.deepEqual(
    lines.slice(1, 3).map((line) => line.trim()),
    ["[", "0,"],
  );
  assert.equal(lines.at(-1)?.trim(), "Showing the first 2000 of 24002 lines.");
});

test("a tool's name is one clean line in a summary, as in the tool's own row", async () => {
  const f = await fixture();
  const name = "lookup\nSECOND LINE\x1b]0;title\x07\x1b[2J";
  const read = f.call("read", "read", { path: "a.ts" });
  read.result(result("x"));
  f.call(name, "made-up", { query: "q" }).result(result("ok"));
  assert.equal(plain(read.view), "✓ Read 1 file, called lookup SECOND LINE ▸");
  assert(!read.view.render(160).some((line) => line.includes("\x1b]0;")));

  await f.pi.event("user_bash");
  const script = f.call("codemode", "script", { code: "await tools.lookup({});" });
  const nested = (type: string, value: object) =>
    f.pi.event(
      `tool_execution_${type}`,
      { parentToolCallId: "script", toolCallId: "script/1", toolName: name, ...value },
      f.ctx,
    );
  await nested("start", { args: {} });
  await nested("end", { result: result("ok"), isError: false });
  assert.equal(plain(script.view), "… Script: called lookup SECOND LINE ▸");
});
