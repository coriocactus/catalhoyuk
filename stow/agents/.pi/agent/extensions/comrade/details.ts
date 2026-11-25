// What a comrade's rows keep in the session: the details of its call's row, and of the message
// that delivers a background run's answer. Rows are drawn from them, and a later run of the
// comrade starts from them.
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { emptyUsage, type Progress, type Request, starting } from "./run.ts";
import type { Face, RunDetails } from "./view.ts";
import { emptyWork } from "./work.ts";

/** The custom type of the message that delivers a background run's answer. */
export const MESSAGE = "comrade";

export interface Details extends RunDetails {
  usage: Usage;
  exitCode?: number | null;
  /** Stopped with Esc, rather than failed. */
  stopped?: boolean;
  /** The comrade's number. Rows saved by older versions number only background comrades. */
  id?: number;
  /** Background comrades: the task's first line. */
  task?: string;
  /** A background comrade's start row. */
  background?: boolean;
  /** The model as asked for, under its provider: what a follow-up runs unless told otherwise. */
  requested?: { provider: string; model: string };
  /** A run that resumes one Pi exited during: when that one started. */
  from?: number;
}

/** A steer sent to comrade #id. Its row keeps this: there was no run of its own. */
export interface Steer {
  id: number;
  steered: true;
  title?: string;
}

/**
 * What a session entry kept of a comrade: a run's details, a steer's, or a delivery's. It is read
 * back from a session file, which an older version may have written, so any part of it may be
 * missing.
 */
export type Saved = Partial<Delivery> & Partial<Steer>;

