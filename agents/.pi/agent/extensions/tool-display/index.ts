import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  type SessionEntry,
  SettingsManager,
  sessionEntryToContextMessages,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import {
  HISTORY_PAGE,
  type HistoryPage,
  type HistoryRenderState,
} from "../file-tools-shared/history.ts";
import {
  type FileReference,
  OPEN_FILE_EVENT,
  type OpenFileRequest,
} from "../file-tools-shared/protocol.ts";
import {
  isTranscriptView,
  TRANSCRIPT_VIEW,
  type TranscriptView,
} from "../file-tools-shared/transcript.ts";
import { ToolGroups, type ToolName } from "./model.ts";
import { installNativeImageSlot, ownImageRendering, renderNativeImages } from "./native-images.ts";
import { installNativeOutputPadding, outputPadding, ownOutputPadding } from "./native-padding.ts";
import { ToolGroupView } from "./view.ts";

const EMPTY: Component = { render: () => [], invalidate() {} };
type DisplayState = { view?: ToolGroupView };

function installNativeRendering(report: (error: Error) => void): () => void {
  const releaseImages = installNativeImageSlot(report);
  try {
    const releasePadding = installNativeOutputPadding(report);
    return () => {
      releasePadding();
      releaseImages();
    };
  } catch (error) {
    releaseImages();
    throw error;
  }
}

export default function (pi: ExtensionAPI) {
  const groups = new ToolGroups();
  let historyGroups = new WeakMap<HistoryPage, ToolGroups>();
  let transcript: TranscriptView | undefined;
  let sessionContext: ExtensionContext | undefined;
  const warnings: string[] = [];
  const flushWarnings = () => {
    if (sessionContext)
      for (const message of warnings.splice(0)) sessionContext.ui.notify(message, "warning");
  };
  const report = (error: Error) => {
    warnings.push(`Tool display: ${error.message}`);
    queueMicrotask(flushWarnings); // Never add UI messages in the middle of a render.
  };
  let releaseRendering: (() => void) | undefined = installNativeRendering(report);
  const unsubscribeTranscript = pi.events.on(TRANSCRIPT_VIEW, (value) => {
    if (!isTranscriptView(value)) return;
    transcript = value;
    groups.reset();
    groups.setAllExpanded(value.expanded);
    replay(groups, value.entries, value.cwd);
  });
  let configuration: { cwd: string; trusted: boolean; settings: SettingsManager } | undefined;

  function settingsFor(ctx: ExtensionContext): SettingsManager {
    const trusted = ctx.isProjectTrusted();
    if (!configuration || configuration.cwd !== ctx.cwd || configuration.trusted !== trusted) {
      configuration = {
        cwd: ctx.cwd,
        trusted,
        settings: SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: trusted }),
      };
    }
    return configuration.settings;
  }

  function rebuild(ctx: ExtensionContext): void {
    groups.reset();
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
    replay(groups, entries, ctx.cwd);
  }

  function replay(target: ToolGroups, entries: readonly SessionEntry[], cwd: string): void {
    for (const entry of entries) {
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
    if (!page) return groups;
    let archived = historyGroups.get(page);
    if (!archived) {
      archived = new ToolGroups();
      replay(archived, page.entries, page.cwd);
      historyGroups.set(page, archived);
    }
    return archived;
  }

  pi.on("session_start", (_event, ctx) => {
    releaseRendering ??= installNativeRendering(report);
    configuration = undefined;
    settingsFor(ctx);
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
    configuration = undefined;
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

  function openFile(file: FileReference): void {
    const request: OpenFileRequest = { ...file, accepted: false };
    pi.events.emit(OPEN_FILE_EVENT, request);
    if (!request.accepted)
      sessionContext?.ui.notify(
        "Filename opening requires vim-files. Enable it and run /reload.",
        "warning",
      );
  }

  function register<P extends TSchema, D, S>(
    name: ToolName,
    create: (cwd: string, settings?: SettingsManager) => ToolDefinition<P, D, S>,
  ): void {
    const original = create(process.cwd());
    let executor: { settings: SettingsManager; definition: ToolDefinition<P, D, S> } | undefined;
    // Pi rebuilds transcript components BEFORE session_start on /reload. Renderer
    // definitions must exist at load time; trusted execution settings must wait.
    const definition: ToolDefinition<P, D, DisplayState> = {
      ...original,
      renderShell: "self",
      execute(id, args, signal, onUpdate, ctx) {
        const settings = settingsFor(ctx);
        if (executor?.settings !== settings)
          executor = { settings, definition: create(ctx.cwd, settings) };
        return executor.definition.execute(id, args, signal, onUpdate, ctx);
      },
      renderCall(args, theme, context) {
        const groups = groupsFor(context.state);
        // Observe global expansion during Pi's update callback, never during render().
        groups.setAllExpanded(sessionContext?.ui.getToolsExpanded() ?? context.expanded);
        const row = groups.addCall(context.toolCallId, name, args, context.cwd);
        if (!row) return EMPTY;
        if (context.executionStarted) groups.markStarted(row);
        const view =
          context.state.view?.row === row
            ? context.state.view
            : new ToolGroupView(row, groups, {
                toggle(target) {
                  groups.toggle(target);
                  context.invalidate();
                },
                openFile,
                outputPad: () => outputPadding(context.state),
                renderImages: (width) => renderNativeImages(context.state, width),
              });
        context.state.view = view;
        view.configure(theme, context.showImages);
        return view;
      },
      renderResult(result, options, _theme, context) {
        const groups = groupsFor(context.state);
        const row = groups.rows.get(context.toolCallId);
        if (row) groups.updateResult(row, result, options.isPartial, context.isError);
        return EMPTY;
      },
    };
    pi.registerTool(ownOutputPadding(ownImageRendering(definition)));
  }

  register("read", (cwd, settings) =>
    createReadToolDefinition(cwd, { autoResizeImages: settings?.getImageAutoResize() }),
  );
  register("bash", (cwd, settings) =>
    createBashToolDefinition(cwd, {
      shellPath: settings?.getShellPath(),
      commandPrefix: settings?.getShellCommandPrefix(),
    }),
  );
  register("edit", (cwd) => createEditToolDefinition(cwd));
  register("write", (cwd) => createWriteToolDefinition(cwd));
}
