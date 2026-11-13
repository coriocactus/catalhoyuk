// What the caller reads of a run: its answer, cut to what a tool result may hold or written
// where the caller asked, and what is said instead when the run did not finish.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { formatDuration } from "../shared/format.ts";
import type { Delivery } from "./details.ts";
import type { Outcome, Request } from "./run.ts";
import { type Card, cutOff, runLine, taskLine } from "./view.ts";

/** Lines of an answer written to output that the calling model still reads. */
const WRITTEN_HEAD = 20;

/** Why a run did not succeed, for its row: its first line always shows. Stopped, nothing. */
export function reasonOf(outcome: Outcome, request: Request): string | undefined {
  if (outcome.aborted && !outcome.timedOut) return undefined;
  if (outcome.timedOut)
    return `Stopped at its ${formatDuration(request.timeoutMs ?? 0)} limit. ${outcome.text ? "Its last text is kept." : "It had said nothing yet."}`;
  return failure(outcome)?.replace(/^Comrade failed: /, "");
}

function failure(outcome: Outcome): string | undefined {
  if (outcome.stopReason === "error" || outcome.stopReason === "aborted")
    return `Comrade failed: ${outcome.errorMessage ?? outcome.stopReason}`;
  if (outcome.exitCode !== 0) {
    const stderr = outcome.stderr.trim().split("\n").slice(-20).join("\n");
    const reason = outcome.errorMessage ?? `pi exited with code ${outcome.exitCode}`;
    return stderr ? `${reason}\n${stderr}` : reason;
  }
  // Pi refused the task before any run, as for a provider without credentials.
  if (!outcome.text)
    return outcome.errorMessage
      ? `Comrade failed: ${outcome.errorMessage}`
      : "Comrade finished without an answer.";
}

/**
 * Truncate like Pi's own tools, keeping the full answer beside the comrade's conversation:
 * `comrade-3.answer.md`, then `comrade-3.answer.2.md` for a later run of the same comrade.
 */
export function limit(
  answer: string,
  session: string | undefined,
  id: number,
): { text: string; file?: string } {
  const cut = truncateHead(answer, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!cut.truncated) return { text: answer };
  // Jobs adopted across a /reload from an older version have no session.
  const dir = session ? dirname(session) : join(tmpdir(), "pi-comrades");
  mkdirSync(dir, { recursive: true });
  let file: string;
  for (let run = 1; ; run++) {
    file = join(dir, `comrade-${id}.answer${run === 1 ? "" : `.${run}`}.md`);
    try {
      writeFileSync(file, answer, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  const shown = `${cut.outputLines} of ${cut.totalLines} lines (${formatSize(cut.outputBytes)} of ${formatSize(cut.totalBytes)})`;
  return { text: `${cut.content}\n\n[Answer truncated: ${shown}. Full answer: ${file}]`, file };
}

/** Write the answer where the caller asked, and say so with its first lines. */
function written(answer: string, file: string): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, answer);
  const lines = answer.split("\n").length;
  const size = `${lines} line${lines === 1 ? "" : "s"}, ${formatSize(Buffer.byteLength(answer))}`;
  if (lines <= WRITTEN_HEAD) return `Answer written to ${file} (${size}):\n\n${answer}`;
  const head = truncateHead(answer, { maxLines: WRITTEN_HEAD, maxBytes: DEFAULT_MAX_BYTES });
  return `Answer written to ${file} (${size}). First ${head.outputLines} lines:\n\n${head.content}`;
}

export interface Reply {
  text: string;
  isError: boolean;
  /** The file holding the whole answer. */
  file?: string;
}

/**
 * What the calling model reads. It never sees the row, so an answer that is not final says so
 * on its first line, and a run line ends every result of a comrade that ran.
 */
export function respond(
  request: Request,
  outcome: Outcome,
  details: Card,
  durationMs: number,
  id: number,
): Reply {
  if (outcome.aborted && !outcome.timedOut)
    return { text: `Comrade #${id} stopped.`, isError: true };
  // Even a comrade that failed at once ends with its run line, which carries its number.
  const run = `\n\n${runLine(details, durationMs, id)}`;
  const limitText = formatDuration(request.timeoutMs ?? 0);
  if (outcome.timedOut && !outcome.text)
    return { text: `Comrade timed out after ${limitText} and was stopped.${run}`, isError: true };
  const failed = outcome.timedOut ? undefined : failure(outcome);
  if (failed !== undefined) return { text: failed + run, isError: true };
  const state = outcome.timedOut
    ? `[Comrade timed out after ${limitText} and was stopped. Its last text follows. It is not a final answer.]`
    : cutOff(details)
      ? `[Comrade's answer is cut off: its last turn ended with stopReason "${outcome.stopReason}"${outcome.stopReason === "length" ? ", the model's output token limit" : ""}. It is not a final answer.]`
      : "";
  let body: string;
  let file: string | undefined;
  let isError = outcome.timedOut;
  if (request.output)
    try {
      body = written(outcome.text, request.output);
      file = request.output;
    } catch (error) {
      const shown = limit(outcome.text, request.session, id);
      body = `Could not write the answer to ${request.output}: ${error instanceof Error ? error.message : error}\n\n${shown.text}`;
      file = shown.file;
      isError = true;
    }
  else ({ text: body, file } = limit(outcome.text, request.session, id));
  return { text: [state, body].filter(Boolean).join("\n\n") + run, isError, file };
}

/** Message text: one header line, then the body. The renderer shows the body under its own card. */
export const message = (id: number, status: Delivery["status"], task: string, body: string) =>
  `[comrade #${id} ${status}] ${taskLine(task).slice(0, 200)}\n\n${body}`;
