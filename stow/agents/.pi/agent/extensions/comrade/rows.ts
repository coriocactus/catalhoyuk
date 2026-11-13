// A comrade's rows as Pi's renderers ask for them: the row of its call, at work and at rest, and
// the row of the message that delivers a background run's answer. What a row looks like is
// view.ts; this decides what each row shows, and keeps the rows at work turning.
import type { MessageRenderer, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Component, Container } from "@earendil-works/pi-tui";
import { type Spinner, spinnerFrame } from "../shared/spinner.ts";
import type { Background, Job } from "./background.ts";
import {
  backgroundStart,
  type Delivery,
  hasCard,
  live,
  MESSAGE,
  record,
  type Saved,
} from "./details.ts";
import { cleanTitle } from "./request.ts";
import type { Channel, Progress } from "./run.ts";
import type { Session } from "./session.ts";
import type { Transcripts } from "./transcripts.ts";
import {
  type Card,
  CardView,
  type Outcome as Ending,
  type Look,
  type Phase,
  type Toggles,
} from "./view.ts";

// biome-ignore lint/suspicious/noExplicitAny: Pi's own type for a tool of any schema.
type Tool = ToolDefinition<any, any, any>;
type RenderContext = Parameters<NonNullable<Tool["renderCall"]>>[2];
/** A call's arguments, as far as its row reads them. They may still be arriving. */
interface Args {
  to?: number;
  task?: string;
  title?: unknown;
}

/** Shared by a row's call and result renderers. */
interface RowState {
  resulted?: boolean;
  /** The whole task, not just its first lines. */
  taskOpen?: boolean;
  /** All its work, not just its latest blocks. */
  earlierOpen?: boolean;
}

export interface RowsDeps {
  session: Session;
  background: Background;
  /** Foreground comrades running now, and what sends them a message. */
  foreground: ReadonlyMap<number, { channel: Channel; title?: string }>;
  /** Foreground comrades whose call has returned: their rows stop spinning. */
  returned: Set<string>;
  transcripts: Transcripts;
  /** Rows at work, by tool call. */
  spinner: Spinner<string>;
}

export type Rows = ReturnType<typeof createRows>;

