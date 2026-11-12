// Stands in for `pi --mode rpc`: `node stand-in.ts SCENARIO ...pi-args`, commands on stdin, one
// JSON record per line, as Pi's RPC mode reads them. The first prompt runs the scenario; a later
// one is answered with what reached it. Closing stdin ends it, as it shuts Pi down. Like Pi, it
// saves each message to its session file as the message ends, and SIGTERM aborts the calls
// running and the reply it would request next.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const [named, ...args] = process.argv.slice(2);
// Report the model it was asked for, as Pi reports the one it ran.
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const provider = flag("--provider") ?? "stand-in";
const model = flag("--model") ?? "";
const session = flag("--session");

/** The session file's entries, as Pi writes them: a header, then messages in a chain. */
const entries = (): {
  type?: string;
  id?: string;
  message?: { role?: string; content?: unknown };
}[] =>
  session && existsSync(session)
    ? readFileSync(session, "utf8")
        .split("\n")
        .flatMap((line) => {
          try {
            return line.trim() ? [JSON.parse(line)] : [];
          } catch {
            return [];
          }
        })
    : [];
let parent: string | null = entries().findLast((entry) => entry.id)?.id ?? null;
let saved = 0;
const save = (message: object) => {
  if (!session) return;
  mkdirSync(dirname(session), { recursive: true });
  if (!existsSync(session) || !readFileSync(session, "utf8"))
    appendFileSync(
      session,
      `${JSON.stringify({ type: "session", version: 3, id: "stand-in", cwd: process.cwd() })}\n`,
    );
  const id = `${process.pid}-${++saved}`;
  const entry = {
    type: "message",
    id,
    parentId: parent,
    timestamp: new Date().toISOString(),
    message,
  };
  appendFileSync(session, `${JSON.stringify(entry)}\n`);
  parent = id;
};
/** Calls started and not ended, which SIGTERM aborts. */
const running = new Map<string, string>();
const write = (record: Record<string, unknown>) => {
  if (record.type === "message_end") save({ ...(record.message as object), timestamp: Date.now() });
  if (record.type === "tool_execution_start")
    running.set(record.toolCallId as string, record.toolName as string);
  process.stdout.write(`${JSON.stringify(record)}\n`);
  // Then, as Pi does, the call's result as a message of its own.
  if (record.type === "tool_execution_end") {
    running.delete(record.toolCallId as string);
    const message = {
      role: "toolResult",
      toolCallId: record.toolCallId,
      toolName: record.toolName,
      isError: record.isError,
      content: (record.result as { content?: unknown }).content ?? [],
      details: (record.result as { details?: unknown }).details,
      timestamp: Date.now(),
    };
    write({ type: "message_start", message });
    write({ type: "message_end", message });
  }
};
process.on("SIGTERM", () => {
  for (const [id, name] of running)
    save({
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      isError: true,
      content: [{ type: "text", text: "Operation aborted" }],
      timestamp: Date.now(),
    });
  save({ role: "assistant", content: [], stopReason: "aborted", timestamp: Date.now() });
  process.exit(143);
});

// Pi fails at startup, before reading any command.
if (named === "crash") {
  process.stderr.write('Error: Model "anthropic/claude-opus-5-5" not found\n');
  process.exit(1);
}

/** Messages queued while a run goes, which a scenario may take; Pi takes the rest before it settles. */
const steering: string[] = [];
const dialogs = new Map<string, (answer: object) => void>();
let prompts = 0;
/** A run is going. */
let active = false;
/** The first prompt's scenario. */
let first = "";
/** `late`: a message has arrived, and its answer waits until the run has settled. */
let arrived = false;

/** The text of a user message. */
const said_ = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.flatMap((part) => (part?.type === "text" ? [part.text] : [])).join("\n")
      : "";
/** Like Pi, keep the conversation in the session file: the earlier tasks and messages, then this. */
function remember(message: string): string[] {
  const history = entries().flatMap((entry) =>
    entry.type === "message" && entry.message?.role === "user"
      ? [said_(entry.message.content)]
      : [],
  );
  heard(message);
  return history;
}

const assistant = (content: object[], stopReason = "stop", extra: object = {}) => ({
  type: "message_end",
  message: {
    role: "assistant",
    content,
    api: "stand-in",
    provider,
    model,
    usage: {
      input: 100,
      output: 10,
      cacheRead: 50,
      cacheWrite: 0,
      totalTokens: 160,
      cost: { input: 0.01, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.011 },
    },
    stopReason,
    timestamp: 0,
    ...extra,
  },
});
const start = (id: string, toolName: string, args: object) =>
  write({ type: "tool_execution_start", toolCallId: id, toolName, args });
