// The Pi a comrade runs, and how a comrade notices that the Pi that started it is gone.
import { existsSync } from "node:fs";
import { basename } from "node:path";
import type { Invocation } from "./run.ts";
import { alive } from "./runs.ts";

/** How often a comrade checks that its host is still running. */
const ORPHAN_MS = 2000;

/**
 * The running Pi itself, so comrades use the same release and extensions. Resolved for each
 * run: an upgrade can delete the runtime under a running Pi (Homebrew removes the old Cellar
 * version), and then the one of the same name on PATH takes its place.
 */
export function currentPi(
  execPath = process.execPath,
  script = process.argv[1],
  exists: (path: string) => boolean = existsSync,
): Invocation {
  const runtime = exists(execPath) ? execPath : undefined;
  if (script && !script.startsWith("/$bunfs/") && exists(script))
    return { command: runtime ?? basename(execPath), args: [script] };
  if (runtime && !/^(node|bun)(\.exe)?$/i.test(basename(runtime)))
    return { command: runtime, args: [] };
  return { command: "pi", args: [] };
}

/**
 * A comrade stops when its host is gone, rather than run on unseen. Pi's shutdown stops
 * comrades itself; this covers a host that crashed or was killed.
 */
export function watchHost(
  host: number,
  every = ORPHAN_MS,
  stop: () => void = () => process.kill(process.pid, "SIGTERM"),
): () => void {
  if (!Number.isInteger(host) || host <= 1) return () => {};
  const timer = setInterval(() => {
    if (alive(host)) return;
    clearInterval(timer);
    stop();
  }, every);
  timer.unref();
  return () => clearInterval(timer);
}
