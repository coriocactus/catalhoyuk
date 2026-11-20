import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { fake, fakePi } from "../../test/fake-pi.ts";
import { load, tui } from "../../test/pi.ts";

const { default: install } = await load<typeof import("../index.ts")>(
  "../index.ts",
  import.meta.url,
);

const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Prose loaded while Pi's Markdown has an unexpected shape, so that it has one warning. `chat`
 * holds what reaches the transcript, in order.
 */
function warned(t: TestContext) {
  const prototype = tui.Markdown.prototype as unknown as { render(width: number): string[] };
  const original = prototype.render;
  prototype.render = () => ["something else"];
  const pi = fakePi();
  install(pi.api);
  const chat: string[] = [];
  let input: ((data: string) => unknown) | undefined;
  const ctx = fake<ExtensionContext>({
    mode: "tui",
    ui: {
      notify: (message) => chat.push(message),
      onTerminalInput(handler) {
        input = handler;
        return () => {
          input = undefined;
        };
      },
    },
  });
  t.after(() => {
    pi.emit("session_shutdown", { reason: "quit" }, ctx);
    prototype.render = original;
  });
  return {
    chat,
    start: (reason: SessionStartEvent["reason"]) => pi.emit("session_start", { reason }, ctx),
    /** What Pi's terminal does with a key: every input listener sees it. */
    key: () => input?.("x"),
    get listening() {
      return input !== undefined;
    },
  };
}

test("at startup the warning waits for the first key, so it lands below the transcript", async (t) => {
  const f = warned(t);
  f.start("startup");
  // Pi draws the session's transcript after session_start at startup.
  f.chat.push("TRANSCRIPT");
  await tick();
  assert.deepEqual(f.chat, ["TRANSCRIPT"]);
  f.key();
  assert.deepEqual(f.chat, ["TRANSCRIPT"], "not while Pi handles the key");
  await tick();
  assert.equal(f.chat.length, 2);
  assert.match(f.chat[1], /Markdown code blocks changed\. prose left Pi's own Markdown\./);
  assert(!f.listening, "the first key is the last one it reads");
  f.key();
  await tick();
  assert.equal(f.chat.length, 2, "once");
});

for (const reason of ["reload", "new", "resume", "fork"] as const) {
  test(`after /${reason} the warning lands at once, below the transcript Pi drew first`, async (t) => {
    const f = warned(t);
    f.chat.push("TRANSCRIPT");
    f.start(reason);
    await tick();
    assert.equal(f.chat.length, 2);
    assert.match(f.chat[1], /Markdown code blocks changed/);
    assert(!f.listening);
  });
}
