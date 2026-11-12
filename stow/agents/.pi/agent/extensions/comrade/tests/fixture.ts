// Comrade's tests share this fixture: comrade on a fake Pi, its comrades run by the stand-in.
// Cross-extension tests in test/ install other extensions beside it, such as mirage.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionToolContext,
  MessageRenderer,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { fake, fakePi, type Tool } from "../../test/fake-pi.ts";
import { load, type themes, tui } from "../../test/pi.ts";

const { register } = await load<typeof import("../index.ts")>("../index.ts", import.meta.url);

type Delivery = import("../index.ts").Delivery;
type Sent = Parameters<ExtensionAPI["sendMessage"]>;
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Result = Awaited<ReturnType<Tool["execute"]>>;
/** The widget comrade sets above the editor, as Pi calls it. */
export type WidgetFactory = (
  tui: { requestRender(): void },
  theme: typeof themes.theme,
) => Component & { dispose?(): void };

export const standIn = fileURLToPath(new URL("./stand-in.ts", import.meta.url));
export const models = [
  "anthropic/claude-opus-5-5",
  "anthropic/claude-fable-5-1",
  // OpenRouter's id for the same model is the text `anthropic/claude-fable-5-1`.
  "openrouter/anthropic/claude-fable-5-1",
  "openrouter/google/gemini-4-argon",
  "openrouter/google/gemini-4-argon:batch",
  // A provider whose own id contains a slash.
  "corp/proxy/big-model",
].map((ref) => {
  const slash = ref.indexOf("/");
  const split = ref.startsWith("corp/proxy/") ? "corp/proxy".length : slash;
  return fake<Model<Api>>({ provider: ref.slice(0, split), id: ref.slice(split + 1) });
});
export const current = models[0];
export const toolNames = ["read", "bash", "edit", "write", "grep", "find", "ls", "codemode"];

