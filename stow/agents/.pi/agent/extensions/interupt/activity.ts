// What Pi is doing while it works, from its own events, for the status on the editor box's bottom
// border: waiting on a reply, thinking, writing, writing a call's arguments, or running tools.
// Pi's own indicator says only `Working`. The words are those of comrade's status line.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatTokens } from "../shared/format.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: a model may name a tool with control bytes.
const CONTROLS = /[\x00-\x1f\x7f]+/g;

export interface Activity {
  /** What it is doing, which a status line holds steady: words of the same kind update in place. */
  kind: "waiting" | "thinking" | "writing" | "calling" | "running";
  label: string;
  /** Output tokens the provider has counted so far, for a reply that streams. */
  tokens?: string;
}

/** Follows Pi's events while it works. Undefined while it is not. */
export function trackActivity(pi: ExtensionAPI): () => Activity | undefined {
  let activity: Activity | undefined;
  // The output count the streaming reply first reported: Anthropic reports a token or two as a
  // reply starts and the rest only at its end, so a count shows once it has moved past this one,
  // as comrade's does.
  let first: number | undefined;
  // Tools running now, by call: those Pi runs, not the calls a script makes.
  const running = new Map<string, string>();
  // A model can name a tool anything: one line of its name, cut short, as rows show it.
  const named = (name: string) =>
    Array.from(name.replace(CONTROLS, " ").replace(/\s+/g, " ").trim()).slice(0, 40).join("") ||
    "a tool";
  const tools = (): Activity => {
    const names = [...running.values()];
    return {
      kind: "running",
      label: names.length === 1 ? `Running ${names[0]}` : `Running ${names.length} tools`,
    };
  };

  pi.on("agent_start", () => {
    running.clear();
    activity = { kind: "waiting", label: "Waiting" };
  });
  // A request is out, and nothing has come back yet.
  pi.on("turn_start", () => {
    if (!running.size) activity = { kind: "waiting", label: "Waiting" };
  });
  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") first = undefined;
  });
  pi.on("message_update", (event) => {
    if (event.message.role !== "assistant") return;
    const output = event.message.usage?.output ?? 0;
    // Providers that count as they go report the reply's output; the rest only at its end.
    first ??= output;
    const tokens = output > first ? `${formatTokens(output)} tok` : undefined;
    const update = event.assistantMessageEvent;
    switch (update.type) {
      case "thinking_start":
      case "thinking_delta":
        activity = { kind: "thinking", label: "Thinking", tokens };
        return;
      case "text_start":
      case "text_delta":
        activity = { kind: "writing", label: "Writing", tokens };
        return;
      case "toolcall_start":
      case "toolcall_delta": {
        const part = update.partial.content[update.contentIndex];
        const name = part?.type === "toolCall" && part.name ? named(part.name) : "a tool";
        activity = { kind: "calling", label: `Calling ${name}` };
        return;
      }
      default:
        return;
    }
  });
  pi.on("tool_execution_start", (event) => {
    if (event.parentToolCallId) return;
    running.set(event.toolCallId, named(event.toolName));
    activity = tools();
  });
  pi.on("tool_execution_end", (event) => {
    if (event.parentToolCallId) return;
    running.delete(event.toolCallId);
    activity = running.size ? tools() : { kind: "waiting", label: "Waiting" };
  });
  pi.on("agent_end", () => {
    running.clear();
    activity = undefined;
  });
  pi.on("session_shutdown", () => {
    running.clear();
    activity = undefined;
  });
  return () => activity;
}
