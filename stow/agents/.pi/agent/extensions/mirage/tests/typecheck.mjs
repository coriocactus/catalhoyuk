import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pkg, version } from "./pi-package.mjs";

const extension = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(join(tmpdir(), "pi-mirage-types-"));
try {
  const paths = Object.fromEntries(
    ["pi-ai", "pi-agent-core", "pi-tui"].map((name) => [
      `@earendil-works/${name}`,
      [join(pkg, `node_modules/@earendil-works/${name}/dist/index.d.ts`)],
    ]),
  );
  paths["@earendil-works/pi-coding-agent"] = [join(pkg, "dist/index.d.ts")];
  paths.typebox = [join(pkg, "node_modules/typebox/build/index.d.mts")];
  const config = join(temporary, "tsconfig.json");
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        skipLibCheck: true,
        allowImportingTsExtensions: true,
        typeRoots: [join(pkg, "node_modules/@types")],
        paths,
      },
      files: [
        join(extension, "index.ts"),
        join(extension, "tests/offline-provider.ts"),
        join(extension, "../inspector/index.ts"),
        join(extension, "../rearview/index.ts"),
        join(extension, "../interupt/index.ts"),
      ],
    }),
  );
  execFileSync("tsc", ["-p", config], { stdio: "inherit" });
  console.log(`PASS: TypeScript (Pi ${version}, Node ${process.versions.node}; ${pkg})`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
