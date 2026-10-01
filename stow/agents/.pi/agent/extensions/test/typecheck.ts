// Strict TypeScript against the INSTALLED Pi's declarations. The config is
// generated because those declarations live wherever Pi is installed.
import { execFileSync } from "node:child_process";
import { globSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dependencyRoot, pkg, version } from "./pi-package.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
// Every extension entry point, every test, and all test support code.
const files = globSync(["*/index.ts", "*/tests/**/*.ts", "test/**/*.ts"], { cwd: root })
  .filter((file) => !file.startsWith("node_modules/"))
  .map((file) => join(root, file));

// Pi's installer may hoist dependencies beside the package rather than inside it.
const piPackages = ["pi-ai", "pi-agent-core", "pi-tui"].map((name) => [
  `@earendil-works/${name}`,
  [join(dependencyRoot(`@earendil-works/${name}`), "dist/index.d.ts")],
]);
const typeRoots = dirname(dependencyRoot("@types/node"));
const temporary = mkdtempSync(join(tmpdir(), "pi-extensions-types-"));
try {
  const config = join(temporary, "tsconfig.json");
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        target: "ES2023",
        module: "ESNext",
        moduleResolution: "Bundler",
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        // Node runs tests by stripping types: only erasable syntax and explicit type imports.
        erasableSyntaxOnly: true,
        verbatimModuleSyntax: true,
        typeRoots: [typeRoots],
        paths: {
          ...Object.fromEntries(piPackages),
          "@earendil-works/pi-coding-agent": [join(pkg, "dist/index.d.ts")],
          "@earendil-works/pi-coding-agent/*": [join(pkg, "*")],
          typebox: [join(dependencyRoot("typebox"), "build/index.d.mts")],
          jiti: [join(dependencyRoot("jiti"), "lib/jiti.d.mts")],
        },
      },
      files,
    }),
  );
  execFileSync("tsc", ["-p", config], { stdio: "inherit" });
  console.log(
    `PASS: TypeScript, ${files.length} roots (Pi ${version}, Node ${process.versions.node}; ${pkg})`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
