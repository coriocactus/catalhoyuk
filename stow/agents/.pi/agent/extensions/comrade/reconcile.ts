// Reconciling: when a session starts, deciding what becomes of each background run on its branch
// that never answered. Pi exited, or left the session, while the run went on.
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { formatDuration } from "../shared/format.ts";
import { respond } from "./answer.ts";
import { type Background, MAX_BACKGROUND } from "./background.ts";
import { conversationCwd, saved } from "./conversation.ts";
import {
  backgroundStart,
  type Delivery,
  emptyProgress,
  record,
  savedFace,
  summary,
} from "./details.ts";
import type { deliveries, Outbox } from "./outbox.ts";
import { within } from "./request.ts";
import { type Finished, finished, interruption, interruptionNote } from "./resume.ts";
import { emptyUsage, type Outcome, type Request } from "./run.ts";
import {
  dropRuns,
  elsewhere,
  modified,
  outlived,
  quietly,
  type RunRecord,
  readRuns,
  saveRun,
} from "./runs.ts";

/** How recently a background run must have been interrupted for the session to resume it. */
const RESUME_WITHIN_MS = 24 * 60 * 60_000;
/**
 * How often a run whose comrade's Pi outlived its host is checked again, and how many times:
 * past a comrade's two seconds to notice, and the time it may take to shut down.
 */
const OUTLIVED_MS = 1000;
const OUTLIVED_CHECKS = 15;
/** What a resumed comrade is asked, after the note on what was interrupted. */
const RESUME_TASK =
  "Resume your task from where you stopped, and end with your final answer as before.";

/** A background run on this branch that never answered: from its start row, or its resume. */
export interface Pending {
  /** Absent in rows saved by older versions. */
  run?: string;
  /** The start row's tool call, which shows the run, and any that resumes it, while it goes. */
  row?: string;
  task: string;
  /** Its row or message: the comrade's conversation and settings. */
  details: Partial<Delivery>;
}

/**
 * The background runs on this branch that never answered, by comrade. A comrade can run in the
 * background more than once, so each run is matched in order, and by its id where both have one.
 */
