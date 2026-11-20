import assert from "node:assert/strict";
import { test } from "node:test";
import { core, load } from "../../test/pi.ts";
import { assistant, text, transcript } from "../../test/transcript.ts";

const { installHistoryAdapter } = await load<typeof import("../native.ts")>(
  "../native.ts",
  import.meta.url,
);

/** What Pi draws in regular mode when a compaction ends, with or without Rearview. */
function compacted(adapted: boolean): string {
  const f = transcript(0),
    sm = core.SessionManager.inMemory(process.cwd());
  f.host.sessionManager = sm;
  f.host.ui.mode = "regular";
  for (let i = 0; i < 6; i++) {
    sm.appendMessage({ role: "user", content: `PROMPT_${i}`, timestamp: 1 });
    sm.appendMessage(assistant(`REPLY_${i}`));
  }
  // The compaction keeps the last two turns, starting with a prompt.
  sm.appendCompaction("CHECKPOINT", sm.getEntries()[8].id, 1000);
  const adapter = adapted
    ? installHistoryAdapter((error) => {
        throw error;
      })
    : undefined;
  try {
    // Pi rebuilds the transcript from the entries the compaction kept, then adds the summary.
    f.chat.clear();
    f.host.renderSessionEntries(sm.buildContextEntries().slice(1));
    return text(f.document);
  } finally {
    adapter?.dispose();
  }
}

test("in regular mode, where no page can load, a compaction adds no blank line on top", () => {
  assert.equal(compacted(true), compacted(false));
});
