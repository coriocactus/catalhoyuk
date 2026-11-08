// Stands in for `pi --mode json`: `node stand-in.ts SCENARIO ...pi-args`, task on stdin.
import { setTimeout as sleep } from "node:timers/promises";

const [named, ...args] = process.argv.slice(2);
let task = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) task += chunk;
// A task starting `#scenario NAME` picks its own, so one fixture can run several kinds.
const scenario = /^#scenario (\w+)/.exec(task)?.[1] ?? named;

const write = (record: object) => process.stdout.write(`${JSON.stringify(record)}\n`);
// Report the model it was asked for, as Pi reports the one it ran.
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const provider = flag("--provider") ?? "stand-in";
const model = flag("--model") ?? "";
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

write({ type: "session", version: 3, id: "stand-in", timestamp: "", cwd: process.cwd() });
switch (scenario) {
  case "echo": {
    start("1", "read", { path: "/tmp/notes.md" });
    end("1", "read");
    write(assistant([{ type: "toolCall", id: "1", name: "read", arguments: {} }], "toolUse"));
    process.stdout.write("not a record\n");
    const answer = { args, task, cwd: process.cwd(), nested: process.env.PI_COMRADE };
    const bytes = Buffer.from(
      `${JSON.stringify(assistant([{ type: "text", text: JSON.stringify(answer) }]))}\n`,
    );
    // Deliver the record in two writes, split inside a multibyte character.
    const split = bytes.indexOf(Buffer.from("✓")) + 1;
    process.stdout.write(bytes.subarray(0, split));
    await sleep(20);
    process.stdout.write(bytes.subarray(split));
    break;
  }
  case "long":
    write(
      assistant([
        { type: "text", text: Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n") },
      ]),
    );
    break;
  case "error":
    write(assistant([], "error", { errorMessage: "529 overloaded" }));
    process.exitCode = 1;
    break;
  case "crash":
    process.stderr.write('Error: Model "anthropic/claude-opus-5-5" not found\n');
    process.exitCode = 1;
    break;
  case "silent":
    break;
  case "busy":
    start("r1", "read", { path: "/tmp/a.ts" });
    end("r1", "read");
    start("r2", "read", { path: "/tmp/b.ts" });
    end("r2", "read");
    start("r3", "read", { path: "/tmp/a.ts" });
    end("r3", "read");
    start("g", "grep", { pattern: "TODO", path: "/tmp" });
    end("g", "grep");
    start("e", "edit", { path: "/tmp/a.ts" });
    end("e", "edit", false, {
      content: [],
      details: { diff: "+ 1 one\n- 2 two\n+ 3 three\n  4 same" },
    });
    start("w", "write", { path: "/tmp/c.md", content: "first\nsecond\n" });
    end("w", "write");
    for (const id of ["t1", "t2"]) {
      start(id, "bash", { command: "npm test\n  --silent" });
      end(id, "bash");
    }
    start("f", "bash", { command: "false" });
    end("f", "bash", true, failed("\nexit code 1\nmore"));
    start("d", "read", { path: "/tmp/d.ts" });
    end("d", "read", true, failed("ENOENT: no such file or directory"));
    start("s", "bash", { command: "sleep 9" });
    write(assistant([{ type: "text", text: "Done." }]));
    break;
  case "hang":
    start("1", "read", { path: "/tmp/forever.md" });
    setInterval(() => {}, 1000);
    break;
  case "length":
    // The model reached its output token limit mid-sentence.
    write(assistant([{ type: "text", text: "The first half of an" }], "length"));
    break;
  case "slow":
    // Some text, then a call that never ends: a timeout finds text to return.
    write(assistant([{ type: "text", text: "Notes so far." }], "toolUse"));
    start("1", "read", { path: "/tmp/forever.md" });
    setInterval(() => {}, 1000);
    break;
}
