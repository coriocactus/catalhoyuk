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
import { HISTORY_PAGE, type HistoryPage, type HistoryRenderState } from "../shared/history.ts";
import type { TranscriptView } from "../shared/transcript.ts";
import { captureViewportAnchor } from "./anchors.ts";
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
  scope?: object,
): Container {
  const page: HistoryPage = { entries, cwd: host.sessionManager.getCwd(), scope };
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

function pad(component: Component, value: number): void {
  if ("setOutputPad" in component && typeof component.setOutputPad === "function")
    component.setOutputPad(value);
}

class HistoryPages extends Container {
  private readonly host: NativeHost;

  constructor(host: NativeHost) {
    super();
    this.host = host;
  }
  override render(width: number): string[] {
    return this.host.ui.mode === "fullscreen" ? super.render(width) : [];
  }
  setExpanded(value: boolean): void {
    for (const page of this.children as Container[])
      for (const child of page.children) expand(child, value);
  }
  /** Pi passes Output padding changes to each chat child, including this one. */
  setOutputPad(value: number): void {
    for (const page of this.children as Container[])
      for (const child of page.children) pad(child, value);
  }
}

export class HistoryController {
  private readonly pages: HistoryPages;
  private readonly pageEntries = new Map<Container, readonly SessionEntry[]>();
  private scope: object = {};
  private readonly display?: (view: TranscriptView) => void;
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
  private readonly host: NativeHost;
  private readonly render: RenderEntries;
  private readonly report: (error: unknown) => void;
  private readonly size: number;

  constructor(
    host: NativeHost,
    render: RenderEntries,
    report: (error: unknown) => void,
    size = PAGE_SIZE,
    display?: (view: TranscriptView) => void,
  ) {
    this.host = host;
    this.display = display;
    this.render = render;
    this.report = report;
    this.size = size;
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

  present(entries: SessionEntry[]): void {
    const boundary = historyBoundary(entries);
    const key = JSON.stringify([this.host.sessionManager.getSessionId(), entries[0]?.id, boundary]);
    let gap: SessionEntry[] | undefined;
    if (key !== this.boundaryKey) {
      gap =
        this.boundaryKey && this.sessionId === this.host.sessionManager.getSessionId()
          ? historyGap(
              boundary,
              this.boundary,
              (id) => this.host.sessionManager.getEntry(id),
              new Set(entries.map((entry) => entry.id)),
            )
          : undefined;
      if (!gap) {
        this.scope = {};
        this.pages.clear();
        this.pageEntries.clear();
      }
    }
    this.display?.({
      sessionId: this.host.sessionManager.getSessionId(),
      cwd: this.host.sessionManager.getCwd(),
      entries,
      expanded: this.host.toolOutputExpanded,
      scope: this.scope,
      history: [
        ...this.pages.children.flatMap((page) => this.pageEntries.get(page as Container) ?? []),
        ...(gap ?? []),
      ],
    });
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
        this.pageEntries.clear();
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
        pad(child, host.outputPad);
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
        const scroll = this.host.transcriptScrollView;
        const width = scroll.getContentWidth(this.host.ui.terminal.columns);
        const anchor = captureViewportAnchor(
          () => this.components(),
          // Header, resources, and filler are direct document children; chat rows are not.
          (component) => !this.host.documentContainer.children.includes(component),
          scroll.scrollTop,
          width,
        );
        const change: TranscriptView = {
          sessionId: this.host.sessionManager.getSessionId(),
          cwd: this.host.sessionManager.getCwd(),
          entries: batch.entries,
          expanded: this.host.toolOutputExpanded,
          scope: this.scope,
          prepend: true,
        };
        let page: Container | undefined;
        try {
          this.display?.(change);
          page = this.renderPage(batch.entries);
          if (this.closed || generation !== this.generation || cursor !== this.cursor) {
            change.transaction?.rollback();
            this.pageEntries.delete(page);
            return;
          }
          cursor.commit(batch);
          change.transaction?.commit();
          this.pages.children.unshift(page);
        } catch (error) {
          change.transaction?.rollback();
          if (page) this.pageEntries.delete(page);
          throw error;
        }
        // Preserve blank space below short transcripts, even when merging a
        // group removed an old header and the new page added no net rows.
        const afterHeight = this.host.documentContainer.render(width).length;
        const added = anchor?.(width) ?? page.render(width).length;
        this.padding += Math.max(
          0,
          Math.max(0, scroll.scrollTop + added) + scroll.viewportHeight - afterHeight,
        );
        this.scrollHook.anchor(anchor ?? page);
        this.host.ui.requestRender();
      } catch (error) {
        this.busy = false;
        this.failed = true;
        this.report(error);
      }
    });
  }

  private components(): Component[] {
    return this.host.documentContainer.children.flatMap((child) =>
      child === this.host.chatContainer
        ? this.host.chatContainer.children.flatMap((entry) =>
            entry === this.pages
              ? this.pages.children.flatMap((page) => (page as Container).children)
              : [entry],
          )
        : [child],
    );
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
    const page = renderHistoryPage(this.host, entries, this.render, this.scope);
    this.pageEntries.set(page, source);
    return page;
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.scrollHook.dispose();
    this.host.chatContainer.removeChild(this.pages);
    this.host.documentContainer.removeChild(this.filler);
    this.pages.clear();
    this.pageEntries.clear();
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
const PATCH = Symbol.for("rearview.patch.v1");

export function installHistoryAdapter(
  report: Owner["report"],
  size = PAGE_SIZE,
  display?: Owner["display"],
): { synchronize(): void; reset(): void; dispose(): void } {
  if (!Number.isSafeInteger(size) || size < 1)
    throw new Error("History page size must be a positive integer.");
  const prototype = InteractiveMode.prototype as unknown as NativeHost & { [PATCH]?: Patch };
  let patch = prototype[PATCH];
  if (patch && prototype.renderSessionEntries !== patch.wrapped)
    throw new Error("Another extension replaced rearview's adapter.");
  if (!patch) {
    const original = prototype.renderSessionEntries;
    if (typeof original !== "function") throw new Error("Pi's transcript renderer is unavailable.");
    const owners = new Set<Owner>(),
      controllers: Patch["controllers"] = new Map(),
      disabled = new WeakSet<NativeHost>();
    const wrapped: RenderEntries = function (entries, options) {
      const owner = [...owners].at(-1);
      if (!owner || disabled.has(this)) return original.call(this, entries, options);
      let selected = entries,
        visible = entries;
      let current = controllers.get(this);
      try {
        if (!current) {
          if (
            !this.transcriptScrollView ||
            !(this.chatContainer instanceof Container) ||
            !(this.documentContainer instanceof Container) ||
            !(this.pendingTools instanceof Map) ||
            typeof this.ui?.requestRender !== "function" ||
            !Number.isFinite(this.ui?.terminal?.columns) ||
            typeof this.sessionManager?.buildContextEntries !== "function" ||
            typeof this.sessionManager?.getEntry !== "function" ||
            typeof this.sessionManager?.getSessionId !== "function" ||
            typeof this.sessionManager?.getCwd !== "function" ||
            typeof this.settingsManager?.getShowImages !== "function" ||
            typeof this.settingsManager?.getImageWidthCells !== "function" ||
            typeof this.getRegisteredToolDefinition !== "function" ||
            typeof this.getUserMessageText !== "function" ||
            typeof this.editor?.addToHistory !== "function"
          )
            throw new Error("Pi's transcript layout changed.");
          current = {
            owner,
            controller: new HistoryController(
              this,
              original,
              owner.report,
              owner.size,
              owner.display,
            ),
          };
          controllers.set(this, current);
        }
        visible = current.controller.select(this.sessionManager.buildContextEntries());
        const ids = new Set(visible.map((entry) => entry.id));
        selected = entries.filter((entry) => ids.has(entry.id));
        current.controller.present(visible);
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
        current?.controller.dispose();
        controllers.delete(this);
        current = undefined;
        disabled.add(this);
        owner.report(
          new Error(
            `Pi ${VERSION}: history paging disabled; using the native transcript. ${error instanceof Error ? error.message : String(error)} Run npm run verify in ~/.pi/agent/extensions.`,
          ),
        );
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
