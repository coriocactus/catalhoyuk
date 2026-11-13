// Measures for test/e2e/perf.ts, from inside Pi: every fullscreen frame and its duration, and
// Pi's CPU time at each mark. A mark comes from the suite (SIGUSR2, its name in $PERF_DIR/mark)
// or from perf-provider.ts, in this process. Written to $PERF_DIR/probe.json as Pi exits.
// It changes no rendering: it times Pi's frame function and passes every call through.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";

/** Where perf-provider.ts finds the probe's `mark`, across the two extensions' module copies. */
export const MARK = Symbol.for("pi-catalhoyuk.perf.mark");

export interface Mark {
  name: string;
  /** Milliseconds since Pi started. */
  at: number;
  /** Pi's CPU time so far, user and system, in milliseconds. */
  cpu: number;
  /** Frames drawn so far. */
  frames: number;
}
export interface Probe {
  /** Each frame's duration in milliseconds, in order. */
  frames: number[];
  marks: Mark[];
}

export default function (_pi: ExtensionAPI) {
  const directory = process.env.PERF_DIR;
  if (!directory) throw new Error("PERF_DIR must point to the perf suite's directory.");
  const shared = globalThis as { [MARK]?: (name: string) => void };
  if (shared[MARK]) return; // A reload loads the probe again: the first stays.
  const probe: Probe = { frames: [], marks: [] };
  // Pi declares its frame function protected. It is wrapped, never replaced: the original runs
  // for every call, with the same receiver.
  const screen = TuiAltScreen.prototype as unknown as { doRender(this: TuiAltScreen): void };
  const doRender = screen.doRender;
  if (typeof doRender !== "function") throw new Error("Pi's fullscreen frame function is gone.");
  screen.doRender = function () {
    const started = performance.now();
    try {
      doRender.call(this);
    } finally {
      probe.frames.push(performance.now() - started);
    }
  };
  const mark = (name: string) => {
    const { user, system } = process.cpuUsage();
    probe.marks.push({
      name,
      at: performance.now(),
      cpu: (user + system) / 1000,
      frames: probe.frames.length,
    });
  };
  shared[MARK] = mark;
  process.on("SIGUSR2", () => mark(readFileSync(join(directory, "mark"), "utf8").trim()));
  process.on("exit", () => {
    mark("exit");
    writeFileSync(join(directory, "probe.json"), JSON.stringify(probe));
  });
}
