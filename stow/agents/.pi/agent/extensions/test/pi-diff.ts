// Upgrade review: what changed in the Pi modules the extensions import, between the Pi
// release they were last reviewed against (`piReviewed` in package.json) and the installed one.
//
//   npm run pi-diff                # reviewed release -> installed release
//   npm run pi-diff -- 1.2.0       # another release -> installed release
//   npm run pi-diff -- --reviewed  # record the installed release as reviewed
//   node test/pi-diff.ts --status  # one line, printed at the end of npm run verify
//
// No file list is kept by hand. Every Pi symbol that extension code imports, including types,
// is traced through Pi's re-exports to the module that defines it. An adapter that patches a
// Pi class must import it, so its module is watched as soon as the adapter exists.
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dependencyRoot, pkg, version } from "./pi-package.ts";

const CODING_AGENT = "@earendil-works/pi-coding-agent";
const PI_PACKAGE = /^@earendil-works\/[^/]+$/;
const root = fileURLToPath(new URL("..", import.meta.url));
const manifestPath = join(root, "package.json");
export const reviewed: unknown = JSON.parse(readFileSync(manifestPath, "utf8")).piReviewed;

/** Pi packages of one release, by package name. */
export interface Release {
  version: string;
  dir(name: string): string;
}

export const installed: Release = {
  version,
  dir: (name) => (name === CODING_AGENT ? pkg : dependencyRoot(name)),
};

/** Package -> symbol -> importing files. */
export type Imports = Map<string, Map<string, Set<string>>>;