export function pendingRuns(branch: SessionEntry[]): Map<number, Pending> {
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
    const details = record(entry);
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

export function createReconciler(pi: ExtensionAPI, background: Background, outbox: Outbox) {
  /** The runs checked again later, by comrade. Their session's end ends the wait. */
  const waits = new Map<number, ReturnType<typeof setTimeout>>();
  pi.on("session_shutdown", () => {
    for (const wait of waits.values()) clearTimeout(wait);
    waits.clear();
  });

  const lost = (id: number, pending: Pending, why?: string) => {
    const session = pending.details.session;
    const continuable = Boolean(session && pending.details.requested && saved(session));
    const again = continuable ? ` Its conversation is saved: continue it with to: ${id}.` : "";
    // What its row says, in a line.
    const reason = why
      ? `Not resumed: ${why}.${continuable ? ` Continue it with to: ${id}.` : ""}`
      : continuable
        ? `It could not be resumed here. Continue it with to: ${id}.`
        : "Pi exited while it ran, so its answer will not arrive.";
    outbox.deliver(
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
        ? `Pi exited or switched sessions while this comrade ran, and it was not resumed: ${why}.${again}`
        : continuable
          ? `Pi exited or switched sessions while this comrade ran, and it could not be resumed here.${again}`
          : "Pi exited or switched sessions while this comrade ran, so its answer will not arrive.",
      false,
    );
    const run = pending.run;
    if (session && run) quietly(() => dropRuns(session, new Set([run])));
  };

  /** What a background run's row or message says it ran with, and what its run record adds. */
  const requestOf = (
    details: Partial<Delivery>,
    record: RunRecord | undefined,
    ctx: ExtensionContext,
    task: string,
    files: string[],
    running = true,
  ): Request | string => {
    const { session, requested } = details;
    if (!session || !requested) return "it ran before comrades kept their conversations";
    // Pi runs a saved conversation in the directory its file names, whatever directory it starts
    // in, so trust is decided for that one. Its row keeps a directory only when not the caller's.
    const named = (saved(session) ? conversationCwd(session) : undefined) ?? details.cwd ?? ctx.cwd;
    // The caller's own directory keeps the caller's name for it, so the row says nothing of it.
    const cwd = within(named, ctx.cwd) && within(ctx.cwd, named) ? ctx.cwd : named;
    // Only a run that runs again needs them: an answer is delivered without either.
    if (running) {
      if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory())
        return `its directory ${cwd} is gone`;
      const gone = files.find((file) => !statSync(file, { throwIfNoEntry: false })?.isFile());
      if (gone) return `its attached file ${gone} is gone`;
    }
    return {
      task,
      provider: requested.provider,
      model: requested.model,
      thinking: details.thinking || ctx.thinkingLevel || pi.getThinkingLevel(),
      // The tools it was given when it started: resuming it finishes that same run.
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
    const request = requestOf(pending.details, record, ctx, record.task, record.files, false);
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
      // Until its last message, or with none known, until its run record last changed.
      durationMs: Math.max(0, (done.ended ?? record.at) - record.started),
      run: record.run,
      ...(pending.row && pending.row !== record.run ? { row: pending.row } : {}),
      // What it did, from its conversation: from the run it resumes, if it resumes one.
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
    outbox.resend(request.session, { ...answer, at: Date.now() }, false);
  };

  /**
   * Resumes a background run that Pi exited during, in its conversation, with what it ran
   * with. One whose task never reached the comrade is sent it again. One interrupted mid-run is
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
      // With no run record, only its conversation could say where it stopped.
      if (!saved && !cut) return "Comrade could not tell where it stopped";
      task = `${interruptionNote(cut, "the Pi that started you exited")}\n\n${RESUME_TASK}`;
    }
    const request = requestOf(pending.details, saved, ctx, task, files);
    if (typeof request === "string") return request;
    const run = randomUUID();
    // The run it resumes started first: its answer shows what both did.
    const from = pending.details.from ?? saved?.started ?? pending.details.started;
    const job = background.start(request, id, run, pending.row, pending.task);
    if (from !== undefined) job.from = from;
    if (saved) quietly(() => dropRuns(request.session, new Set([saved.run])));
    outbox.deliver(
      {
        ...summary(request, emptyProgress()),
        id,
        task: pending.task,
        status: "resumed",
        run,
        ...(pending.row ? { row: pending.row } : {}),
        ...(from !== undefined ? { from } : {}),
      },
      `Pi exited while this comrade ran, so it resumes from where it stopped. Its answer will arrive as another [comrade #${id} …] message.`,
      false,
    );
  };

  /**
   * Reconciles a run again a little later, while the comrade's Pi of an interrupted run is still
   * shutting down. That process is never signalled: its id may have been reused since. One still
   * running after the last check is left, with a notice, for the session's next start.
   */
  const later = (
    id: number,
    pending: Pending,
    ctx: ExtensionContext,
    delivered: ReturnType<typeof deliveries>,
    outliving: RunRecord,
    checks: number,
  ) => {
    if (checks >= OUTLIVED_CHECKS)
      return ctx.ui.notify(
        `Comrade #${id} was not resumed: the Pi of its interrupted run (process ${outliving.child}) is still running. Continue it with to: ${id}.`,
        "warning",
      );
    const session = pending.details.session;
    clearTimeout(waits.get(id));
    const wait = setTimeout(() => {
      waits.delete(id);
      // The comrade moved on meanwhile, continued here or resumed by another Pi: not ours now.
      const now = session
        ? readRuns(session).find((item) => item.run === outliving.run)
        : undefined;
      if (now?.at !== outliving.at) return;
      try {
        reconcile(id, pending, ctx, delivered, true, checks + 1);
      } catch (error) {
        try {
          ctx.ui.notify(
            `comrade #${id}: ${error instanceof Error ? error.message : error}`,
            "error",
          );
        } catch {
          // A context gone stale: the session's next start reconciles it.
        }
      }
    }, OUTLIVED_MS);
    wait.unref();
    waits.set(id, wait);
  };

  /**
   * A background run on this branch that never answered, at the session's start: delivered if it
   * had answered, left alone if another Pi runs it, resumed if it was interrupted in the last day,
   * and reported otherwise. `checks`: how often it has waited for a comrade that outlived its host.
   */
  const reconcile = (
    id: number,
    pending: Pending,
    ctx: ExtensionContext,
    delivered: ReturnType<typeof deliveries>,
    detached: boolean,
    checks = 0,
  ) => {
    if (background.jobs.has(id)) return;
    const session = pending.details.session;
    const run = pending.run;
    const records = session ? readRuns<Delivery>(session) : [];
    const saved = run ? records.find((item) => item.run === run) : undefined;
    // Answered, but the session never held the answer: it is saved.
    if (session && saved?.answer) return outbox.resend(session, saved, false);
    // Answered on another branch: the same answer, here too.
    const there = run ? delivered.get(run) : undefined;
    if (there) return outbox.redeliver(there);
    // Another Pi runs it now, or a run that resumed it, as a fork's Pi does under a run of its
    // own, and its answer goes to that Pi's session.
    const busy = records.find(elsewhere);
    if (busy)
      return ctx.ui.notify(
        `Comrade #${id} is still running in another Pi (process ${busy.owner}).`,
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
    // Interrupted long ago, resuming it could act on files changed since.
    const cutAt = Math.max(saved?.at ?? 0, modified(session));
    if (Date.now() - cutAt > RESUME_WITHIN_MS)
      return lost(id, pending, `it stopped ${formatDuration(Date.now() - cutAt)} ago`);
    // The comrade's Pi of an interrupted run may still be shutting down, and resumed now, two Pis
    // would work in one conversation.
    const outliving = records.find(outlived);
    if (outliving) return later(id, pending, ctx, delivered, outliving, checks);
    // At the limit, it waits for the session's next start.
    if (background.jobs.size >= MAX_BACKGROUND)
      return ctx.ui.notify(
        `Comrade #${id} was not resumed: ${MAX_BACKGROUND} background comrades are running.`,
        "warning",
      );
    const why = resume(id, pending, saved, ctx);
    if (why) lost(id, pending, why);
  };

  return { reconcile };
}
