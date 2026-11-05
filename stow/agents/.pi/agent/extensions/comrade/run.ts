// One comrade run: a fresh `pi --mode json` process with its task on stdin, its event
// stream folded into progress updates and a final outcome.
import { spawn } from "node:child_process";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { emptyWork, Ledger, type Work } from "./work.ts";

/** Set in a comrade's environment so it does not offer comrade itself. */
export const NESTED = "PI_COMRADE";
const STDERR_TAIL = 8 * 1024;

/** The command that starts Pi, before Pi's own arguments. */
export interface Invocation {
  command: string;
  args: string[];
}

export interface Request {
  task: string;
  /** Always passed with the model, so Pi cannot resolve it under another provider. */
  provider: string;
  model: string;
  thinking: string;
  tools: string[];
  cwd: string;
  trusted: boolean;
}

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
}

export interface Outcome extends Progress {
  stopReason?: string;
  errorMessage?: string;
  stderr: string;
  exitCode: number | null;
  aborted: boolean;
}

export function piArgs(request: Request): string[] {
  return [
    "--mode",
    "json",
    "--no-session",
    "--provider",
    request.provider,
    "--model",
    request.model,
    "--thinking",
    request.thinking,
    ...(request.tools.length ? ["--tools", request.tools.join(",")] : ["--no-tools"]),
    // Print mode cannot ask, so the comrade inherits the caller's trust decision.
    request.trusted ? "--approve" : "--no-approve",
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
  };
  if (state.aborted) return Promise.resolve(state);
  const ledger = new Ledger(request.cwd);
  const progress = () => {
    state.work = ledger.snapshot();
    onProgress({ ...state, usage: structuredClone(state.usage) });
  };

  const handle = (line: string) => {
    let event: {
      type?: string;
      message?: AssistantMessage;
      toolCallId?: string;
      toolName?: string;
      args?: unknown;
      result?: unknown;
      isError?: boolean;
    };
    try {
      event = JSON.parse(line);
    } catch {
      return; // JSON mode reserves stdout for records; tolerate anything else.
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message;
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
      progress();
    } else if (event.type === "tool_execution_start" && event.toolName && event.toolCallId) {
      state.calls++;
      ledger.start(event.toolCallId, event.toolName, event.args);
      progress();
    } else if (event.type === "tool_execution_end" && event.toolCallId) {
      ledger.end(event.toolCallId, Boolean(event.isError), event.result);
      progress();
    }
  };

  return new Promise((resolve) => {
    const child = spawn(invocation.command, [...invocation.args, ...piArgs(request)], {
      cwd: request.cwd,
      env: { ...process.env, [NESTED]: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let killer: ReturnType<typeof setTimeout> | undefined;
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
      // Calls still running were cut off. The final record has no current call.
      ledger.close();
      state.work = ledger.snapshot(false);
      resolve(state);
    };
    signal?.addEventListener("abort", abort, { once: true });

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
