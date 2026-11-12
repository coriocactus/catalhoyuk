// One comrade run: a fresh `pi --mode rpc` process given its task as a prompt command, its
// event stream folded into progress updates and a final outcome. Messages sent to it while it
// runs reach it before its next model request. Its conversation is saved in a session file, so
// a later run with the same file continues it.
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Usage } from "@earendil-works/pi-ai";
import {
  detectSupportedImageMimeTypeFromFile,
  type JsonAgentSessionEvent,
  type RpcCommand,
  type RpcExtensionUIRequest,
  type RpcExtensionUIResponse,
  type RpcResponse,
} from "@earendil-works/pi-coding-agent";
import type { Face } from "./view.ts";
import { emptyWork, Ledger, type Work } from "./work.ts";

/**
 * Set in a comrade's environment to the parent's process id, so it does not offer comrade
 * itself and can stop when its parent is gone.
 */
export const NESTED = "PI_COMRADE";
const STDERR_TAIL = 8 * 1024;
/** How long a comrade's Pi may take to exit once it has settled, before it is stopped. */
const EXIT_MS = 10_000;
/** How long a stopped Pi has to exit before it is killed. */
const KILL_MS = 5000;
/** How long the output of a Pi that has exited is read for, if a process it started holds it. */
const DRAIN_MS = 1000;
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
  /** This run carries on after Pi exited while the comrade ran. */
  resumed?: boolean;
  /** How its row names it: its title, and the settings it runs with that are not the caller's. */
  face?: Face;
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
  /** `calling`: the tool. `retrying`: the attempt and the error. */
  detail?: string;
  /** The turn it is in, counted from Pi's turn starts, so a turn's tools belong to it. */
  turn?: number;
}

export const starting = (): Activity => ({ state: "starting", since: Date.now() });

/**
 * The message now streaming: its tokens so far. Providers that count as they go (Google)
 * give exact numbers; the rest report only when the message ends, so until then the output
 * is estimated from the streamed characters.
 */
export interface Streamed {
  /** Input tokens the provider has reported for this message, with cache reads and writes. */
  input: number;
  /** Output tokens so far. */
  output: number;
  /** `output` is the provider's count, not an estimate. */
  exact: boolean;
}

export interface Progress {
  turns: number;
  calls: number;
  /** What the comrade's calls did, summarised. */
  work: Work;
  /** The finished messages' usage. */
  usage: Usage;
  /** The message now streaming, between its start and its end. */
  streamed?: Streamed;
  /** The latest non-empty assistant text: the answer once the run ends. */
  text: string;
  /** The model and thinking level the comrade reports using, once it has answered. */
  model?: string;
  thinking?: string;
  activity: Activity;
  /** The comrade's own Pi, once started. */
  pid?: number;
  /** Its prompt is in its conversation: Pi has saved it. */
  asked?: boolean;
  /** The last complete line of its thinking or text. */
  said?: string;
  /** Whether that line is its thinking, which only shows where Pi shows thinking. */
  saidThinking?: boolean;
  /** The last complete line of its text alone, for where thinking is hidden. */
  spoke?: string;
  /** Said or spoke in an earlier turn than this one. */
  saidBefore?: boolean;
  spokeBefore?: boolean;
  /**
   * Its conversation in this run, as each message ends: its replies, their results, and what it
   * was told. Kept lean: without images, and with long results cut, as its row shows them.
   */
  messages: AgentMessage[];
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

/** A message waiting for the comrade's Pi to start, and what to tell its sender. */
interface Held {
  message: string;
  settle: (error?: Error) => void;
}

/**
 * Messages for a running comrade. Pi delivers each after the comrade's current tool calls,
 * before its next model request, or starts a run with it once the comrade has settled. One sent
 * before Pi has started is held until it has. Open until the run ends.
 */
export class Channel {
  private send?: (message: string) => Promise<void>;
  private held: Held[] = [];
  private closed = false;
  /** Whether it can still take a message. */
  get open(): boolean {
    return !this.closed;
  }
  /** Resolves once the comrade's Pi has taken the message. */
  steer(message: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error("it is no longer running"));
    if (this.send) return this.send(message);
    return new Promise((resolve, reject) =>
      this.held.push({ message, settle: (error) => (error ? reject(error) : resolve()) }),
    );
  }
  /** The run's side: sends messages straight on, starting with those held meanwhile. */
  connect(send: (message: string) => Promise<void>): void {
    if (this.closed) return;
    this.send = send;
    for (const { message, settle } of this.held.splice(0))
      send(message).then(() => settle(), settle);
  }
  /** Takes no more messages, and refuses those held. */
  close(): void {
    this.closed = true;
    this.send = undefined;
    for (const { settle } of this.held.splice(0))
      settle(new Error("it finished before your message reached it"));
  }
}

