// The comrade tool as the calling model sees it: its parameters, what running it does, and how a
// message reaches a comrade already at work. Its rows are rows.ts.
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  formatSize,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { reasonOf, respond } from "./answer.ts";
import { type Background, MAX_BACKGROUND } from "./background.ts";
import { conversation, type Numbers, sessionFile } from "./conversation.ts";
import { type Details, emptyProgress, live, type Steer, summary } from "./details.ts";
import {
  cleanTitle,
  modelDescription,
  prepare,
  THINKING,
  type Thinking,
  toolsDescription,
} from "./request.ts";
import { interruption, interruptionNote } from "./resume.ts";
import type { Rows } from "./rows.ts";
import { Channel, type Invocation, type Progress, type Request, run as runComrade } from "./run.ts";
import { dropRuns, elsewhere, follow, launched, quietly, readRuns, saveRun } from "./runs.ts";
import type { Transcripts } from "./transcripts.ts";
import { type Face, taskLine } from "./view.ts";

/**
 * comrade's parameters, whose model description names the models enabled in this session, and
 * whose tools description names the default tools active in it.
 */
const parameters = (models: string, tools: string) =>
  Type.Object({
    title: Type.String({
      description:
        '3-6 words naming the job, like a commit subject, such as "Review parser error paths". ' +
        "The user sees it on the comrade's row. With to, repeat the comrade's title, or give " +
        "another to rename it.",
    }),
    task: Type.String({
      description:
        "Complete, self-contained instructions: every path, constraint, and the answer format " +
        "you need. With to, only your next message to that comrade.",
    }),
    to: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Continue comrade #N's conversation: task is your next message to it. It keeps its brief, " +
          "files, model, thinking, tools, cwd, and what it read and answered. While #N runs, task " +
          "reaches it before its next model request instead, and nothing else may be given.",
      }),
    ),
    model: Type.Optional(Type.String({ description: models })),
    // Pi's StringEnum schema (a plain string enum, which every provider accepts), typed for TypeBox.
    thinking: Type.Optional(
      Type.Unsafe<Thinking>({
        type: "string",
        enum: [...THINKING],
        description: "Default: your thinking level, or the comrade's with to.",
      }),
    ),
    tools: Type.Optional(Type.Array(Type.String(), { description: tools })),
    files: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Files to attach, text or images, as <file name=...> blocks after the task. Paths " +
          "resolve from the working directory.",
      }),
    ),
    output: Type.Optional(
      Type.String({
        description:
          "Write the whole answer to this file and return only its first lines and the path.",
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        description:
          "Directory the comrade runs in. Default: the working directory, or the comrade's with to.",
      }),
    ),
    timeout: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          "Seconds before the comrade is stopped, for a hard stop only: leave it unset for " +
          "open-ended work, which can take hours. The result then says so and gives any text it " +
          "had, and the comrade can be continued with to.",
      }),
    ),
    background: Type.Optional(
      Type.Boolean({
        description:
          "Return at once and deliver the answer later as a [comrade #N …] message. Only when you " +
          "have other work to do before you need it.",
      }),
    ),
  });

export interface ToolDeps {
  pi: ExtensionAPI;
  /** The Pi to run, resolved again for each run. */
  resolve(): Invocation;
  background: Background;
  /** Foreground comrades running now, and what sends them a message. */
  foreground: Map<number, { channel: Channel; title?: string }>;
  /** Foreground comrades whose call has returned: their rows stop spinning. */
  returned: Set<string>;
  numbers: Numbers;
  transcripts: Transcripts;
  rows: Rows;
}

