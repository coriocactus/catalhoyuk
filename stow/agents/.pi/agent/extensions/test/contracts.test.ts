// Cross-extension identifiers. Producers and consumers must agree on these strings
// and global symbol keys even when loaded from separate module roots.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ROW_ANCHOR } from "../shared/anchors.ts";
import { HISTORY_PAGE } from "../shared/history.ts";
import {
  isNestedRowsRequest,
  NESTED_ROWS_EVENT,
  type NestedRowsRequest,
} from "../shared/nested.ts";
import { isOpenFileRequest, OPEN_FILE_EVENT } from "../shared/protocol.ts";
import {
  CONTENT_START,
  CONTINUES_JOINED,
  CONTINUES_SPACED,
  findMarker,
} from "../shared/selection.ts";
import { isTranscriptView, TRANSCRIPT_VIEW } from "../shared/transcript.ts";
import { fakePi } from "./fake-pi.ts";
import { loadAlone } from "./pi.ts";

test("shared presentation identifiers use the owning extensions' namespaces", () => {
  assert.equal(OPEN_FILE_EVENT, "inspector:open");
  assert.equal(NESTED_ROWS_EVENT, "mirage:nested-rows");
  assert.equal(TRANSCRIPT_VIEW, "rearview:transcript-view");
  assert.equal(Symbol.keyFor(HISTORY_PAGE), "rearview.history-page.v1");
  assert.equal(Symbol.keyFor(ROW_ANCHOR), "rearview.row-anchor.v1");
});

test("payload guards accept well-formed messages and reject malformed ones", () => {
  assert(isNestedRowsRequest({}));
  for (const invalid of [null, undefined, "rows", 1]) assert(!isNestedRowsRequest(invalid));
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
  const scope = {};
  assert(isTranscriptView({ ...view, scope, history: [], prepend: true }));
  for (const invalid of [
    undefined,
    { ...view, expanded: 1 },
    { ...view, entries: [{ id: 1 }] },
    { ...view, scope: "not-an-object" },
    { ...view, scope: null },
    { ...view, history: {} },
    { ...view, prepend: "yes" },
  ])
    assert(!isTranscriptView(invalid));
});

test("selection markers are private, zero-width APC sequences, found in row order", () => {
  for (const marker of [CONTENT_START, CONTINUES_SPACED, CONTINUES_JOINED]) {
    assert(marker.startsWith("\x1b_pi-select;") && marker.endsWith("\x1b\\"), "an APC sequence");
    assert(!marker.startsWith("\x1b_G"), "never a kitty image command");
  }
  assert.equal(findMarker(`  ${CONTINUES_SPACED}x${CONTENT_START}`)?.marker, CONTINUES_SPACED);
  assert.equal(findMarker("plain"), undefined);
});

test("extensions meet through shared/ though Pi gives each its own copy of it", async (t) => {
  // An event's name and payload are the contract: mirage's copy of shared/nested.ts answers an
  // asker that holds another.
  const mirage = await loadAlone<typeof import("../mirage/index.ts")>(
    "../mirage/index.ts",
    import.meta.url,
  );
  const asker = await loadAlone<typeof import("../shared/nested.ts")>(
    "../shared/nested.ts",
    import.meta.url,
  );
  assert.notEqual(asker.isNestedRowsRequest, isNestedRowsRequest, "the asker holds its own copy");
  const pi = fakePi();
  mirage.default(pi.api);
  t.after(() => pi.event("session_shutdown"));
  const request: NestedRowsRequest = {};
  pi.events.emit(asker.NESTED_ROWS_EVENT, request);
  assert(request.rows, "mirage answers");

  // A patch keeps its record on what it patches, so two copies of shared/patch.ts share it.
  const copies = await Promise.all(
    [1, 2].map(() =>
      loadAlone<typeof import("../shared/patch.ts")>("../shared/patch.ts", import.meta.url),
    ),
  );
  assert.notEqual(copies[0].installPatch, copies[1].installPatch);
  class Target {
    method() {
      return "native";
    }
  }
  const key = "test.contracts.patch.v1";
  const [first, second] = copies.map((copy, index) =>
    copy.installPatch<number, undefined>({
      key,
      name: "the test's adapter",
      sites: [{ target: Target.prototype, name: "method" }],
      owner: index,
      build: () => ({ methods: [() => "patched"], state: undefined }),
    }),
  );
  assert.deepEqual([first.first, second.first], [true, false], "the second joins the first");
  assert.equal(second.record, first.record);
  assert.deepEqual([...first.record.owners], [0, 1]);
  assert.equal(new Target().method(), "patched");
  first.release();
  assert.equal(new Target().method(), "patched", "still held by the other copy's owner");
  second.release();
  assert.equal(new Target().method(), "native");
  assert(!copies[0].isPatched(key, Target.prototype));
});
