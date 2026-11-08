import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  type ExtensionAPI,
  type ExtensionContext,
  formatSize,
  type SessionEntry,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, isKeyRelease, matchesKey, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type Previous, prepare, THINKING, type Thinking } from "./request.ts";
import {
  emptyUsage,
  type Invocation,
  NESTED,
  type Outcome,
  type Progress,
  type Request,
  run,
  starting,
} from "./run.ts";
import {
  activityText,
  type Card,
  card,
  cutOff,
  formatCost,
  formatDuration,
  header,
  type Look,
  type Phase,
  runLine,
  taskLine,
} from "./view.ts";
import { emptyWork, summary as workSummary } from "./work.ts";

/** Background comrades running at once, to bound cost. */
const MAX_BACKGROUND = 4;
/** How often a turn waiting for its comrades checks for typed messages. */
const WAIT_POLL_MS = 200;
/** How long jobs parked for a /reload wait for the reloaded extension before being stopped. */
const ADOPT_MS = 10_000;
/** Pi's working spinner: the frames and interval of pi-tui's Loader, as mirage draws them. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_MS = 80;
/** Lines of an answer written to output that the calling model still reads. */
const WRITTEN_HEAD = 20;
/** How often a comrade checks that its parent is still running. */
const ORPHAN_MS = 2000;
/** The current frame, from the clock, so every spinning row shows the same one. */
const frame = () => SPINNER[Math.floor(Date.now() / SPINNER_MS) % SPINNER.length];
const MESSAGE = "comrade";

const parameters = Type.Object({
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
        "files, model, thinking, tools, cwd, and what it read and answered.",
    }),
  ),
  model: Type.Optional(
    Type.String({
      description:
        "provider/id exactly as Pi lists it, such as anthropic/claude-fable-5-1, optionally with " +
        ":thinking. Bare names are refused. Default: your model, or the comrade's with to.",
    }),
  ),
  // Pi's StringEnum schema (a plain string enum, which every provider accepts), typed for TypeBox.
  thinking: Type.Optional(
    Type.Unsafe<Thinking>({
      type: "string",
      enum: [...THINKING],
      description: "Default: your thinking level, or the comrade's with to.",
    }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Default: read-only, ["read", "grep", "find", "ls"], or the comrade\'s with to. Add ' +
        '"edit" and "write" to change files, "bash" to run commands. [] for none. Only tools ' +
        "active here.",
    }),
  ),
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
        "Seconds before the comrade is stopped. The result then says so and gives any text it had.",
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
}

/** A background comrade's delivered message. */
export interface Delivery extends Details {
  id: number;
  task: string;
  status: "finished" | "failed" | "stopped" | "lost";
  durationMs?: number;
}

/** Shared by a row's call and result renderers. */
interface RowState {
  resulted?: boolean;
}

interface Job {
  id: number;
  /** The start row's tool call. Absent in jobs adopted from older versions. */
  toolCallId?: string;
  task: string;
  request: Request;
  started: number;
  progress: Progress;
  controller: AbortController;
  stoppedBy?: "user" | "agent";
  /** Settles once the comrade has exited and its result has been handled. */
  done: Promise<void>;
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

/** The running Pi itself, so comrades use the same release and extensions. */
function currentPi(): Invocation {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/") && existsSync(script))
    return { command: process.execPath, args: [script] };
  if (!/^(node|bun)(\.exe)?$/i.test(basename(process.execPath)))
    return { command: process.execPath, args: [] };
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
  };
}

/** A running comrade's row: its summary, when it started, and what it is doing. */
const live = (request: Request, progress: Progress, started: number): Details => ({
  ...summary(request, progress),
  started,
  ...(progress.activity ? { activity: progress.activity } : {}),
});

const emptyProgress = (): Progress => ({
  turns: 0,
  calls: 0,
  work: emptyWork(),
  usage: emptyUsage(),
  text: "",
  activity: starting(),
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
    provider: requested.provider,
    model: requested.model,
    // Missing settings fall back to the caller's, as for a new comrade.
    thinking: found?.thinking || undefined,
    tools: found?.tools,
    cwd: found?.cwd,
  };
}

