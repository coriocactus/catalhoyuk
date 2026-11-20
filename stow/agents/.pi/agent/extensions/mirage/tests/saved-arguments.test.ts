// A script's call whose arguments were too large for Pi to save, rebuilt from the session: the
// script's result previews its arguments as JSON cut after 200 characters, and what the preview
// holds whole names the call.
import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "../../test/pi.ts";
import { fixture, mouse, plain, type Result } from "./fixture.ts";

const { previewArgs } = await load<typeof import("../nested.ts")>("../nested.ts", import.meta.url);

/** Pi's preview of a call's arguments: their JSON, cut to 197 characters and `...`. */
const cut = (args: object) => `${JSON.stringify(args).slice(0, 197)}...`;

test("a cut preview gives the arguments it holds whole", () => {
  const long = "a".repeat(300);
  assert.deepEqual(previewArgs(cut({ path: "big.txt", content: long })), { path: "big.txt" });
  // Commas inside strings, and members that are objects or lists, are read whole.
  assert.deepEqual(
    previewArgs(cut({ path: 'a,"b".txt', edits: [{ oldText: "x,y" }], content: long })),
    { path: 'a,"b".txt', edits: [{ oldText: "x,y" }] },
  );
  // Cut inside an escape.
  assert.deepEqual(previewArgs(`{"path":"p","content":"${"a".repeat(170)}\\u00...`), {
    path: "p",
  });
  // A preview whole is read whole.
  assert.deepEqual(previewArgs('{"command":"ls"}'), { command: "ls" });
  // Nothing whole before the cut: nothing.
  assert.equal(previewArgs(cut({ command: long })), undefined);
  assert.equal(previewArgs("models.classify"), undefined);
});

test("a saved write whose content Pi did not keep is named by its path", async () => {
  const f = await fixture();
  const details = {
    calls: [
      {
        id: "s/1",
        name: "write",
        args: cut({ path: "big.txt", content: "a".repeat(9000) }),
        status: "ok",
        durationMs: 3,
      },
    ],
  };
  const scriptResult: Result = {
    content: [
      { type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
      { type: "text", text: "done" },
    ],
    details,
  };
  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "s", name: "codemode", arguments: { code: "x" } }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "s",
        toolName: "codemode",
        ...scriptResult,
        isError: false,
        nestedCalls: {
          complete: false,
          calls: [{ id: "s/1", name: "write", argumentsBytes: 9000, status: "ok" }],
        },
      },
    },
  ];
  await f.rebuild("session_start", entries);
  const script = f.call("codemode", "s", { code: "x" });
  plain(script.view);
  script.view.handleMouse(mouse(0));
  // Pi reports the script's saved result too, which carries the preview.
  script.result(scriptResult);
  assert.match(plain(script.view), /^ {2}✓ Wrote big\.txt ▸$/m);
  f.expand(true);
  assert.match(plain(script.view), /Wrote big\.txt ▾\n {4}Content not kept in session\./);
});
