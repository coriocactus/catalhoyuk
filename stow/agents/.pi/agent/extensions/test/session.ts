// A real Pi session in this process: the installed Pi's own extension loader, runner, tool
// pipeline, and codemode, driven by an offline model whose replies each test scripts. The fakes
// check what extensions call of Pi's API; this checks what Pi then does with what they register,
// return, and send, as the terminal suite does with Pi's CLI, but with no terminal.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { Message } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  ExtensionContext,
  ExtensionFactory,
  ExtensionUIContext,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { ai, core, themes } from "./pi.ts";

export { ai };

/**
 * Pi's UI as an extension sees it with no terminal: nothing shows, dialogs are cancelled, as in
 * Pi's own stand-in for a session without one. Typed against Pi's declaration, so a member Pi
 * adds or renames fails typecheck here.
 */
const quietUi = (): ExtensionUIContext => ({
  select: async () => undefined,
  confirm: async () => false,
  input: async () => undefined,
  notify: () => {},
  onTerminalInput: () => () => {},
  setStatus: () => {},
  setWorkingMessage: () => {},
  setWorkingVisible: () => {},
  setWorkingIndicator: () => {},
  setHiddenThinkingLabel: () => {},
  setWidget: () => {},
  setFooter: () => {},
  setHeader: () => {},
  setTitle: () => {},
  custom: async () => undefined as never,
  pasteToEditor: () => {},
  setEditorText: () => {},
  getEditorText: () => "",
  editor: async () => undefined,
  addAutocompleteProvider: () => {},
  setEditorComponent: () => {},
  getEditorComponent: () => undefined,
  get theme() {
    return themes.theme;
  },
  getAllThemes: () => [],
  getTheme: () => undefined,
  setTheme: () => ({ success: false, error: "No terminal" }),
  getToolsExpanded: () => false,
  setToolsExpanded: () => {},
});

export interface SessionOptions {
  /** Extension files, which Pi's loader loads as it loads `~/.pi/agent/extensions`. */
  paths?: string[];
  /** Extensions as factories: for one a test sets up, such as comrade with its stand-in Pi. */
  factories?: ExtensionFactory[];
  /** Turn codemode on, as `defaultTools: ["+codemode"]` does. */
  codemode?: boolean;
  /** Pi's settings, held in memory. */
  settings?: Parameters<typeof SettingsManager.inMemory>[0];
  /** What `ctx.mode` says. Default `tui`, with `ui` in place of the terminal. */
  mode?: ExtensionContext["mode"];
  /** The UI extensions reach: `quietUi` with these members replaced. */
  ui?: Partial<ExtensionUIContext>;
}

export interface Session {
  session: AgentSession;
  /** The offline model: `model.setResponses`, `model.appendResponses`, `model.state`. */
  model: ReturnType<typeof ai.fauxProvider>;
  /** The project directory the session works in. */
  cwd: string;
}

/**
 * Starts a session on its own temporary agent directory and project, so the user's settings,
 * credentials, and extensions stay out of it. The model is offline and asks for no credentials.
 * The session is saved to a file, as Pi saves one, and quits when the test ends.
 */
export async function startSession(t: TestContext, options: SessionOptions = {}): Promise<Session> {
  const { paths = [], factories = [], codemode = false, mode = "tui", settings = {} } = options;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-session-")));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(cwd);
  const model = ai.fauxProvider({ provider: "offline", models: [{ id: "model" }] });
  const settingsManager = core.SettingsManager.inMemory({
    ...(codemode ? { defaultTools: ["+codemode"] } : {}),
    ...settings,
  });
  const resourceLoader = new core.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: paths,
    extensionFactories: [
      ...(codemode ? [core.createCodemodeExtension()] : []),
      (pi) => pi.registerProvider(model.provider),
      ...factories,
    ],
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, [], "every extension loads");
  const { session } = await core.createAgentSession({
    cwd,
    agentDir,
    resourceLoader,
    settingsManager,
    sessionManager: core.SessionManager.create(cwd, join(root, "sessions")),
    model: model.getModel(),
  });
  // Quit as Pi's runtime does on exit, which a bare session leaves to its host: Pi stops, then
  // extensions see the session shut down.
  t.after(async () => {
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  await session.bindExtensions({ mode, uiContext: { ...quietUi(), ...options.ui } });
  return { session, model, cwd };
}

/** Resolves once `ready` holds, checking every 10ms; fails with `what` after `ms`. */
export async function until(ready: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) assert.fail(`Not within ${ms}ms: ${what}`);
    await sleep(10);
  }
}

/** The text of each user message the model received, oldest first. */
export function userTexts(messages: readonly Message[]): string[] {
  return messages.flatMap((message) => {
    if (message.role !== "user") return [];
    const { content } = message;
    if (typeof content === "string") return [content];
    return [content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")];
  });
}

/** A reply that runs one codemode script. */
export const script = (code: string) =>
  ai.fauxAssistantMessage(ai.fauxToolCall("codemode", { code }));

/**
 * What each codemode script in the session returned, oldest first: the object of its `return`,
 * parsed back from the JSON codemode prints it as. Codemode prints a string as it is.
 */
export function scriptReturns(session: AgentSession): unknown[] {
  return session.messages.flatMap((message) => {
    if (message.role !== "toolResult" || message.toolName !== "codemode") return [];
    const [head, ...output] = message.content.flatMap((part) =>
      part.type === "text" ? [part.text] : [],
    );
    assert.match(head ?? "", /^Script completed/, output.join("\n"));
    return [JSON.parse(output.join(""))];
  });
}
