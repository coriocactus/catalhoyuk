// Comrade summarises its comrades' calls in mirage's words and counts, with its own copies
// so the extensions stay independent. These must not drift apart.
import assert from "node:assert/strict";
import { test } from "node:test";
import { load } from "./pi.ts";

const comrade = await load<typeof import("../comrade/work.ts")>(
  "../comrade/work.ts",
  import.meta.url,
);
const comradeView = await load<typeof import("../comrade/view.ts")>(
  "../comrade/view.ts",
  import.meta.url,
);
const mirage = await load<typeof import("../mirage/view.ts")>("../mirage/view.ts", import.meta.url);

test("comrade counts diffs and written lines as mirage does", () => {
  for (const diff of ["", "+ 1 a\n- 2 b\n  3 c\n+12 d", "-  9 x\n+ 10 y\n+ 11 z", "+x\n-y"])
    assert.deepEqual(comrade.diffCounts(diff), mirage.diffCounts(diff), JSON.stringify(diff));
  for (const content of ["", "one", "one\n", "one\ntwo", "one\ntwo\n\n"])
    assert.equal(
      comrade.writtenLines(content),
      mirage.writtenLines(content),
      JSON.stringify(content),
    );
});

test("comrade formats durations as mirage and Pi do", () => {
  for (const ms of [0, 1234, 59_949, 60_000, 754_000, 3_600_000, 3_725_000])
    assert.equal(comradeView.formatDuration(ms), mirage.formatDuration(ms), String(ms));
});
