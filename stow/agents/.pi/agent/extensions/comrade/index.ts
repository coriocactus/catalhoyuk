import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  formatSize,
  getAgentDir,
  type SessionEntry,
  type Theme,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  isKeyRelease,
  matchesKey,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  NESTED_ROWS_EVENT,
  type NestedRows,
  type NestedRowsRequest,
  type NestedTranscript,
} from "../shared/nested.ts";
import {
  cleanTitle,
  modelDescription,
  type Previous,
  prepare,
  THINKING,
  type Thinking,
  toolsDescription,
  within,
} from "./request.ts";
import { type Finished, finished, interruption, interruptionNote, runMessages } from "./resume.ts";
import {
  Channel,
  emptyUsage,
  fromSteering,
  type Invocation,
  NESTED,
  type Outcome,
  type Progress,
  type Request,
  run as runComrade,
  starting,
} from "./run.ts";
import {
  dropRuns,
  elsewhere,
  modified,
  type RunRecord,
  readRuns,
  saveRun,
  updateRun,
} from "./runs.ts";
import {
  activityText,
  type Block,
  type Card,
  CardView,
  cutOff,
  type Outcome as Ending,
  type Face,
  formatCost,
  formatDuration,
  type Look,
  type Phase,
  type Running,
  runLine,
  type Toggles,
  taskLine,
  widgetLine,
} from "./view.ts";
import { callRow, emptyWork, summary as workSummary } from "./work.ts";

/** Background comrades running at once, to bound cost. */
const MAX_BACKGROUND = 4;
/** How often a turn waiting for its comrades checks for typed messages. */
const WAIT_POLL_MS = 200;
/** How long leaving a session waits for its comrades to stop: past the SIGKILL that ends them. */
const STOP_MS = 6000;
/** How long jobs parked for a /reload wait for the reloaded extension before being stopped. */
const ADOPT_MS = 10_000;
/** Pi's working spinner: the frames and interval of pi-tui's Loader, as mirage draws them. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_MS = 80;
/** Lines of an answer written to output that the calling model still reads. */
const WRITTEN_HEAD = 20;
/**
 * One setting from a Pi settings file, or undefined when the file or setting is missing. Throws
 * on a file that does not parse, such as one caught mid-write.
 */
function settingValue(file: string, key: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const settings: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  return settings && typeof settings === "object"
    ? (settings as Record<string, unknown>)[key]
    : undefined;
}

/** How long after the agent settles, idle, an answer it still does not hold is sent again. */
const RESEND_MS = 1000;
/** How recently a background run must have been cut off for the session to carry it on. */
const RESUME_WITHIN_MS = 24 * 60 * 60_000;
/** What a resumed comrade is asked, after the note on what was cut off. */
const CARRY_ON =
  "Carry on with your task from where you stopped, and end with your final answer as before.";
/** How often a comrade checks that its parent is still running. */
const ORPHAN_MS = 2000;
/** The current frame, from the clock, so every spinning row shows the same one. */
const frame = () => SPINNER[Math.floor(Date.now() / SPINNER_MS) % SPINNER.length];
const MESSAGE = "comrade";
/** The key of the widget above the editor that lists background comrades. */
const WIDGET = "comrade";

/**
 * comrade's parameters, whose model description names the models enabled in this session, and
 * whose tools description names the default tools active in it.
 */
const parameters = (models: string, tools: string) =>
  Type.Object({
    title: Type.String({
      description:
        '3-6 words naming the job, like a commit subject, such as "Review parser error paths". ' +
        "The user sees it on the comrade's row. With to, repeat the comrade's title, or give " +
        "another to rename it.",
    }),
    task: Type.String({
      description:
        "Complete, self-contained instructions: every path, constraint, and the answer format " +
        "you need. With to, only your next message to that comrade.",
    }),
    to: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Continue comrade #N's conversation: task is your next message to it. It keeps its brief, " +
          "files, model, thinking, tools, cwd, and what it read and answered. While #N runs, task " +
          "reaches it before its next model request instead, and nothing else may be given.",
      }),
    ),
    model: Type.Optional(Type.String({ description: models })),
    // Pi's StringEnum schema (a plain string enum, which every provider accepts), typed for TypeBox.
    thinking: Type.Optional(
      Type.Unsafe<Thinking>({
        type: "string",
        enum: [...THINKING],
        description: "Default: your thinking level, or the comrade's with to.",
      }),
    ),
    tools: Type.Optional(Type.Array(Type.String(), { description: tools })),
    files: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Files to attach, text or images, as <file name=...> blocks after the task. Paths " +
          "resolve from the working directory.",
      }),
    ),
    output: Type.Optional(
      Type.String({
        description:
          "Write the whole answer to this file and return only its first lines and the path.",
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        description:
          "Directory the comrade runs in. Default: the working directory, or the comrade's with to.",
      }),
    ),
    timeout: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Seconds before the comrade is stopped, for a hard stop only: leave it unset for " +
          "open-ended work, which can take hours. The result then says so and gives any text it " +
          "had, and the comrade can be continued with to.",
      }),
    ),
    background: Type.Optional(
      Type.Boolean({
        description:
          "Return at once and deliver the answer later as a [comrade #N …] message. Only when you " +
          "have other work to do before you need it.",
      }),
    ),
  });

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
  /** A message sent to comrade #id while it ran, rather than a run of its own. */
  steered?: boolean;
  /** A run that carries on one Pi exited during: when that one started. */
  from?: number;
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

/** Shared by a row's call and result renderers. */
interface RowState {
  resulted?: boolean;
  /** The whole task, not just its first lines. */
  taskOpen?: boolean;
  /** All its work, not just its latest blocks. */
  earlierOpen?: boolean;
}

interface Job {
  id: number;
  /** The start row's tool call. Absent in resumed jobs and jobs adopted from older versions. */
  toolCallId?: string;
  /** The run its answer ends. Absent in jobs adopted from older versions. */
  run?: string;
  /** Messages sent to it while it runs. Absent in jobs adopted from older versions. */
  channel?: Channel;
  task: string;
  request: Request;
  started: number;
  progress: Progress;
  controller: AbortController;
  stoppedBy?: "user" | "agent";
  /** Settles once the comrade has exited and its result has been handled. */
  done: Promise<void>;
  /** A resumed run: when the run it carries on started. */
  from?: number;
  outcome?: Outcome;
  /** Delivers the result. Unset while the job waits across a /reload for the new extension. */
  owner?: (job: Job, outcome: Outcome) => void;
}

/**
 * Background comrades outlive /reload: the outgoing extension leaves its running jobs here,
 * keyed by session id, and the reloaded one adopts them. Bump the key if `Job` changes.
 */
const PARKED = Symbol.for("comrade.parked-jobs.v1");
const global = globalThis as { [PARKED]?: Map<string, Job[]> };
global[PARKED] ??= new Map();
const parked = global[PARKED];

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
 * A comrade stops when its parent Pi is gone, rather than run on unseen. Pi's shutdown stops
 * comrades itself; this covers a parent that crashed or was killed.
 */
