// What a comrade did, folded into counts and rows: paths as Pi's tools take them.
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { load } from "../../test/pi.ts";

const { callRow, Ledger } = await load<typeof import("../work.ts")>("../work.ts", import.meta.url);

test("a call on ~/x is on a file in the home directory, as Pi's tools take it", () => {
  assert.equal(
    callRow("read", { path: "~/notes.md" }, "/tmp/project", "success").label,
    "Read ~/notes.md",
  );
  const ledger = new Ledger("/tmp/project");
  ledger.start("1", "read", { path: "~/notes.md" });
  ledger.start("2", "read", { path: join(homedir(), "notes.md") });
  ledger.start("3", "ls", { path: "~" });
  const work = ledger.snapshot();
  assert.equal(work.tallies[0].files, 1, "one file, read twice");
  assert.equal(work.current, "Listing ~");
});
