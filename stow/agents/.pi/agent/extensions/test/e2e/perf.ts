// Performance budgets, measured on real Pi over a PTY: once with Pi alone and once with the
// extensions, on the same streamed reply (perf-provider.ts), with tool output expanded (Ctrl+O),
// where rows cost most. No model or network calls. Budgets are ratios to Pi alone, so they
// hold on a slower machine, except idle, where Pi and the extensions must do nothing at all.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { HeadlessTerminal } from "../headless-terminal.ts";
import { cli, version } from "../pi-package.ts";
import type { Probe } from "./perf-probe.ts";

const here = dirname(fileURLToPath(import.meta.url));
const extensions = resolve(here, "../..");
/** Every extension Pi would load, in its discovery order. */
const loaded = readdirSync(extensions, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(extensions, entry.name, "index.ts")))
  .map((entry) => entry.name)
  .sort();

/** How long Pi is watched idle, before the reply and after it. */
const IDLE_MS = 3000;
/** The budgets. Each ratio is the extensions' cost over Pi's own in the same phase. */
const BUDGET = {
  /** Idle: CPU time in milliseconds per watch (half a percent of a core), and frames drawn. */
  idleCpuMs: IDLE_MS * 0.005,
  idleFrames: 1,
  /**
   * A write's 400 lines streaming in, below 1,200 expanded lines of the same group. Measured
   * 1.1 to 1.3. Highlighting the whole write for every frame, not only its new lines, measured
   * 1.8 to 2.1.
   */
  writeCpu: 1.5,
  /**
   * Calls in progress in that group, one of them a command printing for 3 s. Measured 1.8 to
   * 2.2. A spinner frame that built the group's output again measured 5.2 to 7.6.
   */
  toolsCpu: 3.5,
};

interface Phase {
  wallMs: number;
  cpuMs: number;
  frames: number;
  /** Frame durations in milliseconds. */
  p50: number;
  p99: number;
}

const root = mkdtempSync(join(tmpdir(), "pi-perf-"));

async function measure(name: "alone" | "extended"): Promise<Map<string, Phase>> {
  const directory = join(root, name);
  const agent = join(directory, "config");
  mkdirSync(join(agent, "extensions"), { recursive: true });
  mkdirSync(join(directory, "src"));
  writeFileSync(
    join(agent, "settings.json"),
    JSON.stringify({
      lastChangelogVersion: version,
      theme: "dark",
      tuiMode: "fullscreen",
      quietStartup: true,
      hideThinkingBlock: true,
      outputPad: 1,
      terminal: { hyperlinks: true, trueColor: true },
      enableInstallTelemetry: false,
      showCacheMissNotices: false,
    }),
  );
  // A comrade's own Pi discovers extensions in the agent directory: it needs the provider.
  writeFileSync(
    join(agent, "extensions", "perf-provider.ts"),
    `export { default } from ${JSON.stringify(join(here, "perf-provider.ts"))};\n`,
  );
  for (let file = 0; file < 3; file++)
    writeFileSync(
      join(directory, `src/file-${file}.ts`),
      `${Array.from({ length: 400 }, (_, i) => `export const line${i} = ${i};`).join("\n")}\n`,
    );
  const env: Record<string, string | undefined> = {
    ...process.env,
    PI_CODING_AGENT_DIR: agent,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "xterm",
    PERF_DIR: directory,
  };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.PI_COMRADE;
  const terminal = await HeadlessTerminal.start(
    process.execPath,
    [
      cli,
      "--offline",
      "--session",
      join(directory, "session.jsonl"),
      "--no-extensions",
      "-e",
      "builtin:codemode",
      ...(name === "extended"
        ? loaded.flatMap((extension) => ["-e", join(extensions, extension, "index.ts")])
        : []),
      "-e",
      join(here, "perf-provider.ts"),
      "-e",
      join(here, "perf-probe.ts"),
      "--provider",
      "perf",
      "--model",
      "stream",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
    ],
    { cwd: directory, env, artifacts: directory, name, cols: 150, rows: 50 },
  );
  const mark = async (label: string) => {
    writeFileSync(join(directory, "mark"), label);
    process.kill(terminal.pid, "SIGUSR2");
    await delay(40);
  };
  /** Resolves once the terminal has received nothing for `ms`. */
  const quiet = async (ms: number) => {
    let last = terminal.mark();
    for (let since = performance.now(); performance.now() - since < ms; ) {
      await delay(15);
      if (terminal.mark() === last) continue;
      last = terminal.mark();
      since = performance.now();
    }
  };
  try {
    await terminal.waitFor((screen) => screen.includes("stream"), "the footer names the model");
    await quiet(400);
    terminal.send("\x0f"); // Ctrl+O: tool output expanded from here on.
    await quiet(400);
    await mark("idle");
    await delay(IDLE_MS);
    await mark("reply");
    terminal.send("PERF_TOOLS\r");
    await terminal.waitFor((screen) => screen.includes("PERF_TOOLS_DONE"), "the reply", 60_000);
    await quiet(500);
    if (name === "extended") {
      terminal.send("PERF_COMRADE\r");
      await terminal.waitFor(
        (screen) => screen.includes("PERF_COMRADE_DONE"),
        "a comrade in the foreground, then one in the background",
        90_000,
      );
      await quiet(500);
    }
    await mark("rest");
    await delay(IDLE_MS);
    await mark("end");
    terminal.save();
    terminal.send("/quit\r");
    for (let i = 0; i < 400 && !existsSync(join(directory, "probe.json")); i++) await delay(25);
  } catch (error) {
    terminal.save();
    throw error;
  } finally {
    await terminal.close().catch(() => {});
  }
  const probe: Probe = JSON.parse(readFileSync(join(directory, "probe.json"), "utf8"));
  const phases = new Map<string, Phase>();
  for (const [index, from] of probe.marks.entries()) {
    const to = probe.marks[index + 1];
    if (!to) break;
    const frames = probe.frames.slice(from.frames, to.frames).sort((a, b) => a - b);
    const at = (share: number) =>
      frames[Math.min(frames.length - 1, Math.floor(frames.length * share))] ?? 0;
    phases.set(from.name, {
      wallMs: to.at - from.at,
      cpuMs: to.cpu - from.cpu,
      frames: frames.length,
      p50: at(0.5),
      p99: at(0.99),
    });
  }
  return phases;
}

