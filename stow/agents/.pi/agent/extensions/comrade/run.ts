// One comrade run: a fresh `pi --mode json` process with its task on stdin, its event
// stream folded into progress updates and a final outcome. Its conversation is saved in a
// session file, so a later run with the same file continues it.
import { spawn } from "node:child_process";
import type { Usage } from "@earendil-works/pi-ai";
import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { emptyWork, Ledger, type Work } from "./work.ts";

/**
 * Set in a comrade's environment to the parent's process id, so it does not offer comrade
 * itself and can stop when its parent is gone.
 */
export const NESTED = "PI_COMRADE";
const STDERR_TAIL = 8 * 1024;
/** How often streamed text may update progress. State changes update it at once. */
const STREAM_MS = 250;
/** Characters per token, to estimate streamed tokens before the provider counts them. */
const CHARS_PER_TOKEN = 4;

/** The command that starts Pi, before Pi's own arguments. */
export interface Invocation {
  command: string;
  args: string[];
  /** The environment to run it in. Default: this process's. */
  env?: NodeJS.ProcessEnv;
}

export interface Request {
  task: string;
  /** Always passed with the model, so Pi cannot resolve it under another provider. */
  provider: string;
  model: string;
  thinking: string;
  tools: string[];
  /** Absolute paths, attached to the prompt after the task. */
  files: string[];
  /** Absolute path the whole answer is written to. */
  output?: string;
  /** Stops the comrade after this long. */
  timeoutMs?: number;
  /** The session file holding the comrade's conversation. Pi creates it on the first run. */
  session: string;
  /** This run continues the conversation in `session`. */
  followUp?: boolean;
  /** The directory the comrade runs in. */
  cwd: string;
  /** The caller's working directory. Absent in jobs adopted from older versions. */
  origin?: string;
  /** Whether Pi may load project-local files in `cwd`. */
  trusted: boolean;
}

/** What a running comrade is doing now, from its event stream. */
export interface Activity {
  state:
    | "starting"
    | "waiting"
    | "thinking"
    | "writing"
    | "calling"
    | "running"
    | "retrying"
    | "compacting";
  /** When it entered this state. */
  since: number;
  /** Tokens streamed in this state, estimated from their characters. */
  tokens?: number;
  /** `calling`: the tool. `retrying`: the attempt and the error. */
  detail?: string;
  /** The turn it is in, counted from Pi's turn starts, so a turn's tools belong to it. */
  turn?: number;
}

export const starting = (): Activity => ({ state: "starting", since: Date.now() });

export interface Progress {
  turns: number;
  calls: number;
  /** What the comrade's calls did, summarised. */
  work: Work;
  usage: Usage;
  /** The latest non-empty assistant text: the answer once the run ends. */
  text: string;
  /** The model and thinking level the comrade reports using, once it has answered. */
  model?: string;
  thinking?: string;
  activity: Activity;
}

export interface Outcome extends Progress {
  stopReason?: string;
  errorMessage?: string;
  stderr: string;
  exitCode: number | null;
  aborted: boolean;
  /** Stopped because it ran past its timeout, not by Esc or the comrades tool. */
  timedOut: boolean;
}

export function piArgs(request: Request): string[] {
  return [
    "--mode",
    "json",
    // A path Pi has not seen starts a session there; an existing one is continued.
    "--session",
    request.session,
    "--provider",
    request.provider,
    "--model",
    request.model,
    "--thinking",
    request.thinking,
    ...(request.tools.length ? ["--tools", request.tools.join(",")] : ["--no-tools"]),
    // Print mode cannot ask, so the comrade inherits the caller's trust decision.
    request.trusted ? "--approve" : "--no-approve",
    // Pi appends each file to the stdin task as a <file name="..."> block.
    ...request.files.map((file) => `@${file}`),
  ];
}

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(total: Usage, usage: Usage | undefined): void {
  if (!usage) return;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
    total[key] += usage[key] ?? 0;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
    total.cost[key] += usage.cost?.[key] ?? 0;
}

