// How rows word durations, costs, line counts and paths, so rows drawn by different extensions
// read alike. Pure functions: each extension loads its own copy of this module, and every copy
// answers the same.
import { homedir } from "node:os";

/** Pi's formats: `1.2s`, `2m 5s`, `1h 2m 5s`. */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${total % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${total % 60}s`;
}

/** Pi's format: cents from one cent up, two significant digits below a cent. */
export function formatCost(cost: number): string {
  if (!cost) return "$0.00";
  return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

/** The added and removed lines of a diff as Pi's `edit` tool writes it, with line numbers. */
export function diffCounts(value: string): { added: number; removed: number } {
  let added = 0,
    removed = 0;
  for (const line of value.split("\n")) {
    if (/^\+\s*\d+ /.test(line)) added++;
    else if (/^-\s*\d+ /.test(line)) removed++;
  }
  return { added, removed };
}

/**
 * The lines in a write's content. Pi reports no diff for a write, and an overwrite's old content
 * is unknown, so a write counts only what it wrote.
 */
export function writtenLines(content: string): number {
  if (!content) return 0;
  const lines = content.split("\n").length;
  return content.endsWith("\n") ? lines - 1 : lines;
}

/** A path with the home directory as `~`. */
export function homePath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** The exit code Pi appends to a failed command's output. */
export function exitCode(output: string): string | undefined {
  return /Command exited with code (\d+)\s*$/.exec(output)?.[1];
}