/** Whether saved usage has the counts and the cost a row reads. */
function isUsage(usage: unknown): boolean {
  return (
    typeof usage === "object" &&
    usage !== null &&
    "input" in usage &&
    typeof usage.input === "number" &&
    "output" in usage &&
    typeof usage.output === "number" &&
    "cacheRead" in usage &&
    typeof usage.cacheRead === "number" &&
    "cacheWrite" in usage &&
    typeof usage.cacheWrite === "number" &&
    "cost" in usage &&
    typeof usage.cost === "object" &&
    usage.cost !== null &&
    "total" in usage.cost &&
    typeof usage.cost.total === "number"
  );
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Whether each of these parts is absent, or of the type a row reads it as. */
const optional = (saved: Record<string, unknown>, type: string, keys: readonly string[]) =>
  keys.every((key) => saved[key] === undefined || typeof saved[key] === type);

/** A call as a row names it, by its label. */
const isCallRow = (row: unknown) => isObject(row) && typeof row.label === "string";

/** Whether saved work has the tallies a row sums up and the calls it names. */
function isWork(work: unknown): boolean {
  return (
    isObject(work) &&
    Array.isArray(work.tallies) &&
    work.tallies.every(isObject) &&
    Array.isArray(work.rows) &&
    work.rows.every(isCallRow) &&
    (work.recent === undefined || (Array.isArray(work.recent) && work.recent.every(isCallRow))) &&
    optional(work, "number", ["omitted"]) &&
    optional(work, "string", ["current"])
  );
}

/** The parts of run details a row reads as text, and as numbers, when they are there. */
const TEXTS = ["title", "chip", "cwd", "reason", "answer", "task", "stopReason", "session"];
const NUMBERS = ["id", "files", "started", "ended"];

/**
 * Whether saved details have everything a row shows of a run, each part of the type the row
 * reads it as. A row draws a run only from details that pass: a row that throws as Pi draws it
 * takes Pi down.
 */
export function hasRunDetails(saved: unknown): saved is Saved & RunDetails {
  if (typeof saved !== "object" || saved === null) return false;
  if (
    !("model" in saved) ||
    !("thinking" in saved) ||
    !("tools" in saved) ||
    !("turns" in saved) ||
    !("calls" in saved) ||
    !("usage" in saved)
  )
    return false;
  const { model, thinking, tools, turns, calls, usage } = saved;
  const work = "work" in saved ? saved.work : undefined;
  return (
    typeof model === "string" &&
    typeof thinking === "string" &&
    Array.isArray(tools) &&
    tools.every((tool) => typeof tool === "string") &&
    typeof turns === "number" &&
    typeof calls === "number" &&
    isUsage(usage) &&
    optional(saved, "string", TEXTS) &&
    optional(saved, "number", NUMBERS) &&
    (work === undefined || isWork(work))
  );
}

/** The custom type of the entry `/comrades` adds to the transcript. It never reaches the model. */
export const LISTING = "comrades";

/** A background run that was in progress when it was listed, as its row in the listing shows it. */
export interface Listed {
  /** What its start row shows, as it stood when it was listed. */
  details: Saved & RunDetails & { id: number };
  /** The run, which the row follows while it goes on. Absent in jobs adopted from older versions. */
  run?: string;
  /** Its start row, whose ending the row says once the run has ended. */
  row?: string;
}

/** What a listing keeps: a `/comrades` entry's data, or a `comrades` call's details. */
export interface Listing {
  listed: Listed[];
  /**
   * When it was made. Only the newest listing follows its runs; an older one says how they stood
   * then. Absent in a stop's details, which record a stop rather than list what runs.
   */
  at?: number;
}

/** When a saved listing was made, or 0 if it does not say: older than any that does. */
export function atIn(saved: unknown): number {
  return typeof saved === "object" &&
    saved !== null &&
    "at" in saved &&
    typeof saved.at === "number" &&
    Number.isFinite(saved.at)
    ? saved.at
    : 0;
}

/** Whether saved details record a `comrades` call that stopped comrades. */
export function isStop(saved: unknown): boolean {
  return (
    typeof saved === "object" &&
    saved !== null &&
    "stopped" in saved &&
    Array.isArray(saved.stopped)
  );
}

const isListed = (value: unknown): value is Listed => {
  if (typeof value !== "object" || value === null || !("details" in value)) return false;
  const { details } = value;
  return (
    hasRunDetails(details) &&
    typeof details.id === "number" &&
    (!("run" in value) || typeof value.run === "string") &&
    (!("row" in value) || typeof value.row === "string")
  );
};

/** What stopping says of numbers that no background comrade running had. */
export const notRunning = (ids: readonly (number | string)[]) =>
  `No background comrade${ids.length === 1 ? "" : "s"} ${ids.map((id) => `#${id}`).join(", ")} running.`;

/** The numbers a saved `comrades` call asked to stop that no comrade had. */
export function missingIn(saved: unknown): number[] {
  if (typeof saved !== "object" || saved === null || !("missing" in saved)) return [];
  return Array.isArray(saved.missing)
    ? saved.missing.filter((id): id is number => typeof id === "number")
    : [];
}

/** The runs a saved listing names. Each is checked: a session file may hold anything. */
export function listedIn(saved: unknown): Listed[] {
  if (typeof saved !== "object" || saved === null || !("listed" in saved)) return [];
  return Array.isArray(saved.listed) ? saved.listed.filter(isListed) : [];
}

/** A background comrade's delivered message. */
export interface Delivery extends Details {
  id: number;
  task: string;
  /** `resumed` starts a run in the background, as a start row does; the rest end one. */
  status: "finished" | "failed" | "stopped" | "lost" | "resumed";
  durationMs?: number;
  /** The run it ends or starts: a start row's tool call id, or a resumed run's own. */
  run?: string;
  /** A resumed run: the start row that shows it while it goes. */
  row?: string;
}

const STATUSES = new Set<string>([
  "finished",
  "failed",
  "stopped",
  "lost",
  "resumed",
] satisfies Delivery["status"][]);

/** Whether a delivery's saved details have everything its row reads, each of the right type. */
export function isDelivery(saved: unknown): saved is Delivery {
  return (
    hasRunDetails(saved) &&
    typeof saved.id === "number" &&
    typeof saved.task === "string" &&
    typeof saved.status === "string" &&
    STATUSES.has(saved.status) &&
    isObject(saved) &&
    optional(saved, "number", ["durationMs"]) &&
    optional(saved, "string", ["run", "row"])
  );
}

/** Prefers what the comrade reports using over the name it was given. */
export function summary(request: Request, progress: Progress): Details {
  const { turns, calls, work, usage } = progress;
  return {
    model: progress.model ?? `${request.provider}/${request.model}`,
    thinking: progress.thinking ?? request.thinking,
    tools: request.tools,
    // Jobs adopted across a /reload from an older version have no files or session.
    ...(request.files?.length ? { files: request.files.length } : {}),
    ...(request.origin && request.cwd !== request.origin ? { cwd: request.cwd } : {}),
    turns,
    calls,
    work,
    usage,
    requested: { provider: request.provider, model: request.model },
    ...(request.session ? { session: request.session } : {}),
    ...(request.followUp ? { followUp: true } : {}),
    ...(request.resumed ? { resumed: true } : {}),
    ...request.face,
  };
}

/**
 * What a running comrade said last. A run from an older version, adopted across /reload, also
 * says the words of its thinking, marked `saidThinking`, with its text alone as `spoke`: a row
 * never shows those words, so it shows that text instead.
 */
function saidIn(progress: Progress): Pick<Details, "said" | "saidBefore"> {
  const older = progress as Progress & {
    saidThinking?: boolean;
    spoke?: string;
    spokeBefore?: boolean;
  };
  const [said, before] = older.saidThinking
    ? [older.spoke, older.spokeBefore]
    : [progress.said, progress.saidBefore];
  return said ? { said, ...(before ? { saidBefore: true } : {}) } : {};
}

/** A running comrade's row: its run details, when it started, and what it is doing. */
export const live = (request: Request, progress: Progress, started: number): Details => ({
  ...summary(request, progress),
  started,
  ...(progress.activity ? { activity: progress.activity } : {}),
  ...(progress.streamed ? { streamed: progress.streamed } : {}),
  ...saidIn(progress),
});

export const emptyProgress = (): Progress => ({
  turns: 0,
  calls: 0,
  work: emptyWork(),
  usage: emptyUsage(),
  text: "",
  activity: starting(),
  messages: [],
});

/** A comrade's details in a session entry: its call's row or its delivered message. */
export function record(entry: SessionEntry): Saved | undefined {
  if (entry.type === "message" && entry.message.role === "toolResult")
    return entry.message.toolName === "comrade"
      ? (entry.message.details as Saved | undefined)
      : undefined;
  if (entry.type === "custom_message" && entry.customType === MESSAGE)
    return entry.details as Saved | undefined;
}

/** A background comrade's start row. Older versions numbered only those, and saved no session. */
export const backgroundStart = (details: Partial<Details> | undefined) =>
  details?.id !== undefined && (details.background === true || !details.session);

/** The face a row saved: a resumed run keeps it. */
export const savedFace = (details: Partial<Delivery>): Face => ({
  ...(details.title ? { title: details.title } : {}),
  ...(details.chip ? { chip: details.chip } : {}),
});
