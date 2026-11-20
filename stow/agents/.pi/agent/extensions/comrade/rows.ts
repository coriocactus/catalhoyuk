// A comrade's rows as Pi's renderers ask for them: the row of its call, at work and at rest, the
// row of the message that delivers a background run's answer, and listings, which show the
// background runs in progress as their start rows do. What a row looks like is view.ts; this
// decides what each row shows, and keeps the rows at work turning.
import type {
  EntryRenderer,
  MessageRenderer,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text } from "@earendil-works/pi-tui";
import { type Spinner, spinnerFrame } from "../shared/spinner.ts";
import type { Background, Job } from "./background.ts";
import {
  atIn,
  backgroundStart,
  type Delivery,
  hasRunDetails,
  isDelivery,
  isStop,
  LISTING,
  type Listed,
  type Listing,
  listedIn,
  live,
  MESSAGE,
  missingIn,
  notRunning,
  record,
  type Saved,
} from "./details.ts";
import { cleanTitle } from "./request.ts";
import type { Channel, Progress } from "./run.ts";
import type { Session } from "./session.ts";
import type { Transcripts } from "./transcripts.ts";
import {
  type Ending,
  ListingLine,
  type Look,
  type Phase,
  RowView,
  type RunDetails,
  type Stacked,
  StackView,
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

/** Whether a listed run's row is expanded, and its task and earlier work with it. */
interface Shown {
  expanded: boolean;
  taskExpanded?: boolean;
  earlierExpanded?: boolean;
}

/** A listing's rows, as clicks left them since Ctrl+O last expanded or collapsed them all. */
interface ListingState {
  /** What Ctrl+O said when they were last all expanded or collapsed. */
  expanded: boolean;
  /** By comrade. */
  rows: Map<number, Shown>;
  /** An older listing's one line is expanded to its rows. */
  line?: boolean;
}

/** Shared by a row's call and result renderers. */
interface RowState {
  resulted?: boolean;
  /** The whole task, not just its first lines. */
  taskExpanded?: boolean;
  /** All its work, not just its latest blocks. */
  earlierExpanded?: boolean;
}

export interface RowsDeps {
  session: Session;
  background: Background;
  /** Foreground comrades running now, and what sends them a steer. */
  foreground: ReadonlyMap<number, { channel: Channel; title?: string }>;
  /** Foreground comrades whose call has returned: their rows stop spinning. */
  returned: Set<string>;
  transcripts: Transcripts;
  /** Rows at work: by tool call, and by listing and comrade. */
  spinner: Spinner<string>;
  /** Asks Pi for a frame, for rows Pi gives no way to redraw: a listing in a session entry. */
  requestRender(): void;
  /** Pi's output padding, for rows Pi does not tell it: a listing in a session entry. */
  outputPad(): number;
}

export type Rows = ReturnType<typeof createRows>;

export function createRows(deps: RowsDeps) {
  const { session, background, foreground, returned, transcripts, spinner, requestRender } = deps;
  const { jobs } = background;
  // How to redraw each comrade's background start rows, which say how its runs went once the
  // session holds their answer: comrade -> tool call -> redraw.
  const startRows = new Map<number, Map<string, () => void>>();
  const redrawStartRows = (id?: number) => {
    const rows = id === undefined ? [...startRows.values()] : [startRows.get(id)];
    for (const redraws of rows) for (const redraw of redraws?.values() ?? []) redraw();
  };

  /** The row's one component, drawing its latest state: Pi keeps it between renderer calls. */
  const draw = (previous: Component | undefined, ...row: Parameters<RowView["update"]>) =>
    previous instanceof RowView ? previous.update(...row) : new RowView(...row);

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
  const endingOf = (toolCallId: string, id: number): Ending | undefined => {
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
      // Its own run's answer, or a run that resumed it: not a later run's of the same comrade.
      if (details.run && details.run !== toolCallId && details.row !== toolCallId) continue;
      return details.status;
    }
  };

  // One header per row: the call slot shows it until a result exists, then the result
  // slot draws it with the ending and the call slot stays empty.
  const renderCall = (args: Args, theme: Theme, context: RenderContext): Component => {
    // The spinner asked Pi to draw the row again: what changed, the row reads as it is drawn.
    if (spinner.animating && context.lastComponent) return context.lastComponent;
    const state = context.state as RowState;
    if (state.resulted)
      return context.lastComponent instanceof Container ? context.lastComponent : new Container();
    // The task is still arriving or the call running: spin until a result takes the header
    // over. Pi draws a call left without a result, in a session opened again, as if its task
    // were still arriving, and never tells it otherwise: only while Pi works is a call at work.
    const working = () => session.working?.() === true;
    const atWork = (!context.argsComplete || context.executionStarted) && working();
    if (atWork)
      spinner.add(context.toolCallId, {
        redraw: context.invalidate,
        spinning: () => !state.resulted && working(),
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
    // Its header is Pi's to expand and collapse, as on every call's row; the task's toggle is its own.
    const toggles: Toggles = {
      task: () => {
        state.taskExpanded = !state.taskExpanded;
        context.invalidate();
      },
      earlier: () => {
        state.earlierExpanded = !state.earlierExpanded;
        context.invalidate();
      },
    };
    // A steer: its message, sent.
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
    // Refused before it started, or details that are not a run's: the reason is all there is.
    if (!hasRunDetails(details))
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
    // replaces its progress as the comrade works, so the run details follow it as the row is drawn.
    let seen: Progress | undefined;
    let card: Saved & RunDetails = details;
    const current = (): RunDetails => {
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
    // What it did, for a row that shows it: expanded, or at work in the foreground. A background
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
      taskExpanded: state.taskExpanded,
      earlierExpanded: state.earlierExpanded,
      id,
      spinner: running ? spinnerFrame() : undefined,
      live: inBackground && running,
      home: session.home,
      ...(inBackground && !running && id !== undefined
        ? { ending: endingOf(context.toolCallId, id) }
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
    // Pi draws what a session file holds, which may be damaged: then the message is all there is.
    const details = isDelivery(entry.details) ? entry.details : undefined;
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
    // Expanded, the task its start row was given and what it did, looked up only then: a row drawn
    // before the session has started knows neither yet.
    const expand = () => {
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
    if (expanded) expand();
    // Its own clicks expand and collapse it, until Ctrl+O, which draws it afresh.
    return new RowView(look, details, phase === "resumed" ? "" : body, theme, outputPad, {
      row: () => {
        look.expanded = !look.expanded;
        if (look.expanded) expand();
      },
      task: () => {
        look.taskExpanded = !look.taskExpanded;
      },
      earlier: () => {
        look.earlierExpanded = !look.earlierExpanded;
      },
    });
  };

  // Listings: a `/comrades` entry, or an agent's `comrades` call, shows each background run in
  // progress then as its start row does. Only the newest follows its runs: an older one shows how
  // they stood when it was made, in one line, so checking again repeats nothing live. Pi builds a
  // listing afresh whenever it invalidates it, so which rows are expanded is kept here, by
  // listing, until Ctrl+O expands or collapses all.
  const listings = new Map<string, ListingState>();
  /** When the newest listing was made: in this session, or before it, as its branch shows. */
  let newest = 0;
  const noteListing = (at: number) => {
    if (at <= newest) return;
    newest = at;
    requestRender();
  };

  /**
   * One run's row in a listing, drawn as its start row is. In the newest listing it follows its
   * run, spinning while the run goes on, then saying how it ended; in an older one it shows how the
   * run stood when listed. Asked on every draw, it changes without Pi rendering the listing afresh.
   */
  const listedRow = (
    key: string,
    at: number,
    { details, run, row }: Listed,
    state: ListingState,
    theme: Theme,
    pad: number,
  ): ((current: boolean) => Stacked) => {
    const { id } = details;
    const spin = `${key}\0${id}`;
    const shown = state.rows.get(id) ?? { expanded: state.expanded };
    state.rows.set(id, shown);
    // A resumed run has a run of its own, but keeps its start row.
    const ours = (job: Job | undefined): job is Job =>
      job !== undefined && (job.run === run || (row !== undefined && job.toolCallId === row));
    // The whole task, as the call that started the run gave it: looked up when first expanded.
    let task: string | undefined;
    const fullTask = () => {
      task ??= taskFor({ id, run: row ?? run }) ?? details.task ?? "";
      return task;
    };
    let view: RowView | undefined;
    let drawn: { running: boolean; current: boolean } | undefined;
    // The session now holds the run's answer, or the agent stopped it: its ending is known.
    let stale = false;
    const redraws = startRows.get(id) ?? new Map<string, () => void>();
    startRows.set(
      id,
      redraws.set(spin, () => {
        stale = true;
        requestRender();
      }),
    );
    const build = (job: Job | undefined, current: boolean): RowView => {
      const look: Look = {
        phase: "background",
        task: shown.expanded ? fullTask() : (details.task ?? ""),
        expanded: shown.expanded,
        taskExpanded: shown.taskExpanded,
        earlierExpanded: shown.earlierExpanded,
        id,
        live: job !== undefined,
        home: session.home,
        ...(job
          ? { spinner: spinnerFrame(), durationMs: Date.now() - job.started }
          : current
            ? { ending: row === undefined ? undefined : endingOf(row, id) }
            : {
                stood: true,
                ...(at && details.started !== undefined
                  ? { durationMs: at - details.started }
                  : {}),
              }),
      };
      const cwd = details.cwd ?? session.home;
      const follow = transcripts.keepCurrent(
        look,
        () =>
          job?.run && look.expanded
            ? transcripts.blocksFor(job.run, () => job.progress.messages, cwd, theme, true)
            : undefined,
        job !== undefined,
      );
      let card: RunDetails = details;
      if (job) {
        spinner.add(spin, {
          redraw: requestRender,
          spinning: () => ours(jobs.get(id)) && at >= newest,
          settle: true,
        });
        let seen: Progress | undefined;
        look.refresh = () => {
          spinner.drew(spin);
          look.spinner = spinnerFrame();
          look.durationMs = Date.now() - job.started;
          follow();
          if (job.progress !== seen) {
            seen = job.progress;
            card = live(job.request, job.progress, job.started);
          }
          return card;
        };
      } else look.refresh = follow;
      // Its own clicks expand and collapse it: a listing holds several rows, each its own.
      const toggles: Toggles = {
        row: () => {
          look.expanded = !look.expanded;
          shown.expanded = look.expanded;
          if (look.expanded) look.task = fullTask();
        },
        task: () => {
          look.taskExpanded = !look.taskExpanded;
          shown.taskExpanded = look.taskExpanded;
        },
        earlier: () => {
          look.earlierExpanded = !look.earlierExpanded;
          shown.earlierExpanded = look.earlierExpanded;
        },
      };
      return draw(view, look, card, "", theme, pad, toggles);
    };
    return (current) => {
      const job = jobs.get(id);
      const running = current && ours(job);
      // Built again when its run ends, its ending becomes known, or a newer listing takes over:
      // more than its frame changed.
      if (!view || stale || drawn?.running !== running || drawn.current !== current) {
        view = build(running ? job : undefined, current);
        drawn = { running, current };
        stale = false;
      }
      return { component: view, expanded: shown.expanded };
    };
  };

  /**
   * The rows of a listing, one per run it names. `key` names the listing; `at` is when it was
   * made, absent for a stop's rows, which say how the runs ended whatever came after.
   */
  const listingView = (
    key: string,
    at: number | undefined,
    listed: Listed[],
    expanded: boolean,
    theme: Theme,
    pad: number,
  ): StackView => {
    if (at !== undefined) noteListing(at);
    const kept = listings.get(key);
    const state: ListingState =
      kept?.expanded === expanded ? kept : { expanded, rows: new Map<number, Shown>() };
    listings.set(key, state);
    const current = () => at === undefined || at >= newest;
    const rows = listed.map((item) => listedRow(key, at ?? 0, item, state, theme, pad));
    // Older, several runs take one line, which expands to their rows as they stood, indented.
    const frozen =
      listed.length > 1
        ? listed.map((item) => listedRow(`${key}\0stood`, at ?? 0, item, state, theme, pad + 2))
        : rows;
    const line = new ListingLine(
      listed.map((item) => item.details),
      at ?? 0,
      theme,
      pad,
      () => state.line === true,
      () => {
        state.line = !state.line;
      },
    );
    return new StackView(() => {
      if (current()) return rows.map((each) => each(true));
      if (listed.length === 1) return [rows[0](false)];
      const stood: Stacked[] = [{ component: line, expanded: false }];
      if (state.line) stood.push(...frozen.map((each) => ({ ...each(false), expanded: false })));
      return stood;
    });
  };

  /** A `/comrades` entry: the background runs in progress when it was added. */
  const renderListing: EntryRenderer = (entry, { expanded }, theme) => {
    const listed = listedIn(entry.data);
    return listed.length
      ? listingView(
          `entry\0${entry.id}`,
          atIn(entry.data),
          listed,
          expanded,
          theme,
          deps.outputPad(),
        )
      : undefined;
  };

  /** An agent's `comrades` call until its result: the comrades it stops, if any. */
  const renderListCall = (
    args: { stop?: number[] },
    theme: Theme,
    context: RenderContext,
  ): Component => {
    const state = context.state as RowState;
    if (state.resulted)
      return context.lastComponent instanceof Container ? context.lastComponent : new Container();
    const stopping = args.stop?.length
      ? `Stopping comrade ${args.stop.map((id) => `#${id}`).join(", ")}`
      : "";
    return new Text(stopping && theme.fg("muted", stopping), context.outputPad, 0);
  };

  /**
   * An agent's `comrades` call: the runs it listed or stopped, as their start rows show them. What
   * the agent read is the result's text; with no run to show, the row is that text.
   */
  const renderListResult = (
    result: Parameters<NonNullable<Tool["renderResult"]>>[0],
    { expanded }: Parameters<NonNullable<Tool["renderResult"]>>[1],
    theme: Theme,
    context: RenderContext,
  ): Component => {
    const state = context.state as RowState;
    if (!state.resulted) {
      state.resulted = true;
      // Empty the call slot after this pass, not during it.
      queueMicrotask(() => context.invalidate());
    }
    const pad = context.outputPad;
    const listed = listedIn(result.details);
    if (!listed.length) {
      const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
      return new Text(theme.fg("muted", text.join("\n")), pad, 0);
    }
    const at = isStop(result.details) ? undefined : atIn(result.details);
    const rows = listingView(`call\0${context.toolCallId}`, at, listed, expanded, theme, pad);
    // Numbers it asked to stop that no comrade had: said under the rows, as the agent read it.
    const missing = missingIn(result.details);
    if (!missing.length) return rows;
    const both = new Container();
    both.addChild(rows);
    both.addChild(new Text(theme.fg("muted", notRunning(missing)), pad, 0));
    return both;
  };

  /** A new listing of these runs, made now: it becomes the newest, the one that follows them. */
  const listing = (listed: Listed[]): Listing => {
    const at = Math.max(Date.now(), newest + 1);
    noteListing(at);
    return { listed, at };
  };

  /** Whether the last entry on the branch is a listing, so another would repeat it. */
  const listingLast = (): boolean => {
    const last = session.branch?.().at(-1);
    if (last?.type === "custom") return last.customType === LISTING;
    return (
      last?.type === "message" &&
      last.message.role === "toolResult" &&
      last.message.toolName === "comrades" &&
      !isStop(last.message.details) &&
      listedIn(last.message.details).length > 0
    );
  };

  return {
    listing,
    listingLast,
    /** A session started: its newest listing, before any drawn here, is the one that follows. */
    started() {
      newest = 0;
      for (const entry of session.branch?.() ?? [])
        if (entry.type === "custom" && entry.customType === LISTING)
          newest = Math.max(newest, atIn(entry.data));
        else if (
          entry.type === "message" &&
          entry.message.role === "toolResult" &&
          entry.message.toolName === "comrades" &&
          !isStop(entry.message.details)
        )
          newest = Math.max(newest, atIn(entry.message.details));
    },
    renderCall,
    renderResult,
    renderMessage,
    renderListing,
    renderListCall,
    renderListResult,
    /** Redraws comrade #id's background start rows, or every comrade's. */
    redrawStartRows,
    /** The session ended: its rows are gone. */
    ended() {
      startRows.clear();
      listings.clear();
      newest = 0;
      spinner.stop(true);
      returned.clear();
    },
  };
}