export function watchParent(
  parent: number,
  every = ORPHAN_MS,
  stop: () => void = () => process.kill(process.pid, "SIGTERM"),
): () => void {
  if (!Number.isInteger(parent) || parent <= 1) return () => {};
  const alive = () => {
    try {
      process.kill(parent, 0);
      return true;
    } catch (error) {
      // EPERM: it exists, but is not ours to signal.
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  const timer = setInterval(() => {
    if (alive()) return;
    clearInterval(timer);
    stop();
  }, every);
  timer.unref();
  return () => clearInterval(timer);
}

/** Saves a run's record; one that cannot be saved costs only its recovery, never the run. */
function quietly(save: () => void): void {
  try {
    save();
  } catch {
    // The run goes on without it.
  }
}

/** Prefers what the comrade reports using over the name it was given. */
function summary(request: Request, progress: Progress): Details {
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
const live = (request: Request, progress: Progress, started: number): Details => ({
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

const emptyProgress = (): Progress => ({
  turns: 0,
  calls: 0,
  work: emptyWork(),
  usage: emptyUsage(),
  text: "",
  activity: starting(),
  messages: [],
});

/** Where comrade #id's conversation is saved: beside the caller's session, or in tmp without one. */
function sessionFile(ctx: ExtensionContext, id: number): string {
  const parent = ctx.sessionManager.getSessionFile();
  const dir = parent
    ? join(dirname(parent), `${basename(parent, ".jsonl")}.comrades`)
    : join(tmpdir(), "pi-comrades", ctx.sessionManager.getSessionId());
  return join(dir, `comrade-${id}.jsonl`);
}

/**
 * Claims comrade #id's conversation file, so no other Pi on this session (a fork open beside
 * it) takes the number. Pi starts a session in an empty file as it would in a missing one.
 */
function claim(file: string): boolean {
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(file, "", { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** The conversation file holds a run: Pi wrote to it. A claimed, empty one was never started. */
const saved = (file: string) => (statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 0;

/** A comrade's record in a session entry: its tool row or its delivered message. */
function record(entry: SessionEntry): Partial<Details> | undefined {
  if (entry.type === "message" && entry.message.role === "toolResult")
    return entry.message.toolName === "comrade"
      ? (entry.message.details as Partial<Details> | undefined)
      : undefined;
  if (entry.type === "custom_message" && entry.customType === MESSAGE)
    return entry.details as Partial<Details> | undefined;
}

/** A background comrade's start row. Older versions numbered only those, and saved no session. */
const backgroundStart = (details: Partial<Details> | undefined) =>
  details?.id !== undefined && (details.background === true || !details.session);

/** A background run on this branch that never answered: from its start row, or its resume. */
interface Pending {
  /** Absent in rows saved by older versions. */
  run?: string;
  /** The start row's tool call, which shows the run, and any that carries it on, while it goes. */
  row?: string;
  task: string;
  /** Its row or message: the comrade's conversation and settings. */
  details: Partial<Delivery>;
}

/**
 * The background runs on this branch that never answered, by comrade. A comrade can run in the
 * background more than once, so each run is matched in order, and by its id where both have one.
 */
function pendingRuns(branch: SessionEntry[]): Map<number, Pending> {
  const pending = new Map<number, Pending>();
  for (const entry of branch) {
    // Comrades the agent stopped send no message; their stop is the record.
    if (
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.toolName === "comrades"
    ) {
      const stopped = (entry.message.details as { stopped?: number[] } | undefined)?.stopped;
      for (const id of stopped ?? []) pending.delete(id);
      continue;
    }
    const details = record(entry) as Partial<Delivery> | undefined;
    if (details?.id === undefined) continue;
    const id = details.id;
    if (entry.type === "message" && entry.message.role === "toolResult") {
      if (details.steered) continue;
      if (backgroundStart(details))
        pending.set(id, {
          run: entry.message.toolCallId,
          row: entry.message.toolCallId,
          task: details.task ?? "",
          details,
        });
      // A later run in the foreground continued its conversation.
      else pending.delete(id);
    } else if (details.status === "resumed")
      pending.set(id, { run: details.run, row: details.row, task: details.task ?? "", details });
    else if (!details.run || details.run === pending.get(id)?.run) pending.delete(id);
  }
  return pending;
}

/** The messages that ended background runs, by run, on any branch. */
function deliveries(
  entries: SessionEntry[],
): Map<string, SessionEntry & { type: "custom_message" }> {
  const runs = new Map<string, SessionEntry & { type: "custom_message" }>();
  for (const entry of entries) {
    if (entry.type !== "custom_message" || entry.customType !== MESSAGE) continue;
    const delivery = entry.details as Partial<Delivery> | undefined;
    if (delivery?.run && delivery.status !== "resumed") runs.set(delivery.run, entry);
  }
  return runs;
}

/** What continuing comrade #id needs, from its latest record on this branch. */
function conversation(id: number, ctx: ExtensionContext): Previous & { session: string } {
  let seen = false;
  let found: Partial<Details> | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    const details = record(entry);
    if (details?.id !== id) continue;
    seen = true;
    if (details.session && details.requested) found = details;
  }
  if (!seen) throw new Error(`No comrade #${id} on this branch of the conversation.`);
  const session = found?.session;
  const requested = found?.requested;
  if (!session || !requested)
    throw new Error(
      `Comrade #${id} cannot continue: it ran before comrades kept their conversations. Start a new comrade.`,
    );
  if (!saved(session))
    throw new Error(
      `Comrade #${id} cannot continue: its conversation was never saved, or was deleted (${session}). Start a new comrade.`,
    );
  return {
    session,
    ...(found?.title ? { title: found.title } : {}),
    provider: requested.provider,
    model: requested.model,
    // Missing settings fall back to the caller's, as for a new comrade.
    thinking: found?.thinking || undefined,
    tools: found?.tools,
    cwd: found?.cwd,
  };
}

/** Why a run did not succeed, for its row: its first line always shows. Stopped, nothing. */
function reasonOf(outcome: Outcome, request: Request): string | undefined {
  if (outcome.aborted && !outcome.timedOut) return undefined;
  if (outcome.timedOut)
    return `Stopped at its ${formatDuration(request.timeoutMs ?? 0)} limit. ${outcome.text ? "Its last text is kept." : "It had said nothing yet."}`;
  return failure(outcome)?.replace(/^Comrade failed: /, "");
}

function failure(outcome: Outcome): string | undefined {
  if (outcome.stopReason === "error" || outcome.stopReason === "aborted")
    return `Comrade failed: ${outcome.errorMessage ?? outcome.stopReason}`;
  if (outcome.exitCode !== 0) {
    const stderr = outcome.stderr.trim().split("\n").slice(-20).join("\n");
    const reason = outcome.errorMessage ?? `pi exited with code ${outcome.exitCode}`;
    return stderr ? `${reason}\n${stderr}` : reason;
  }
  // Pi refused the task before any run, as for a provider without credentials.
  if (!outcome.text)
    return outcome.errorMessage
      ? `Comrade failed: ${outcome.errorMessage}`
      : "Comrade finished without an answer.";
}

/**
 * Truncate like Pi's own tools, keeping the full answer beside the comrade's conversation:
 * `comrade-3.answer.md`, then `comrade-3.answer.2.md` for a later run of the same comrade.
 */
function limit(
  answer: string,
  session: string | undefined,
  id: number,
): { text: string; file?: string } {
  const cut = truncateHead(answer, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!cut.truncated) return { text: answer };
  // Jobs adopted across a /reload from an older version have no session.
  const dir = session ? dirname(session) : join(tmpdir(), "pi-comrades");
  mkdirSync(dir, { recursive: true });
  let file: string;
  for (let run = 1; ; run++) {
    file = join(dir, `comrade-${id}.answer${run === 1 ? "" : `.${run}`}.md`);
    try {
      writeFileSync(file, answer, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const shown = `${cut.outputLines} of ${cut.totalLines} lines (${formatSize(cut.outputBytes)} of ${formatSize(cut.totalBytes)})`;
  return { text: `${cut.content}\n\n[Answer truncated: ${shown}. Full answer: ${file}]`, file };
}

/** Write the answer where the caller asked, and say so with its first lines. */
function written(answer: string, file: string): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, answer);
  const lines = answer.split("\n").length;
  const size = `${lines} line${lines === 1 ? "" : "s"}, ${formatSize(Buffer.byteLength(answer))}`;
  if (lines <= WRITTEN_HEAD) return `Answer written to ${file} (${size}):\n\n${answer}`;
  const head = truncateHead(answer, { maxLines: WRITTEN_HEAD, maxBytes: DEFAULT_MAX_BYTES });
  return `Answer written to ${file} (${size}). First ${head.outputLines} lines:\n\n${head.content}`;
}

interface Reply {
  text: string;
  isError: boolean;
  /** The file holding the whole answer. */
  file?: string;
}

/**
 * What the calling model reads. It never sees the row, so an answer that is not final says so
 * on its first line, and a run line ends every result of a comrade that ran.
 */
function respond(
  request: Request,
  outcome: Outcome,
  details: Card,
  durationMs: number,
  id: number,
): Reply {
  if (outcome.aborted && !outcome.timedOut)
    return { text: `Comrade #${id} stopped.`, isError: true };
  // Even a comrade that failed at once ends with its run line, which carries its number.
  const run = `\n\n${runLine(details, durationMs, id)}`;
  const limitText = formatDuration(request.timeoutMs ?? 0);
  if (outcome.timedOut && !outcome.text)
    return { text: `Comrade timed out after ${limitText} and was stopped.${run}`, isError: true };
  const failed = outcome.timedOut ? undefined : failure(outcome);
  if (failed !== undefined) return { text: failed + run, isError: true };
  const state = outcome.timedOut
    ? `[Comrade timed out after ${limitText} and was stopped. Its last text follows. It is not a final answer.]`
    : cutOff(details)
      ? `[Comrade's answer is cut off: its last turn ended with stopReason "${outcome.stopReason}"${outcome.stopReason === "length" ? ", the model's output token limit" : ""}. It is not a final answer.]`
      : "";
  let body: string;
  let file: string | undefined;
  let isError = outcome.timedOut;
  if (request.output)
    try {
      body = written(outcome.text, request.output);
      file = request.output;
    } catch (error) {
      const shown = limit(outcome.text, request.session, id);
      body = `Could not write the answer to ${request.output}: ${error instanceof Error ? error.message : error}\n\n${shown.text}`;
      file = shown.file;
      isError = true;
    }
  else ({ text: body, file } = limit(outcome.text, request.session, id));
  return { text: [state, body].filter(Boolean).join("\n\n") + run, isError, file };
}

/** Message text: one header line, then the body. The renderer shows the body under its own card. */
const message = (id: number, status: Delivery["status"], task: string, body: string) =>
  `[comrade #${id} ${status}] ${taskLine(task).slice(0, 200)}\n\n${body}`;

/** `invocation` may be a function, to resolve it again for each run. */
export function register(pi: ExtensionAPI, invocation: Invocation | (() => Invocation)): void {
  const resolve = () => (typeof invocation === "function" ? invocation() : invocation);
  const jobs = new Map<number, Job>();
  // Foreground comrades running now, and what sends them a message.
  const foreground = new Map<number, { channel: Channel; title?: string }>();
  let next = 1;
  /** The next comrade number whose conversation file is free, claimed. */
  const reserve = (ctx: ExtensionContext) => {
    let id = next++;
    while (!claim(sessionFile(ctx, id))) id = next++;
    return id;
  };
  let ui: ExtensionContext["ui"] | undefined;
  let sessionId: string | undefined;
  // Answers delivered to wake the agent, so a waiting turn knows one has arrived. Pi counts only
  // typed messages as pending, not an extension's queued follow-ups.
  let woken = 0;
  // Foreground comrades whose call has returned: their rows stop spinning even if Pi never
  // draws them again.
  const returned = new Set<string>();

  // Rows still running, by tool call id. A timer redraws them for each spinner frame. A row
  // that stopped running is redrawn once more, at rest, and dropped, and the timer stops when
  // none are left.
  const spinning = new Map<string, { redraw: () => void; running: () => boolean }>();
  let ticker: ReturnType<typeof setInterval> | undefined;
  const stopSpinning = () => {
    clearInterval(ticker);
    ticker = undefined;
    spinning.clear();
  };
  const spin = (id: string, redraw: () => void, running: () => boolean) => {
    spinning.set(id, { redraw, running });
    if (ticker) return;
    ticker = setInterval(() => {
      for (const [key, row] of spinning) {
        row.redraw();
        if (row.running()) continue;
        spinning.delete(key);
        returned.delete(key);
      }
      if (!spinning.size) stopSpinning();
    }, SPINNER_MS);
    ticker.unref();
  };

  const listing = () => {
    const lines = [...jobs.values()].map((job) =>
      [
        `#${job.id}`,
        job.request.face?.title ?? taskLine(job.task).slice(0, 60),
        job.request.thinking
          ? `${job.request.provider}/${job.request.model}:${job.request.thinking}`
          : `${job.request.provider}/${job.request.model}`,
        // Counted from Pi's turn starts, as the row counts them.
        `turn ${job.progress.activity.turn ?? job.progress.turns + 1}`,
        activityText(live(job.request, job.progress, job.started)) ||
          workSummary(job.progress.work.tallies) ||
          "no calls yet",
        formatCost(job.progress.usage.cost.total),
        formatDuration(Date.now() - job.started),
      ].join(" · "),
    );
    // Background costs are not in the session's totals, so the listing adds them up.
    if (lines.length > 1) {
      const total = [...jobs.values()].reduce((sum, job) => sum + job.progress.usage.cost.total, 0);
      lines.push(`${lines.length} running · ${formatCost(total)} so far`);
    }
    return lines.join("\n");
  };

  const deliver = (delivery: Delivery, body: string, wake: boolean) => {
    if (wake) woken++;
    pi.sendMessage(
      {
        customType: MESSAGE,
        // Named by its title, as its row is; rows saved before titles, by the task's first line.
        content: message(delivery.id, delivery.status, delivery.title ?? delivery.task, body),
        display: true,
        details: delivery,
      },
      { deliverAs: "followUp", triggerTurn: wake },
    );
  };

  // The open session's entries, which tell whether a saved answer has been delivered, and its
  // current branch, which rows look their comrade's runs up in.
  let entries: (() => SessionEntry[]) | undefined;
  let branch: (() => SessionEntry[]) | undefined;
  // Background answers saved and sent whose message the session may not hold yet:
  // run -> the comrade's conversation.
  const unconfirmed = new Map<string, string>();
  // When each was last sent, so one sent as the agent settled is not sent again at once.
  const sentAt = new Map<string, number>();
  // How to redraw each comrade's background start rows, which say how its runs went once the
  // session holds their answer: comrade -> tool call -> redraw.
  const startRows = new Map<number, Map<string, () => void>>();
  /** Drops the records of runs whose answer the session now holds. */
  const confirm = () => {
    if (!unconfirmed.size || !entries) return;
    const delivered = deliveries(entries());
    const done = new Map<string, Set<string>>();
    for (const [run, session] of unconfirmed) {
      if (!delivered.has(run)) continue;
      unconfirmed.delete(run);
      done.set(session, (done.get(session) ?? new Set<string>()).add(run));
    }
    for (const [session, runs] of done) quietly(() => dropRuns(session, runs));
    // Their lines in the widget go with them, and their start rows now say how they went.
    let changed = false;
    for (const runs of done.values())
      for (const run of runs) {
        changed = answered.delete(run) || changed;
        const id = (delivered.get(run)?.details as Partial<Delivery> | undefined)?.id;
        for (const redraw of id === undefined ? [] : (startRows.get(id)?.values() ?? [])) redraw();
      }
    if (changed) refreshWidget();
  };
  /** Sends a saved answer, which stays saved until the session holds it. */
  const resend = (session: string, answer: RunRecord<Delivery>, wake: boolean) => {
    if (!answer.answer) return;
    unconfirmed.set(answer.run, session);
    sentAt.set(answer.run, Date.now());
    deliver(answer.answer.delivery, answer.answer.body, wake);
    confirm();
  };
  /** Sends the message another branch holds again, here, without starting a turn. */
  const redeliver = (entry: SessionEntry & { type: "custom_message" }) =>
    pi.sendMessage(
      {
        customType: MESSAGE,
        content: entry.content,
        display: entry.display,
        details: entry.details as Delivery,
      },
      { deliverAs: "followUp", triggerTurn: false },
    );

  /**
   * The whole task a delivered answer's run was given, from its start row: the row of its run,
   * or for a resumed run, the comrade's latest start row before the message.
   */
  const taskFor = (delivery: Partial<Delivery>): string | undefined => {
    if (!branch) return undefined;
    const tasks = new Map<string, string>();
    let latest: string | undefined;
    for (const entry of branch()) {
      if (entry.type === "message" && entry.message.role === "assistant") {
        for (const part of entry.message.content)
          if (part.type === "toolCall" && part.name === "comrade") {
            const task = (part.arguments as { task?: unknown }).task;
            if (typeof task === "string") tasks.set(part.id, task);
          }
      } else if (entry.type === "message" && entry.message.role === "toolResult") {
        const details = record(entry);
        if (details && details.id === delivery.id && !details.steered)
          latest = tasks.get(entry.message.toolCallId) ?? latest;
      } else if (entry.type === "custom_message" && entry.customType === MESSAGE) {
        const details = entry.details as Partial<Delivery> | undefined;
        if (
          details &&
          details.id === delivery.id &&
          details.run === delivery.run &&
          details.status === delivery.status
        )
          break;
      }
    }
    return (delivery.run && tasks.get(delivery.run)) || latest;
  };
  /** How a background start row's run ended: the comrade's first ending after the row. */
  const outcomeOf = (toolCallId: string, id: number): Ending | undefined => {
    if (!branch) return undefined;
    let after = false;
    for (const entry of branch()) {
      if (!after) {
        after =
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          entry.message.toolCallId === toolCallId;
        continue;
      }
      if (
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === "comrades" &&
        (entry.message.details as { stopped?: number[] } | undefined)?.stopped?.includes(id)
      )
        return "stopped";
      if (entry.type !== "custom_message" || entry.customType !== MESSAGE) continue;
      const details = entry.details as Partial<Delivery> | undefined;
      if (details?.id !== id || details.status === "resumed" || !details.status) continue;
      // Its own run's answer, or a run that carried it on: not a later run's of the same comrade.
      if (details.run && details.run !== toolCallId && details.row !== toolCallId) continue;
      return details.status;
    }
  };

  // The widget above the editor: a line for each background comrade at work, and for each
  // answer the session has yet to take. Only in the terminal.
  let terminal = false;
  let widgetTui: TUI | undefined;
  let widgetShown = false;
  let widgetTimer: ReturnType<typeof setInterval> | undefined;
  /** Background runs that have ended, by run, until the session holds their answer. */
  const answered = new Map<string, Running>();
  const widgetLines = (width: number, theme: Theme) => {
    const rows: Running[] = [...jobs.values()]
      .sort((a, b) => a.id - b.id)
      .map((job) => ({
        id: job.id,
        title: job.request.face?.title ?? taskLine(job.task),
        doing: activityText(live(job.request, job.progress, job.started)) || "starting",
        cost: job.progress.usage.cost.total,
        elapsedMs: Date.now() - job.started,
      }));
    rows.push(...answered.values());
    // Ids and titles in columns; titles as wide as the widest, up to a third of the width.
    const idWidth = Math.max(...rows.map((row) => `#${row.id}`.length));
    const titleWidth = Math.min(
      Math.max(16, Math.floor(width / 3)),
      Math.max(0, ...rows.map((row) => visibleWidth(row.title))),
    );
    return rows.map((row) => widgetLine(row, idWidth, titleWidth, width, theme));
  };
  const refreshWidget = () => {
    const wanted = terminal && ui !== undefined && (jobs.size > 0 || answered.size > 0);
    if (wanted && !widgetShown && ui) {
      widgetShown = true;
      ui.setWidget(
        WIDGET,
        (tui, theme) => {
          widgetTui = tui;
          return {
            render: (width: number) => widgetLines(width, theme),
            invalidate() {},
            dispose() {
              if (widgetTui === tui) widgetTui = undefined;
            },
          };
        },
        { placement: "aboveEditor" },
      );
      // Its clocks tick once a second.
      widgetTimer = setInterval(() => widgetTui?.requestRender(), 1000);
      widgetTimer.unref();
    } else if (!wanted && widgetShown) {
      widgetShown = false;
      clearInterval(widgetTimer);
      widgetTimer = undefined;
      ui?.setWidget(WIDGET, undefined);
      widgetTui = undefined;
    } else widgetTui?.requestRender();
  };

  // Mirage draws a comrade's calls as it draws Pi's own, when it is loaded: see shared/nested.ts.
  // Asked once per session, as rows are drawn: every extension has loaded by then, so no answer
  // (null) means mirage is not loaded, until the next session start or /reload.
  let mirage: NestedRows | null | undefined;
  const rowsService = () => {
    if (mirage === undefined) {
      const request: NestedRowsRequest = {};
      pi.events.emit(NESTED_ROWS_EVENT, request);
      mirage = request.rows ?? null;
    }
    return mirage ?? undefined;
  };
  // Pi's thinking toggle: mirage follows it as it changes. Without mirage, Pi's setting, which
  // Ctrl+T saves globally and a trusted project's settings may override: read again when either
  // file changes, looked at no more than four times a second. Read without Pi's settings lock,
  // which a draw must not wait on: a file caught mid-write keeps the last value read.
  let thinkingHidden = false;
  let trusted = false;
  let settingsSeen: { at: number; changed: string } | undefined;
  const settingHidden = () => {
    const now = Date.now();
    if (settingsSeen && now - settingsSeen.at < 250) return thinkingHidden;
    const files = [join(getAgentDir(), "settings.json")];
    if (trusted) files.push(join(home, CONFIG_DIR_NAME, "settings.json"));
    const changed = files.map(modified).join(" ");
    if (settingsSeen?.changed !== changed)
      try {
        let hidden = false;
        for (const file of files) {
          const value = settingValue(file, "hideThinkingBlock");
          if (typeof value === "boolean") hidden = value;
        }
        thinkingHidden = hidden;
      } catch {}
    settingsSeen = { at: now, changed };
    return thinkingHidden;
  };
  const thinkingShown = () => !(rowsService()?.thinkingHidden() ?? settingHidden());
  // The directory comrades run in unless told otherwise.
  let home = process.cwd();

  /** A run's conversation, as it goes or once ended, and mirage's rows for it. */
  interface Shown {
    messages: AgentMessage[];
    running: boolean;
    transcript?: NestedTranscript;
    added: number;
  }
  // By run: a foreground row's tool call, or a background run's id. The few last drawn, as kept
  // in memory; another is read again from its conversation when its row is opened. A run whose
  // conversation is not known is kept too, with no messages, so it is not looked for again.
  const shown = new Map<string, Shown>();
  const SHOWN_MAX = 40;
  const keepShown = (key: string, entry: Shown) => {
    shown.delete(key);
    shown.set(key, entry);
    if (shown.size > SHOWN_MAX) shown.delete(shown.keys().next().value as string);
    return entry;
  };
  /** Follows a run's conversation as its messages arrive. */
  const track = (key: string, messages: AgentMessage[], running: boolean) => {
    const entry = shown.get(key);
    if (entry && entry.messages === messages) entry.running = running;
    else keepShown(key, { messages, running, added: 0 });
  };
  const textOf = (content: unknown) =>
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .flatMap((part) =>
              part?.type === "text" && typeof part.text === "string" ? [part.text] : [],
            )
            .join("\n")
        : "";
  /**
   * What a run did, in order, for its row: its words, its thinking where Pi shows thinking, the
   * messages sent to it, and its calls, mirage's rows for mirage's tools. Its first prompt is the
   * row's own, so it is left out. Nothing for a run whose conversation is not known.
   */
  const blocksFor = (
    key: string,
    source: () => AgentMessage[] | undefined,
    cwd: string,
    theme: Theme,
    running: boolean,
  ): Block[] => {
    const known = keepShown(key, shown.get(key) ?? { messages: source() ?? [], running, added: 0 });
    known.running = running;
    const service = rowsService();
    if (service && !known.transcript) {
      known.transcript = service.transcript(cwd, () => (known.running ? frame() : undefined));
      known.added = 0;
    }
    for (; known.added < known.messages.length; known.added++)
      known.transcript?.add(known.messages[known.added]);
    const thinking = thinkingShown();
    const results = new Map<string, { error: boolean; text: string; details: unknown }>();
    for (const message of known.messages)
      if (message.role === "toolResult")
        results.set(message.toolCallId, {
          error: message.isError,
          text: textOf(message.content),
          details: message.details,
        });
    const rowOf = (part: { id: string; name: string; arguments: unknown }) => {
      const result = results.get(part.id);
      const status = result
        ? result.error
          ? "error"
          : "success"
        : running
          ? undefined
          : "cancelled";
      return callRow(
        part.name,
        part.arguments,
        cwd,
        status,
        result?.error ? result.text : undefined,
        result?.details,
      );
    };
    const blocks: Block[] = [];
    // The group mirage's row holds, and the last call in it.
    let group: Extract<Block, { kind: "rows" }> | undefined;
    let last: Parameters<typeof rowOf>[0] | undefined;
    let prompted = false;
    for (const message of known.messages) {
      if (message.role === "user") {
        const text = fromSteering(textOf(message.content));
        if (prompted && text.trim()) blocks.push({ kind: "message", text });
        prompted = true;
        continue;
      }
      if (message.role !== "assistant") continue;
      for (const part of message.content) {
        if (part.type === "thinking") {
          if (thinking && part.thinking.trim())
            blocks.push({ kind: "thinking", text: part.thinking, source: part });
        } else if (part.type === "text") {
          if (part.text.trim()) blocks.push({ kind: "text", text: part.text, source: part });
        } else if (part.type === "toolCall") {
          const going = running && !results.has(part.id);
          if (known.transcript?.draws(part.name)) {
            const component = known.transcript.row(part.id, theme);
            if (component) {
              group = { kind: "rows", component, calls: 1, running: going ? 1 : 0 };
              blocks.push(group);
            } else if (group) {
              // A later call in the group an earlier call's row holds.
              group.calls++;
              if (going) group.running++;
            }
            last = part;
            continue;
          }
          blocks.push({ kind: "call", row: rowOf(part) });
        }
      }
    }
    // The latest group's last call, which a running row names when the group has only it.
    if (group && last) group.last = rowOf(last);
    return blocks;
  };
  /**
   * Keeps a row's work in step with Pi's thinking toggle, drawn again as it changes: worked out
   * once per setting, not on every draw.
   */
  const keepCurrent = (look: Look, work: () => Block[] | undefined) => {
    let done: boolean | undefined;
    look.refresh = () => {
      const thinking = thinkingShown();
      if (done === thinking) return;
      done = thinking;
      look.thinking = thinking;
      const blocks = work();
      if (blocks) look.blocks = blocks;
      else delete look.blocks;
    };
  };
  /** A run's conversation from its saved file, for a row drawn after the run's process has gone. */
  const savedRun = (details: Partial<Details>) => () =>
    details.session && details.started !== undefined
      ? runMessages(details.session, details.started, details.ended)
      : undefined;

  /** Saves what a run's progress shows of it: its comrade's Pi, and its prompt reaching it. */
  const follow = (session: string, run: string) => {
    let child: number | undefined;
    let asked = false;
    return (progress: Progress) => {
      if (progress.pid !== undefined && progress.pid !== child) {
        child = progress.pid;
        quietly(() => updateRun(session, run, { child }));
      }
      if (progress.asked && !asked) {
        asked = true;
        quietly(() => updateRun(session, run, { phase: "asked" }));
      }
    };
  };
  /** A run's record as it starts, run by this Pi. */
  const launched = (request: Request, run: string, background: boolean, started: number) => ({
    run,
    background,
    owner: process.pid,
    started,
    phase: "starting" as const,
    task: request.task,
    files: request.files,
    ...(request.output ? { output: request.output } : {}),
    ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
  });

  /**
   * How a comrade's row names it: its title, then its model and thinking level, and what it may
   * do, each only when not the caller's own, as they are when it is called.
   */
  const faceOf = (
    request: Pick<Request, "provider" | "model" | "thinking">,
    ctx: Pick<ExtensionContext, "model" | "thinkingLevel">,
    title?: string,
  ): Face => {
    const caller = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
    const otherModel = caller !== `${request.provider}/${request.model}`;
    const otherThinking = request.thinking !== (ctx.thinkingLevel ?? pi.getThinkingLevel());
    const chip = otherModel
      ? `${request.model}${otherThinking ? `:${request.thinking}` : ""}`
      : otherThinking
        ? `${request.thinking} thinking`
        : undefined;
    return { ...(title ? { title } : {}), ...(chip ? { chip } : {}) };
  };
  /** The face a row saved: a resumed run keeps it. */
  const savedFace = (details: Partial<Delivery>): Face => ({
    ...(details.title ? { title: details.title } : {}),
    ...(details.chip ? { chip: details.chip } : {}),
  });

  function finish(job: Job, outcome: Outcome) {
    jobs.delete(job.id);
    const session = job.request.session;
    const run = job.run;
    // The agent's own comrades call reports the stop, and the session records it there.
    if (job.stoppedBy === "agent") {
      if (run) quietly(() => dropRuns(session, new Set([run])));
      return refreshWidget();
    }
    // Leaving the session cut it off: its record carries it on when the session next starts.
    if (!ui && outcome.aborted && !job.stoppedBy && !outcome.timedOut) return refreshWidget();
    const base = {
      ...summary(job.request, outcome),
      stopReason: outcome.stopReason,
      exitCode: outcome.exitCode,
      ...(outcome.timedOut ? { timedOut: true } : {}),
      id: job.id,
      task: job.task,
      durationMs: Date.now() - job.started,
      // What it did is its conversation from then: from the run it carries on, if resumed.
      started: job.from ?? job.started,
      ended: Date.now(),
      ...(run ? { run } : {}),
      // A resumed run's answer names the start row that showed it.
      ...(job.toolCallId && job.toolCallId !== run ? { row: job.toolCallId } : {}),
    };
    // A resumed run's answer reads both runs from its conversation; memory holds only its own.
    if (run && job.from === undefined) track(run, outcome.messages, false);
    else if (run) shown.delete(run);
    const reason = job.stoppedBy ? undefined : reasonOf(outcome, job.request);
    let delivery: Delivery;
    let body: string;
    let wake = true;
    if (job.stoppedBy === "user") {
      // The user stopped it: tell the agent without starting a turn.
      delivery = { ...base, status: "stopped" };
      body = "Stopped by the user.";
      wake = false;
    } else {
      const reply = respond(job.request, outcome, base, base.durationMs, job.id);
      delivery = {
        ...base,
        status: reply.isError ? "failed" : "finished",
        answer: reply.file,
        ...(reason ? { reason } : {}),
      };
      body = reply.text;
    }
    // Saved before it is sent: Pi holds a message that arrives during a turn in memory until
    // the turn ends, so the session's next start delivers one Pi exits with first from here.
    if (run)
      quietly(() =>
        updateRun<Delivery>(session, run, { phase: "done", answer: { delivery, body } }),
      );
    if (!ui) return refreshWidget();
    if (run) {
      unconfirmed.set(run, session);
      sentAt.set(run, Date.now());
    }
    deliver(delivery, body, wake);
    // Until the session holds its answer, its line stays in the widget, saying so.
    if (run && job.stoppedBy !== "user")
      answered.set(run, {
        id: job.id,
        title: job.request.face?.title ?? job.task,
        doing: `${delivery.status} · answer queued`,
        cost: outcome.usage.cost.total,
        elapsedMs: base.durationMs,
        ended: delivery.status === "failed" ? "failed" : "finished",
      });
    confirm();
    refreshWidget();
  }

  /** A background run: `task` is the task line it shows. */
  function start(
    request: Request,
    id: number,
    run: string,
    toolCallId?: string,
    task?: string,
  ): Job {
    const progress = emptyProgress();
    const started = Date.now();
    const job: Job = {
      id,
      toolCallId,
      run,
      channel: new Channel(),
      task: task ?? taskLine(request.task),
      request,
      started,
      progress,
      controller: new AbortController(),
      done: Promise.resolve(),
      owner: finish,
    };
    jobs.set(job.id, job);
    refreshWidget();
    quietly(() => saveRun<Delivery>(request.session, launched(request, run, true, started)));
    const watch = follow(request.session, run);
    job.done = runComrade(
      resolve(),
      request,
      job.controller.signal,
      (update) => {
        watch(update);
        track(run, update.messages, true);
        job.progress = update;
      },
      job.channel,
    )
      .then((outcome) => {
        job.outcome = outcome;
        job.owner?.(job, outcome);
      })
      .catch((error: unknown) => {
        jobs.delete(job.id);
        ui?.notify(
          `comrade #${job.id}: ${error instanceof Error ? error.message : error}`,
          "error",
        );
      });
    return job;
  }

  /** Reports a background run that did not carry on, saying why when it could have. */
  const lost = (id: number, pending: Pending, why?: string) => {
    const session = pending.details.session;
    const continuable = Boolean(session && pending.details.requested && saved(session));
    const again = continuable ? ` Its conversation is saved: continue it with to: ${id}.` : "";
    // What its row says, in a line.
    const reason = why
      ? `Not carried on: ${why}.${continuable ? ` Continue it with to: ${id}.` : ""}`
      : continuable
        ? `It could not carry on here. Continue it with to: ${id}.`
        : "Pi exited while it ran, so its answer will not arrive.";
    deliver(
      {
        model: "",
        thinking: "",
        tools: [],
        turns: 0,
        calls: 0,
        usage: emptyUsage(),
        ...savedFace(pending.details),
        id,
        task: pending.task,
        status: "lost",
        reason,
        ...(pending.run ? { run: pending.run } : {}),
        // A resumed run's start row, which this message tells how it went.
        ...(pending.row && pending.row !== pending.run ? { row: pending.row } : {}),
      },
      why
        ? `Pi exited or switched sessions while this comrade ran, and it was not carried on: ${why}.${again}`
        : continuable
          ? `Pi exited or switched sessions while this comrade ran, and it could not carry on here.${again}`
          : "Pi exited or switched sessions while this comrade ran, so its answer will not arrive.",
      false,
    );
    const run = pending.run;
    if (session && run) quietly(() => dropRuns(session, new Set([run])));
  };

  /** What a background run's row or message says it ran with, and what its record adds. */
  const requestOf = (
    details: Partial<Delivery>,
    record: RunRecord | undefined,
    ctx: ExtensionContext,
    task: string,
    files: string[],
  ): Request | string => {
    const { session, requested } = details;
    if (!session || !requested) return "it ran before comrades kept their conversations";
    const cwd = details.cwd ?? ctx.cwd;
    if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory())
      return `its directory ${cwd} is gone`;
    const gone = files.find((file) => !statSync(file, { throwIfNoEntry: false })?.isFile());
    if (gone) return `its attached file ${gone} is gone`;
    return {
      task,
      provider: requested.provider,
      model: requested.model,
      thinking: details.thinking || ctx.thinkingLevel || pi.getThinkingLevel(),
      // The tools it was given when it started: carrying on is still that run.
      tools: details.tools ?? [],
      files,
      ...(record?.output ? { output: record.output } : {}),
      ...(record?.timeoutMs !== undefined ? { timeoutMs: record.timeoutMs } : {}),
      session,
      ...(saved(session) ? { followUp: true } : {}),
      resumed: true,
      face: savedFace(details),
      cwd,
      origin: ctx.cwd,
      trusted: ctx.isProjectTrusted() && within(cwd, ctx.cwd),
    };
  };

  /** Delivers the answer a run's conversation shows it gave, which never came back. */
  const answerFrom = (
    id: number,
    pending: Pending,
    record: RunRecord<Delivery>,
    done: Finished,
    ctx: ExtensionContext,
  ): string | undefined => {
    const request = requestOf(pending.details, record, ctx, record.task, record.files);
    if (typeof request === "string") return request;
    const outcome: Outcome = {
      ...emptyProgress(),
      turns: done.turns,
      calls: done.calls,
      usage: done.usage,
      text: done.text,
      ...(done.model ? { model: done.model } : {}),
      stopReason: done.stopReason,
      stderr: "",
      exitCode: 0,
      aborted: false,
      timedOut: false,
    };
    const base = {
      ...summary({ ...request, resumed: false }, outcome),
      stopReason: done.stopReason,
      exitCode: 0,
      id,
      task: pending.task,
      durationMs: Math.max(0, record.at - record.started),
      run: record.run,
      ...(pending.row && pending.row !== record.run ? { row: pending.row } : {}),
      // What it did, from its conversation: from the run it carries on, if it carries one on.
      started: pending.details.from ?? record.started,
      ...(done.ended ? { ended: done.ended } : {}),
    };
    const reply = respond(request, outcome, base, base.durationMs, id);
    const delivery: Delivery = {
      ...base,
      status: reply.isError ? "failed" : "finished",
      answer: reply.file,
    };
    const answer = { ...record, phase: "done" as const, answer: { delivery, body: reply.text } };
    quietly(() => saveRun<Delivery>(request.session, answer));
    resend(request.session, { ...answer, at: Date.now() }, false);
  };

  /**
   * Carries on a background run that Pi exited during, in its conversation, with what it ran
   * with. One whose prompt never reached the comrade is sent it again. One cut off mid-run is
   * told so, and which of its calls may or may not have taken effect. Returns why it could not.
   */
  const resume = (
    id: number,
    pending: Pending,
    saved: RunRecord<Delivery> | undefined,
    ctx: ExtensionContext,
  ): string | undefined => {
    const session = pending.details.session;
    let task: string;
    let files: string[] = [];
    if (saved?.phase === "starting") {
      task = saved.task;
      files = saved.files;
    } else {
      const cut = session ? interruption(session) : undefined;
      // With no record, only its conversation could say where it stopped.
      if (!saved && !cut) return "Comrade could not tell where it stopped";
      task = `${interruptionNote(cut, "the Pi that started you exited")}\n\n${CARRY_ON}`;
    }
    const request = requestOf(pending.details, saved, ctx, task, files);
    if (typeof request === "string") return request;
    const run = randomUUID();
    // The run it carries on started first: its answer shows what both did.
    const from = pending.details.from ?? saved?.started ?? pending.details.started;
    const job = start(request, id, run, pending.row, pending.task);
    if (from !== undefined) job.from = from;
    if (saved) quietly(() => dropRuns(request.session, new Set([saved.run])));
    deliver(
      {
        ...summary(request, emptyProgress()),
        id,
        task: pending.task,
        status: "resumed",
        run,
        ...(pending.row ? { row: pending.row } : {}),
        ...(from !== undefined ? { from } : {}),
      },
      `Pi exited while this comrade ran, so it carries on from where it stopped. Its answer will arrive as another [comrade #${id} …] message.`,
      false,
    );
  };

  /**
   * A background run on this branch that never answered, at the session's start: delivered if it
   * had answered, left alone if another Pi runs it, carried on if it was cut off in the last day,
   * and reported otherwise.
   */
  const recover = (
    id: number,
    pending: Pending,
    ctx: ExtensionContext,
    delivered: ReturnType<typeof deliveries>,
    detached: boolean,
  ) => {
    if (jobs.has(id)) return;
    const session = pending.details.session;
    const run = pending.run;
    const saved =
      session && run ? readRuns<Delivery>(session).find((item) => item.run === run) : undefined;
    // Answered, but the session never held the answer: it is saved.
    if (session && saved?.answer) return resend(session, saved, false);
    // Answered on another branch: the same answer, here too.
    const there = run ? delivered.get(run) : undefined;
    if (there) return redeliver(there);
    // Another Pi runs it now, and its answer goes to that Pi's session.
    if (saved && elsewhere(saved))
      return ctx.ui.notify(
        `Comrade #${id} is still running in another Pi (process ${saved.owner}).`,
        "info",
      );
    // Print and JSON modes end with the turn: it is left for a session that can wait for it.
    if (!detached) return;
    // One that ran before comrades kept conversations, or whose Pi never started, cannot.
    if (!session || !pending.details.requested || (!saved && !modified(session)))
      return lost(id, pending);
    // Its conversation shows it answered: the answer is there.
    const done = saved?.phase === "asked" ? finished(session, saved.started) : undefined;
    if (saved && done) {
      const why = answerFrom(id, pending, saved, done, ctx);
      return why ? lost(id, pending, why) : undefined;
    }
    // Cut off long ago, carrying it on could act on files changed since.
    const cutAt = Math.max(saved?.at ?? 0, modified(session));
    if (Date.now() - cutAt > RESUME_WITHIN_MS)
      return lost(id, pending, `it stopped ${formatDuration(Date.now() - cutAt)} ago`);
    // At the limit, it waits for the session's next start.
    if (jobs.size >= MAX_BACKGROUND)
      return ctx.ui.notify(
        `Comrade #${id} did not carry on: ${MAX_BACKGROUND} background comrades are running.`,
        "warning",
      );
    const why = resume(id, pending, saved, ctx);
    if (why) lost(id, pending, why);
  };

  pi.on("session_start", (event, ctx) => {
    ui = ctx.ui;
    sessionId = ctx.sessionManager.getSessionId();
    entries = () => ctx.sessionManager.getEntries();
    branch = () => ctx.sessionManager.getBranch();
    terminal = ctx.mode === "tui";
    home = ctx.cwd;
    mirage = undefined;
    try {
      trusted = ctx.isProjectTrusted();
    } catch {
      trusted = false;
    }
    settingsSeen = undefined;
    // Comrades started before a /reload keep running; take them over.
    const adopted = event?.reason === "reload" ? (parked.get(sessionId) ?? []) : [];
    parked.delete(sessionId);
    for (const job of adopted) {
      jobs.set(job.id, job);
      job.owner = finish;
    }
    // Number comrades past every one this session has seen, on any branch.
    const all = ctx.sessionManager.getEntries();
    const seen = all.flatMap((entry) => record(entry)?.id ?? []);
    next = Math.max(0, ...seen, ...jobs.keys()) + 1;
    // Records done with: runs whose answer the session holds, and foreground runs no Pi runs.
    const delivered = deliveries(all);
    for (const session of new Set(all.flatMap((entry) => record(entry)?.session ?? []))) {
      const stale = readRuns(session).filter(
        (saved) => delivered.has(saved.run) || (!saved.background && !elsewhere(saved)),
      );
      if (stale.length) quietly(() => dropRuns(session, new Set(stale.map((saved) => saved.run))));
    }
    const detached = ctx.mode === "tui" || ctx.mode === "rpc";
    for (const [id, pending] of pendingRuns(ctx.sessionManager.getBranch()))
      try {
        recover(id, pending, ctx, delivered, detached);
      } catch (error) {
        ctx.ui.notify(`comrade #${id}: ${error instanceof Error ? error.message : error}`, "error");
      }
    confirm();
    // Deliver what finished while the extension was reloading.
    for (const job of adopted) if (job.outcome) finish(job, job.outcome);
    refreshWidget();
    // Pi drew the transcript before this ran, when start rows could not look their runs up.
    for (const rows of startRows.values()) for (const redraw of rows.values()) redraw();
  });

  // An answer that started a turn is in the session as soon as Pi has taken it, and a stop the
  // agent made with the comrades tool once its result is: either tells a start row how its run went.
  pi.on("message_end", (event) => {
    const message = event?.message as
      | { role?: string; customType?: string; toolName?: string; details?: { stopped?: number[] } }
      | undefined;
    if (message?.role === "custom" && message.customType === MESSAGE)
      setTimeout(confirm, 0).unref();
    if (message?.role === "toolResult" && message.toolName === "comrades")
      setTimeout(() => {
        for (const id of message.details?.stopped ?? [])
          for (const redraw of startRows.get(id)?.values() ?? []) redraw();
      }, 0).unref();
  });

  // Pi takes an answer queued behind a turn when the turn ends; in the terminal, Esc or the
  // dequeue key drops it instead. Once the agent has been idle a moment, so an answer sent as it
  // settled has been taken, any the session still does not hold is sent again, without starting
  // a turn. Only in the terminal, whose every abort clears the queue first: elsewhere an abort,
  // such as RPC's, leaves the answer queued for the next run, so sending it again would deliver
  // it twice. There, the saved record delivers an answer that never arrived at the next start.
  let settleCheck: ReturnType<typeof setTimeout> | undefined;
  pi.on("agent_settled", (_event, ctx) => {
    confirm();
    clearTimeout(settleCheck);
    settleCheck = setTimeout(() => {
      let idle = true;
      try {
        idle = ctx.isIdle?.() !== false;
      } catch {
        return;
      }
      if (!ui || !idle || !terminal) return;
      confirm();
      let gone = false;
      for (const [run, session] of unconfirmed) {
        if (Date.now() - (sentAt.get(run) ?? 0) < RESEND_MS) continue;
        const saved = readRuns<Delivery>(session).find((item) => item.run === run);
        if (saved?.answer) {
          sentAt.set(run, Date.now());
          deliver(saved.answer.delivery, saved.answer.body, false);
        } else {
          unconfirmed.delete(run);
          gone = answered.delete(run) || gone;
        }
      }
      confirm();
      if (gone) refreshWidget();
    }, RESEND_MS);
    settleCheck.unref();
  });

  // An agent does not end its turn while its background comrades run: it waits, without using
  // tokens, and Pi continues the turn with the first answer that arrives. A message typed
  // meanwhile, or Esc, ends the wait at once. Only in the terminal, where Esc can be seen:
  // Pi's own abort waits for this handler, so a wait nothing could end would hang it.
  pi.on("agent_before_settle", async (_event, ctx) => {
    if (!jobs.size || ctx.mode !== "tui") return;
    let interrupted = false;
    const unsubscribe = ctx.ui.onTerminalInput((data) => {
      // Kitty's protocol also reports releases, such as the end of an Esc pressed before the wait.
      if (matchesKey(data, "escape") && !isKeyRelease(data)) interrupted = true;
      return undefined;
    });
    const before = woken;
    try {
      while (jobs.size && !interrupted && !ctx.hasPendingMessages() && woken === before) {
        // The widget above the editor says which.
        ctx.ui.setWorkingMessage(
          jobs.size === 1 ? `Waiting for comrade #${[...jobs.keys()][0]}` : "Waiting for comrades",
        );
        await Promise.race([
          new Promise((wake) => setTimeout(wake, WAIT_POLL_MS)),
          ...[...jobs.values()].map((job) => job.done),
        ]);
      }
    } finally {
      unsubscribe();
      ctx.ui.setWorkingMessage();
    }
  });

  pi.on("session_shutdown", async (event) => {
    // Answers still unconfirmed stay saved, and the session's next start delivers them.
    confirm();
    unconfirmed.clear();
    sentAt.clear();
    answered.clear();
    clearTimeout(settleCheck);
    if (widgetShown) {
      widgetShown = false;
      clearInterval(widgetTimer);
      ui?.setWidget(WIDGET, undefined);
      widgetTui = undefined;
    }
    entries = undefined;
    branch = undefined;
    startRows.clear();
    // Mirage's rows belong to this runtime's mirage: a reloaded one draws them afresh.
    shown.clear();
    mirage = undefined;
    ui = undefined;
    stopSpinning();
    returned.clear();
    if (event?.reason === "reload" && sessionId !== undefined) {
      const left = [...jobs.values()];
      for (const job of left) job.owner = undefined;
      parked.set(sessionId, left);
      // If the reloaded extension never adopts them, for example because it failed to load,
      // stop them rather than let them run unseen.
      const id = sessionId;
      setTimeout(() => {
        if (parked.get(id) !== left) return;
        parked.delete(id);
        for (const job of left) job.controller.abort();
      }, ADOPT_MS).unref();
      jobs.clear();
      return;
    }
    // Stopped, each comrade's Pi records the calls it cut off. The session carries them on when
    // it next starts, perhaps at once in this Pi, so the old ones must be gone by then.
    const stopping = [...jobs.values()];
    for (const job of stopping) job.controller.abort();
    jobs.clear();
    await Promise.race([
      Promise.all(stopping.map((job) => job.done)),
      new Promise((wake) => setTimeout(wake, STOP_MS).unref()),
    ]);
  });

  pi.registerCommand("comrades", {
    description: "List background comrades, or stop them with /comrades stop <n|all>",
    getArgumentCompletions: (prefix) => {
      const items = ["stop all", ...[...jobs.keys()].map((id) => `stop ${id}`)]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const [verb, target] = args.trim().split(/\s+/).filter(Boolean);
      if (verb === "stop") {
        const ids = target === "all" ? [...jobs.keys()] : [Number(target?.replace(/^#/, ""))];
        const stopping = ids.flatMap((id) => jobs.get(id) ?? []);
        if (!stopping.length) {
          ctx.ui.notify(`No running comrade ${target ?? ""}`.trimEnd(), "warning");
          return;
        }
        for (const job of stopping) {
          job.stoppedBy = "user";
          job.controller.abort();
        }
        ctx.ui.notify(`Stopping comrade ${stopping.map((job) => `#${job.id}`).join(", ")}`, "info");
        return;
      }
      if (verb) {
        ctx.ui.notify("Usage: /comrades [stop <n|all>]", "warning");
        return;
      }
      ctx.ui.notify(listing() || "No comrades running.", "info");
    },
  });

  pi.registerMessageRenderer<Delivery>(MESSAGE, (entry, { expanded, outputPad }, theme) => {
    const content = typeof entry.content === "string" ? entry.content : "";
    const details = entry.details;
    const body = details ? content.slice(content.indexOf("\n\n") + 2) : content;
    const phase: Phase = details?.status ?? "finished";
    const look: Look = {
      phase,
      task: details?.task ?? "",
      id: details?.id,
      expanded,
      durationMs: details?.durationMs,
      home,
      ...(phase === "resumed" ? { note: body } : {}),
    };
    // Opened, the task its start row was given and what it did, looked up only then: a row drawn
    // before the session has started knows neither yet.
    const open = () => {
      if (!details) return;
      look.task = taskFor(details) ?? look.task;
      keepCurrent(look, () =>
        look.expanded && details.run && phase !== "resumed" && phase !== "lost"
          ? blocksFor(details.run, savedRun(details), details.cwd ?? home, theme, false)
          : undefined,
      );
    };
    if (expanded) open();
    // Its own clicks open and close it, until Ctrl+O, which draws it afresh.
    return new CardView(look, details, phase === "resumed" ? "" : body, theme, outputPad, {
      row: () => {
        look.expanded = !look.expanded;
        if (look.expanded) open();
      },
      task: () => {
        look.taskOpen = !look.taskOpen;
      },
      earlier: () => {
        look.earlierOpen = !look.earlierOpen;
      },
    });
  });

  /**
   * A message for comrade #id while it runs. Pi gives it to the comrade once its current tool
   * calls finish, before its next model request, and its answer comes as it would have.
   */
  async function tell(
    id: number,
    params: { task: string } & Partial<Record<string, unknown>>,
    signal?: AbortSignal,
  ) {
    if (!params.task.trim()) throw new Error("comrade needs a task.");
    const given = ["model", "thinking", "tools", "files", "output", "cwd", "timeout"].filter(
      (key) => params[key] !== undefined,
    );
    if (given.length)
      throw new Error(
        `Comrade #${id} is running, so a message to it can carry only task. Wait for its answer to change its ${given.join(", ")}.`,
      );
    const job = jobs.get(id);
    const channel = foreground.get(id)?.channel ?? job?.channel;
    const title = foreground.get(id)?.title ?? job?.request.face?.title;
    if (!channel)
      throw new Error(
        `Comrade #${id} cannot take messages while it runs: it started before comrades could. Wait for its answer.`,
      );
    if (!channel.open)
      throw new Error(
        `Comrade #${id} has just finished, so your message did not reach it. Its answer is on its way: continue it with to: ${id} once it arrives.`,
      );
    // Esc ends the wait, not the message: it may still reach the comrade.
    const stopped = new Promise<"stopped">((wake) => {
      if (signal?.aborted) wake("stopped");
      signal?.addEventListener("abort", () => wake("stopped"), { once: true });
    });
    let outcome: "stopped" | undefined;
    try {
      outcome = await Promise.race([channel.steer(params.task).then(() => undefined), stopped]);
    } catch (error) {
      throw new Error(
        `Comrade #${id} did not take your message: ${error instanceof Error ? error.message : error}.`,
      );
    }
    if (outcome === "stopped")
      throw new Error(
        `Stopped waiting for comrade #${id} to take your message. It may still reach it.`,
      );
    const arrives = job
      ? `Its answer will arrive as a [comrade #${id} …] message, as before.`
      : "Its answer returns from the call that started it.";
    return {
      content: [
        {
          type: "text" as const,
          text: `Sent to comrade #${id}. It reads your message once its current tool calls finish, before its next model request. ${arrives}`,
        },
      ],
      details: { id, steered: true, ...(title ? { title } : {}) } as Details,
    };
  }

  let models = modelDescription();
  let tools = toolsDescription();
  const tool = defineTool({
    name: "comrade",
    label: "Comrade",
    description:
      "Run a task in a fresh pi process and return its final answer. The comrade sees nothing " +
      "of this conversation. Several calls in one message run in parallel. Every comrade is " +
      "numbered #N and keeps its conversation: continue it with to: N, or while it runs, send it " +
      "a message the same way. " +
      `Answers over ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} are truncated ` +
      "and saved in full to a file. Every result ends with a run line: #N, model, turns, calls, " +
      "tokens, cost, duration, and why it stopped.",
    promptSnippet:
      "Delegate a self-contained task to a fresh pi agent and get its answer, or continue one",
    promptGuidelines: [
      "A comrade sees none of this conversation: put every path, constraint, and the expected answer format in its task.",
      "To follow up with a comrade (a correction, a question, the next step), call comrade with to: N and only your new message. While it runs, the message reaches it before its next model request, so a running comrade can be redirected rather than waited for. Start a new comrade for unrelated work, or once the conversation has grown long: each follow-up resends all of it.",
      "Leave background off unless you have other work to do before you need the answer; foreground calls in one message already run in parallel. A background answer arrives later as a [comrade #N …] message: never guess it. When your other work is done, end your reply, and your turn waits for it.",
      'comrade is read-only by default. Add "edit" and "write" when it must change files, or "bash" to run commands.',
      "When a comrade needs more than a few files, pass them in files with tools: []. When its answer feeds a file or a build, set output and ask for the exact text, with no fences or commentary.",
      "A result whose first line starts [Comrade's answer is cut off or [Comrade timed out is not a finished answer.",
    ],
    parameters: parameters(models, tools),
    // Flat, as mirage draws its rows: no box behind it.
    renderShell: "self",

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const to = params.to;
      if (to !== undefined && (foreground.has(to) || jobs.has(to))) return tell(to, params, signal);
      const previous = to === undefined ? undefined : conversation(to, ctx);
      // A new comrade is named by its caller; one continued keeps its name unless given another.
      const title = cleanTitle(params.title) ?? previous?.title;
      const prepared = prepare(params, ctx, pi, previous);
      if (previous) {
        const runs = readRuns(previous.session);
        const busy = runs.find(elsewhere);
        if (busy)
          throw new Error(
            `Comrade #${to} is running in another Pi (process ${busy.owner}). Wait for its answer there, or start a new comrade.`,
          );
        // Runs of it cut off and never carried on end here: this run continues its conversation.
        const stale = runs.filter((saved) => saved.phase !== "done");
        if (stale.length)
          quietly(() => dropRuns(previous.session, new Set(stale.map((saved) => saved.run))));
      }
      // A comrade whose last run was cut off first reads which calls may or may not have run.
      const cut = previous ? interruption(previous.session) : undefined;
      if (cut) prepared.task = `${interruptionNote(cut)}\n\n${prepared.task}`;
      // Print and JSON modes exit when the agent settles, before a later message could arrive.
      const detached = ctx.mode === "tui" || ctx.mode === "rpc";
      const background = Boolean(params.background && detached);
      if (background && jobs.size >= MAX_BACKGROUND)
        throw new Error(
          `${MAX_BACKGROUND} background comrades are already running. Wait for one to finish, or stop one with the comrades tool.`,
        );
      const id = to ?? reserve(ctx);
      const request: Request = {
        ...prepared,
        session: previous?.session ?? sessionFile(ctx, id),
        ...(previous ? { followUp: true } : {}),
        face: faceOf(prepared, ctx, title),
      };
      if (background) {
        const job = start(request, id, toolCallId, toolCallId, taskLine(params.task));
        return {
          content: [
            {
              type: "text",
              text: `Comrade #${job.id} started in the background. Keep working. Its answer will arrive as a [comrade #${job.id} …] message${ctx.mode === "tui" ? ", and if you finish first, your turn waits for it" : ""}. Check on it or stop it with the comrades tool.`,
            },
          ],
          details: {
            ...summary(request, job.progress),
            id: job.id,
            task: job.task,
            background: true,
            started: job.started,
          },
        };
      }

      const began = Date.now();
      // Its record says this Pi runs it, so no other Pi continues it meanwhile. Its result is in
      // the session once the call returns, so the record goes then.
      quietly(() => saveRun(request.session, launched(request, toolCallId, false, began)));
      const watch = follow(request.session, toolCallId);
      const update = (progress: Progress) => {
        watch(progress);
        track(toolCallId, progress.messages, true);
        onUpdate?.({
          content: [{ type: "text", text: progress.text }],
          details: { ...live(request, progress, began), id },
        });
      };
      // Show the row, and the model it will use, before the comrade has started.
      update(emptyProgress());
      const channel = new Channel();
      foreground.set(id, { channel, title: request.face?.title });
      const outcome = await runComrade(resolve(), request, signal, update, channel).finally(() => {
        foreground.delete(id);
        returned.add(toolCallId);
        quietly(() => dropRuns(request.session, new Set([toolCallId])));
      });
      track(toolCallId, outcome.messages, false);
      const details: Details = {
        ...summary(request, outcome),
        started: began,
        ended: Date.now(),
        id,
        stopReason: outcome.stopReason,
        exitCode: outcome.exitCode,
        ...(outcome.aborted && !outcome.timedOut ? { stopped: true } : {}),
        ...(outcome.timedOut ? { timedOut: true } : {}),
      };
      const reason = reasonOf(outcome, request);
      if (reason) details.reason = reason;
      const reply = respond(request, outcome, details, Date.now() - began, id);
      if (reply.isError)
        return {
          content: [{ type: "text", text: reply.text }],
          details: { ...details, answer: reply.file },
          usage: outcome.usage,
          isError: true,
        };
      const note = params.background
        ? "(Ran in the foreground: background comrades need an interactive session.)\n\n"
        : "";
      return {
        content: [{ type: "text", text: note + reply.text }],
        details: { ...details, answer: reply.file },
        usage: outcome.usage,
      };
    },

    // One header per row: the call slot shows it until a result exists, then the result
    // slot draws it with the outcome and the call slot stays empty.
    renderCall(args, theme, context) {
      const state = context.state as RowState;
      if (state.resulted) return new Container();
      // The task is still arriving or the call running: spin until a result takes the header
      // over. A call left without a result, in a session opened again, is still.
      const live = !context.argsComplete || context.executionStarted;
      if (live) spin(context.toolCallId, context.invalidate, () => !state.resulted);
      const to = args.to;
      const sent = to !== undefined && (foreground.has(to) || jobs.has(to));
      const look: Look = {
        phase: sent ? "sent" : "running",
        task: args.task ?? "",
        title: sent
          ? (foreground.get(to)?.title ?? jobs.get(to)?.request.face?.title)
          : cleanTitle(typeof args.title === "string" ? args.title : undefined),
        ...(sent ? { id: to, message: args.task ?? "" } : {}),
        expanded: false,
        ...(live ? { spinner: frame() } : {}),
      };
      return new CardView(look, undefined, "", theme, context.outputPad);
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const state = context.state as RowState;
      if (!state.resulted) {
        state.resulted = true;
        // Redraw the call slot after this pass, not during it.
        queueMicrotask(() => context.invalidate());
      }
      const first = result.content[0];
      const body = first?.type === "text" ? first.text : "";
      const details = result.details as Partial<Details> | undefined;
      const args = context.args ?? {};
      const task = String(args.task ?? "");
      const pad = context.outputPad;
      // Its header is Pi's to open and close, as every tool row's is; the task's toggle is its own.
      const toggles: Toggles = {
        task: () => {
          state.taskOpen = !state.taskOpen;
          context.invalidate();
        },
        earlier: () => {
          state.earlierOpen = !state.earlierOpen;
          context.invalidate();
        },
      };
      // A message to a running comrade: the message, sent.
      if (details?.steered)
        return new CardView(
          { phase: "sent", task, message: task, id: details.id, title: details.title, expanded },
          undefined,
          "",
          theme,
          pad,
          toggles,
        );
      // Refused before it started: the reason is all there is.
      if (!details?.usage)
        return new CardView(
          {
            phase: "failed",
            task,
            title: cleanTitle(typeof args.title === "string" ? args.title : undefined),
            expanded,
            note: body,
          },
          undefined,
          "",
          theme,
          pad,
          toggles,
        );
      const background = !isPartial && backgroundStart(details);
      const phase: Phase = isPartial
        ? "running"
        : background
          ? "background"
          : context.isError
            ? details.stopped
              ? "stopped"
              : "failed"
            : "finished";
      // A foreground comrade spins while it runs, and a background one while its job does. A
      // comrade continued in the background again has a new start row, which shows that run.
      const id = details.id;
      const ours = (job: Job | undefined) =>
        job !== undefined && (job.toolCallId ?? context.toolCallId) === context.toolCallId;
      const job = background && id !== undefined ? jobs.get(id) : undefined;
      const running = phase === "running" || ours(job);
      if (phase === "running")
        spin(context.toolCallId, context.invalidate, () => !returned.has(context.toolCallId));
      else if (running)
        spin(context.toolCallId, context.invalidate, () => ours(jobs.get(id as number)));
      else {
        spinning.delete(context.toolCallId);
        returned.delete(context.toolCallId);
      }
      // A running background comrade shows its job's progress, not the saved start.
      const card =
        background && job && ours(job)
          ? { ...live(job.request, job.progress, job.started), id, background: true }
          : (details as Details);
      if (background && id !== undefined) {
        const rows = startRows.get(id) ?? new Map<string, () => void>();
        startRows.set(id, rows.set(context.toolCallId, context.invalidate));
      }
      // What it did, for a row that shows it: open, or at work in the foreground. A background
      // start row shows its run's work only while that run goes on; its answer shows the rest.
      const key = background ? job?.run : context.toolCallId;
      const cwd = details.cwd ?? home;
      const work = () =>
        key && (expanded || phase === "running") && (!background || running)
          ? blocksFor(
              key,
              // After /reload, a running job's messages are its own, not yet in memory here.
              background ? () => job?.progress.messages : savedRun(details),
              cwd,
              theme,
              running,
            )
          : undefined;
      const look: Look = {
        phase,
        task,
        expanded,
        taskOpen: state.taskOpen,
        earlierOpen: state.earlierOpen,
        id,
        spinner: running ? frame() : undefined,
        live: background && running,
        home,
        ...(background && !running && id !== undefined
          ? { outcome: outcomeOf(context.toolCallId, id) }
          : {}),
        durationMs:
          running && card.started !== undefined
            ? Date.now() - card.started
            : background
              ? undefined
              : context.durationMs,
      };
      keepCurrent(look, work);
      return new CardView(look, card, body, theme, pad, toggles);
    },
  });
  pi.registerTool(tool);
  // Name the enabled models and the default tools once the session is known, and again whenever
  // /scoped-models or the active tools change them. Only a change re-registers, so the declared
  // tools stay byte-identical.
  const describe = (_event: unknown, ctx: ExtensionContext) => {
    const nextModels = modelDescription(ctx);
    const nextTools = toolsDescription(pi.getActiveTools());
    if (nextModels === models && nextTools === tools) return;
    models = nextModels;
    tools = nextTools;
    pi.registerTool({ ...tool, parameters: parameters(models, tools) });
  };
  pi.on("session_start", describe);
  pi.on("before_agent_start", describe);

  registerList(pi, jobs, listing);
}

/** The agent's view of its background comrades: list them, or stop some. */
function registerList(pi: ExtensionAPI, jobs: Map<number, Job>, listing: () => string) {
  pi.registerTool({
    name: "comrades",
    label: "Comrades",
    description:
      "List your running background comrades, or stop some of them. Without stop, it lists each " +
      "comrade's number, progress, cost so far, and task. With stop, it stops those comrades and " +
      "waits for them to exit. No message arrives for a comrade you stopped.",
    promptSnippet: "List or stop your background comrades",
    parameters: Type.Object({
      stop: Type.Optional(
        Type.Array(Type.Integer({ minimum: 1 }), {
          description: "Numbers of the background comrades to stop, for example [3].",
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      const ids = [...new Set(params.stop ?? [])];
      if (!ids.length)
        return {
          content: [{ type: "text", text: listing() || "No background comrades are running." }],
          details: { stopped: [] as number[] },
        };
      const stopping = ids.flatMap((id) => jobs.get(id) ?? []);
      for (const job of stopping) {
        job.stoppedBy = "agent";
        job.controller.abort();
      }
      await Promise.all(stopping.map((job) => job.done));
      const missing = ids.filter((id) => !stopping.some((job) => job.id === id));
      const report = [
        stopping.length ? `Stopped comrade ${stopping.map((job) => `#${job.id}`).join(", ")}.` : "",
        missing.length ? `No running comrade ${missing.map((id) => `#${id}`).join(", ")}.` : "",
      ];
      return {
        content: [{ type: "text", text: report.filter(Boolean).join(" ") }],
        details: { stopped: stopping.map((job) => job.id) },
        isError: stopping.length === 0,
      };
    },
  });
}

export default function (pi: ExtensionAPI) {
  const parent = process.env[NESTED];
  // A comrade offers no comrade of its own, and stops once its parent is gone.
  if (parent !== undefined) {
    watchParent(Number(parent));
    return;
  }
  register(pi, () => currentPi());
}
