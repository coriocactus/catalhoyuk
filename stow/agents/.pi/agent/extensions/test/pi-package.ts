// Locate the INSTALLED Pi package. Tests exercise it, not a separately installed copy.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

interface Manifest {
  name?: string;
  version: string;
  bin?: string | { pi?: string };
}

let directory =
  process.env.PI_PACKAGE_DIR ||
  dirname(realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim()));
while (!existsSync(join(directory, "package.json")) && dirname(directory) !== directory)
  directory = dirname(directory);
const manifest: Manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
if (manifest.name !== "@earendil-works/pi-coding-agent")
  throw new Error("Set PI_PACKAGE_DIR to the installed @earendil-works/pi-coding-agent package.");

const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
if (typeof bin !== "string") throw new Error("Pi's package does not declare its CLI executable.");

export const version = manifest.version;
export const pkg = directory;
export const cli = join(pkg, bin);
/** Resolve Pi's own dependencies (pi-tui, typebox, jiti) from its installation. */
export const piRequire = createRequire(join(pkg, "package.json"));