const end = (id: string, toolName: string, isError = false, result: object = { content: [] }) =>
  write({ type: "tool_execution_end", toolCallId: id, toolName, isError, result });
const failed = (message: string) => ({ content: [{ type: "text", text: message }] });
/** Pi takes what is still queued before the run settles. */
const settled = () => {
  if (steering.length) {
    const message = steering.splice(0).join("\n");
    heard(message);
    said(`Heard late: ${message}`);
  }
  active = false;
  write({ type: "agent_settled", aborted: false });
};
const said = (text: string) => write(assistant([{ type: "text", text }]));
/** A reply asking for calls, which Pi then runs. */
const asks = (calls: [string, string, object][]) =>
  write(
    assistant(
      calls.map(([id, name, args]) => ({ type: "toolCall", id, name, arguments: args })),
      "toolUse",
    ),
  );
/** A user message Pi delivers into the run, as it does a steering message. */
const heard = (text: string) => {
  const message = { role: "user", content: [{ type: "text", text }], timestamp: 0 };
  write({ type: "message_start", message });
  write({ type: "message_end", message });
};
const until = async (ready: () => boolean) => {
  while (!ready()) await sleep(10);
};

interface Prompt {
  message: string;
  images?: { mimeType: string }[];
}

/** What reached it, as the echo scenario answers. */
const echo = (prompt: Prompt, history: string[]) => ({
  args,
  task: prompt.message,
  images: (prompt.images ?? []).map((image) => image.mimeType),
  history,
  cwd: process.cwd(),
  nested: process.env.PI_COMRADE,
});

