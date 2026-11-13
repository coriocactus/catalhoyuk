// What each run did, as its row shows it: its words, its thinking, what it was told, and its
// calls, as mirage's rows where mirage is loaded. Built as the run's messages arrive, so a row
// drawn again costs nothing until its run has said or done more.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
  NESTED_ROWS_EVENT,
  type NestedRows,
  type NestedRowsRequest,
  type NestedTranscript,
} from "../shared/nested.ts";
import { spinnerFrame } from "../shared/spinner.ts";
import type { Details } from "./details.ts";
import { runMessages } from "./resume.ts";
import { fromSteering } from "./run.ts";
import type { Block, LiveRow, Look } from "./view.ts";
import { callRow } from "./work.ts";

/** Runs kept in memory: the few last drawn. */
const SHOWN_MAX = 40;
/** How long one reading of Pi's thinking setting stands. */
const SETTING_MS = 250;

type Call = { id: string; name: string; arguments: unknown };
type RowsBlock = Extract<Block, { kind: "rows" }>;
type CallBlock = Extract<Block, { kind: "call" }>;

/** A run's blocks, and what building them further needs. */
interface Built {
  // What the blocks depend on besides the messages. A change in any starts them over.
  running: boolean;
  thinking: boolean;
  theme: Theme;
  cwd: string;
  /** The messages read so far. */
  read: number;
  blocks: Block[];
  /** `blocks` as last handed out: a new array each time they change, so a row can tell. */
  view: Block[];
  /** Its first prompt has passed: it is the row's own task, and left out. */
  prompted: boolean;
  /** The group mirage's latest row holds, and the last call in it. */
  group?: RowsBlock;
  last?: Call;
  /** Each call drawn, by id: where it shows, and whether its group counts it as running. */
  calls: Map<string, { call: Call; block: RowsBlock | CallBlock; going: boolean }>;
  results: Map<string, { error: boolean; text: string; details: unknown }>;
}

/** A run's conversation, as it goes or once ended, and mirage's rows for it. */
interface Shown {
  messages: AgentMessage[];
  running: boolean;
  transcript?: NestedTranscript;
  /** The messages given to mirage so far. */
  added: number;
  built?: Built;
}

const textOf = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .flatMap((part) =>
            part?.type === "text" && typeof part.text === "string" ? [part.text] : [],
          )
          .join("\n")
      : "";

export type Transcripts = ReturnType<typeof createTranscripts>;