function failure(outcome: Outcome): string | undefined {
  if (outcome.stopReason === "error" || outcome.stopReason === "aborted")
    return `Comrade failed: ${outcome.errorMessage ?? outcome.stopReason}`;
  if (outcome.exitCode !== 0) {
    const stderr = outcome.stderr.trim().split("\n").slice(-20).join("\n");
    const reason = outcome.errorMessage ?? `pi exited with code ${outcome.exitCode}`;
    return stderr ? `${reason}\n${stderr}` : reason;
  }
  if (!outcome.text) return "Comrade finished without an answer.";
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

export function register(pi: ExtensionAPI, invocation: Invocation): void {
  const jobs = new Map<number, Job>();
  // Foreground comrades running now, which a follow-up must wait for.
  const busy = new Set<number>();
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
        `turn ${job.progress.turns + 1}`,
        activityText(live(job.request, job.progress, job.started)) ||
          workSummary(job.progress.work.tallies) ||
          "no calls yet",
        formatCost(job.progress.usage.cost.total),
        formatDuration(Date.now() - job.started),
        taskLine(job.task).slice(0, 60),
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
        content: message(delivery.id, delivery.status, delivery.task, body),
        display: true,
        details: delivery,
      },
      { deliverAs: "followUp", triggerTurn: wake },
    );
  };

  function finish(job: Job, outcome: Outcome) {
    jobs.delete(job.id);
    // After shutdown, the next session start reports the comrade as lost.
    if (!ui) return;
    const base = {
      ...summary(job.request, outcome),
      stopReason: outcome.stopReason,
      exitCode: outcome.exitCode,
      ...(outcome.timedOut ? { timedOut: true } : {}),
      id: job.id,
      task: job.task,
      durationMs: Date.now() - job.started,
    };
    // The agent's own comrades call reports the stop, and the session records it there.
    if (job.stoppedBy === "agent") return;
    if (job.stoppedBy === "user")
      // The user stopped it: tell the agent without starting a turn.
      return deliver({ ...base, status: "stopped" }, "Stopped by the user.", false);
    const reply = respond(job.request, outcome, base, base.durationMs, job.id);
    deliver(
      { ...base, status: reply.isError ? "failed" : "finished", answer: reply.file },
      reply.text,
      true,
    );
  }

  function start(request: Request, id: number, toolCallId: string): Job {
    const progress = emptyProgress();
    const job: Job = {
      id,
      toolCallId,
      task: taskLine(request.task),
      request,
      started: Date.now(),
      progress,
      controller: new AbortController(),
      done: Promise.resolve(),
      owner: finish,
    };
    jobs.set(job.id, job);
    job.done = run(invocation, request, job.controller.signal, (update) => {
      job.progress = update;
    })
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

  pi.on("session_start", (event, ctx) => {
    ui = ctx.ui;
    sessionId = ctx.sessionManager.getSessionId();
    // Comrades started before a /reload keep running; take them over.
    const adopted = event?.reason === "reload" ? (parked.get(sessionId) ?? []) : [];
    parked.delete(sessionId);
    for (const job of adopted) {
      jobs.set(job.id, job);
      job.owner = finish;
    }
    // Number comrades past every one this session has seen, on any branch.
    const seen = ctx.sessionManager.getEntries().flatMap((entry) => record(entry)?.id ?? []);
    next = Math.max(0, ...seen, ...jobs.keys()) + 1;
    // Background runs that were going when Pi exited or switched sessions will never answer. A
    // comrade can run in the background more than once, so each run is matched in order.
    const pending = new Map<number, string>();
    for (const entry of ctx.sessionManager.getBranch()) {
      const details = record(entry);
      if (details?.id !== undefined && entry.type === "message") {
        if (backgroundStart(details)) pending.set(details.id, details.task ?? "");
      } else if (details?.id !== undefined) pending.delete(details.id);
      // Comrades the agent stopped send no message; their stop is the record.
      const stops =
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.toolName === "comrades"
          ? (entry.message.details as { stopped?: number[] } | undefined)?.stopped
          : undefined;
      for (const id of stops ?? []) pending.delete(id);
    }
    for (const [id, task] of pending) {
      if (jobs.has(id)) continue;
      const lost: Delivery = {
        model: "",
        thinking: "",
        tools: [],
        turns: 0,
        calls: 0,
        usage: emptyUsage(),
        id,
        task,
        status: "lost",
      };
      deliver(
        lost,
        "Pi exited or switched sessions while this comrade ran, so its answer will not arrive.",
        false,
      );
    }
    // Deliver what finished while the extension was reloading.
    for (const job of adopted) if (job.outcome) finish(job, job.outcome);
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
        const waiting = [...jobs.keys()].map((id) => `comrade #${id}`).join(", ");
        ctx.ui.setWorkingMessage(`Waiting for ${waiting}`);
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

  pi.on("session_shutdown", (event) => {
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
    } else for (const job of jobs.values()) job.controller.abort();
    jobs.clear();
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
    const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
    if (!details) {
      box.addChild(new Text(content, 0, 0));
      return box;
    }
    const phases = {
      finished: "finished",
      failed: "failed",
      stopped: "stopped",
      lost: "lost",
    } as const;
    const look: Look = {
      phase: phases[details.status],
      task: details.task,
      id: details.id,
      expanded,
      durationMs: details.durationMs,
    };
    // Lost comrades have nothing to show but why.
    const shown = details.status === "lost" ? undefined : details;
    box.addChild(card(look, shown, content.slice(content.indexOf("\n\n") + 2), theme));
    return box;
  });

  pi.registerTool({
    name: "comrade",
    label: "Comrade",
    description:
      "Run a task in a fresh pi process and return its final answer. The comrade sees nothing " +
      "of this conversation. Several calls in one message run in parallel. Every comrade is " +
      "numbered #N and keeps its conversation: continue it with to: N. " +
      `Answers over ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} are truncated ` +
      "and saved in full to a file. Every result ends with a run line: #N, model, turns, calls, " +
      "tokens, cost, duration, and why it stopped.",
    promptSnippet:
      "Delegate a self-contained task to a fresh pi agent and get its answer, or continue one",
    promptGuidelines: [
      "A comrade sees none of this conversation: put every path, constraint, and the expected answer format in its task.",
      "To follow up with a comrade (a correction, a question, the next step), call comrade with to: N and only your new message. Start a new comrade for unrelated work, or once the conversation has grown long: each follow-up resends all of it.",
      "Leave background off unless you have other work to do before you need the answer; foreground calls in one message already run in parallel. A background answer arrives later as a [comrade #N …] message: never guess it. When your other work is done, end your reply, and your turn waits for it.",
      'comrade is read-only by default. Add "edit" and "write" when it must change files, or "bash" to run commands.',
      "When a comrade needs more than a few files, pass them in files with tools: []. When its answer feeds a file or a build, set output and ask for the exact text, with no fences or commentary.",
      "A result whose first line starts [Comrade's answer is cut off or [Comrade timed out is not a finished answer.",
    ],
    parameters,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const to = params.to;
      if (to !== undefined && busy.has(to))
        throw new Error(`Comrade #${to} is still running. Wait for its answer.`);
      if (to !== undefined && jobs.has(to))
        throw new Error(
          `Comrade #${to} is still running in the background. Wait for its answer, or stop it with the comrades tool.`,
        );
      const previous = to === undefined ? undefined : conversation(to, ctx);
      const prepared = prepare(params, ctx, pi, previous);
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
      };
      if (background) {
        const job = start(request, id, toolCallId);
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
          },
        };
      }

      const began = Date.now();
      const update = (progress: Progress) =>
        onUpdate?.({
          content: [{ type: "text", text: progress.text }],
          details: { ...live(request, progress, began), id },
        });
      // Show the row, and the model it will use, before the comrade has started.
      update(emptyProgress());
      busy.add(id);
      const outcome = await run(invocation, request, signal, update).finally(() => {
        busy.delete(id);
        returned.add(toolCallId);
      });
      const details: Details = {
        ...summary(request, outcome),
        id,
        stopReason: outcome.stopReason,
        exitCode: outcome.exitCode,
        ...(outcome.aborted && !outcome.timedOut ? { stopped: true } : {}),
        ...(outcome.timedOut ? { timedOut: true } : {}),
      };
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
      // The task is still arriving: spin until a result takes the header over.
      spin(context.toolCallId, context.invalidate, () => !state.resulted);
      const look: Look = {
        phase: "running",
        task: args.task ?? "",
        expanded: false,
        spinner: frame(),
      };
      return header(look, undefined, theme);
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
      const task = String(context.args?.task ?? "");
      // Rejected before it started: the reason is all there is.
      if (!details?.usage)
        return card({ phase: "failed", task, expanded: true, note: body }, undefined, "", theme);
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
      const shown =
        background && job && ours(job)
          ? { ...live(job.request, job.progress, job.started), id, background: true }
          : (details as Details);
      const look: Look = {
        phase,
        task,
        expanded,
        // Ctrl+O shows the whole task, from the first progress line on.
        prompt: true,
        id,
        spinner: running ? frame() : undefined,
        live: background && running,
        durationMs:
          running && shown.started !== undefined
            ? Date.now() - shown.started
            : background
              ? undefined
              : context.durationMs,
        note:
          phase === "background"
            ? `Runs in the background. Its answer arrives later as Comrade #${details.id}.`
            : phase === "stopped"
              ? "Stopped with Esc."
              : undefined,
      };
      return card(look, shown, body, theme);
    },
  });

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
  register(pi, currentPi());
}
