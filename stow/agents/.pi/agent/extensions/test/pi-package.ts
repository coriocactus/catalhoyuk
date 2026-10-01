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

const NAME = "@earendil-works/pi-coding-agent";

/**
 * Pi's managed installer puts a shell launcher in `<agent>/bin` and releases in
 * `<agent>/install`.
 */
function managedPackage(launcher: string): string | undefined {
  const install = join(dirname(dirname(launcher)), "install");
  const current = join(install, "current-version");
  if (!existsSync(current)) return undefined;
  const release = readFileSync(current, "utf8").trim();
  return join(install, "releases", release, "node_modules", NAME);
}

function locate(): string {
  if (process.env.PI_PACKAGE_DIR) return process.env.PI_PACKAGE_DIR;
  const launcher = realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim());
  let directory = dirname(launcher);
  while (!existsSync(join(directory, "package.json")) && dirname(directory) !== directory)
    directory = dirname(directory);
  return existsSync(join(directory, "package.json"))
    ? directory
    : (managedPackage(launcher) ?? directory);
}

const directory = locate();
const manifestPath = join(directory, "package.json");
const manifest: Manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : { version: "" };
if (manifest.name !== NAME) throw new Error(`Set PI_PACKAGE_DIR to the installed ${NAME} package.`);

const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
if (typeof bin !== "string") throw new Error("Pi's package does not declare its CLI executable.");

export const version = manifest.version;
export const pkg = directory;
export const cli = join(pkg, bin);
/** Resolve Pi's own dependencies (pi-tui, typebox, jiti) from its installation. */
export const piRequire = createRequire(join(pkg, "package.json"));

/** Root directory of one of Pi's dependencies, wherever the installer placed it. */
export function dependencyRoot(name: string): string {
  // Search Node's lookup directories directly. Resolving an entry point fails when a
  // package's exports hide it.
  for (const directory of piRequire.resolve.paths(name) ?? []) {
    const root = join(directory, name);
    if (existsSync(join(root, "package.json"))) return root;
  }
  throw new Error(`Cannot locate Pi's ${name} dependency.`);
}
