// Upgrade review must see every Pi module extension code depends on. These tests fail
// when an import cannot be traced, rather than letting the review silently watch less.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { importsIn, installed, piImports, reviewed, watchedModules } from "./pi-diff.ts";

test("Pi imports must be named imports from package entry points", () => {
  const imports = importsIn(
    "a.ts",
    'import { a, type B, c as d } from "@earendil-works/pi-tui";\nimport type {\n  E,\n} from "@earendil-works/pi-ai";\n',
  );
  assert.deepEqual([...(imports.get("@earendil-works/pi-tui")?.keys() ?? [])], ["a", "B", "c"]);
  assert.deepEqual([...(imports.get("@earendil-works/pi-ai")?.keys() ?? [])], ["E"]);
  for (const source of [
    'import * as tui from "@earendil-works/pi-tui";',
    'import tui from "@earendil-works/pi-tui";',
    'import { a } from "@earendil-works/pi-tui/dist/tui.js";',
    'import "@earendil-works/pi-tui";',
    'type T = typeof import("@earendil-works/pi-tui");',
  ])
    assert.throws(() => importsIn("a.ts", source), /^Error: a\.ts: /, source);
});

test("every Pi symbol extension code imports traces to the installed module defining it", () => {
  const watched = watchedModules();
  const imported = [...piImports().values()].flatMap((symbols) => [...symbols.keys()]);
  const traced = watched.flatMap((entry) => [...entry.symbols.keys()]);
  assert.deepEqual(new Set(traced), new Set(imported));
  for (const { name, module, symbols } of watched) {
    const declarations = readFileSync(join(installed.dir(name), `${module}.d.ts`), "utf8");
    for (const symbol of symbols.keys())
      assert.match(declarations, new RegExp(`\\b${symbol}\\b`), `${name}/${module}: ${symbol}`);
  }
});

test("the Pi release the extensions were last reviewed against is recorded", () => {
  assert.match(String(reviewed), /^\d+\.\d+\.\d+/);
});