export function createRows(deps: RowsDeps) {
  const { session, background, foreground, returned, transcripts, spinner } = deps;
  const { jobs } = background;
  // How to redraw each comrade's background start rows, which say how its runs went once the
  // session holds their answer: comrade -> tool call -> redraw.
  const startRows = new Map<number, Map<string, () => void>>();
  const redrawStartRows = (id?: number) => {
    const rows = id === undefined ? [...startRows.values()] : [startRows.get(id)];
    for (const redraws of rows) for (const redraw of redraws?.values() ?? []) redraw();
  };

  /** The row's one component, drawing its latest state: Pi keeps it between renderer calls. */
  const draw = (previous: Component | undefined, ...row: Parameters<CardView["update"]>) =>
    previous instanceof CardView ? previous.update(...row) : new CardView(...row);

  /**
   * The whole task a delivered answer's run was given, from its start row: the row of its run,
   * or for a resumed run, the comrade's latest start row before the message.
   */
  const taskFor = (delivery: Partial<Delivery>): string | undefined => {
    if (!session.branch) return undefined;
    const tasks = new Map<string, string>();
    let latest: string | undefined;
    for (const entry of session.branch()) {
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
    if (!session.branch) return undefined;
    let after = false;
    for (const entry of session.branch()) {
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

  // One header per row: the call slot shows it until a result exists, then the result
  // slot draws it with the outcome and the call slot stays empty.
  const renderCall = (args: Args, theme: Theme, context: RenderContext): Component => {
    // The spinner asked Pi to draw the row again: what changed, the row reads as it is drawn.
    if (spinner.animating && context.lastComponent) return context.lastComponent;
    const state = context.state as RowState;
    if (state.resulted)
      return context.lastComponent instanceof Container ? context.lastComponent : new Container();
    // The task is still arriving or the call running: spin until a result takes the header
    // over. A call left without a result, in a session opened again, is still.
    const atWork = !context.argsComplete || context.executionStarted;
    if (atWork)
      spinner.add(context.toolCallId, {
        redraw: context.invalidate,
        spinning: () => !state.resulted,
        settle: true,
      });
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
      ...(atWork ? { spinner: spinnerFrame() } : {}),
    };
    if (atWork)
      look.refresh = () => {
        spinner.drew(context.toolCallId);
        look.spinner = spinnerFrame();
      };
    return draw(context.lastComponent, look, undefined, "", theme, context.outputPad);
  };

  const renderResult = (
    result: Parameters<NonNullable<Tool["renderResult"]>>[0],
    { expanded, isPartial }: Parameters<NonNullable<Tool["renderResult"]>>[1],
    theme: Theme,
    context: RenderContext,
  ): Component => {
    if (spinner.animating && context.lastComponent) return context.lastComponent;
    const state = context.state as RowState;
    if (!state.resulted) {
      state.resulted = true;
      // Redraw the call slot after this pass, not during it.
      queueMicrotask(() => context.invalidate());
    }
    const first = result.content[0];
    const body = first?.type === "text" ? first.text : "";
    const details = result.details as Saved | undefined;
    const args: Args = context.args ?? {};
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
      return draw(
        context.lastComponent,
        { phase: "sent", task, message: task, id: details.id, title: details.title, expanded },
        undefined,
        "",
        theme,
        pad,
        toggles,
      );
    // Refused before it started, or a record that is not a run's: the reason is all there is.
    if (!hasCard(details))
      return draw(
        context.lastComponent,
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
    const inBackground = !isPartial && backgroundStart(details);
    const phase: Phase = isPartial
      ? "running"
      : inBackground
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
    const job = inBackground && id !== undefined ? jobs.get(id) : undefined;
    const running = phase === "running" || ours(job);
    if (phase === "running")
      spinner.add(context.toolCallId, {
        redraw: context.invalidate,
        spinning: () => !returned.has(context.toolCallId),
        settle: true,
        forgotten: () => returned.delete(context.toolCallId),
      });
    else if (running)
      spinner.add(context.toolCallId, {
        redraw: context.invalidate,
        spinning: () => ours(jobs.get(id as number)),
        settle: true,
      });
    else {
      spinner.delete(context.toolCallId);
      returned.delete(context.toolCallId);
    }
    // A running background comrade shows its job's progress, not the saved start. Its job
    // replaces its progress as the comrade works, so the card follows it as the row is drawn.
    let seen: Progress | undefined;
    let card: Saved & Card = details;
    const current = (): Card => {
      if (inBackground && job && ours(job) && job.progress !== seen) {
        seen = job.progress;
        card = { ...live(job.request, job.progress, job.started), id, background: true };
      }
      return card;
    };
    const started = current().started;
    if (inBackground && id !== undefined) {
      const rows = startRows.get(id) ?? new Map<string, () => void>();
      startRows.set(id, rows.set(context.toolCallId, context.invalidate));
    }
    // What it did, for a row that shows it: open, or at work in the foreground. A background
    // start row shows its run's work only while that run goes on; its answer shows the rest.
    const key = inBackground ? job?.run : context.toolCallId;
    const cwd = details.cwd ?? session.home;
    const work = () =>
      key && (expanded || phase === "running") && (!inBackground || running)
        ? transcripts.blocksFor(
            key,
            // After /reload, a running job's messages are its own, not yet in memory here.
            inBackground ? () => job?.progress.messages : transcripts.savedRun(details),
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
      spinner: running ? spinnerFrame() : undefined,
      live: inBackground && running,
      home: session.home,
      ...(inBackground && !running && id !== undefined
        ? { outcome: outcomeOf(context.toolCallId, id) }
        : {}),
      durationMs:
        running && started !== undefined
          ? Date.now() - started
          : inBackground
            ? undefined
            : context.durationMs,
    };
    const follow = transcripts.keepCurrent(look, work, running);
    // At work, the row reads its spinner, its clock and its comrade's progress each time Pi
    // draws it, so any frame keeps it current, whoever asked for the frame.
    look.refresh = running
      ? () => {
          spinner.drew(context.toolCallId);
          look.spinner = spinnerFrame();
          if (started !== undefined) look.durationMs = Date.now() - started;
          follow();
          return current();
        }
      : follow;
    return draw(context.lastComponent, look, card, body, theme, pad, toggles);
  };

  /** The row of a delivered answer, or of the note that a run was resumed or lost. */
  const renderMessage: MessageRenderer<Delivery> = (entry, { expanded, outputPad }, theme) => {
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
      home: session.home,
      ...(phase === "resumed" ? { note: body } : {}),
    };
    // Opened, the task its start row was given and what it did, looked up only then: a row drawn
    // before the session has started knows neither yet.
    const open = () => {
      if (!details) return;
      look.task = taskFor(details) ?? look.task;
      look.refresh = transcripts.keepCurrent(
        look,
        () =>
          look.expanded && details.run && phase !== "resumed" && phase !== "lost"
            ? transcripts.blocksFor(
                details.run,
                transcripts.savedRun(details),
                details.cwd ?? session.home,
                theme,
                false,
              )
            : undefined,
        false,
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
  };

  return {
    renderCall,
    renderResult,
    renderMessage,
    /** Redraws comrade #id's background start rows, or every comrade's. */
    redrawStartRows,
    /** The session ended: its rows are gone. */
    ended() {
      startRows.clear();
      spinner.stop(true);
      returned.clear();
    },
  };
}
