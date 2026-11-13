// What a comrade's rows keep in the session: the details of its tool row, and of the message
// that delivers a background run's answer. Rows are drawn from them, and a later run of the
// comrade starts from them.
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { emptyUsage, type Progress, type Request, starting } from "./run.ts";
import type { Card, Face } from "./view.ts";
import { emptyWork } from "./work.ts";

/** The custom type of the message that delivers a background run's answer. */
export const MESSAGE = "comrade";

export interface Details extends Card {
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
  /** A run that carries on one Pi exited during: when that one started. */
  from?: number;
}

/** A message sent to comrade #id while it ran. Its row keeps this: there was no run of its own. */
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

/**
 * Whether a saved record has everything a row shows of a run, each part of the type the row
 * reads it as. A row draws a run only from a record that passes.
 */
export function hasCard(saved: Saved | undefined): saved is Saved & Card {
  const usage = saved?.usage;
  return (
    saved !== undefined &&
    typeof saved.model === "string" &&
    typeof saved.thinking === "string" &&
    Array.isArray(saved.tools) &&
    saved.tools.every((tool) => typeof tool === "string") &&
    typeof saved.turns === "number" &&
    typeof saved.calls === "number" &&
    typeof usage === "object" &&
    usage !== null &&
    typeof usage.input === "number" &&
    typeof usage.output === "number" &&
    typeof usage.cacheRead === "number" &&
    typeof usage.cacheWrite === "number" &&
    typeof usage.cost?.total === "number"
  );
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

/** A running comrade's row: its summary, when it started, and what it is doing. */
export const live = (request: Request, progress: Progress, started: number): Details => ({
  ...summary(request, progress),
  started,
  ...(progress.activity ? { activity: progress.activity } : {}),
  ...(progress.streamed ? { streamed: progress.streamed } : {}),
  ...(progress.said ? { said: progress.said } : {}),
  ...(progress.saidThinking ? { saidThinking: true } : {}),
  ...(progress.saidBefore ? { saidBefore: true } : {}),
  ...(progress.spoke ? { spoke: progress.spoke } : {}),
  ...(progress.spokeBefore ? { spokeBefore: true } : {}),
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

/** A comrade's record in a session entry: its tool row or its delivered message. */
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