try {
  const alone = await measure("alone");
  const extended = await measure("extended");
  const phase = (phases: Map<string, Phase>, name: string) => {
    const found = phases.get(name);
    assert(found, `phase ${name} was measured`);
    return found;
  };
  const one = (p: Phase) =>
    `${p.cpuMs.toFixed(0)} ms CPU in ${(p.wallMs / 1000).toFixed(1)} s, ${p.frames} frames, p50 ${p.p50.toFixed(1)} p99 ${p.p99.toFixed(1)} ms`;
  const describe = (name: string) =>
    `${name}: Pi alone ${one(phase(alone, name))}; with extensions ${one(phase(extended, name))}`;
  // A comrade's runs have no counterpart in Pi alone: reported, and budgeted only by the rest
  // that follows them.
  const report = [
    ...["idle", "write", "tools", "rest"].map(describe),
    ...["foreground", "background"].map(
      (name) => `comrade in the ${name}: ${one(phase(extended, name))}`,
    ),
  ].join("\n  ");
  // Idle before the reply and at rest after it, a comrade's two runs included: nothing runs.
  for (const [who, phases] of [
    ["Pi alone", alone],
    ["with extensions", extended],
  ] as const)
    for (const name of ["idle", "rest"]) {
      const { cpuMs, frames } = phase(phases, name);
      assert(
        cpuMs <= BUDGET.idleCpuMs && frames <= BUDGET.idleFrames,
        `${who}, ${name}: ${cpuMs.toFixed(1)} ms CPU and ${frames} frames in ${IDLE_MS} ms; the budget is ${BUDGET.idleCpuMs} ms and ${BUDGET.idleFrames} frame.\n  ${report}`,
      );
    }
  const ratio = (name: string, of: (phase: Phase) => number) =>
    of(phase(extended, name)) / Math.max(1, of(phase(alone, name)));
  for (const [name, measured, budget, what] of [
    ["write", ratio("write", (p) => p.cpuMs), BUDGET.writeCpu, "CPU while a write streams in"],
    ["tools", ratio("tools", (p) => p.cpuMs), BUDGET.toolsCpu, "CPU while calls are in progress"],
  ] as const)
    assert(
      measured <= budget,
      `${what} is ${measured.toFixed(2)} times Pi's own; the budget is ${budget}.\n  ${describe(name)}`,
    );
  console.log(
    `PASS: budgets hold against Pi ${version} alone, tool output expanded. Write streaming ${ratio("write", (p) => p.cpuMs).toFixed(2)}x CPU (budget ${BUDGET.writeCpu}), calls in progress ${ratio("tools", (p) => p.cpuMs).toFixed(2)}x CPU (${BUDGET.toolsCpu}), idle ${phase(extended, "idle").cpuMs.toFixed(1)} ms CPU in ${IDLE_MS} ms (${BUDGET.idleCpuMs}).\n  ${report}\n  Artifacts: ${root}`,
  );
} catch (error) {
  console.error(`Performance test failed. Artifacts: ${root}`);
  throw error;
}
