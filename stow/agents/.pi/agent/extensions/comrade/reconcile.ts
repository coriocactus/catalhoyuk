// Reconciling: when a session starts, deciding what becomes of each background run on its branch
// that never answered. Pi exited, or left the session, while the run went on.
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { formatDuration } from "../shared/format.ts";
import { respond } from "./answer.ts";
import { type Background, MAX_BACKGROUND } from "./background.ts";
import { saved } from "./conversation.ts";
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
  quietly,
  type RunRecord,
  readRuns,
  saveRun,
} from "./runs.ts";

/** How recently a background run must have been cut off for the session to carry it on. */
const RESUME_WITHIN_MS = 24 * 60 * 60_000;
/** What a resumed comrade is asked, after the note on what was cut off. */
const CARRY_ON =
  "Carry on with your task from where you stopped, and end with your final answer as before.";

/** A background run on this branch that never answered: from its start row, or its resume. */
export interface Pending {
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
    outbox.resend(request.session, { ...answer, at: Date.now() }, false);
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
    if (background.jobs.has(id)) return;
    const session = pending.details.session;
    const run = pending.run;
    const saved =
      session && run ? readRuns<Delivery>(session).find((item) => item.run === run) : undefined;
    // Answered, but the session never held the answer: it is saved.
    if (session && saved?.answer) return outbox.resend(session, saved, false);
    // Answered on another branch: the same answer, here too.
    const there = run ? delivered.get(run) : undefined;
    if (there) return outbox.redeliver(there);
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
    if (background.jobs.size >= MAX_BACKGROUND)
      return ctx.ui.notify(
        `Comrade #${id} did not carry on: ${MAX_BACKGROUND} background comrades are running.`,
        "warning",
      );
    const why = resume(id, pending, saved, ctx);
    if (why) lost(id, pending, why);
  };

  return { recover };
}
