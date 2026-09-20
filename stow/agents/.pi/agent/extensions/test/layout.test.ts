import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("Pi autoloads exactly the four extensions; test and shared code never load", () => {
  // Pi loads top-level script files and subdirectories with an index entry point.
  const loaded = readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isFile()) return /\.[cm]?[jt]s$/.test(entry.name) ? [entry.name] : [];
    if (!entry.isDirectory()) return [];
    return ["index.ts", "index.js"]
      .filter((name) => existsSync(join(root, entry.name, name)))
      .map((name) => `${entry.name}/${name}`);
  });
  assert.deepEqual(loaded.sort(), [
    "inspector/index.ts",
    "interupt/index.ts",
    "mirage/index.ts",
    "rearview/index.ts",
  ]);
});