/** How much of a call's result a row keeps: mirage shows at most this much of it opened. */
const RESULT_MAX = 32_000;

/** A message as a row keeps it: images dropped, as rows draw none, and long results cut. */
export function lean(message: AgentMessage): AgentMessage {
  if (message.role === "user" && Array.isArray(message.content))
    return { ...message, content: message.content.filter((part) => part.type !== "image") };
  if (message.role !== "toolResult") return message;
  const content = message.content.flatMap((part) => {
    if (part.type === "image") return [];
    if (part.text.length <= RESULT_MAX) return [part];
    // Not between the halves of a surrogate pair.
    const end = /[\uD800-\uDBFF]/.test(part.text[RESULT_MAX - 1] ?? "")
      ? RESULT_MAX - 1
      : RESULT_MAX;
    return [{ ...part, text: `${part.text.slice(0, end)}\n…` }];
  });
  return { ...message, content };
}

/**
 * How a message sent while the comrade works reaches it. The comrade may be finishing its answer
 * when it arrives, and its last reply is what comes back, so it is asked for a complete one.
 */
const STEERING =
  "[A message from the agent that started you, sent while you worked. Take it into account, and end with your complete final answer, covering your task and this message.]\n\n";
export const steering = (message: string) => `${STEERING}${message}`;
/** A message sent while it worked, as its sender wrote it. */
export const fromSteering = (text: string) =>
  text.startsWith(STEERING) ? text.slice(STEERING.length) : text;

/**
 * The prompt Pi's `@file` arguments would build, which RPC mode does not take: the task, then
 * each file as a `<file name="...">` block, text inline and images attached. Pi converts and
 * resizes the images for the model it runs, as it does for `@file`. Empty files are skipped.
 */
export async function prompt(
  task: string,
  files: string[],
): Promise<{ message: string; images: ImageContent[] }> {
  let blocks = "";
  const images: ImageContent[] = [];
  for (const file of files) {
    if ((await stat(file)).size === 0) continue;
    const mimeType = await detectSupportedImageMimeTypeFromFile(file);
    if (mimeType) {
      images.push({ type: "image", mimeType, data: (await readFile(file)).toString("base64") });
      blocks += `<file name="${file}"></file>\n`;
    } else {
      const content = (await readFile(file, "utf8")).replace(/^\uFEFF/, "");
      blocks += `<file name="${file}">\n${content}\n</file>\n`;
    }
  }
  return { message: blocks ? `${task}\n\n${blocks.trimEnd()}` : task, images };
}

/** Pi's dialogs, which wait for an answer: a comrade has no one to ask, so each is cancelled. */
const DIALOGS: ReadonlySet<RpcExtensionUIRequest["method"]> = new Set([
  "select",
  "confirm",
  "input",
  "editor",
]);