export function fixture(
  t: TestContext,
  scenario: string,
  {
    trusted = true,
    /** A function is called again for each run. */
    command = process.execPath as string | (() => string),
    mode = "tui" as ExtensionToolContext["mode"],
    entries = [] as SessionEntry[],
    sessionId = "session",
    reason = "startup",
    /** The caller's session file, beside which comrades keep theirs. Null: an unsaved session. */
    parent = "parent.jsonl" as string | null,
    /** The current branch, when it is not every entry. */
    branch = undefined as SessionEntry[] | undefined,
    /** Tools this Pi has but does not offer the model, which a comrade cannot have either. */
    inactive = [] as string[],
    /** The session's scoped models (`enabledModels`). Empty: no scope. */
    scoped = [] as Model<Api>[],
    /** The models with credentials, which a session with no scope may use. */
    available = models,
    /** Installs other extensions on the same Pi first, as cross-extension tests do with mirage. */
    beside = undefined as ((api: ExtensionAPI) => void) | undefined,
    /** Pi's settings, such as `hideThinkingBlock`. */
    settings = {} as Record<string, unknown>,
  } = {},
) {
  const pi = fakePi();
  const sent: Sent[] = [];
  const waiting: (() => void)[] = [];
  const commands = new Map<string, Command>();
  const renderers = new Map<string, MessageRenderer<Delivery>>();
  const notices: string[] = [];
  const api: ExtensionAPI = {
    ...pi.api,
    sendMessage: ((...message: Sent) => {
      sent.push(message);
      for (const wake of waiting.splice(0)) wake();
    }) as ExtensionAPI["sendMessage"],
    registerCommand: (name, options) => commands.set(name, options),
    registerMessageRenderer: ((type: string, renderer: MessageRenderer<Delivery>) =>
      renderers.set(type, renderer)) as ExtensionAPI["registerMessageRenderer"],
    getAllTools: () =>
      [...toolNames, ...pi.tools.keys()].map((name) =>
        fake<ReturnType<ExtensionAPI["getAllTools"]>[number]>({ name }),
      ),
    // Active in the caller: everything but what `inactive` names.
    getActiveTools: () =>
      [...toolNames, ...pi.tools.keys()].filter((name) => !inactive.includes(name)),
  };
  beside?.(api);
  register(
    api,
    typeof command === "function"
      ? () => ({ command: command(), args: [standIn, scenario] })
      : { command, args: [standIn, scenario] },
  );
  const tool = pi.tools.get("comrade");
  const list = pi.tools.get("comrades");
  assert(tool && list, "comrade and comrades registered");
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "comrade-test-")));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  // Pi's settings for this test alone, never the user's.
  const agentDir = join(cwd, ".agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  });
  const working: (string | undefined)[] = [];
  const keys = new Set<(data: string) => unknown>();
  let pending = false;
  const widgets: (WidgetFactory | undefined)[] = [];
  const ui = {
    setStatus: () => assert.fail("comrade must not add a footer status"),
    notify: (message: string) => void notices.push(message),
    setWorkingMessage: (message?: string) => void working.push(message),
    setWidget: (key: string, content: unknown, options?: { placement?: string }) => {
      assert.equal(key, "comrade");
      if (content !== undefined) assert.equal(options?.placement, "aboveEditor");
      widgets.push(content as WidgetFactory | undefined);
    },
    onTerminalInput: (handler: (data: string) => unknown) => {
      keys.add(handler);
      return () => keys.delete(handler);
    },
    getToolsExpanded: () => false,
  };
  const ctx = fake<ExtensionToolContext>({
    cwd,
    mode,
    ui,
    sessionManager: {
      getEntries: () => entries,
      getBranch: () => branch ?? entries,
      getSessionId: () => sessionId,
      getSessionFile: () => (parent === null ? undefined : join(cwd, parent)),
      buildContextEntries: () => branch ?? entries,
    },
    isIdle: () => true,
    model: current,
    thinkingLevel: "xhigh",
    scopedModels: scoped.map((model) => ({ model })),
    modelRegistry: {
      find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
      getAvailable: () => available,
    },
    isProjectTrusted: () => trusted,
    hasPendingMessages: () => pending,
  });
  const updates: Result[] = [];
  // A new comrade is titled with its task's first line unless a test says otherwise; an empty
  // title is none.
  const call = (
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: () => void,
    toolCallId = "call",
  ) =>
    tool.execute(
      toolCallId,
      params.to === undefined && params.title === undefined && typeof params.task === "string"
        ? { ...params, title: params.task.split("\n")[0] }
        : params,
      signal,
      (update) => {
        updates.push(update);
        onUpdate?.();
      },
      ctx,
    ) as Promise<Result>;
  pi.emit("session_start", { reason }, ctx);
  t.after(() => pi.emit("session_shutdown", { reason: "quit" }, ctx));
  const comrades = (params: Record<string, unknown>) =>
    list.execute("list", params, undefined, undefined, ctx) as Promise<Result>;
  /** Resolves once `count` messages have been sent. */
  const delivered = async (count: number) => {
    while (sent.length < count) await new Promise<void>((wake) => waiting.push(wake));
    return sent;
  };
  const slash = (args: string) => {
    const comrades = commands.get("comrades");
    assert(comrades, "/comrades registered");
    return comrades.handler(args, fake<ExtensionCommandContext>({ ui }));
  };
  const shutdown = (why = "quit") => pi.emit("session_shutdown", { reason: why }, ctx);
  /** The agent tries to end its turn. Resolves when Pi may let it. */
  const settle = () => pi.event("agent_before_settle", {}, ctx);
  const press = (data: string) => {
    for (const handler of keys) handler(data);
  };
  const typed = () => {
    pending = true;
  };
  /** Records a comrade's row in the session, as Pi does once the call returns. */
  const remember = (result: Result) =>
    entries.push(
      fake<SessionEntry>({
        type: "message",
        message: { role: "toolResult", toolName: "comrade", details: result.details },
      } as never),
    );
  return {
    pi,
    ctx,
    remember,
    entries,
    tool,
    cwd,
    call,
    updates,
    sent,
    delivered,
    slash,
    notices,
    renderers,
    shutdown,
    comrades,
    settle,
    press,
    typed,
    working,
    keys,
    widgets,
  };
}

/** A component's lines as the terminal shows them, without styles or trailing spaces. */
export const render = (component: Component | undefined, width = 120) => {
  assert(component);
  return component
    .render(width)
    .map((line) => tui.stripTerminalSequences(line).trimEnd())
    .join("\n");
};
