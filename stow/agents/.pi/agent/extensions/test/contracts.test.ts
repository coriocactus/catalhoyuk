// Cross-extension identifiers. Producers and consumers must agree on these strings
// and global symbol keys even when loaded from separate module roots.
import assert from "node:assert/strict";
import { test } from "node:test";
import { HISTORY_PAGE } from "../shared/history.ts";
import { isOpenFileRequest, OPEN_FILE_EVENT } from "../shared/protocol.ts";
import { isTranscriptView, TRANSCRIPT_VIEW } from "../shared/transcript.ts";

test("shared presentation identifiers use the owning extensions' namespaces", () => {
  assert.equal(OPEN_FILE_EVENT, "inspector:open");
  assert.equal(TRANSCRIPT_VIEW, "rearview:transcript-view");
  assert.equal(Symbol.keyFor(HISTORY_PAGE), "rearview.history-page.v1");
});

test("payload guards accept well-formed messages and reject malformed ones", () => {
  const request = { path: "a.txt", cwd: "/tmp", tool: "read", accepted: false };
  assert(isOpenFileRequest(request));
  for (const invalid of [
    null,
    { ...request, path: "" },
    { ...request, cwd: "relative" },
    { ...request, tool: "bash" },
    { ...request, accepted: "no" },
  ])
    assert(!isOpenFileRequest(invalid));
  const view = { sessionId: "s", cwd: "/tmp", expanded: false, entries: [{ id: "e", type: "x" }] };
  assert(isTranscriptView(view));
  for (const invalid of [undefined, { ...view, expanded: 1 }, { ...view, entries: [{ id: 1 }] }])
    assert(!isTranscriptView(invalid));
});