export function createTranscripts(pi: ExtensionAPI) {
  // Mirage draws a comrade's calls as it draws Pi's own, when it is loaded: see shared/nested.ts.
  // Asked once per session, as rows are drawn: every extension has loaded by then, so no answer
  // (null) means mirage is not loaded, until the next session start or /reload.
  let mirage: NestedRows | null | undefined;
  const rowsService = () => {
    if (mirage === undefined) {
      const request: NestedRowsRequest = {};
      pi.events.emit(NESTED_ROWS_EVENT, request);
      mirage = request.rows ?? null;
    }
    return mirage ?? undefined;
  };

  // Pi's thinking toggle: mirage follows it as it changes. Without mirage, Pi's own setting,
  // which Ctrl+T changes. A row asks on every draw and Pi copies its settings for each answer,
  // so one reading stands for a quarter of a second.
  let setting: { at: number; hidden: boolean } | undefined;
  const settingHidden = () => {
    const now = Date.now();
    if (setting && now - setting.at < SETTING_MS) return setting.hidden;
    let hidden = setting?.hidden ?? false;
    try {
      hidden = pi.getSettings().hideThinkingBlock === true;
    } catch {
      // Pi has not bound its runtime yet, as while it loads: the last reading stands.
    }
    setting = { at: now, hidden };
    return hidden;
  };
  /** Whether Pi shows thinking now, so a row shows the comrade's. */
  const thinkingShown = () => !(rowsService()?.thinkingHidden() ?? settingHidden());

  // By run: a foreground row's tool call, or a background run's id. The few last drawn, as kept
  // in memory; another is read again from its conversation when its row is opened. A run whose
  // conversation is not known is kept too, with no messages, so it is not looked for again.
  const shown = new Map<string, Shown>();
  const keep = (key: string, entry: Shown) => {
    shown.delete(key);
    shown.set(key, entry);
    if (shown.size > SHOWN_MAX) shown.delete(shown.keys().next().value as string);
    return entry;
  };

  /** Follows a run's conversation as its messages arrive. */
  const track = (key: string, messages: AgentMessage[], running: boolean) => {
    const entry = shown.get(key);
    if (entry && entry.messages === messages) entry.running = running;
    else keep(key, { messages, running, added: 0 });
  };

  /** Reads the messages a run's blocks have not taken in yet. */
  const extend = (known: Shown, built: Built) => {
    const { running, thinking, theme, cwd, blocks } = built;
    const rowOf = (call: Call): LiveRow => {
      const result = built.results.get(call.id);
      const status = result
        ? result.error
          ? "error"
          : "success"
        : running
          ? undefined
          : "cancelled";
      return callRow(
        call.name,
        call.arguments,
        cwd,
        status,
        result?.error ? result.text : undefined,
        result?.details,
      );
    };
    for (; built.read < known.messages.length; built.read++) {
      const message = known.messages[built.read];
      if (message.role === "toolResult") {
        built.results.set(message.toolCallId, {
          error: message.isError,
          text: message.isError ? textOf(message.content) : "",
          details: message.details,
        });
        // Its call's row now says how it went, and its group counts one fewer running.
        const drawn = built.calls.get(message.toolCallId);
        if (drawn?.block.kind === "call") drawn.block.row = rowOf(drawn.call);
        else if (drawn?.going) {
          drawn.going = false;
          drawn.block.running--;
        }
        continue;
      }
      if (message.role === "user") {
        const text = fromSteering(textOf(message.content));
        if (built.prompted && text.trim()) blocks.push({ kind: "message", text });
        built.prompted = true;
        continue;
      }
      if (message.role !== "assistant") continue;
      for (const part of message.content) {
        if (part.type === "thinking") {
          if (thinking && part.thinking.trim())
            blocks.push({ kind: "thinking", text: part.thinking, source: part });
        } else if (part.type === "text") {
          if (part.text.trim()) blocks.push({ kind: "text", text: part.text, source: part });
        } else if (part.type === "toolCall") {
          const going = running && !built.results.has(part.id);
          if (known.transcript?.draws(part.name)) {
            const component = known.transcript.row(part.id, theme);
            if (component) {
              // Only the latest group names its last call.
              if (built.group) delete built.group.last;
              built.group = { kind: "rows", component, calls: 1, running: going ? 1 : 0 };
              blocks.push(built.group);
              built.calls.set(part.id, { call: part, block: built.group, going });
            } else if (built.group) {
              // A later call in the group an earlier call's row holds.
              built.group.calls++;
              if (going) built.group.running++;
              built.calls.set(part.id, { call: part, block: built.group, going });
            }
            built.last = part;
            continue;
          }
          const block: CallBlock = { kind: "call", row: rowOf(part) };
          blocks.push(block);
          built.calls.set(part.id, { call: part, block, going: false });
        }
      }
    }
    // The latest group's last call, which a running row names when the group has only it.
    if (built.group && built.last) built.group.last = rowOf(built.last);
    built.view = [...blocks];
  };

  /**
   * What a run did, in order, for its row: its words, its thinking where Pi shows thinking, the
   * messages sent to it, and its calls, mirage's rows for mirage's tools. Its first prompt is the
   * row's own, so it is left out. Nothing for a run whose conversation is not known. The array is
   * the same one until the run has said or done more.
   */
  const blocksFor = (
    key: string,
    source: () => AgentMessage[] | undefined,
    cwd: string,
    theme: Theme,
    running: boolean,
  ): Block[] => {
    const known = keep(key, shown.get(key) ?? { messages: source() ?? [], running, added: 0 });
    known.running = running;
    const service = rowsService();
    if (service && !known.transcript) {
      known.transcript = service.transcript(cwd, () =>
        known.running ? spinnerFrame() : undefined,
      );
      known.added = 0;
      known.built = undefined;
    }
    for (; known.added < known.messages.length; known.added++)
      known.transcript?.add(known.messages[known.added]);
    const thinking = thinkingShown();
    let built = known.built;
    // A run's messages only ever grow. Whether it still runs, whether Pi shows thinking, and the
    // theme and directory its calls are drawn in can change behind them: each starts over.
    if (
      !built ||
      built.running !== running ||
      built.thinking !== thinking ||
      built.theme !== theme ||
      built.cwd !== cwd ||
      built.read > known.messages.length
    )
      built = known.built = {
        running,
        thinking,
        theme,
        cwd,
        read: 0,
        blocks: [],
        view: [],
        prompted: false,
        calls: new Map(),
        results: new Map(),
      };
    if (built.read < known.messages.length) extend(known, built);
    return built.view;
  };

  /**
   * Keeps a row's work in step with its run and with Pi's thinking toggle, which redraws rows
   * without rendering them afresh. A row at work asks on every draw, which costs nothing until
   * its run has done more. One at rest asks once per setting: its run is over, and asking again
   * could read its conversation from its file again.
   */
  const keepCurrent = (look: Look, work: () => Block[] | undefined, atWork: boolean) => {
    let done: boolean | undefined;
    return () => {
      const thinking = thinkingShown();
      if (!atWork && done === thinking) return;
      done = thinking;
      look.thinking = thinking;
      const blocks = work();
      if (blocks) look.blocks = blocks;
      else delete look.blocks;
    };
  };

  /** A run's conversation from its saved file, for a row drawn after the run's process has gone. */
  const savedRun = (details: Partial<Details>) => () =>
    details.session && details.started !== undefined
      ? runMessages(details.session, details.started, details.ended)
      : undefined;

  return {
    track,
    blocksFor,
    keepCurrent,
    savedRun,
    thinkingShown,
    /** Forgets a run, whose row will read it again from its conversation. */
    forget: (key: string) => void shown.delete(key),
    /** A session started: mirage and Pi's setting are asked again. */
    started() {
      mirage = undefined;
      setting = undefined;
    },
    /** The session ended. Mirage's rows belong to its runtime: a reloaded one draws them afresh. */
    ended() {
      shown.clear();
      mirage = undefined;
    },
  };
}