/** Registers the comrade tool, and keeps its description in step with the session. */
export function registerComrade(deps: ToolDeps): void {
  const { pi, background, foreground, returned, numbers, transcripts, rows } = deps;

  /**
   * How a comrade's row names it: its title, then its model and thinking level, and what it may
   * do, each only when not the caller's own, as they are when it is called.
   */
  const faceOf = (
    request: Pick<Request, "provider" | "model" | "thinking">,
    ctx: Pick<ExtensionContext, "model" | "thinkingLevel">,
    title?: string,
  ): Face => {
    const caller = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
    const otherModel = caller !== `${request.provider}/${request.model}`;
    const otherThinking = request.thinking !== (ctx.thinkingLevel ?? pi.getThinkingLevel());
    const chip = otherModel
      ? `${request.model}${otherThinking ? `:${request.thinking}` : ""}`
      : otherThinking
        ? `${request.thinking} thinking`
        : undefined;
    return { ...(title ? { title } : {}), ...(chip ? { chip } : {}) };
  };

  /**
   * A message for comrade #id while it runs. Pi gives it to the comrade once its current tool
   * calls finish, before its next model request, and its answer comes as it would have.
   */
  async function tell(
    id: number,
    params: { task: string } & Partial<Record<string, unknown>>,
    signal?: AbortSignal,
  ) {
    if (!params.task.trim()) throw new Error("comrade needs a task.");
    const given = ["model", "thinking", "tools", "files", "output", "cwd", "timeout"].filter(
      (key) => params[key] !== undefined,
    );
    if (given.length)
      throw new Error(
        `Comrade #${id} is running, so a message to it can carry only task. Wait for its answer to change its ${given.join(", ")}.`,
      );
    const job = background.jobs.get(id);
    const channel = foreground.get(id)?.channel ?? job?.channel;
    const title = foreground.get(id)?.title ?? job?.request.face?.title;
    if (!channel)
      throw new Error(
        `Comrade #${id} cannot take messages while it runs: it started before comrades could. Wait for its answer.`,
      );
    if (!channel.open)
      throw new Error(
        `Comrade #${id} has just finished, so your message did not reach it. Its answer is on its way: continue it with to: ${id} once it arrives.`,
      );
    // Esc ends the wait, not the message: it may still reach the comrade.
    const stopped = new Promise<"stopped">((wake) => {
      if (signal?.aborted) wake("stopped");
      signal?.addEventListener("abort", () => wake("stopped"), { once: true });
    });
    let outcome: "stopped" | undefined;
    try {
      outcome = await Promise.race([channel.steer(params.task).then(() => undefined), stopped]);
    } catch (error) {
      throw new Error(
        `Comrade #${id} did not take your message: ${error instanceof Error ? error.message : error}.`,
      );
    }
    if (outcome === "stopped")
      throw new Error(
        `Stopped waiting for comrade #${id} to take your message. It may still reach it.`,
      );
    const arrives = job
      ? `Its answer will arrive as a [comrade #${id} …] message, as before.`
      : "Its answer returns from the call that started it.";
    const details: Steer = { id, steered: true, ...(title ? { title } : {}) };
    return {
      content: [
        {
          type: "text" as const,
          text: `Sent to comrade #${id}. It reads your message once its current tool calls finish, before its next model request. ${arrives}`,
        },
      ],
      details,
    };
  }

  let models = modelDescription();
  let tools = toolsDescription();
  const tool = defineTool({
    name: "comrade",
    label: "Comrade",
    description:
      "Run a task in a fresh pi process and return its final answer. The comrade sees nothing " +
      "of this conversation. Several calls in one message run in parallel. Every comrade is " +
      "numbered #N and keeps its conversation: continue it with to: N, or while it runs, send it " +
      "a message the same way. " +
      `Answers over ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} are truncated ` +
      "and saved in full to a file. Every result ends with a run line: #N, model, turns, calls, " +
      "tokens, cost, duration, and why it stopped.",
    promptSnippet:
      "Delegate a self-contained task to a fresh pi agent and get its answer, or continue one",
    promptGuidelines: [
      "A comrade sees none of this conversation: put every path, constraint, and the expected answer format in its task.",
      "To follow up with a comrade (a correction, a question, the next step), call comrade with to: N and only your new message. While it runs, the message reaches it before its next model request, so a running comrade can be redirected rather than waited for. Start a new comrade for unrelated work, or once the conversation has grown long: each follow-up resends all of it.",
      "Leave background off unless you have other work to do before you need the answer; foreground calls in one message already run in parallel. A background answer arrives later as a [comrade #N …] message: never guess it. When your other work is done, end your reply, and your turn waits for it.",
      'comrade is read-only by default. Add "edit" and "write" when it must change files, or "bash" to run commands.',
      "When a comrade needs more than a few files, pass them in files with tools: []. When its answer feeds a file or a build, set output and ask for the exact text, with no fences or commentary.",
      "A result whose first line starts [Comrade's answer is cut off or [Comrade timed out is not a finished answer.",
    ],
    parameters: parameters(models, tools),
    // Flat, as mirage draws its rows: no box behind it.
    renderShell: "self",
    renderCall: rows.renderCall,
    renderResult: rows.renderResult,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const to = params.to;
      if (to !== undefined && (foreground.has(to) || background.jobs.has(to)))
        return tell(to, params, signal);
      const previous = to === undefined ? undefined : conversation(to, ctx);
      // A new comrade is named by its caller; one continued keeps its name unless given another.
      const title = cleanTitle(params.title) ?? previous?.title;
      const prepared = prepare(params, ctx, pi, previous);
      if (previous) {
        const runs = readRuns(previous.session);
        const busy = runs.find(elsewhere);
        if (busy)
          throw new Error(
            `Comrade #${to} is running in another Pi (process ${busy.owner}). Wait for its answer there, or start a new comrade.`,
          );
        // Runs of it cut off and never carried on end here: this run continues its conversation.
        const stale = runs.filter((saved) => saved.phase !== "done");
        if (stale.length)
          quietly(() => dropRuns(previous.session, new Set(stale.map((saved) => saved.run))));
      }
      // A comrade whose last run was cut off first reads which calls may or may not have run.
      const cut = previous ? interruption(previous.session) : undefined;
      if (cut) prepared.task = `${interruptionNote(cut)}\n\n${prepared.task}`;
      // Print and JSON modes exit when the agent settles, before a later message could arrive.
      const detached = ctx.mode === "tui" || ctx.mode === "rpc";
      const inBackground = Boolean(params.background && detached);
      if (inBackground && background.jobs.size >= MAX_BACKGROUND)
        throw new Error(
          `${MAX_BACKGROUND} background comrades are already running. Wait for one to finish, or stop one with the comrades tool.`,
        );
      const id = to ?? numbers.reserve(ctx);
      const request: Request = {
        ...prepared,
        session: previous?.session ?? sessionFile(ctx, id),
        ...(previous ? { followUp: true } : {}),
        face: faceOf(prepared, ctx, title),
      };
      if (inBackground) {
        const job = background.start(request, id, toolCallId, toolCallId, taskLine(params.task));
        return {
          content: [
            {
              type: "text",
              text: `Comrade #${job.id} started in the background. Keep working. Its answer will arrive as a [comrade #${job.id} …] message${ctx.mode === "tui" ? ", and if you finish first, your turn waits for it" : ""}. Check on it or stop it with the comrades tool.`,
            },
          ],
          details: {
            ...summary(request, job.progress),
            id: job.id,
            task: job.task,
            background: true,
            started: job.started,
          },
        };
      }

      const began = Date.now();
      // Its record says this Pi runs it, so no other Pi continues it meanwhile. Its result is in
      // the session once the call returns, so the record goes then.
      quietly(() => saveRun(request.session, launched(request, toolCallId, false, began)));
      const watch = follow(request.session, toolCallId);
      const update = (progress: Progress) => {
        watch(progress);
        transcripts.track(toolCallId, progress.messages, true);
        onUpdate?.({
          content: [{ type: "text", text: progress.text }],
          details: { ...live(request, progress, began), id },
        });
      };
      const channel = new Channel();
      foreground.set(id, { channel, title: request.face?.title });
      // Show the row, and the model it will use, before the comrade has started.
      update(emptyProgress());
      const outcome = await runComrade(deps.resolve(), request, signal, update, channel).finally(
        () => {
          foreground.delete(id);
          returned.add(toolCallId);
          quietly(() => dropRuns(request.session, new Set([toolCallId])));
        },
      );
      transcripts.track(toolCallId, outcome.messages, false);
      const details: Details = {
        ...summary(request, outcome),
        started: began,
        ended: Date.now(),
        id,
        stopReason: outcome.stopReason,
        exitCode: outcome.exitCode,
        ...(outcome.aborted && !outcome.timedOut ? { stopped: true } : {}),
        ...(outcome.timedOut ? { timedOut: true } : {}),
      };
      const reason = reasonOf(outcome, request);
      if (reason) details.reason = reason;
      const reply = respond(request, outcome, details, Date.now() - began, id);
      if (reply.isError)
        return {
          content: [{ type: "text", text: reply.text }],
          details: { ...details, answer: reply.file },
          usage: outcome.usage,
          isError: true,
        };
      const note = params.background
        ? "(Ran in the foreground: background comrades need an interactive session.)\n\n"
        : "";
      return {
        content: [{ type: "text", text: note + reply.text }],
        details: { ...details, answer: reply.file },
        usage: outcome.usage,
      };
    },
  });
  pi.registerTool(tool);
  // Name the enabled models and the default tools once the session is known, and again whenever
  // /scoped-models or the active tools change them. Only a change re-registers, so the declared
  // tools stay byte-identical.
  const describe = (_event: unknown, ctx: ExtensionContext) => {
    const nextModels = modelDescription(ctx);
    const nextTools = toolsDescription(pi.getActiveTools());
    if (nextModels === models && nextTools === tools) return;
    models = nextModels;
    tools = nextTools;
    pi.registerTool({ ...tool, parameters: parameters(models, tools) });
  };
  pi.on("session_start", describe);
  pi.on("before_agent_start", describe);
}
