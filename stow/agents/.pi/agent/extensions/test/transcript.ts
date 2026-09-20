// A real InteractiveMode prototype with only the transcript fields Pi's native
// renderer reads. Shared by history unit tests and cross-extension tests.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Component, Container, ScrollView } from "@earendil-works/pi-tui";
import type { Tool } from "./fake-pi.ts";
import { core, tui } from "./pi.ts";

type RenderOptions = { updateFooter?: boolean; populateHistory?: boolean };
export type RenderEntries = (entries: SessionEntry[], options?: RenderOptions) => void;

/** Private InteractiveMode members used by the transcript tests. */
export interface TranscriptHost {
  sessionManager: SessionManager;
  chatContainer: Container;
  documentContainer: Container;
  transcriptScrollView: ScrollView;
  pendingTools: Map<string, unknown>;
  ui: { mode: string; terminal: { columns: number }; requestRender(): void };
  outputPad: number;
  renderSessionEntries: RenderEntries;
  setToolsExpanded(expanded: boolean): void;
  loadedResourcesContainer?: Container;
  builtInHeader?: Container;
  showStatus?: (message: string) => void;
}

const prototype = core.InteractiveMode.prototype as unknown as TranscriptHost;
/** Pi's unpatched transcript renderer, captured before any extension loads. */
export const nativeRenderEntries: RenderEntries = prototype.renderSessionEntries;

export const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function assistant(
  text: string,
  content: AssistantMessage["content"] = [{ type: "text", text }],
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "fixture",
    usage,
    stopReason: "stop",
    timestamp: 1,
  };
}

export const text = (component: Component): string =>
  component.render(100).map(tui.stripTerminalSequences).join("\n");
export const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** `count` old messages, then a compaction that keeps only CURRENT_ANCHOR. */
export function transcript(count = 130) {
  const sm = core.SessionManager.inMemory(process.cwd());
  for (let i = 0; i < count; i++) sm.appendMessage(assistant(`OLD_${String(i).padStart(3, "0")}`));
  const kept = sm.appendMessage(assistant("CURRENT_ANCHOR"));
  sm.appendCompaction("CHECKPOINT", kept, 10000);
  const chat = new tui.Container(),
    document = new tui.Container();
  document.addChild(chat);
  const scroll = new tui.ScrollView(document, { follow: "end" });
  let renders = 0,
    historyAdds = 0;
  const host: TranscriptHost = Object.create(core.InteractiveMode.prototype);
  const fields = {
    sessionManager: sm,
    settingsManager: {
      getShowCacheMissNotices: () => false,
      getShowImages: () => false,
      getImageWidthCells: () => 8,
    },
    chatContainer: chat,
    documentContainer: document,
    transcriptScrollView: scroll,
    pendingTools: new Map([["live", { untouched: true }]]),
    ui: {
      mode: "fullscreen",
      terminal: { columns: 100 },
      requestRender() {
        renders++;
      },
    },
    toolOutputExpanded: false,
    hideThinkingBlock: true,
    hiddenThinkingLabel: "Thinking…",
    outputPad: 1,
    getRegisteredToolDefinition: () => undefined,
    getMarkdownThemeWithSettings: () => core.getMarkdownTheme(),
    getMarkdownTransformers: () => [],
    editor: {
      addToHistory() {
        historyAdds++;
      },
    },
  };
  for (const [key, value] of Object.entries(fields))
    Object.defineProperty(host, key, { value, writable: true, configurable: true });
  return {
    host,
    sm,
    chat,
    document,
    scroll,
    get renders() {
      return renders;
    },
    get historyAdds() {
      return historyAdds;
    },
    layout(height = 20) {
      scroll.updateLayout(document.render(100).length, height, () => {});
    },
  };
}

/** Route tool rendering through Pi's real lookup and any installed adapters. */
export function bindTools(host: TranscriptHost, tools: ReadonlyMap<string, Tool>): void {
  Object.defineProperty(host, "session", {
    configurable: true,
    value: { getToolDefinition: (name: string) => tools.get(name) },
  });
  delete (host as { getRegisteredToolDefinition?: unknown }).getRegisteredToolDefinition;
}
