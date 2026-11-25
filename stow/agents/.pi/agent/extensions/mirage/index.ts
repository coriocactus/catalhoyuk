import {
  type ExtensionAPI,
  type ExtensionContext,
  type SessionEntry,
  sessionEntryToContextMessages,
  type ToolRenderers,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { type AnchorState, ROW_ANCHOR } from "../shared/anchors.ts";
import { HISTORY_PAGE, type HistoryPage, type HistoryRenderState } from "../shared/history.ts";
import { isNestedRowsRequest, NESTED_ROWS_EVENT, type NestedRows } from "../shared/nested.ts";
import { type FileReference, OPEN_FILE_EVENT, type OpenFileRequest } from "../shared/protocol.ts";
import { Spinner, spinnerFrame } from "../shared/spinner.ts";
import { isTranscriptView, TRANSCRIPT_VIEW, type TranscriptView } from "../shared/transcript.ts";
import {
  everyKind,
  inProgress,
  TOOL_NAMES,
  type ToolCallState,
  ToolGroups,
  type ToolKinds,
  type ToolName,
} from "./model.ts";
import { installNativeImageSlot, ownImageRendering, renderNativeImages } from "./native-images.ts";
import { installNativeThinking } from "./native-thinking.ts";
import { ToolGroupView } from "./view.ts";

const EMPTY: Component = { render: () => [], invalidate() {} };
type DisplayState = { view?: ToolGroupView; outputPad?: number };
type RenderCall = NonNullable<ToolRenderers["renderCall"]>;
type RenderResult = NonNullable<ToolRenderers["renderResult"]>;
/** An MCP server's tool, as Pi names it: `mcp__<server>__<tool>`. */
const MCP_TOOL = /^mcp__.+?__.+$/;

function installNativeRendering(
  report: (error: Error) => void,
  visibility: (hidden: boolean) => void,
): () => void {
  const releases: (() => void)[] = [];
  const release = () => {
    for (const dispose of releases.reverse()) dispose();
  };
  try {
    releases.push(installNativeImageSlot(report));
    releases.push(installNativeThinking(report, visibility));
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

export default function (pi: ExtensionAPI) {
  if (typeof pi.registerToolRenderer !== "function")
    throw new Error(`Pi ${VERSION}: tool renderer API is unavailable.`);
  // Pi executes its own tools, and mirage only draws them. A tool that another extension
  // registered under the same name keeps that extension's rendering.
  const claims = (name: string): boolean => {
    if (!TOOL_NAMES.has(name)) return false;
    try {
      const tool = pi.getAllTools().find((candidate) => candidate.name === name);
      return !tool || tool.sourceInfo.source === "builtin";
    } catch {
      // Test fakes have no getAllTools, so the call always throws there. In Pi it throws only
      // before the runtime is initialised, or once a reload or session replacement makes
      // this extension stale. Either way, draw the tool as Pi's own.
      return true;
    }
  };
  // An MCP server's tool is drawn as a plain call, though Pi's MCP extension gives each one
  // renderers of its own. Any other tool is drawn as one when Pi would otherwise draw it in its
  // default box: when neither the tool nor another extension draws it. Pi says so as it resolves
  // the tool's renderers (see the resolver below), the first time it draws one of its calls.
  const plain = new Map<string, boolean>();
  const kinds: ToolKinds = (name) =>
    claims(name) ? (name as ToolName) : MCP_TOOL.test(name) || plain.get(name) ? "tool" : undefined;
  const groups = new ToolGroups(kinds);
  let historyGroups = new WeakMap<HistoryPage, ToolGroups>();
  const images = new WeakMap<ToolCallState, (width: number) => readonly string[]>();
  // Pi redraws a script's calls only when it redraws the script's row, so keep each script
  // row's redraw callback.
  const redraws = new WeakMap<ToolCallState, () => void>();
  // True while mirage asks Pi to draw a row whose model it has already changed, for a nested
  // call's event or a toggle. Pi invalidates the row first, but the view throws nothing away: it
  // draws afresh only what changed, by revision, as for a spinner frame.
  let redrawing = false;
  const redrawChanged = (invalidate: () => void) => {
    redrawing = true;
    try {
      invalidate();
    } finally {
      redrawing = false;
    }
  };
  // Pi draws a compaction's summary below the entries it kept, until it next draws the whole
  // transcript, which puts the summary first: a call made after the compaction starts a group.
  let compacted = false;
  // Live rows whose group still has calls in progress spin while Pi works: see shared/spinner.ts.
  // Its timer stops once none remain or Pi is idle, when a row left in progress is redrawn once
  // to show its resting glyph, so nothing runs between turns.
  const working = () => sessionContext?.isIdle?.() === false;
  const spinning = new Spinner<ToolCallState>(working);
  const spinner = () => (working() ? spinnerFrame() : undefined);
  /** Whether Pi is drawing a row again with nothing changed that its view must throw away. */
  const animating = () => spinning.animating || redrawing;
  /** Whether a row still leads a group of the live model with calls in progress. */
  const spins = (row: ToolCallState) =>
    groups.rows.get(row.id) === row && row.group.rows[0] === row && row.group.rows.some(inProgress);
  const models = new Set([new WeakRef(groups)]);
  /** Another agent's calls (see below), which do not follow Ctrl+T. */
  const nestedModels = new WeakSet<ToolGroups>();
  let thinkingHidden = false;
  const visibility = (hidden: boolean) => {
    if (hidden === thinkingHidden) return;
    thinkingHidden = hidden;
    for (const reference of models) {
      const model = reference.deref();
      if (!model) models.delete(reference);
      else if (!nestedModels.has(model)) model.setThinkingHidden(hidden);
    }
  };
  let transcript: TranscriptView | undefined;
  let sessionContext: ExtensionContext | undefined;
  const warnings: string[] = [];
  const flushWarnings = () => {
    if (sessionContext)
      for (const message of warnings.splice(0)) sessionContext.ui.notify(message, "warning");
  };
  const report = (error: Error) => {
    warnings.push(`Mirage: ${error.message}`);
    queueMicrotask(flushWarnings); // Never add UI messages in the middle of a render.
  };
  // Pi passes the Output padding setting to every render and re-renders rows when it changes.
  let paddingWarned = false;
  const outputPad = (value: number): number => {
    if (Number.isSafeInteger(value) && value >= 0) return value;
    if (!paddingWarned) {
      paddingWarned = true;
      report(
        new Error(
          `Pi ${VERSION}: tool render contexts lack outputPad; rows will use no outer padding. Run npm run verify in ~/.pi/agent/extensions.`,
        ),
      );
    }
    return 0;
  };
  let releaseRendering: (() => void) | undefined = installNativeRendering(report, visibility);
  const unsubscribeTranscript = pi.events.on(TRANSCRIPT_VIEW, (value) => {
    if (!isTranscriptView(value)) return;
    if (value.prepend) {
      if (
        !value.scope ||
        value.scope !== transcript?.scope ||
        value.sessionId !== transcript.sessionId
      )
        return;
      const staged = groups.stagePrepend(snapshot(value.entries, value.cwd));
      const current = transcript;
      value.transaction = {
        commit() {
          staged.commit();
          current.history = [...value.entries, ...(current.history ?? [])];
        },
        rollback: staged.rollback,
      };
      return;
    }
    if (transcript?.scope !== value.scope || transcript?.sessionId !== value.sessionId)
      groups.reset();
    transcript = value;
    groups.setAllExpanded(value.expanded);
    groups.replace(snapshot([...(value.history ?? []), ...value.entries], value.cwd));
    if (compacted) groups.boundary();
  });
  function rebuild(ctx: ExtensionContext): void {
    groups.setAllExpanded(ctx.ui.getToolsExpanded());
    let entries = ctx.sessionManager.buildContextEntries();
    if (transcript && transcript.sessionId === ctx.sessionManager.getSessionId()) {
      const first =
        transcript.entries[0]?.type === "compaction"
          ? transcript.entries[1]
          : transcript.entries[0];
      const start = entries.findIndex((entry) => entry.id === first?.id);
      if (start > 0)
        entries = [
          ...(entries[0]?.type === "compaction" ? [entries[0]] : []),
          ...entries.slice(start),
        ];
    }
    const history =
      transcript?.sessionId === ctx.sessionManager.getSessionId() ? (transcript.history ?? []) : [];
    groups.replace(snapshot([...history, ...entries], ctx.cwd));
    if (compacted) groups.boundary();
  }

  function snapshot(entries: readonly SessionEntry[], cwd: string): ToolGroups {
    const model = new ToolGroups(kinds);
    model.setThinkingHidden(thinkingHidden);
    replay(model, entries, cwd);
    return model;
  }

  function replay(target: ToolGroups, entries: readonly SessionEntry[], cwd: string): void {
    // Pi shows cache warming between calls only with this notice on, as a line of its own.
    const notices = pi.getSettings().notices?.cacheWarming === true;
    for (const entry of entries) {
      // Custom entries store extension data, such as codemode's store() writes between a
      // script's call and its result. Live events never include custom entries, so they are
      // never boundaries.
      if (entry.type === "custom") continue;
      if (entry.type === "usage") {
        if (entry.kind === "cache_warm" && notices) target.boundary();
        continue;
      }
      // An entry that is no message, such as a label or a model change, Pi does not draw: it
      // separates nothing.
      for (const message of sessionEntryToContextMessages(entry)) {
        target.startMessage(message, cwd);
        target.finishMessage(message, cwd);
      }
    }
    // Only live calls are ever in progress: a saved one without its result never gets it.
    target.abandonUnfinished();
  }

  function groupsFor(state: object): ToolGroups {
    const page = (state as HistoryRenderState)[HISTORY_PAGE];
    if (!page || (page.scope && page.scope === transcript?.scope)) return groups;
    let pageGroups = historyGroups.get(page);
    if (!pageGroups) {
      pageGroups = new ToolGroups(kinds);
      pageGroups.setThinkingHidden(thinkingHidden);
      models.add(new WeakRef(pageGroups));
      replay(pageGroups, page.entries, page.cwd);
      historyGroups.set(page, pageGroups);
    }
    return pageGroups;
  }

  pi.on("session_start", (_event, ctx) => {
    releaseRendering ??= installNativeRendering(report, visibility);
    visibility(pi.getSettings().hideThinkingBlock === true);
    sessionContext = ctx.mode === "tui" ? ctx : undefined;
    flushWarnings();
    compacted = false;
    if (sessionContext) rebuild(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    compacted = false;
    if (sessionContext) rebuild(ctx);
  });
  pi.on("session_compact", (_event, ctx) => {
    compacted = true;
    if (sessionContext) rebuild(ctx);
  });
  pi.on("session_shutdown", () => {
    spinning.stop(true);
    unsubscribeTranscript();
    unsubscribeNested();
    transcript = undefined;
    releaseRendering?.();
    releaseRendering = undefined;
    sessionContext = undefined;
    groups.reset();
    historyGroups = new WeakMap();
  });
  pi.on("message_start", ({ message }, ctx) => {
    // The compaction's redraws are over: any Pi draws from now on puts its summary first.
    compacted = false;
    if (sessionContext) groups.startMessage(message, ctx.cwd);
  });
  pi.on("message_update", ({ message }, ctx) => {
    if (sessionContext) groups.observe(message, ctx.cwd);
  });
  pi.on("message_end", ({ message }, ctx) => {
    if (sessionContext) groups.finishMessage(message, ctx.cwd);
  });
  pi.on("user_bash", () => groups.boundary());
  // Pi reports calls inside scripts only as tool_execution_* events whose parentToolCallId
  // names the calling script or call.
  const redraw = (script: ToolCallState | undefined) => {
    const invalidate = script && redraws.get(script);
    if (invalidate) redrawChanged(invalidate);
  };
  pi.on("tool_execution_start", (event, ctx) => {
    if (sessionContext && event.parentToolCallId)
      redraw(
        groups.startNested(
          event.parentToolCallId,
          event.toolCallId,
          event.toolName,
          event.args,
          ctx.cwd,
        ),
      );
  });
  pi.on("tool_execution_update", (event) => {
    if (sessionContext && event.parentToolCallId)
      redraw(groups.updateNested(event.toolCallId, event.partialResult, true, false));
  });
  pi.on("tool_execution_end", (event) => {
    if (sessionContext && event.parentToolCallId)
      redraw(
        groups.updateNested(event.toolCallId, event.result, false, event.isError, event.durationMs),
      );
  });

  // Another extension's agent's calls, drawn as these rows, so they look the same everywhere:
  // see shared/nested.ts. Each transcript is its own model, grouped by the same rules, starting
  // collapsed whatever Ctrl+O says. Its thinking is what the extension shows, whatever Ctrl+T
  // says, so it always separates calls.
  const nested: NestedRows = {
    transcript(cwd, frame) {
      // Another agent's calls have no renderer of their own here: mirage draws every one.
      const model = new ToolGroups(everyKind);
      nestedModels.add(model);
      models.add(new WeakRef(model));
      const views = new Map<string, ToolGroupView>();
      // Whether the calls the agent left in progress when it last stopped are cancelled.
      let ended = false;
      return {
        add(message) {
          ended = false;
          model.startMessage(message, cwd);
          model.finishMessage(message, cwd);
          // Pi runs a reply's calls once it ends: they are under way, not waiting to start.
          if (message.role !== "assistant" || message.stopReason !== "toolUse") return;
          for (const block of message.content) {
            const row = block.type === "toolCall" ? model.rows.get(block.id) : undefined;
            if (row) model.markStarted(row);
          }
        },
        draws: () => true,
        row(id, theme) {
          // No frame: the agent has stopped, and nothing will end the calls it left in progress.
          if (!ended && frame() === undefined) {
            ended = true;
            model.cancelUnfinished("Cancelled when the agent stopped.");
          }
          const row = model.rows.get(id);
          if (!row || row.group.rows[0] !== row) return undefined;
          let view = views.get(id);
          if (view?.row !== row) {
            view = new ToolGroupView(row, model, {
              toggle: (target) => model.toggle(target),
              openFile,
              outputPad: () => 0,
              renderImages: () => [],
              spinner: frame,
            });
            views.set(id, view);
          }
          view.configure(theme, false);
          return view;
        },
      };
    },
  };
  const unsubscribeNested = pi.events.on(NESTED_ROWS_EVENT, (value) => {
    if (isNestedRowsRequest(value)) value.rows = nested;
  });

  function openFile(file: FileReference): void {
    const request: OpenFileRequest = { ...file, accepted: false };
    pi.events.emit(OPEN_FILE_EVENT, request);
    if (!request.accepted)
      sessionContext?.ui.notify(
        "Filename opening requires inspector. Enable it and run /reload.",
        "warning",
      );
  }

  function renderers(name: string): ToolRenderers {
    const renderCall: RenderCall = (args, theme, context) => {
      const state = context.state as DisplayState & AnchorState;
      // The spinner, or mirage after changing the model, asked Pi to draw the row again: the view
      // reads the frame from the clock, and the change from the model, when Pi draws it.
      if (animating() && state.view) return state.view;
      state.outputPad = outputPad(context.outputPad);
      const groups = groupsFor(state);
      // Observe global expansion during Pi's update callback, never during render().
      groups.setAllExpanded(sessionContext?.ui.getToolsExpanded() ?? context.expanded);
      const row = groups.addCall(context.toolCallId, name, args, context.cwd);
      if (!row) return EMPTY;
      if (context.executionStarted) groups.markStarted(row);
      images.set(row, (width) => renderNativeImages(state, width));
      if (row.kind === "codemode") redraws.set(row, context.invalidate);
      // Only live calls are ever in progress, and only a group's leader draws it.
      if (row.group.rows.some(inProgress))
        spinning.add(row, { redraw: context.invalidate, spinning: () => spins(row) });
      const view =
        state.view?.row === row
          ? state.view
          : new ToolGroupView(row, groups, {
              toggle(target) {
                groups.toggle(target);
                redrawChanged(context.invalidate);
              },
              openFile,
              outputPad: () => state.outputPad ?? 0,
              renderImages: (target, width) => images.get(target)?.(width) ?? [],
              spinner,
              spun: () => spinning.drew(row),
              animating,
            });
      state.view = view;
      state[ROW_ANCHOR] = view;
      view.configure(theme, context.showImages);
      return view;
    };
    const renderResult: RenderResult = (result, options, _theme, context) => {
      if (animating()) return EMPTY;
      const groups = groupsFor(context.state);
      const row = groups.rows.get(context.toolCallId);
      if (row)
        groups.updateResult(row, result, options.isPartial, context.isError, {
          durationMs: context.durationMs,
        });
      return EMPTY;
    };
    // The renderers must exist at load time, because Pi rebuilds the transcript before
    // session_start.
    return ownImageRendering({ renderShell: "self", renderCall, renderResult });
  }

  const built = new Map<string, ToolRenderers>();
  const drawn = (name: string): ToolRenderers => {
    let found = built.get(name);
    if (!found) {
      found = renderers(name);
      built.set(name, found);
    }
    return found;
  };
  /** Whether mirage draws a tool that is not Pi's own changed: every model groups again. */
  const decide = (name: string, mine: boolean) => {
    const before = plain.get(name) ?? false;
    plain.set(name, mine);
    if (before === mine) return;
    for (const reference of models) {
      const model = reference.deref();
      if (model) model.reconsider();
      else models.delete(reference);
    }
  };
  pi.registerToolRenderer((name, next) => {
    // Pi's own tools, and MCP servers' tools, whose renderers Pi's MCP extension resolves after
    // mirage's: mirage draws them, whatever would draw them otherwise.
    if (claims(name) || MCP_TOOL.test(name)) return drawn(name);
    // Any other tool keeps the renderer it has, its own or another extension's. One with none
    // would get Pi's default box: mirage draws it instead.
    const own = next();
    const mine = !own?.renderCall && !own?.renderResult;
    decide(name, mine);
    return mine ? drawn(name) : own;
  });
}
