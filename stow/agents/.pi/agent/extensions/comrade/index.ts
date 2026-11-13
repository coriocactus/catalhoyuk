// Comrade: a tool that hands a task to a fresh Pi process and returns its answer. This file
// wires the parts together and listens to Pi's session events. The parts:
//
//   tool.ts         the comrade tool: its parameters, what running it does
//   rows.ts         what each of a comrade's rows shows; view.ts is how a row looks
//   background.ts   jobs: the background runs in progress in this Pi
//   outbox.ts       delivering a background run's answer into the session, at least once
//   reconcile.ts    at session start, what becomes of background runs that never answered
//   transcripts.ts  what each run did, for its row
//   widget.ts       the lines above the editor
//   run.ts          one run of a comrade's Pi; runs.ts and resume.ts are what is saved of it
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Spinner } from "../shared/spinner.ts";
import { createBackground, type Job } from "./background.ts";
import { createNumbers } from "./conversation.ts";
import { type Delivery, MESSAGE, record } from "./details.ts";
import { createOutbox, deliveries } from "./outbox.ts";
import { currentPi, watchParent } from "./pi.ts";
import { createReconciler, pendingRuns } from "./reconcile.ts";
import { createRows } from "./rows.ts";
import { type Channel, type Invocation, NESTED } from "./run.ts";
import { dropRuns, elsewhere, quietly, readRuns } from "./runs.ts";
import type { Session } from "./session.ts";
import { registerComrade } from "./tool.ts";
import { createTranscripts } from "./transcripts.ts";
import { createWidget } from "./widget.ts";

export type { Delivery, Details } from "./details.ts";
export { currentPi, watchParent } from "./pi.ts";

/** How often a turn waiting for its comrades checks for typed messages. */
const WAIT_POLL_MS = 200;

/** `invocation` may be a function, to resolve it again for each run. */
export function register(pi: ExtensionAPI, invocation: Invocation | (() => Invocation)): void {
  const resolve = () => (typeof invocation === "function" ? invocation() : invocation);
  const session: Session = { terminal: false, home: process.cwd() };
  // Foreground comrades running now, and what sends them a message.
  const foreground = new Map<number, { channel: Channel; title?: string }>();
  // Foreground comrades whose call has returned: their rows stop spinning even if Pi never
  // draws them again.
  const returned = new Set<string>();
  const numbers = createNumbers();
  const transcripts = createTranscripts(pi);
  // The parts below name each other, so the two that are named first are reached through these.
  const outbox = createOutbox(pi, session, {
    redrawStartRows: (id) => rows.redrawStartRows(id),
    refreshWidget: () => widget.refresh(),
  });
  const background = createBackground({
    pi,
    session,
    resolve,
    outbox,
    transcripts,
    refreshWidget: () => widget.refresh(),
  });
  const { jobs } = background;
  const widget = createWidget(session, () => [
    ...background.working(),
    ...outbox.answered.values(),
  ]);
  // Rows still at work spin: see shared/spinner.ts. A row that stopped is redrawn once more, at
  // rest, and the timer stops when none is left.
  const rows = createRows({
    session,
    background,
    foreground,
    returned,
    transcripts,
    spinner: new Spinner<string>(),
  });
  const reconciler = createReconciler(pi, background, outbox);

  pi.on("session_start", (event, ctx) => {
    session.ui = ctx.ui;
    session.id = ctx.sessionManager.getSessionId();
    session.entries = () => ctx.sessionManager.getEntries();
    session.branch = () => ctx.sessionManager.getBranch();
    session.terminal = ctx.mode === "tui";
    session.home = ctx.cwd;
    transcripts.started();
    // Comrades started before a /reload keep running; take them over.
    const adopted = background.adopt(session.id, event?.reason === "reload");
    // Number comrades past every one this session has seen, on any branch.
    const all = ctx.sessionManager.getEntries();
    const seen = all.flatMap((entry) => record(entry)?.id ?? []);
    numbers.past([...seen, ...jobs.keys()]);
    // Records done with: runs whose answer the session holds, and foreground runs no Pi runs.
    const delivered = deliveries(all);
    for (const conversation of new Set(all.flatMap((entry) => record(entry)?.session ?? []))) {
      const stale = readRuns(conversation).filter(
        (saved) => delivered.has(saved.run) || (!saved.background && !elsewhere(saved)),
      );
      if (stale.length)
        quietly(() => dropRuns(conversation, new Set(stale.map((saved) => saved.run))));
    }
    const detached = ctx.mode === "tui" || ctx.mode === "rpc";
    for (const [id, pending] of pendingRuns(ctx.sessionManager.getBranch()))
      try {
        reconciler.recover(id, pending, ctx, delivered, detached);
      } catch (error) {
        ctx.ui.notify(`comrade #${id}: ${error instanceof Error ? error.message : error}`, "error");
      }
    outbox.confirm();
    // Deliver what finished while the extension was reloading.
    for (const job of adopted) if (job.outcome) background.finish(job, job.outcome);
    widget.refresh();
    // Pi drew the transcript before this ran, when start rows could not look their runs up.
    rows.redrawStartRows();
  });

  // An answer that started a turn is in the session as soon as Pi has taken it, and a stop the
  // agent made with the comrades tool once its result is: either tells a start row how its run went.
  pi.on("message_end", (event) => {
    const message = event?.message as
      | { role?: string; customType?: string; toolName?: string; details?: { stopped?: number[] } }
      | undefined;
    if (message?.role === "custom" && message.customType === MESSAGE)
      setTimeout(outbox.confirm, 0).unref();
    if (message?.role === "toolResult" && message.toolName === "comrades")
      setTimeout(() => {
        for (const id of message.details?.stopped ?? []) rows.redrawStartRows(id);
      }, 0).unref();
  });

  pi.on("agent_settled", (_event, ctx) => outbox.settled(ctx));

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
    const before = outbox.woken();
    try {
      while (jobs.size && !interrupted && !ctx.hasPendingMessages() && outbox.woken() === before) {
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
    outbox.close();
    widget.close();
    session.entries = undefined;
    session.branch = undefined;
    rows.ended();
    transcripts.ended();
    session.ui = undefined;
    if (event?.reason === "reload" && session.id !== undefined) return background.park(session.id);
    await background.stop();
  });

  pi.registerCommand("comrades", {
    description: "List background comrades, or stop them with /comrades stop <n|all>",
    getArgumentCompletions: (prefix) => {
      const items = ["stop all", ...[...background.jobs.keys()].map((id) => `stop ${id}`)]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const [verb, target] = args.trim().split(/\s+/).filter(Boolean);
      if (verb === "stop") {
        const ids =
          target === "all" ? [...background.jobs.keys()] : [Number(target?.replace(/^#/, ""))];
        const stopping = ids.flatMap((id) => background.jobs.get(id) ?? []);
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
      ctx.ui.notify(background.listing() || "No comrades running.", "info");
    },
  });

  pi.registerMessageRenderer<Delivery>(MESSAGE, rows.renderMessage);
  registerComrade({ pi, resolve, background, foreground, returned, numbers, transcripts, rows });
  registerList(pi, jobs, background.listing);
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
  // A comrade offers no comrade of its own, and stops once its parent is gone. It watches from
  // its session's start, not as the extension loads: Pi can load extensions and start no session.
  if (parent !== undefined) {
    let unwatch = () => {};
    pi.on("session_start", () => {
      unwatch();
      unwatch = watchParent(Number(parent));
    });
    pi.on("session_shutdown", () => unwatch());
    return;
  }
  register(pi, () => currentPi());
}
