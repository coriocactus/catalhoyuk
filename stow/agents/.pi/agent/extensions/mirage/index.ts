import {
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  type SessionEntry,
  SettingsManager,
  sessionEntryToContextMessages,
  type ToolRenderers,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { type AnchorState, ROW_ANCHOR } from "../shared/anchors.ts";
import { HISTORY_PAGE, type HistoryPage, type HistoryRenderState } from "../shared/history.ts";
import { type FileReference, OPEN_FILE_EVENT, type OpenFileRequest } from "../shared/protocol.ts";
import { isTranscriptView, TRANSCRIPT_VIEW, type TranscriptView } from "../shared/transcript.ts";
import { TOOL_NAMES, ToolGroups, type ToolName, type ToolRow } from "./model.ts";
import { installNativeImageSlot, ownImageRendering, renderNativeImages } from "./native-images.ts";
import { installNativeThinking } from "./native-thinking.ts";
import { ToolGroupView } from "./view.ts";

const EMPTY: Component = { render: () => [], invalidate() {} };
type DisplayState = { view?: ToolGroupView; outputPad?: number };
type RenderCall = NonNullable<ToolRenderers["renderCall"]>;
type RenderResult = NonNullable<ToolRenderers["renderResult"]>;

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
  const groups = new ToolGroups(claims);
  let historyGroups = new WeakMap<HistoryPage, ToolGroups>();
  const images = new WeakMap<ToolRow, (width: number) => string[]>();
  // Pi redraws a script's calls only when it redraws the script's row, so keep each script
  // row's redraw callback.
  const redraws = new WeakMap<ToolRow, () => void>();
  const models = new Set([new WeakRef(groups)]);
  let thinkingHidden = false;
  const visibility = (hidden: boolean) => {
    if (hidden === thinkingHidden) return;
    thinkingHidden = hidden;
    for (const reference of models) {
      const model = reference.deref();
      if (model) model.setThinkingHidden(hidden);
      else models.delete(reference);
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
          `Pi ${VERSION}: tool render contexts lack outputPad; tool rows will use no outer padding. Run npm run verify in ~/.pi/agent/extensions.`,
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
  }

  function snapshot(entries: readonly SessionEntry[], cwd: string): ToolGroups {
    const model = new ToolGroups(claims);
    model.setThinkingHidden(thinkingHidden);
    replay(model, entries, cwd);
    return model;
  }

  function replay(target: ToolGroups, entries: readonly SessionEntry[], cwd: string): void {
    for (const entry of entries) {
      // Custom entries store extension data, such as codemode's store() writes between a
      // script's call and its result. Live events never include custom entries, so they are
      // never boundaries.
      if (entry.type === "custom") continue;
      const messages = sessionEntryToContextMessages(entry);
      if (!messages.length) target.boundary();
      for (const message of messages) {
        target.startMessage(message, cwd);
        target.finishMessage(message, cwd);
      }
    }
  }

  function groupsFor(state: object): ToolGroups {
    const page = (state as HistoryRenderState)[HISTORY_PAGE];
    if (!page || (page.scope && page.scope === transcript?.scope)) return groups;
    let archived = historyGroups.get(page);
    if (!archived) {
      archived = new ToolGroups(claims);
      archived.setThinkingHidden(thinkingHidden);
      models.add(new WeakRef(archived));
      replay(archived, page.entries, page.cwd);
      historyGroups.set(page, archived);
    }
    return archived;
  }

  pi.on("session_start", (_event, ctx) => {
    releaseRendering ??= installNativeRendering(report, visibility);
    const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    });
    visibility(settings.getHideThinkingBlock());
    sessionContext = ctx.mode === "tui" ? ctx : undefined;
    flushWarnings();
    if (sessionContext) rebuild(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    if (sessionContext) rebuild(ctx);
  });
  pi.on("session_compact", (_event, ctx) => {
    if (sessionContext) rebuild(ctx);
  });
  pi.on("session_shutdown", () => {
    unsubscribeTranscript();
    transcript = undefined;
    releaseRendering?.();
    releaseRendering = undefined;
    sessionContext = undefined;
    groups.reset();
    historyGroups = new WeakMap();
  });
  pi.on("message_start", ({ message }, ctx) => {
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
  const redraw = (script: ToolRow | undefined) => {
    if (script) redraws.get(script)?.();
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

  function openFile(file: FileReference): void {
    const request: OpenFileRequest = { ...file, accepted: false };
    pi.events.emit(OPEN_FILE_EVENT, request);
    if (!request.accepted)
      sessionContext?.ui.notify(
        "Filename opening requires inspector. Enable it and run /reload.",
        "warning",
      );
  }

  function renderers(name: ToolName): ToolRenderers {
    const renderCall: RenderCall = (args, theme, context) => {
      const state = context.state as DisplayState & AnchorState;
      state.outputPad = outputPad(context.outputPad);
      const groups = groupsFor(state);
      // Observe global expansion during Pi's update callback, never during render().
      groups.setAllExpanded(sessionContext?.ui.getToolsExpanded() ?? context.expanded);
      const row = groups.addCall(context.toolCallId, name, args, context.cwd);
      if (!row) return EMPTY;
      if (context.executionStarted) groups.markStarted(row);
      images.set(row, (width) => renderNativeImages(state, width));
      if (row.kind === "codemode") redraws.set(row, context.invalidate);
      const view =
        state.view?.row === row
          ? state.view
          : new ToolGroupView(row, groups, {
              toggle(target) {
                groups.toggle(target);
                context.invalidate();
              },
              openFile,
              outputPad: () => state.outputPad ?? 0,
              renderImages: (target, width) => images.get(target)?.(width) ?? [],
            });
      state.view = view;
      state[ROW_ANCHOR] = view;
      view.configure(theme, context.showImages);
      return view;
    };
    const renderResult: RenderResult = (result, options, _theme, context) => {
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

  const drawn = new Map([...TOOL_NAMES].map((name) => [name, renderers(name as ToolName)]));
  pi.registerToolRenderer((name, next) => (claims(name) ? drawn.get(name) : undefined) ?? next());
}
