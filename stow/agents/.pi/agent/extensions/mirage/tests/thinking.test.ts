import assert from "node:assert/strict";
import { test } from "node:test";
import { core, load, loadFuture, tui } from "../../test/pi.ts";
import { assistant } from "../../test/transcript.ts";

const { installNativeThinking } = await load<typeof import("../native-thinking.ts")>(
  "../native-thinking.ts",
  import.meta.url,
);
const plain = (component: InstanceType<typeof core.AssistantMessageComponent>) =>
  component.render(100).map((line) => tui.stripTerminalSequences(line).trimEnd());
const thinking = { type: "thinking" as const, thinking: "PRIVATE_REASONING" };

test("hidden thinking takes no rows, restores on toggles, and never alters messages", () => {
  const original = core.AssistantMessageComponent.prototype.updateContent;
  const visibility: boolean[] = [];
  const release = installNativeThinking(
    (error) => {
      throw error;
    },
    (hidden) => visibility.push(hidden),
  );
  try {
    const message = assistant("", [thinking]);
    Object.freeze(message.content[0]);
    Object.freeze(message.content);
    Object.freeze(message);
    const component = new core.AssistantMessageComponent(message, true);
    assert.deepEqual(plain(component), []);
    component.invalidate();
    assert.deepEqual(plain(component), []);
    component.setHideThinkingBlock(false);
    assert(plain(component).join("\n").includes("PRIVATE_REASONING"));
    component.setHideThinkingBlock(true);
    component.setHiddenThinkingLabel("CUSTOM_PLACEHOLDER");
    component.setOutputPad(0);
    assert.deepEqual(plain(component), []);
    const streamed = assistant("", [
      thinking,
      { type: "text", text: "Thinking... is literal text" },
    ]);
    const before = JSON.stringify(streamed);
    component.updateContent(streamed, true);
    assert.deepEqual(plain(component), ["", "Thinking... is literal text"]);
    component.invalidate();
    component.setHideThinkingBlock(false);
    assert(plain(component).join("\n").includes("PRIVATE_REASONING"));
    assert.equal(JSON.stringify(streamed), before);
    assert(visibility.includes(true) && visibility.includes(false));
    for (const stopReason of ["error", "aborted", "length"] as const) {
      component.setHideThinkingBlock(true);
      component.updateContent({ ...message, stopReason, errorMessage: "VISIBLE_FAILURE" });
      const output = plain(component).join("\n");
      assert.match(output, stopReason === "length" ? /truncated/ : /VISIBLE_FAILURE/);
      assert(!output.includes("PRIVATE_REASONING") && !output.includes("CUSTOM_PLACEHOLDER"));
    }
  } finally {
    release();
    release();
  }
  assert.equal(core.AssistantMessageComponent.prototype.updateContent, original);
  assert.match(
    plain(new core.AssistantMessageComponent(assistant("", [thinking]), true)).join("\n"),
    /Thinking/,
  );
});

test("thinking adapter checks capabilities, reports once and respects patch ownership", async (t) => {
  const future = await loadFuture<typeof import("../native-thinking.ts")>(
    "../native-thinking.ts",
    import.meta.url,
  );
  const prototype = core.AssistantMessageComponent.prototype;
  const calls: unknown[] = [];
  const native = t.mock.method(prototype, "updateContent", (message: unknown) => {
    calls.push(message);
  });
  const warnings: string[] = [];
  const release = future.installNativeThinking(
    (error) => warnings.push(error.message),
    () => {},
  );
  const second = future.installNativeThinking(
    (error) => warnings.push(error.message),
    () => {},
  );
  const wrapped = prototype.updateContent;
  try {
    const message = assistant("", [thinking]);
    Reflect.apply(wrapped, {}, [message]);
    Reflect.apply(wrapped, {}, [message]);
    assert.deepEqual(calls, [message, message]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Pi 999\.0\.0: thinking adapter API changed/);
    release();
    assert.equal(prototype.updateContent, wrapped, "other owner remains active");
    prototype.updateContent = () => {};
    assert.throws(
      () =>
        future.installNativeThinking(
          () => {},
          () => {},
        ),
      /Another extension/,
    );
    second();
    assert.notEqual(prototype.updateContent, wrapped, "never overwrite another patch");
    // Restore our wrapper only for test cleanup; a real conflict requires restart.
    prototype.updateContent = wrapped;
    const cleanup = future.installNativeThinking(
      () => {},
      () => {},
    );
    cleanup();
    assert.equal(prototype.updateContent, native);
  } finally {
    release();
    second();
  }
});
