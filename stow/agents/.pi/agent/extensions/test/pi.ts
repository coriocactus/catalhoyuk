// Runtime access to the installed Pi for in-process tests. Types come from Pi's own
// declarations; values come from its installation, never a separately installed copy.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { piRequire, pkg } from "./pi-package.ts";

export { cli, piRequire, pkg, version } from "./pi-package.ts";

type CodingAgent = typeof import("@earendil-works/pi-coding-agent");
type Tui = typeof import("@earendil-works/pi-tui");
type Themes =
  typeof import("@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js");

/** Import a module from Pi's installed package by its path within the package. */
export function piModule<T>(path: string): Promise<T> {
  return import(pathToFileURL(join(pkg, path)).href) as Promise<T>;
}

export const core = await piModule<CodingAgent>("dist/index.js");
export const tui = (await import(
  pathToFileURL(piRequire.resolve("@earendil-works/pi-tui")).href
)) as Tui;
export const themes = await piModule<Themes>("dist/modes/interactive/theme/theme.js");
core.initTheme("dark");

const { createJiti } = piRequire("jiti") as typeof import("jiti");
const tuiEntry = piRequire.resolve("@earendil-works/pi-tui");
const jiti = createJiti(import.meta.url, {
  alias: {
    "@earendil-works/pi-coding-agent": join(pkg, "dist/index.js"),
    "@earendil-works/pi-tui": tuiEntry,
    typebox: piRequire.resolve("typebox"),
  },
});

/**
 * Load extension source the way Pi does (jiti), bound to the installed Pi.
 * Usage: `await load<typeof import("../index.ts")>("../index.ts", import.meta.url)`.
 */
export function load<T>(specifier: string, from: string): Promise<T> {
  return jiti.import<T>(fileURLToPath(new URL(specifier, from)));
}

let futureShim: string | undefined;
/**
 * Fresh extension modules that see a future Pi VERSION while sharing the rest of
 * the installed Pi. Exercises capability checks instead of a version allowlist.
 */
export function loadFuture<T>(specifier: string, from: string): Promise<T> {
  if (!futureShim) {
    const directory = mkdtempSync(join(tmpdir(), "pi-future-"));
    process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
    futureShim = join(directory, "future-pi.mjs");
    writeFileSync(
      futureShim,
      `export * from ${JSON.stringify(pathToFileURL(join(pkg, "dist/index.js")).href)};\nexport const VERSION = "999.0.0";\n`,
    );
  }
  const future = createJiti(import.meta.url, {
    moduleCache: false,
    fsCache: false,
    alias: { "@earendil-works/pi-coding-agent": futureShim, "@earendil-works/pi-tui": tuiEntry },
  });
  return future.import<T>(fileURLToPath(new URL(specifier, from)));
}