export function run(
  invocation: Invocation,
  request: Request,
  signal: AbortSignal | undefined,
  onProgress: (progress: Progress) => void,
): Promise<Outcome> {
  const state: Outcome = {
    turns: 0,
    calls: 0,
    work: emptyWork(),
    usage: emptyUsage(),
    text: "",
    stderr: "",
    exitCode: null,
    aborted: Boolean(signal?.aborted),
    timedOut: false,
    activity: starting(),
  };
  if (state.aborted) return Promise.resolve(state);
  const ledger = new Ledger(request.cwd);
  let reported = 0;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  // The turn Pi last started: the turns finished before it, plus this one.
  let turn = 0;
  const progress = () => {
    clearTimeout(trailing);
    trailing = undefined;
    reported = Date.now();
    state.work = ledger.snapshot();
    if (turn) state.activity.turn = turn;
    onProgress({ ...state, usage: structuredClone(state.usage), activity: { ...state.activity } });
  };
  // Streamed text arrives many times a second: report it at most every STREAM_MS.
  const streamed = () => {
    if (trailing) return;
    const wait = reported + STREAM_MS - Date.now();
    if (wait <= 0) return progress();
    trailing = setTimeout(progress, wait);
    trailing.unref();
  };
  let chars = 0;
  /**
   * Enters a state, reporting it at once. Staying in it only adds to its streamed text, unless
   * `fresh` starts it over, as each new tool call does.
   */
  const enter = (next: Activity["state"], detail?: string, delta = "", fresh = false) => {
    const label = detail || undefined;
    if (fresh || next !== state.activity.state || label !== state.activity.detail) {
      chars = 0;
      state.activity = { state: next, since: Date.now(), ...(label ? { detail: label } : {}) };
      if (delta) {
        chars = delta.length;
        state.activity.tokens = Math.ceil(chars / CHARS_PER_TOKEN);
      }
      return progress();
    }
    if (!delta) return;
    chars += delta.length;
    state.activity.tokens = Math.ceil(chars / CHARS_PER_TOKEN);
    streamed();
  };

  // Pi's JSON mode writes one session event per line, in the shape its JsonAgentSessionEvent
  // type declares. Narrowing on that type keeps this reader in step with Pi's event names.
  const handle = (line: string) => {
    let event: JsonAgentSessionEvent;
    try {
      event = JSON.parse(line);
    } catch {
      return; // JSON mode reserves stdout for records; tolerate anything else.
    }
    if (typeof event !== "object" || event === null) return;
    switch (event.type) {
      case "message_end": {
        const message = event.message;
        if (message?.role !== "assistant") return;
        state.turns++;
        addUsage(state.usage, message.usage);
        state.model = `${message.provider}/${message.model}`;
        state.thinking = message.thinkingLevel ?? state.thinking;
        state.stopReason = message.stopReason;
        state.errorMessage = message.errorMessage;
        const text = message.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n")
          .trim();
        if (text) state.text = text;
        return progress();
      }
      case "tool_execution_start":
        if (!event.toolName || !event.toolCallId) return;
        state.calls++;
        ledger.start(event.toolCallId, event.toolName, event.args);
        state.activity = { state: "running", since: Date.now() };
        return progress();
      case "tool_execution_end":
        if (!event.toolCallId) return;
        ledger.end(event.toolCallId, Boolean(event.isError), event.result);
        return progress();
      case "message_update": {
        const update = event.assistantMessageEvent;
        switch (update?.type) {
          case "thinking_start":
            return enter("thinking");
          case "thinking_delta":
            return enter("thinking", undefined, update.delta);
          case "text_start":
            return enter("writing");
          case "text_delta":
            return enter("writing", undefined, update.delta);
          case "toolcall_start":
            return enter("calling", update.toolName || state.activity.detail, "", true);
          case "toolcall_delta":
            if (state.activity.state === "calling")
              enter("calling", state.activity.detail, update.delta);
            return;
          default:
            return;
        }
      }
      case "turn_start":
        turn = state.turns + 1;
        return enter("waiting");
      // A request is out, and nothing has come back yet.
      case "agent_start":
      case "compaction_end":
        return enter("waiting");
      case "auto_retry_end":
        // A retry that gave up sends no request.
        if (event.success !== false) enter("waiting");
        return;
      case "auto_retry_start": {
        const attempt =
          event.attempt && event.maxAttempts ? `${event.attempt}/${event.maxAttempts}` : "";
        const error = event.errorMessage?.split("\n")[0]?.slice(0, 120) ?? "";
        return enter("retrying", [attempt, error].filter(Boolean).join(" · "));
      }
      case "compaction_start":
        return enter("compacting");
      default:
        return;
    }
  };

  return new Promise((resolve) => {
    const child = spawn(invocation.command, [...invocation.args, ...piArgs(request)], {
      cwd: request.cwd,
      env: { ...(invocation.env ?? process.env), [NESTED]: String(process.pid) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let killer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      state.aborted = true;
      child.kill("SIGTERM");
      killer = setTimeout(() => child.kill("SIGKILL"), 5000);
      // Never hold Pi open on exit just to finish the kill.
      killer.unref();
    };
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      clearTimeout(killer);
      clearTimeout(deadline);
      clearTimeout(trailing);
      // Calls still running were cut off. The final record has no current call.
      ledger.close();
      state.work = ledger.snapshot(false);
      resolve(state);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (request.timeoutMs !== undefined) {
      deadline = setTimeout(() => {
        state.timedOut = true;
        abort();
      }, request.timeoutMs);
      deadline.unref();
    }

    // Records are split on LF only; the decoder keeps multibyte characters whole across chunks.
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        handle(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      state.stderr = (state.stderr + chunk).slice(-STDERR_TAIL);
    });
    // The child may exit before reading its task.
    child.stdin.on("error", () => {});
    child.stdin.end(request.task);

    child.on("error", (error) => {
      if (child.pid !== undefined) return;
      state.errorMessage = `Could not start pi: ${error.message}`;
      finish();
    });
    child.on("close", (code) => {
      if (buffer) handle(buffer);
      state.exitCode = code;
      finish();
    });
  });
}
