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
import { partialAnswer, type RunDetails, runLine, taskLine } from "./view.ts";

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

const why = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Saves the whole answer beside the comrade's conversation: `comrade-3.answer.md`, then
 * `comrade-3.answer.2.md` for a later run of the same comrade.
 */
function save(answer: string, session: string | undefined, id: number): string {
  // Jobs adopted across a /reload from an older version have no session.
  const dir = session ? dirname(session) : join(tmpdir(), "pi-comrades");
  mkdirSync(dir, { recursive: true });
  for (let run = 1; ; run++) {
    const file = join(dir, `comrade-${id}.answer${run === 1 ? "" : `.${run}`}.md`);
    try {
      writeFileSync(file, answer, { flag: "wx", mode: 0o600 });
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/** The first bytes of a line too long to show whole, cut where a character starts. */
function headOf(line: string, maxBytes: number): string {
  // A character takes at least one byte for each of its UTF-16 units, so these hold enough bytes.
  const bytes = Buffer.from(line.slice(0, maxBytes));
  let end = Math.min(maxBytes, bytes.length);
  // A byte of the form 10xxxxxx carries on a character: the cut goes before that character.
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

/**
 * Truncate like Pi's own tools, keeping the full answer beside the comrade's conversation. Pi
 * keeps nothing of a first line over the byte limit, so the caller gets as much of it as fits.
 * When the whole answer cannot be saved, the caller still gets what fits, and why.
 */
export function limit(
  answer: string,
  session: string | undefined,
  id: number,
): { text: string; file?: string } {
  const cut = truncateHead(answer, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!cut.truncated) return { text: answer };
  const head = cut.firstLineExceedsLimit ? headOf(answer, DEFAULT_MAX_BYTES) : cut.content;
  const shown = cut.firstLineExceedsLimit
    ? `part of line 1 of ${cut.totalLines} (${formatSize(Buffer.byteLength(head))} of ${formatSize(cut.totalBytes)})`
    : `${cut.outputLines} of ${cut.totalLines} lines (${formatSize(cut.outputBytes)} of ${formatSize(cut.totalBytes)})`;
  let file: string;
  try {
    file = save(answer, session, id);
  } catch (error) {
    return {
      text: `${head}\n\n[Answer truncated: ${shown}. The full answer could not be saved: ${why(error)}]`,
    };
  }
  return { text: `${head}\n\n[Answer truncated: ${shown}. Full answer: ${file}]`, file };
}

/** Write the answer where the caller asked, and say so with as much of it as the caller reads. */
function written(answer: string, file: string): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, answer);
  const lines = answer.split("\n").length;
  const size = `${lines} line${lines === 1 ? "" : "s"}, ${formatSize(Buffer.byteLength(answer))}`;
  const head = truncateHead(answer, { maxLines: WRITTEN_HEAD, maxBytes: DEFAULT_MAX_BYTES });
  if (!head.truncated) return `Answer written to ${file} (${size}):\n\n${answer}`;
  if (head.firstLineExceedsLimit)
    return `Answer written to ${file} (${size}). Its first line alone is over ${formatSize(DEFAULT_MAX_BYTES)}, so none of it is shown here.`;
  const shown = `${head.outputLines} line${head.outputLines === 1 ? "" : "s"}`;
  return `Answer written to ${file} (${size}). First ${shown}:\n\n${head.content}`;
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
  details: RunDetails,
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
  // A run that timed out has no answer, so its last text is no file's content.
  const unwritten =
    outcome.timedOut && request.output ? `, so it was not written to ${request.output}` : "";
  const state = outcome.timedOut
    ? `[Comrade timed out after ${limitText} and was stopped. Its last text follows. It is not a final answer${unwritten}.]`
    : partialAnswer(details)
      ? `[Comrade's answer is partial: its last turn ended with stopReason "${outcome.stopReason}"${outcome.stopReason === "length" ? ", the model's output token limit" : ""}. It is not a final answer.]`
      : "";
  let body: string;
  let file: string | undefined;
  let isError = outcome.timedOut;
  if (request.output && !outcome.timedOut)
    try {
      body = written(outcome.text, request.output);
      file = request.output;
    } catch (error) {
      const shown = limit(outcome.text, request.session, id);
      body = `Could not write the answer to ${request.output}: ${why(error)}\n\n${shown.text}`;
      file = shown.file;
      isError = true;
    }
  else ({ text: body, file } = limit(outcome.text, request.session, id));
  return { text: [state, body].filter(Boolean).join("\n\n") + run, isError, file };
}

/** Message text: one header line, then the body. The renderer shows the body under its own header. */
export const message = (id: number, status: Delivery["status"], task: string, body: string) =>
  `[comrade #${id} ${status}] ${taskLine(task).slice(0, 200)}\n\n${body}`;
