// Jobs: the background runs in progress in this Pi. A job is what the host holds of a run to
// follow it, send it messages, and stop it. When it ends, its answer goes to the outbox.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatCost, formatDuration } from "../shared/format.ts";
import { reasonOf, respond } from "./answer.ts";
import { type Delivery, emptyProgress, live, summary } from "./details.ts";
import type { Outbox } from "./outbox.ts";
import {
  Channel,
  type Invocation,
  type Outcome,
  type Progress,
  type Request,
  run as runComrade,
} from "./run.ts";
import { dropRuns, follow, launched, quietly, saveRun, updateRun } from "./runs.ts";
import type { Session } from "./session.ts";
import type { Transcripts } from "./transcripts.ts";
import { activityText, type Running, taskLine } from "./view.ts";
import { summary as workSummary } from "./work.ts";

/** Background comrades running at once, to bound cost. */
export const MAX_BACKGROUND = 4;
/** How long leaving a session waits for its comrades to stop: past the SIGKILL that ends them. */
const STOP_MS = 6000;
/** How long jobs parked for a /reload wait for the reloaded extension before being stopped. */
const ADOPT_MS = 10_000;

export interface Job {
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

export interface BackgroundDeps {
  pi: ExtensionAPI;
  session: Session;
  /** The Pi to run, resolved again for each run. */
  resolve(): Invocation;
  outbox: Outbox;
  transcripts: Transcripts;
  refreshWidget(): void;
}

export type Background = ReturnType<typeof createBackground>;

export function createBackground(deps: BackgroundDeps) {
  const { session, outbox, transcripts, refreshWidget } = deps;
  /** By comrade: a comrade runs once at a time. */
  const jobs = new Map<number, Job>();

  /** What the agent and `/comrades` read: a line per job, then their cost together. */
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

  /** The widget's lines for the jobs at work, in comrade order. */
  const working = (): Running[] =>
    [...jobs.values()]
      .sort((a, b) => a.id - b.id)
      .map((job) => ({
        id: job.id,
        title: job.request.face?.title ?? taskLine(job.task),
        doing: activityText(live(job.request, job.progress, job.started)) || "starting",
        cost: job.progress.usage.cost.total,
        elapsedMs: Date.now() - job.started,
      }));

  /** A job's run has ended: its answer is saved, then sent. */
  function finish(job: Job, outcome: Outcome) {
    jobs.delete(job.id);
    const conversation = job.request.session;
    const run = job.run;
    // The agent's own comrades call reports the stop, and the session records it there.
    if (job.stoppedBy === "agent") {
      if (run) quietly(() => dropRuns(conversation, new Set([run])));
      return refreshWidget();
    }
    // Leaving the session cut it off: its record carries it on when the session next starts.
    if (!session.ui && outcome.aborted && !job.stoppedBy && !outcome.timedOut)
      return refreshWidget();
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
    if (run && job.from === undefined) transcripts.track(run, outcome.messages, false);
    else if (run) transcripts.forget(run);
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
        updateRun<Delivery>(conversation, run, { phase: "done", answer: { delivery, body } }),
      );
    if (!session.ui) return refreshWidget();
    if (run) outbox.sent(run, conversation);
    outbox.deliver(delivery, body, wake);
    // Until the session holds its answer, its line stays in the widget, saying so.
    if (run && job.stoppedBy !== "user")
      outbox.answered.set(run, {
        id: job.id,
        title: job.request.face?.title ?? job.task,
        doing: `${delivery.status} · answer queued`,
        cost: outcome.usage.cost.total,
        elapsedMs: base.durationMs,
        ended: delivery.status === "failed" ? "failed" : "finished",
      });
    outbox.confirm();
    refreshWidget();
  }

  /** Starts a background run. `task` is the task line it shows. */
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
      deps.resolve(),
      request,
      job.controller.signal,
      (update) => {
        watch(update);
        transcripts.track(run, update.messages, true);
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
        session.ui?.notify(
          `comrade #${job.id}: ${error instanceof Error ? error.message : error}`,
          "error",
        );
      });
    return job;
  }

  /** Takes over the jobs a /reload of this session parked. They keep running meanwhile. */
  const adopt = (sessionId: string, reloaded: boolean): Job[] => {
    const adopted = reloaded ? (parked.get(sessionId) ?? []) : [];
    parked.delete(sessionId);
    for (const job of adopted) {
      jobs.set(job.id, job);
      job.owner = finish;
    }
    return adopted;
  };

  /** Leaves the jobs running across a /reload, for the reloaded extension to adopt. */
  const park = (sessionId: string) => {
    const left = [...jobs.values()];
    for (const job of left) job.owner = undefined;
    parked.set(sessionId, left);
    // If the reloaded extension never adopts them, for example because it failed to load,
    // stop them rather than let them run unseen.
    setTimeout(() => {
      if (parked.get(sessionId) !== left) return;
      parked.delete(sessionId);
      for (const job of left) job.controller.abort();
    }, ADOPT_MS).unref();
    jobs.clear();
  };

  /**
   * Stops every job as its session is left. Stopped, each comrade's Pi records the calls it cut
   * off. The session carries them on when it next starts, perhaps at once in this Pi, so the
   * old ones must be gone by then.
   */
  const stop = async () => {
    const stopping = [...jobs.values()];
    for (const job of stopping) job.controller.abort();
    jobs.clear();
    await Promise.race([
      Promise.all(stopping.map((job) => job.done)),
      new Promise((wake) => setTimeout(wake, STOP_MS).unref()),
    ]);
  };

  return { jobs, listing, working, start, finish, adopt, park, stop };
}
