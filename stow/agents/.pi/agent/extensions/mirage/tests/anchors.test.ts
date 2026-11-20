// An anchor keeps the viewport on a line while a page is added above it: located again with
// nothing changed, it is the line it was captured on, in a script's row too.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, plain, result } from "./fixture.ts";

test("an anchor captured on any line of an expanded group locates that line again", async () => {
  const f = await fixture();
  f.expand(true);
  const read = f.call("read", "read", { path: "a.ts" });
  read.result(result("l1\nl2\nl3"));
  const script = f.call("codemode", "script", { code: "const a = 1;\nconst b = 2;\nreturn a;" });
  for (const id of ["1", "2"]) {
    const nested = (type: string, value: object) =>
      f.pi.event(
        `tool_execution_${type}`,
        { parentToolCallId: "script", toolCallId: `script/${id}`, toolName: "read", ...value },
        f.ctx,
      );
    await nested("start", { args: { path: `f${id}.ts` } });
    await nested("end", { result: result("x\ny"), isError: false });
  }
  script.result({
    content: [
      { type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
      { type: "text", text: "out 1\nout 2\nout 3" },
    ],
    details: { calls: [] },
  });
  const lines = plain(read.view).split("\n");
  // The script's own lines are its header, its source, and its output after its nested calls.
  assert.match(lines.join("\n"), /JavaScript, 3 lines ▾\n {6}const a = 1;/);
  assert.match(lines.join("\n"), /Read f2\.ts ▾\n {6}x\n {6}y\n {4}out 1\n {4}out 2\n {4}out 3$/);
  for (const [line, text] of lines.entries()) {
    const anchor = read.view.capture(line, 160);
    assert(anchor, `line ${line} has an anchor`);
    assert.equal(read.view.locate(anchor, 160), line, `line ${line}: ${text}`);
  }
});
