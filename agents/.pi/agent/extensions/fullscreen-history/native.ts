import {
  AssistantMessageComponent,
  InteractiveMode,
  type SessionEntry,
  type SessionManager,
  type SettingsManager,
  ToolExecutionComponent,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, type ScrollView, type TUI } from "@earendil-works/pi-tui";
import {
  HISTORY_PAGE,
  type HistoryPage,
  type HistoryRenderState,
} from "../file-tools-shared/history.ts";
import type { TranscriptView } from "../file-tools-shared/transcript.ts";
import { HistoryCursor, historyBoundary, historyGap, PAGE_SIZE, recentEntries } from "./model.ts";
import { attachTopPaging } from "./scroll.ts";

type Renderers = NonNullable<ConstructorParameters<typeof ToolExecutionComponent>[4]>;
type RenderEntries = (
  this: NativeHost,
  entries: SessionEntry[],
  options?: { updateFooter?: boolean; populateHistory?: boolean },
) => void;

// The ONLY private Pi boundary. Reuse native message/tool rendering against an
// isolated receiver: no live pending tools, editor history, footer, or agent writes.
export interface NativeHost {
  renderSessionEntries: RenderEntries;
  chatContainer: Container;
  documentContainer: Container;
  pendingTools: Map<string, ToolExecutionComponent>;
  transcriptScrollView: ScrollView;
  sessionManager: Pick<
    SessionManager,
    "getEntry" | "getCwd" | "getSessionId" | "buildContextEntries"
  >;
  settingsManager: Pick<SettingsManager, "getShowImages" | "getImageWidthCells">;
  ui: TUI;
  toolOutputExpanded: boolean;
  hideThinkingBlock: boolean;
  hiddenThinkingLabel: string;
  outputPad: number;
  getRegisteredToolDefinition(name: string): Renderers | undefined;
  getUserMessageText(message: unknown): string;
  editor: { addToHistory?(text: string): void };
}

function renderersForPage(
  definition: Renderers | undefined,
  page: HistoryPage,
): Renderers | undefined {
  if (!definition) return undefined;
  const call = definition.renderCall,
    result = definition.renderResult;
  return {
    ...definition, // Preserve native-image ownership symbols and renderShell.
    ...(call
      ? {
          renderCall(...args: Parameters<NonNullable<Renderers["renderCall"]>>) {
            (args[2].state as HistoryRenderState)[HISTORY_PAGE] = page;
            return call(args[0], args[1], args[2]);
          },
        }
      : {}),
    ...(result
      ? {
          renderResult(...args: Parameters<NonNullable<Renderers["renderResult"]>>) {
            (args[3].state as HistoryRenderState)[HISTORY_PAGE] = page;
            return result(args[0], args[1], args[2], args[3]);
          },
        }
      : {}),
  };
}

export function renderHistoryPage(
  host: NativeHost,
  entries: SessionEntry[],
  render: RenderEntries,
): Container {
  const page: HistoryPage = { entries, cwd: host.sessionManager.getCwd() };
  const receiver: NativeHost = Object.create(host);
  receiver.chatContainer = new Container();
  receiver.pendingTools = new Map();
  receiver.getRegisteredToolDefinition = (name) =>
    renderersForPage(host.getRegisteredToolDefinition(name), page);
  render.call(receiver, entries); // No populateHistory/updateFooter flags.
  return receiver.chatContainer;
}

function expand(component: Component, value: boolean): void {
  if ("setExpanded" in component && typeof component.setExpanded === "function")
    component.setExpanded(value);
}

class HistoryPages extends Container {
  constructor(private readonly host: NativeHost) {
    super();
  }
  override render(width: number): string[] {
    return this.host.ui.mode === "fullscreen" ? super.render(width) : [];
  }
  setExpanded(value: boolean): void {
    for (const page of this.children as Container[])
      for (const child of page.children) expand(child, value);
  }
}

export class HistoryController {
  private readonly pages: HistoryPages;
  private padding = 0;
  private readonly filler: Component;
  private readonly scrollHook: ReturnType<typeof attachTopPaging>;
  private cursor?: HistoryCursor;
  private boundaryKey?: string;
  private sessionId?: string;
  private boundary: string | null = null;
  private firstDisplayed?: string;
  private generation = 0;
  private busy = false;
  private closed = false;
  private failed = false;
  private presentation = "";
  private contextEntries: SessionEntry[] = [];

  constructor(
    private readonly host: NativeHost,
    private readonly render: RenderEntries,
    private readonly report: (error: unknown) => void,
    private readonly size = PAGE_SIZE,
  ) {
    this.pages = new HistoryPages(host);
    this.filler = {
      render: () => (host.ui.mode === "fullscreen" ? Array(this.padding).fill("") : []),
      invalidate() {},
    };
    this.scrollHook = attachTopPaging(host.transcriptScrollView, {
      active: () => !this.closed && host.ui.mode === "fullscreen",
      width: () => host.ui.terminal.columns,
      load: () => this.requestOlder(),
      settled: () => {
        this.busy = false;
      },
      end: () => {
        if (this.padding) {
          this.padding = 0;
          host.ui.requestRender();
        }
      },
    });
  }