/** Markdown's marks around and before words, which a one-line excerpt does without. */
const MARKS = /(\*\*|`)|^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: a model's text may carry escapes.
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]+/g;
/** Words a full stop ends without ending a sentence. */
const ABBREVIATIONS = /(?:^|\W)(?:e\.g|i\.e|etc|vs|cf|approx|incl|no|fig|eq|ch|sec|v\d*)$/i;
const SAID_MAX = 200;

/** Where the text's last complete sentence or line ends, or -1 with none. */
function completeEnd(text: string): number {
  let end = text.lastIndexOf("\n");
  // A colon mid-line introduces what follows, so only a line break ends what it begins.
  for (const match of text.matchAll(/[.!?](?=\s)/g)) {
    const before = text.slice(Math.max(0, match.index - 12), match.index);
    // A sentence ends after a word: not a list number, a version, or an abbreviation.
    if (!/[\p{L})"'\]]$/u.test(before) || ABBREVIATIONS.test(before)) continue;
    end = Math.max(end, match.index + 1);
  }
  return end;
}

/** Lines that are not prose: code, table rows, rules, and bare list numbers. */
function prose(lines: string[]): string[] {
  const kept: string[] = [];
  let fenced = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || /^\s*\|/.test(line) || /^\s*([-*_]\s*){3,}$/.test(line)) continue;
    const plain = line.replace(MARKS, "").replace(CONTROLS, " ").replace(/\s+/g, " ").trim();
    if (/\p{L}/u.test(plain)) kept.push(plain);
  }
  return kept;
}

/**
 * The last complete thing a comrade said: its prose up to its last line break or sentence end,
 * then the last line of that, so the row never shows half a sentence, code, or a table row.
 * `whole`: the text is done, so its end is complete too.
 */
export function lastSaid(text: string, whole = false): string | undefined {
  const end = whole ? text.length : completeEnd(text);
  if (end <= 0) return undefined;
  const line = prose(text.slice(0, end).split("\n")).at(-1);
  if (!line) return undefined;
  const characters = Array.from(line);
  return characters.length > SAID_MAX ? `${characters.slice(0, SAID_MAX - 1).join("")}…` : line;
}

export function piArgs(request: Request): string[] {
  return [
    "--mode",
    "rpc",
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
    // No one can answer a trust prompt, so the comrade inherits the caller's decision.
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

export async function run(
  invocation: Invocation,
  request: Request,
  signal: AbortSignal | undefined,
  onProgress: (progress: Progress) => void,
  channel?: Channel,
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
    messages: [],
  };
  let first: Awaited<ReturnType<typeof prompt>> | undefined;
  if (!state.aborted)
    try {
      first = await prompt(request.task, request.files);
    } catch (error) {
      state.errorMessage = `Could not attach a file: ${error instanceof Error ? error.message : error}`;
    }
  // Stopped while its files were read.
  if (signal?.aborted) state.aborted = true;
  if (!first || state.aborted) {
    channel?.close();
    return state;
  }
  const task = first;
  const ledger = new Ledger(request.cwd);
  let reported = 0;
  let trailing: ReturnType<typeof setTimeout> | undefined;
  // The turn Pi last started: the turns finished before it, plus this one.
  let turn = 0;
  // The thinking or text block now streaming, whose last complete line is what it says.
  let block = "";
  let blockThinking = false;
  let unread = false;
  const say = (said: string, thinking: boolean) => {
    state.said = said;
    state.saidThinking = thinking;
    state.saidBefore = undefined;
    if (thinking) return;
    state.spoke = said;
    state.spokeBefore = undefined;
  };
  const progress = () => {
    clearTimeout(trailing);
    trailing = undefined;
    reported = Date.now();
    if (unread) {
      unread = false;
      const said = lastSaid(block);
      if (said) say(said, blockThinking);
    }
    state.work = ledger.snapshot();
    if (turn) state.activity.turn = turn;
    onProgress({
      ...state,
      usage: structuredClone(state.usage),
      activity: { ...state.activity },
      ...(state.streamed ? { streamed: { ...state.streamed } } : {}),
    });
  };
  // Streamed text arrives many times a second: report it at most every STREAM_MS.
  const streamed = () => {
    if (trailing) return;
    const wait = reported + STREAM_MS - Date.now();
    if (wait <= 0) return progress();
    trailing = setTimeout(progress, wait);
    trailing.unref();
  };
  // The streaming message: its characters so far, and the provider's output count, which is
  // trusted once it has moved (Anthropic reports a token or two at the start, then nothing
  // until the end; Google counts along).
  let chars = 0;
  let counted = 0;
  let counting = false;
  const began = () => {
    chars = 0;
    counted = 0;
    counting = false;
    state.streamed = { input: 0, output: 0, exact: false };
  };
  /** Folds in the provider's cumulative usage for the streaming message. */
  const count = (usage: Usage | undefined) => {
    if (!usage || !state.streamed) return;
    state.streamed.input = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    if (usage.output > counted) {
      if (counted > 0) counting = true;
      counted = usage.output;
    }
  };
  const tally = () => {
    if (!state.streamed) return;
    state.streamed.output = counting ? counted : Math.ceil(chars / CHARS_PER_TOKEN);
    state.streamed.exact = counting;
  };
  /**
   * Enters a state, reporting it at once. Staying in it only adds to the streamed text, unless
   * `fresh` starts the state over, as each new tool call does.
   */
  const enter = (next: Activity["state"], detail?: string, delta = "", fresh = false) => {
    const label = detail || undefined;
    chars += delta.length;
    tally();
    if (fresh || next !== state.activity.state || label !== state.activity.detail) {
      state.activity = { state: next, since: Date.now(), ...(label ? { detail: label } : {}) };
      return progress();
    }
    if (delta) streamed();
  };

  // RPC mode writes one record per line: session events in the shape Pi's JsonAgentSessionEvent
  // type declares, command responses, and extension dialogs. Narrowing on Pi's types keeps this
  // reader in step with its record names.
  let answer: (record: RpcResponse) => void = () => {};
  let ask: (request: RpcExtensionUIRequest) => void = () => {};
  let settled: () => void = () => {};
  // A run is going: Pi accepted a prompt of ours, or started one. Only its end settles the
  // comrade, not anything Pi reports before it.
  let going = false;
  const handle = (line: string) => {
    let event: JsonAgentSessionEvent | RpcResponse | RpcExtensionUIRequest;
    try {
      event = JSON.parse(line);
    } catch {
      return; // RPC mode reserves stdout for records; tolerate anything else.
    }
    if (typeof event !== "object" || event === null) return;
    switch (event.type) {
      case "response":
        return answer(event);
      case "extension_ui_request":
        return ask(event);
      case "agent_settled":
        if (!going) return;
        going = false;
        return settled();
      case "message_start":
        if (event.message?.role !== "assistant") return;
        began();
        count(event.message.usage);
        return;
      case "message_end": {
        const message = event.message;
        // Its conversation in this run, for its row to show as mirage shows Pi's own.
        if (
          message?.role === "user" ||
          message?.role === "assistant" ||
          message?.role === "toolResult"
        )
          state.messages.push(lean(message as AgentMessage));
        // Pi saves each message as it ends: the comrade has its prompt.
        if (message?.role === "user" && !state.asked) {
          state.asked = true;
          return progress();
        }
        if (message?.role !== "assistant") return progress();
        state.turns++;
        state.streamed = undefined;
        addUsage(state.usage, message.usage);
        state.model = `${message.provider}/${message.model}`;
        state.thinking = message.thinkingLevel ?? state.thinking;
        state.stopReason = message.stopReason;
        state.errorMessage = message.errorMessage;
        const text = message.content
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n")
          .trim();
        if (text) {
          state.text = text;
          const said = lastSaid(text, true);
          if (said) say(said, false);
        }
        unread = false;
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
        // The first update of a message Pi did not announce starts it.
        if (!state.streamed) began();
        count(event.usage);
        const update = event.assistantMessageEvent;
        switch (update?.type) {
          case "thinking_start":
          case "text_start":
            block = "";
            blockThinking = update.type === "thinking_start";
            return enter(update.type === "text_start" ? "writing" : "thinking");
          case "thinking_delta":
          case "text_delta":
            block += update.delta;
            unread = true;
            return enter(
              update.type === "text_delta" ? "writing" : "thinking",
              undefined,
              update.delta,
            );
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
        // What it said is kept, marked as from an earlier turn, until it says more.
        if (state.said) state.saidBefore = true;
        if (state.spoke) state.spokeBefore = true;
        return enter("waiting");
      // A request is out, and nothing has come back yet.
      case "agent_start":
        going = true;
        return enter("waiting");
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
    let buffer = "";
    let killer: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;
    let finished = false;
    let ended = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(invocation.command, [...invocation.args, ...piArgs(request)], {
        cwd: request.cwd,
        env: { ...(invocation.env ?? process.env), [NESTED]: String(process.pid) },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      state.errorMessage = `Could not start pi: ${error instanceof Error ? error.message : error}`;
      channel?.close();
      resolve(state);
      return;
    }
    const stdin = child.stdin;
    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdin || !stdout || !stderr) throw new Error("pi started without its pipes");
    if (child.pid !== undefined) {
      state.pid = child.pid;
      progress();
    }

    // Commands, each answered by a response with its id. One the comrade exits before answering
    // is answered as failed. Prompts in flight keep the comrade open: one may start a run.
    let sent = 0;
    const answers = new Map<string, (response: RpcResponse) => void>();
    const inFlight = new Set<Promise<unknown>>();
    const write = (record: RpcCommand | RpcExtensionUIResponse) => {
      if (!ended && stdin.writable) stdin.write(`${JSON.stringify(record)}\n`);
    };
    const command = (record: RpcCommand) => {
      const response = new Promise<RpcResponse>((reply) => {
        if (ended)
          return reply({
            type: "response",
            command: record.type,
            success: false,
            error: "Pi exited",
          });
        const id = `comrade-${++sent}`;
        answers.set(id, reply);
        write({ ...record, id });
      }).then((response) => {
        // Accepted: it runs now, or in the run going now.
        if (
          response.success &&
          response.command === "prompt" &&
          response.data.disposition !== "handled"
        )
          going = true;
        return response;
      });
      inFlight.add(response);
      void response.finally(() => inFlight.delete(response));
      return response;
    };
    answer = (response) => {
      if (response.id === undefined) return;
      answers.get(response.id)?.(response);
      answers.delete(response.id);
    };
    ask = (request) => {
      if (DIALOGS.has(request.method))
        write({ type: "extension_ui_response", id: request.id, cancelled: true });
    };

    // Closing stdin asks Pi to shut down, which aborts any run, so only once the comrade has
    // settled. From then on its outcome stands: the timeout and Esc no longer apply, and a Pi
    // that does not exit in time is stopped.
    const end = () => {
      channel?.close();
      if (ended) return;
      ended = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      stdin.end();
      killer = setTimeout(() => {
        child.kill("SIGTERM");
        killer = setTimeout(() => child.kill("SIGKILL"), KILL_MS);
        killer.unref();
      }, EXIT_MS);
      killer.unref();
    };

    // A message for the comrade, as a prompt Pi queues into the run going now, or starts a run
    // with once the comrade has settled, so none is left in a queue nothing reads.
    const steer = async (message: string) => {
      const response = await command({
        type: "prompt",
        message: steering(message),
        streamingBehavior: "steer",
      });
      if (!response.success) throw new Error(response.error);
      if (response.command === "prompt" && response.data.disposition === "handled")
        throw new Error("an extension in its Pi took it instead");
    };
    // Settled: once Pi has answered every prompt in flight, the comrade is done unless one of
    // them started another run, whose end settles it in turn. One settling at a time.
    let settling = Promise.resolve();
    settled = () => {
      settling = settling.then(async () => {
        while (inFlight.size && !ended) await Promise.all(inFlight);
        if (!going && !state.aborted && !ended) end();
      });
    };

    const abort = () => {
      if (ended) return;
      state.aborted = true;
      ended = true;
      channel?.close();
      child.kill("SIGTERM");
      killer = setTimeout(() => child.kill("SIGKILL"), KILL_MS);
      // Never hold Pi open on exit just to finish the kill.
      killer.unref();
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      ended = true;
      channel?.close();
      for (const [id, reply] of answers)
        reply({ id, type: "response", command: "", success: false, error: "Pi exited" });
      answers.clear();
      signal?.removeEventListener("abort", abort);
      clearTimeout(killer);
      clearTimeout(deadline);
      clearTimeout(drain);
      clearTimeout(trailing);
      // Calls still running were cut off. The final record has no current call.
      ledger.close();
      state.work = ledger.snapshot(false);
      resolve(state);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (request.timeoutMs !== undefined) {
      deadline = setTimeout(() => {
        if (ended) return;
        state.timedOut = true;
        abort();
      }, request.timeoutMs);
      deadline.unref();
    }

    // Records are split on LF only; the decoder keeps multibyte characters whole across chunks.
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        handle(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    });
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      state.stderr = (state.stderr + chunk).slice(-STDERR_TAIL);
    });
    // The child may exit before reading its commands.
    stdin.on("error", () => {});
    // As a follow-up, so a run an extension started meanwhile takes it when it is done.
    void command({
      type: "prompt",
      message: task.message,
      ...(task.images.length ? { images: task.images } : {}),
      streamingBehavior: "followUp",
    }).then((response) => {
      if (finished) return;
      if (!response.success) {
        state.errorMessage = response.error;
        end();
      } else if (response.command === "prompt" && response.data.disposition === "handled") end();
    });
    // After the prompt, so a message held until now reaches the run it started.
    channel?.connect(steer);

    child.on("error", (error) => {
      if (child.pid !== undefined) return;
      state.errorMessage = `Could not start pi: ${error.message}`;
      finish();
    });
    // Its output closes once it exits, unless a process it started still holds it: then what
    // is left is read for a moment, and the comrade is done.
    child.on("exit", (code) => {
      state.exitCode = code;
      drain = setTimeout(() => {
        if (buffer) handle(buffer);
        finish();
      }, DRAIN_MS);
      drain.unref();
    });
    child.on("close", (code) => {
      if (buffer) handle(buffer);
      state.exitCode = code;
      finish();
    });
  });
}