/** Adds one file's Pi imports. Throws on import forms that cannot be traced to a module. */
export function importsIn(file: string, source: string, imports: Imports = new Map()): Imports {
  if (/import\s*\(\s*["']@earendil-works\/|import\s+["']@earendil-works\//.test(source))
    throw new Error(`${file}: import Pi symbols by name so upgrade review watches their modules.`);
  const statements =
    /\b(?:import|export)\s+(?:type\s+)?([^;]*?)\s+from\s+["'](@earendil-works\/[^"']+)["']/g;
  for (const [, clause, name] of source.matchAll(statements)) {
    const names = /^\{([^}]*)\}$/.exec(clause.trim())?.[1];
    if (names === undefined || !PI_PACKAGE.test(name))
      throw new Error(`${file}: use named imports from the ${name} package entry point.`);
    const symbols = imports.get(name) ?? new Map<string, Set<string>>();
    imports.set(name, symbols);
    for (const [, symbol] of listed(names)) {
      const users = symbols.get(symbol) ?? new Set<string>();
      symbols.set(symbol, users.add(file));
    }
  }
  return imports;
}

/** Pi imports of extension code: everything except tests and test support. */
export function piImports(): Imports {
  const imports: Imports = new Map();
  const files = globSync("**/*.ts", { cwd: root })
    .filter((file) => !/^(?:node_modules|test)\//.test(file) && !file.includes("/tests/"))
    .sort();
  for (const file of files) importsIn(file, readFileSync(join(root, file), "utf8"), imports);
  return imports;
}

/** `[local, original]` pairs of an import/export list such as `a, type b, c as d`. */
function listed(list: string): [string, string][] {
  return list.split(",").flatMap((item): [string, string][] => {
    const [original, local = original] = item
      .trim()
      .replace(/^type\s+/, "")
      .split(/\s+as\s+/);
    return original ? [[local, original]] : [];
  });
}

function typesEntry(dir: string): string {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const types = manifest.exports?.["."]?.types ?? manifest.types ?? manifest.typings;
  if (typeof types !== "string") throw new Error(`${manifest.name} declares no types entry.`);
  return join(dir, types);
}

/** A defining module: its package, and its path in that package without an extension. */
export interface Location {
  name: string;
  module: string;
}

/**
 * Follows Pi's declarations from a package entry point to the module that defines `symbol`,
 * across Pi packages. Undefined when the release does not export it, or when it comes from
 * a package outside Pi.
 */
export function definingModule(
  release: Release,
  name: string,
  symbol: string,
): Location | undefined {
  const visited = new Set<string>();
  const search = (name: string, file: string | undefined, wanted: string): Location | undefined => {
    if (!file || visited.has(`${file}\0${wanted}`) || !existsSync(file)) return undefined;
    visited.add(`${file}\0${wanted}`);
    const source = readFileSync(file, "utf8");
    const here = { name, module: relative(release.dir(name), file).replace(/\.d\.ts$/, "") };
    const follow = (target: string, imported: string) =>
      target.startsWith(".")
        ? search(name, declarationFile(file, target), imported)
        : PI_PACKAGE.test(target)
          ? search(target, typesEntry(release.dir(target)), imported)
          : undefined;
    const kinds = "class|function|const|let|var|interface|type|enum|namespace";
    const declaration = `^export\\s+(?:declare\\s+)?(?:abstract\\s+)?(?:${kinds})\\s+${wanted}\\b`;
    if (new RegExp(declaration, "m").test(source)) return here;
    // `export { a as b } from "..."`, or `export { b }` of an import or local declaration.
    const lists = /^export\s+(?:type\s+)?\{([^}]*)\}\s*(?:from\s*["']([^"']+)["'])?/gm;
    for (const [, list, target] of source.matchAll(lists))
      for (const [exported, original] of listed(list)) {
        if (exported !== wanted) continue;
        if (target) return follow(target, original);
        const imports = /^import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/gm;
        for (const [, names, from] of source.matchAll(imports))
          for (const [local, imported] of listed(names))
            if (local === original) return follow(from, imported);
        return here;
      }
    for (const [, target] of source.matchAll(/^export\s+\*\s+from\s*["']([^"']+)["']/gm)) {
      const found = follow(target, wanted);
      if (found) return found;
    }
    return undefined;
  };
  const declarationFile = (from: string, target: string): string => {
    const stem = join(dirname(from), target).replace(/\.(?:d\.ts|ts|js)$/, "");
    return existsSync(`${stem}.d.ts`) ? `${stem}.d.ts` : join(stem, "index.d.ts");
  };
  return search(name, typesEntry(release.dir(name)), symbol);
}

/** A watched module and the imports that it defines: symbol -> package imported from. */
export interface Watched extends Location {
  symbols: Map<string, string>;
  users: Set<string>;
}

export function watchedModules(release: Release = installed): Watched[] {
  const modules = new Map<string, Watched>();
  for (const [name, symbols] of piImports())
    for (const [symbol, users] of symbols) {
      const location = definingModule(release, name, symbol);
      if (!location)
        throw new Error(`Pi ${release.version}: cannot trace ${symbol} from ${name} to a module.`);
      const key = `${location.name}/${location.module}`;
      const entry = modules.get(key) ?? { ...location, symbols: new Map(), users: new Set() };
      entry.symbols.set(symbol, name);
      for (const user of users) entry.users.add(user);
      modules.set(key, entry);
    }
  return [...modules.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.module.localeCompare(b.module),
  );
}

function compareVersions(a: string, b: string): number {
  const [x, y] = [a, b].map((value) => value.split(/[.+-]/).slice(0, 3).map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

/**
 * Pi's managed installer keeps the release that ran the last update beside the active one.
 * Older releases, and every release of a package install, come from npm. Pi publishes its
 * packages in lockstep, so each is fetched at the release's own version.
 */
export function release(at: string): Release {
  if (at === version) return installed;
  const releases = dirname(dirname(dirname(dirname(pkg))));
  const managed = join(releases, at, "node_modules");
  if (basename(releases) === "releases" && existsSync(join(managed, CODING_AGENT)))
    return { version: at, dir: (name) => join(managed, name) };
  const cache = mkdtempSync(join(tmpdir(), `pi-${at}-`));
  console.log(`Pi ${at} is not installed; fetching its packages from npm into ${cache}.\n`);
  return {
    version: at,
    dir(name) {
      const target = join(cache, name);
      if (existsSync(target)) return target;
      const packed = execFileSync(
        "npm",
        ["pack", `${name}@${at}`, "--json", "--pack-destination", cache],
        { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
      );
      mkdirSync(target, { recursive: true });
      const tarball = join(cache, JSON.parse(packed)[0].filename);
      execFileSync("tar", ["-xzf", tarball, "-C", target, "--strip-components", "1"]);
      return target;
    },
  };
}

function read(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Files of a package's `dist`, without source maps or the CLI bundle. */
function distFiles(dir: string): string[] {
  return globSync("dist/**/*", { cwd: dir }).filter(
    (file) =>
      !file.endsWith(".map") &&
      !file.startsWith("dist/bundle/") &&
      statSync(join(dir, file)).isFile(),
  );
}

function review(from: Release, to: Release): void {
  console.log(`Pi ${from.version} -> ${to.version}\n`);
  const changelog = read(join(to.dir(CODING_AGENT), "CHANGELOG.md")) ?? "";
  const sections = changelog.split(/^(?=## \[)/m).filter((section) => {
    const at = /^## \[([^\]]+)\]/.exec(section)?.[1];
    return (
      at !== undefined &&
      compareVersions(at, from.version) > 0 &&
      compareVersions(at, to.version) <= 0
    );
  });
  console.log(`== Changelog\n\n${sections.join("").trim() || "(no entries)"}\n`);

  const watched = watchedModules(to);
  const diffed = new Set<string>();
  const diffs: string[] = [];
  console.log(`== ${watched.length} modules the extensions import`);
  for (const { name, module, symbols, users } of watched) {
    const before = [...symbols].map(([symbol, imported]) => definingModule(from, imported, symbol));
    const previous = before.find((location) => location !== undefined) ?? { name, module };
    const notes: string[] = [];
    if (before.includes(undefined)) notes.push(`exports new in ${to.version}`);
    if (previous.name !== name || previous.module !== module)
      notes.push(`moved from ${previous.name}/${previous.module}`);
    let changed = false;
    for (const extension of [".js", ".d.ts"]) {
      const paths = [
        join(from.dir(previous.name), previous.module + extension),
        join(to.dir(name), module + extension),
      ];
      diffed.add(`${previous.name}/${previous.module}${extension}`);
      diffed.add(`${name}/${module}${extension}`);
      if (read(paths[0]) === read(paths[1])) continue;
      changed = true;
      const labels = [
        `${from.version}/${previous.name}/${previous.module}${extension}`,
        `${to.version}/${name}/${module}${extension}`,
      ];
      const files = paths.map((path) => (existsSync(path) ? path : "/dev/null"));
      const diff = spawnSync(
        "diff",
        ["-u", "--label", labels[0], "--label", labels[1], files[0], files[1]],
        { encoding: "utf8" },
      );
      if (diff.status !== 1) throw new Error(`diff failed: ${diff.stderr || diff.error}`);
      diffs.push(diff.stdout);
    }
    const imported = `${[...symbols.keys()].join(", ")} <- ${[...users].join(", ")}`;
    const status = changed ? "CHANGED  " : "unchanged";
    const note = notes.length ? ` [${notes.join("; ")}]` : "";
    console.log(`${status} ${name}/${module} (${imported})${note}`);
  }
  if (diffs.length) console.log(`\n== Diffs of changed modules\n\n${diffs.join("\n")}`);

  const others: string[] = [];
  for (const name of new Set(watched.map((entry) => entry.name))) {
    const files = new Set([...distFiles(from.dir(name)), ...distFiles(to.dir(name))]);
    for (const file of [...files].sort()) {
      if (diffed.has(`${name}/${file}`)) continue;
      const [a, b] = [read(join(from.dir(name), file)), read(join(to.dir(name), file))];
      if (a === b) continue;
      const status = a === undefined ? "added  " : b === undefined ? "removed" : "changed";
      others.push(`${status} ${name}/${file}`);
    }
  }
  console.log(`\n== ${others.length} other changed files in those packages\n${others.join("\n")}`);
  console.log("\nNext: npm run verify. After the review: npm run pi-diff -- --reviewed");
}

function main(args: string[]): void {
  if (args.includes("--status")) {
    console.log(
      reviewed === version
        ? `PASS: extensions reviewed against the installed Pi ${version}.`
        : `REVIEW PENDING: Pi ${version} is installed, but the extensions were last reviewed against Pi ${String(reviewed)}. See README: After upgrading Pi.`,
    );
    return;
  }
  if (args.includes("--reviewed")) {
    const text = readFileSync(manifestPath, "utf8");
    if (!/"piReviewed":/.test(text)) throw new Error("package.json has no piReviewed field.");
    const updated = text.replace(/("piReviewed":\s*)"[^"]*"/, `$1${JSON.stringify(version)}`);
    writeFileSync(manifestPath, updated);
    console.log(`Recorded Pi ${version} as reviewed in package.json. Commit it with the upgrade.`);
    return;
  }
  const from = args[0] ?? reviewed;
  if (typeof from !== "string" || !/^\d+\.\d+\.\d+/.test(from))
    throw new Error("Pass a Pi version, or set piReviewed in package.json.");
  if (from === version)
    console.log(`Pi ${version} is the reviewed release. Pass an older version to compare.`);
  else review(release(from), installed);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