  select(entries: SessionEntry[]): SessionEntry[] {
    if (
      this.host.ui.mode !== "fullscreen" ||
      (this.sessionId === this.host.sessionManager.getSessionId() &&
        this.boundaryKey &&
        !this.firstDisplayed)
    )
      return entries;
    return recentEntries(
      entries,
      this.size,
      this.sessionId === this.host.sessionManager.getSessionId() ? this.firstDisplayed : undefined,
    );
  }

  refresh(entries: SessionEntry[]): void {
    if (this.closed) return;
    const boundary = historyBoundary(entries),
      sessionId = this.host.sessionManager.getSessionId();
    const key = JSON.stringify([sessionId, entries[0]?.id, boundary]);
    this.contextEntries = entries;
    if (this.boundaryKey !== key) {
      this.generation++;
      this.busy = false;
      this.failed = false;
      this.padding = 0;
      this.scrollHook.reset();
      const visible = new Set(entries.map((entry) => entry.id));
      const lookup = (id: string) => this.host.sessionManager.getEntry(id);
      const gap =
        this.boundaryKey && this.sessionId === sessionId
          ? historyGap(boundary, this.boundary, lookup, visible)
          : undefined;
      if (gap) {
        if (gap.length) this.pages.addChild(this.renderPage(gap));
      } else {
        this.pages.clear();
        this.cursor = new HistoryCursor(boundary, lookup, visible);
      }
      this.boundaryKey = key;
      this.boundary = boundary;
      this.sessionId = sessionId;
    }
    this.firstDisplayed = (entries[0]?.type === "compaction" ? entries[1] : entries[0])?.id;
    // Pi clears the chat on compaction, tree navigation, and display rebuilds.
    if (
      (this.cursor?.next || this.pages.children.length) &&
      !this.host.chatContainer.children.includes(this.pages)
    )
      this.host.chatContainer.children.unshift(this.pages);
    if (!this.host.documentContainer.children.includes(this.filler))
      this.host.documentContainer.addChild(this.filler);
    this.synchronize();
  }

  synchronize(): void {
    if (this.closed) return;
    const host = this.host,
      show = host.settingsManager.getShowImages(),
      width = host.settingsManager.getImageWidthCells();
    const signature = JSON.stringify([
      host.hideThinkingBlock,
      host.hiddenThinkingLabel,
      host.outputPad,
      show,
      width,
    ]);
    if (signature === this.presentation) return;
    this.presentation = signature;
    for (const page of this.pages.children as Container[]) {
      for (const child of page.children) {
        if (child instanceof AssistantMessageComponent) {
          child.setHideThinkingBlock(host.hideThinkingBlock);
          child.setHiddenThinkingLabel(host.hiddenThinkingLabel);
        }
        if ("setOutputPad" in child && typeof child.setOutputPad === "function")
          child.setOutputPad(host.outputPad);
        if (child instanceof ToolExecutionComponent) {
          child.setShowImages(show);
          child.setImageWidthCells(width);
        }
      }
    }
    this.host.ui.requestRender();
  }

  private requestOlder(): void {
    if (this.closed || this.failed || this.busy || !this.cursor?.next) return;
    this.busy = true;
    const generation = this.generation;
    // Coalesce wheel reports/Home repeats. Never construct history during layout.
    queueMicrotask(() => {
      if (this.closed || generation !== this.generation) return;
      if (this.host.ui.mode !== "fullscreen" || this.host.transcriptScrollView.scrollTop !== 0) {
        this.busy = false;
        return;
      }
      try {
        const cursor = this.cursor;
        const batch = cursor?.prepare(this.size);
        if (!batch || !cursor) {
          this.busy = false;
          return;
        }
        const page = this.renderPage(batch.entries);
        // Preserve blank space below a short transcript too; otherwise native
        // scroll clamping would move the old messages downward after a prepend.
        const scroll = this.host.transcriptScrollView;
        const beforeHeight = this.host.documentContainer.render(
          scroll.getContentWidth(this.host.ui.terminal.columns),
        ).length;
        if (this.closed || generation !== this.generation || cursor !== this.cursor) return;
        this.padding += Math.max(0, scroll.viewportHeight - beforeHeight);
        cursor.commit(batch);
        this.pages.children.unshift(page);
        this.scrollHook.anchor(page);
        this.host.ui.requestRender();
      } catch (error) {
        this.busy = false;
        this.failed = true;
        this.report(error);
      }
    });
  }

