import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import type { FileReference } from "../file-tools-shared/protocol.ts";

interface PiPathResolvers {
  resolveToCwd(path: string, cwd: string): string;
  resolveReadPathAsync(path: string, cwd: string): Promise<string>;
}

let resolvers: Promise<PiPathResolvers> | undefined;

/**
 * Pi does not publicly export its tool path resolvers. Keep this compatibility
 * dependency isolated rather than reimplementing Unicode/macOS fallback rules.
 * An incompatible Pi release fails visibly on click, never opens a guessed path.
 */
function loadResolvers(): Promise<PiPathResolvers> {
  resolvers ??= import(
    pathToFileURL(join(getPackageDir(), "dist/core/tools/path-utils.js")).href
  ).then((module) => {
    if (
      typeof module.resolveToCwd !== "function" ||
      typeof module.resolveReadPathAsync !== "function"
    ) {
      throw new Error("This Pi version does not expose the expected tool path resolvers.");
    }
    return module as PiPathResolvers;
  });
  return resolvers;
}

export async function resolveToolFile(file: FileReference): Promise<string> {
  const paths = await loadResolvers();
  return file.tool === "read"
    ? paths.resolveReadPathAsync(file.path, file.cwd)
    : paths.resolveToCwd(file.path, file.cwd);
}
