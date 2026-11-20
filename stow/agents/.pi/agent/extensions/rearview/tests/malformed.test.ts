import assert from "node:assert/strict";
import { test } from "node:test";
import type { UserMessage } from "@earendil-works/pi-ai";
import { core, load } from "../../test/pi.ts";
import { assistant, text, transcript } from "../../test/transcript.ts";

const { HistoryCursor, recentEntries } = await load<typeof import("../model.ts")>(
  "../model.ts",
  import.meta.url,
);
const { installHistoryAdapter } = await load<typeof import("../native.ts")>(
  "../native.ts",
  import.meta.url,
);

/** Session files are parsed without validation: old, forked or edited ones can lack content. */
const missing = null as unknown as UserMessage["content"];

/** A transcript of `sm` whose editor records the prompts Pi adds to its history. */
function recorded(sm: ReturnType<typeof core.SessionManager.inMemory>) {
  const f = transcript(0),
    prompts: string[] = [];
  f.host.sessionManager = sm;
  Object.assign(f.host, { editor: { addToHistory: (prompt: string) => prompts.push(prompt) } });
  return { f, prompts };
}

test("a prompt without content leaves paging on and prompt history as Pi's own", () => {
  const sm = core.SessionManager.inMemory(process.cwd());
  for (let i = 0; i < 40; i++) {
    sm.appendMessage({ role: "user", content: i === 5 ? missing : `PROMPT_${i}`, timestamp: 1 });
    sm.appendMessage(assistant(`REPLY_${i}`));
  }
  const native = recorded(sm);
  native.f.host.renderSessionEntries(sm.buildContextEntries(), { populateHistory: true });
  assert.equal(native.prompts.length, 39);
  const errors: unknown[] = [];
  const adapter = installHistoryAdapter((error) => errors.push(error), 10);
  try {
    const { f, prompts } = recorded(sm);
    f.host.renderSessionEntries(sm.buildContextEntries(), { populateHistory: true });
    assert.deepEqual(errors, []);
    assert.equal(text(f.chat).match(/REPLY_/g)?.length, 5, "the transcript is still bounded");
    assert.deepEqual(prompts, native.prompts);
  } finally {
    adapter.dispose();
  }
});

test("a fallback part-way through prompt history adds no prompt twice", () => {
  const sm = core.SessionManager.inMemory(process.cwd());
  for (let i = 0; i < 40; i++) {
    sm.appendMessage({ role: "user", content: `PROMPT_${i}`, timestamp: 1 });
    sm.appendMessage(assistant(`REPLY_${i}`));
  }
  const errors: unknown[] = [];
  const adapter = installHistoryAdapter((error) => errors.push(error), 10);
  try {
    const { f, prompts } = recorded(sm);
    // Pi's reading of a prompt fails once, while Rearview collects the prompts it does not draw.
    const read = f.host as unknown as { getUserMessageText(message: unknown): string };
    const own = read.getUserMessageText;
    let failed = false;
    read.getUserMessageText = function (message) {
      const prompt = own.call(this, message);
      if (prompt !== "PROMPT_7" || failed) return prompt;
      failed = true;
      throw new Error("glitch");
    };
    f.host.renderSessionEntries(sm.buildContextEntries(), { populateHistory: true });
    assert.equal(errors.length, 1, "history paging falls back, with one warning");
    assert.equal(text(f.chat).match(/REPLY_/g)?.length, 40);
    assert.deepEqual(
      prompts,
      Array.from({ length: 40 }, (_, i) => `PROMPT_${i}`),
    );
  } finally {
    adapter.dispose();
  }
});

test("a result without its call bounds its page, and older pages still load", () => {
  for (const older of [300, 6000]) {
    const sm = core.SessionManager.inMemory(process.cwd());
    for (let i = 0; i < older; i++) sm.appendMessage(assistant(`OLD_${i}`));
    sm.appendMessage({
      role: "toolResult",
      toolCallId: "orphan",
      toolName: "read",
      content: [{ type: "text", text: "x" }],
      isError: false,
      timestamp: 1,
    });
    for (let i = 0; i < 5; i++) sm.appendMessage(assistant(`NEW_${i}`));
    assert(recentEntries(sm.buildContextEntries(), 10).length < 300, "the first view is bounded");
    const cursor = new HistoryCursor(sm.getLeafId(), (id) => sm.getEntry(id), new Set());
    const sizes: number[] = [];
    for (let page = cursor.prepare(10); page; page = cursor.prepare(10)) {
      sizes.push(page.entries.length);
      cursor.commit(page);
    }
    assert(sizes[0] > 10 && sizes[0] < 300, `the orphan's page: ${sizes[0]} entries`);
    assert(
      sizes.slice(1, -1).every((size) => size === 10),
      "the pages above it",
    );
    assert.equal(
      sizes.reduce((sum, size) => sum + size, 0),
      older + 6,
      "paging reaches the root",
    );
  }
});