  private renderPage(source: readonly SessionEntry[]): Container {
    const entries = [...source],
      calls = new Set<string>(),
      results = new Set<string>();
    for (const entry of entries) {
      if (entry.type !== "message") continue;
      if (entry.message.role === "assistant")
        for (const block of entry.message.content ?? []) {
          if (block.type === "toolCall") calls.add(block.id);
        }
      if (entry.message.role === "toolResult") results.add(entry.message.toolCallId);
    }
    // Old compactions can retain a result but omit its call. Complete the archived
    // call without moving/duplicating live components or executing anything.
    for (const entry of this.contextEntries) {
      if (
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        calls.has(entry.message.toolCallId) &&
        !results.has(entry.message.toolCallId)
      )
        entries.push(entry);
    }
    return renderHistoryPage(this.host, entries, this.render);
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.scrollHook.dispose();
    this.host.chatContainer.removeChild(this.pages);
    this.host.documentContainer.removeChild(this.filler);
    this.pages.clear();
  }
}

interface Owner {
  report(error: unknown): void;
  size: number;
  display?(view: TranscriptView): void;
}
interface Patch {
  original: RenderEntries;
  wrapped: RenderEntries;
  owners: Set<Owner>;
  controllers: Map<NativeHost, { owner: Owner; controller: HistoryController }>;
}
const PATCH = Symbol.for("pi-local.fullscreen-history.v1");

export function installHistoryAdapter(
  report: Owner["report"],
  size = PAGE_SIZE,
  display?: Owner["display"],
): { synchronize(): void; reset(): void; dispose(): void } {
  if (!Number.isSafeInteger(size) || size < 1)
    throw new Error("History page size must be a positive integer.");
  if (VERSION !== "0.85.1")
    throw new Error(
      `fullscreen-history supports Pi 0.85.1, not ${VERSION}. Revalidate native.ts before enabling it.`,
    );
  const prototype = InteractiveMode.prototype as unknown as NativeHost & { [PATCH]?: Patch };
  let patch = prototype[PATCH];
  if (patch && prototype.renderSessionEntries !== patch.wrapped)
    throw new Error("Another extension replaced fullscreen-history's adapter.");
  if (!patch) {
    const original = prototype.renderSessionEntries;
    if (typeof original !== "function") throw new Error("Pi's transcript renderer is unavailable.");
    const owners = new Set<Owner>(),
      controllers: Patch["controllers"] = new Map();
    const wrapped: RenderEntries = function (entries, options) {
      const owner = [...owners].at(-1);
      if (!owner) return original.call(this, entries, options);
      let selected = entries,
        visible = entries;
      let current = controllers.get(this);
      try {
        if (!current) {
          if (
            !this.transcriptScrollView ||
            !(this.chatContainer instanceof Container) ||
            !(this.documentContainer instanceof Container)
          )
            throw new Error("Pi's transcript layout changed.");
          current = {
            owner,
            controller: new HistoryController(this, original, owner.report, owner.size),
          };
          controllers.set(this, current);
        }
        visible = current.controller.select(this.sessionManager.buildContextEntries());
        const ids = new Set(visible.map((entry) => entry.id));
        selected = entries.filter((entry) => ids.has(entry.id));
        current.owner.display?.({
          sessionId: this.sessionManager.getSessionId(),
          cwd: this.sessionManager.getCwd(),
          entries: visible,
          expanded: this.toolOutputExpanded,
        });
        // Keep native Up-arrow prompt history complete even when its old rows are
        // not constructed. Paging itself never adds prompts to editor history.
        if (options?.populateHistory)
          for (const entry of entries) {
            if (!ids.has(entry.id) && entry.type === "message" && entry.message.role === "user") {
              const text = this.getUserMessageText(entry.message);
              if (text) this.editor.addToHistory?.(text);
            }
          }
      } catch (error) {
        selected = entries;
        visible = entries;
        owner.report(error);
      }
      original.call(this, selected, options); // Native errors must still propagate.
      try {
        current?.controller.refresh(visible);
      } catch (error) {
        owner.report(error);
      }
    };
    patch = { original, wrapped, owners, controllers };
    prototype[PATCH] = patch;
    prototype.renderSessionEntries = wrapped;
  }
  const owner: Owner = { report, size, display };
  patch.owners.add(owner);
  let closed = false;
  const reset = () => {
    for (const [host, value] of patch.controllers)
      if (value.owner === owner) {
        value.controller.dispose();
        patch.controllers.delete(host);
      }
  };
  return {
    reset,
    synchronize() {
      if (closed) return;
      for (const value of patch.controllers.values())
        if (value.owner === owner) value.controller.synchronize();
    },
    dispose() {
      if (closed) return;
      closed = true;
      patch.owners.delete(owner);
      reset();
      if (patch.owners.size === 0 && prototype.renderSessionEntries === patch.wrapped) {
        prototype.renderSessionEntries = patch.original;
        delete prototype[PATCH];
      }
    },
  };
}
