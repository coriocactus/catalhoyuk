// What the caller knows of each comrade run, saved beside the comrade's conversation as it goes
// (`comrade-3.jsonl` keeps `comrade-3.runs.json`). It says which Pi runs it, so no other Pi
// carries it on meanwhile; whether its prompt has reached the comrade, so one that never did is
// sent again rather than told to carry on; what it sends, to send it again; and, once it ends,
// its answer until the caller's session holds it. Pi holds a message that arrives during a turn
// in memory until the turn ends, so an answer Pi exits with first is delivered from here.
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

export interface RunRecord<D = unknown> {
  /** The run: its start row's tool call id, or a resumed run's own. */
  run: string;
  /** A background run, which the session carries on if Pi exits during it. */
  background: boolean;
  /** The Pi running it. */
  owner: number;
  /** The comrade's own Pi, once started. */
  child?: number;
  /** When this run started. */
  started: number;
  /** When this record last changed: when the run was cut off, if it was. */
  at: number;
  /** `starting`: its prompt may not have reached the comrade. `asked`: Pi saved it. `done`: ended. */
  phase: "starting" | "asked" | "done";
  /** What it sends, to send again if it never reached the comrade. */
  task: string;
  files: string[];
  output?: string;
  timeoutMs?: number;
  /** Once done, a background run's answer for the caller's session. */
  answer?: { delivery: D; body: string };
}

/** `comrade-3.jsonl` keeps its runs in `comrade-3.runs.json`. */
export const runsFile = (session: string) => `${session.replace(/\.jsonl$/, "")}.runs.json`;

const isRecord = (value: unknown): value is RunRecord =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as RunRecord).run === "string" &&
  typeof (value as RunRecord).owner === "number" &&
  typeof (value as RunRecord).task === "string";

/** The comrade's runs. A missing or damaged file holds none, and a damaged record is skipped. */
export function readRuns<D>(session: string): RunRecord<D>[] {
  try {
    const runs = JSON.parse(readFileSync(runsFile(session), "utf8"));
    return Array.isArray(runs) ? (runs.filter(isRecord) as RunRecord<D>[]) : [];
  } catch {
    return [];
  }
}

/** Replaces the file whole, so a reader never sees half of it. With no runs left, no file. */
function writeRuns<D>(session: string, runs: RunRecord<D>[]): void {
  const file = runsFile(session);
  if (!runs.length) {
    rmSync(file, { force: true });
    return;
  }
  const partial = `${file}.${process.pid}.tmp`;
  writeFileSync(partial, JSON.stringify(runs), { mode: 0o600 });
  renameSync(partial, file);
}

/** Saves a run's record, replacing any of the same run, stamped with the time. */
export function saveRun<D>(session: string, record: Omit<RunRecord<D>, "at">): void {
  const runs = readRuns<D>(session).filter((saved) => saved.run !== record.run);
  writeRuns(session, [...runs, { ...record, at: Date.now() }]);
}

/** Changes a saved run's record, stamped with the time. A run with no record stays without. */
export function updateRun<D>(session: string, run: string, change: Partial<RunRecord<D>>): void {
  const runs = readRuns<D>(session);
  const index = runs.findIndex((record) => record.run === run);
  if (index < 0) return;
  runs[index] = { ...runs[index], ...change, run, at: Date.now() };
  writeRuns(session, runs);
}

/** Drops the records of these runs. */
export function dropRuns(session: string, runs: ReadonlySet<string>): void {
  const all = readRuns(session);
  const left = all.filter((record) => !runs.has(record.run));
  if (left.length !== all.length) writeRuns(session, left);
}

/** Whether process `pid` exists. EPERM: it does, but is not ours to signal. */
export function alive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether another Pi runs it now: its owner is alive and not this Pi, and its comrade's Pi,
 * once started, is alive too, so a process id reused since does not hold it forever.
 */
export const elsewhere = (record: RunRecord) =>
  record.phase !== "done" &&
  record.owner !== process.pid &&
  alive(record.owner) &&
  (record.child === undefined || alive(record.child));

/** When the conversation was last written, or never. */
export function modified(file: string): number {
  return statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;
}