async function scenario(name: string, prompt: Prompt, history: string[]) {
  switch (name) {
    case "echo": {
      write(
        assistant(
          [{ type: "toolCall", id: "1", name: "read", arguments: { path: "/tmp/notes.md" } }],
          "toolUse",
        ),
      );
      start("1", "read", { path: "/tmp/notes.md" });
      end("1", "read");
      process.stdout.write("not a record\n");
      const answer = assistant([{ type: "text", text: JSON.stringify(echo(prompt, history)) }]);
      save({ ...answer.message, timestamp: Date.now() });
      const bytes = Buffer.from(`${JSON.stringify(answer)}\n`);
      // Deliver the record in two writes, split inside a multibyte character.
      const split = bytes.indexOf(Buffer.from("✓")) + 1;
      process.stdout.write(bytes.subarray(0, split));
      await sleep(20);
      process.stdout.write(bytes.subarray(split));
      return settled();
    }
    case "long":
      said(Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n"));
      return settled();
    case "error":
      write(assistant([], "error", { errorMessage: "529 overloaded" }));
      return settled();
    case "silent":
      return settled();
    case "busy": {
      // One reply asking for many calls, as Pi runs them; the last never ends.
      const calls: [string, string, object][] = [
        ["r1", "read", { path: "/tmp/a.ts" }],
        ["r2", "read", { path: "/tmp/b.ts" }],
        ["r3", "read", { path: "/tmp/a.ts" }],
        ["g", "grep", { pattern: "TODO", path: "/tmp" }],
        ["e", "edit", { path: "/tmp/a.ts" }],
        ["w", "write", { path: "/tmp/c.md", content: "first\nsecond\n" }],
        ["t1", "bash", { command: "npm test\n  --silent" }],
        ["t2", "bash", { command: "npm test\n  --silent" }],
        ["f", "bash", { command: "false" }],
        ["d", "read", { path: "/tmp/d.ts" }],
        ["s", "bash", { command: "sleep 9" }],
      ];
      asks(calls);
      const results: Record<string, [boolean, object]> = {
        e: [false, { content: [], details: { diff: "+ 1 one\n- 2 two\n+ 3 three\n  4 same" } }],
        f: [true, failed("\nexit code 1\nmore")],
        d: [true, failed("ENOENT: no such file or directory")],
      };
      for (const [id, name, args] of calls) {
        start(id, name, args);
        if (id !== "s") end(id, name, ...(results[id] ?? [false]));
      }
      said("Done.");
      return settled();
    }
    case "work": {
      // A comrade at work as Pi runs it: thinking, words, a read, then two commands.
      write(
        assistant(
          [
            { type: "thinking", thinking: "The notes come first." },
            { type: "text", text: "Reading the notes." },
            { type: "toolCall", id: "r", name: "read", arguments: { path: "/tmp/notes.md" } },
          ],
          "toolUse",
        ),
      );
      start("r", "read", { path: "/tmp/notes.md" });
      end("r", "read", false, { content: [{ type: "text", text: "notes" }] });
      const listing = { command: "cd /tmp &&\n  ls -la" };
      asks([
        ["b1", "bash", listing],
        ["b2", "bash", { command: "false" }],
      ]);
      start("b1", "bash", listing);
      end("b1", "bash", false, { content: [{ type: "text", text: "total 0" }] });
      start("b2", "bash", { command: "false" });
      end("b2", "bash", true, failed("Command exited with code 1"));
      said("All good: the notes read cleanly.");
      return settled();
    }
    case "thinks": {
      // Thinking streams a complete sentence, then the reply follows: the running row may say it.
      write({ type: "turn_start" });
      write({ type: "message_start", message: { role: "assistant", content: [] } });
      const update = (type: string, extra: object = {}) =>
        write({
          type: "message_update",
          assistantMessageEvent: { type, contentIndex: 0, ...extra },
        });
      update("thinking_start");
      update("thinking_delta", { delta: "The plan is a secret. Then" });
      await sleep(400);
      write(
        assistant([
          { type: "thinking", thinking: "The plan is a secret. Then the reply." },
          { type: "text", text: "Done." },
        ]),
      );
      return settled();
    }
    case "hang": {
      // A reply asking for a read that never ends, as Pi runs it: the turn, the reply, the call.
      const args = { path: "/tmp/forever.md" };
      write({ type: "turn_start" });
      write(assistant([{ type: "toolCall", id: "h1", name: "read", arguments: args }], "toolUse"));
      start("h1", "read", args);
      return new Promise(() => {});
    }
    case "length":
      // The model reached its output token limit mid-sentence.
      write(assistant([{ type: "text", text: "The first half of an" }], "length"));
      return settled();
    case "stream": {
      // A turn as Pi streams it: retries, a compaction, thinking, tool calls, then the reply.
      // Pauses longer than the 250ms report interval let throttled text through.
      // `usage` is the streaming message's cumulative usage, as Pi's RPC mode carries it.
      const update = (type: string, extra: object = {}, usage?: object) =>
        write({
          type: "message_update",
          ...(usage ? { usage } : {}),
          assistantMessageEvent: { type, contentIndex: 0, ...extra },
        });
      const counted = (output: number) => ({ input: 100, output, cacheRead: 0, cacheWrite: 0 });
      write({ type: "turn_start" });
      write({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 10,
        errorMessage: "529 overloaded\nmore",
      });
      write({ type: "auto_retry_end", success: true, attempt: 2 });
      // A retry Pi reports without its attempt or error.
      write({ type: "auto_retry_start" });
      write({ type: "auto_retry_end", success: true });
      write({ type: "compaction_start", reason: "overflow" });
      write({ type: "compaction_end", reason: "overflow", aborted: false, willRetry: true });
      // Like Anthropic: the input is counted at the start, the output only at the end.
      write({
        type: "message_start",
        message: { role: "assistant", content: [], usage: { input: 1000, output: 1 } },
      });
      update("thinking_start");
      for (let i = 0; i < 20; i++) update("thinking_delta", { delta: "x".repeat(400) });
      await sleep(600);
      update("toolcall_start", { id: "1", toolName: "read" });
      update("toolcall_delta", { delta: "x".repeat(400) });
      await sleep(600);
      // A second call to the same tool starts its count over.
      update("toolcall_start", { id: "2", toolName: "read" });
      update("toolcall_delta", { delta: "{}" });
      asks([["1", "read", { path: "/tmp/a.ts" }]]);
      start("1", "read", { path: "/tmp/a.ts" });
      end("1", "read");
      write({ type: "turn_start" });
      // Like Google: the provider counts as it goes, so once its count has moved it is shown.
      update("text_start");
      update("text_delta", { delta: "Do" }, counted(2));
      await sleep(400);
      update("text_delta", { delta: "ne." }, counted(4));
      await sleep(400);
      said("Done.");
      return settled();
    }
    case "unfinished":
      // Text streams, then Pi exits before the message ends: no report may follow the result.
      write({ type: "turn_start" });
      write({ type: "message_update", assistantMessageEvent: { type: "thinking_start" } });
      for (let i = 0; i < 3; i++)
        write({
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", delta: "x" },
        });
      process.exit(0);
      return;
    case "slow":
      // Some text, then a call that never ends: a timeout finds text to return.
      write(
        assistant(
          [
            { type: "text", text: "Notes so far." },
            { type: "toolCall", id: "1", name: "read", arguments: { path: "/tmp/forever.md" } },
          ],
          "toolUse",
        ),
      );
      start("1", "read", { path: "/tmp/forever.md" });
      return new Promise(() => {});
    case "steer": {
      // A long call, during which a message arrives: Pi delivers it once the call ends.
      asks([["1", "read", { path: "/tmp/long.md" }]]);
      start("1", "read", { path: "/tmp/long.md" });
      await until(() => steering.length > 0);
      end("1", "read");
      const message = steering.splice(0).join("\n");
      heard(message);
      said(`Heard: ${message}`);
      return settled();
    }
    case "deaf":
      // A message arrives after the comrade's last check: still in Pi's queue once it settles.
      await until(() => steering.length > 0);
      said("Done before reading it.");
      return settled();
    case "late":
      // It settles while a message to it is on its way: Pi starts a run with the message.
      await until(() => arrived);
      said("Done.");
      return settled();
    case "ignored":
      // An extension takes every message sent to it; it runs on until stopped.
      start("1", "read", { path: "/tmp/forever.md" });
      return new Promise(() => {});
    case "slowexit":
      said("All done.");
      return settled();
    case "unstarted":
      // The run fails before it starts: Pi reports no agent_start, only the failure.
      write(assistant([], "error", { errorMessage: "No model selected" }));
      return settled();
    case "dialog": {
      // An extension asks the user, and waits for the answer.
      const answer = await new Promise<object>((reply) => {
        dialogs.set("ask-1", reply);
        write({
          type: "extension_ui_request",
          id: "ask-1",
          method: "confirm",
          title: "Allow?",
          message: "Run it?",
        });
        // Fire and forget: no answer expected.
        write({ type: "extension_ui_request", id: "note-1", method: "notify", message: "hi" });
      });
      said(JSON.stringify(answer));
      return settled();
    }
  }
}

async function handle(command: Record<string, unknown>) {
  const id = command.id as string | undefined;
  switch (command.type) {
    case "prompt": {
      const prompt = command as unknown as Prompt & { streamingBehavior?: string };
      const respond = (disposition: string) =>
        write({ id, type: "response", command: "prompt", success: true, data: { disposition } });
      if (first === "late" && prompts > 0 && !arrived) {
        // Answered once the run it reached has settled: then it starts a run of its own.
        arrived = true;
        await until(() => !active);
      }
      // During a run, a message with streamingBehavior is queued into it.
      if (active && prompt.streamingBehavior) {
        if (first === "ignored") return respond("handled");
        steering.push(prompt.message);
        return respond("queued");
      }
      // A message starting `#scenario NAME` picks its own, so one fixture can run several kinds.
      const name =
        prompts++ === 0 ? (/^#scenario (\w+)/.exec(prompt.message)?.[1] ?? named) : "again";
      if (!first) first = name;
      if (name === "rejected")
        return write({
          id,
          type: "response",
          command: "prompt",
          success: false,
          error: "No API key found for anthropic",
        });
      respond(name === "handled" ? "handled" : "started");
      if (name === "handled") return;
      active = true;
      // Pi starts a run for the prompt, and saves the prompt as it starts.
      if (name !== "unstarted") write({ type: "agent_start" });
      const history = remember(prompt.message);
      // A later prompt: what reached it, as a final answer.
      if (name === "again") {
        said(JSON.stringify(echo(prompt, history)));
        return settled();
      }
      return scenario(name, prompt, history);
    }
    case "extension_ui_response":
      dialogs.get(id ?? "")?.(command);
      return;
    default:
      return write({ id, type: "response", command: command.type, success: false, error: "?" });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    void handle(JSON.parse(line));
  }
});
// Closing stdin shuts Pi down: at once, or for `slowexit`, after a while.
process.stdin.on("end", () => {
  if (first === "slowexit") setTimeout(() => process.exit(), 1500);
  else process.exit();
});
