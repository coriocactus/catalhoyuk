import type { NestedToolCallRecord } from "@earendil-works/pi-ai";
import {
  type AgentToolResult,
  type CodemodeToolDetails,
  generateDiffString,
} from "@earendil-works/pi-coding-agent";

// Codemode scripts call other tools through ctx.executeTool(). Pi lists the calls in the script
// result's `details.calls` and saves their arguments and status as `nestedCalls` on the script's
// tool result message. Only the script receives their outputs, so the outputs exist only in live
// tool_execution_* events. This module reads both shapes defensively, and an unknown shape
// yields no calls.

export type CallStatus = "running" | "success" | "error" | "cancelled";
type DetailCall = CodemodeToolDetails["calls"][number];

/** One entry of a script result's `details.calls`. */
export interface ScriptCall {
  id: string;
  name: string;
  /** Compact, possibly truncated JSON of the arguments, or a model reference. */
  preview: string;
  status: CallStatus;
  error?: string;
  cost?: number;
}

/**
 * One call in a script result's `nestedCalls`. Pi saves its arguments and status, not its
 * output.
 */
export interface SavedCall {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  /** Size in bytes of arguments Pi did not keep. */
  omittedBytes?: number;
  status: CallStatus;
  error?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const DETAIL_STATUS: Record<DetailCall["status"], CallStatus> = {
  running: "running",
  ok: "success",
  error: "error",
  cancelled: "cancelled",
};
const SAVED_STATUS: Record<NestedToolCallRecord["status"], CallStatus> = {
  ok: "success",
  error: "error",
  // The script ended while the call was running, so the call never reported back.
  unfinished: "cancelled",
};

/**
 * Whether a call is a `models.classify()` or `models.generateImages()` call, which is not a
 * tool call.
 */
export function isModelCall(name: string): boolean {
  return name.startsWith("models.");
}

/**
 * Whether `details.calls` shows a tool call that is still running. Its id is the placeholder
 * `<script id>/?`.
 */
export function isPlaceholder(id: string): boolean {
  return id.endsWith("/?");
}

export function scriptCalls(details: unknown): ScriptCall[] {
  if (!isRecord(details) || !Array.isArray(details.calls)) return [];
  return details.calls.flatMap((value: unknown) => {
    if (!isRecord(value)) return [];
    const call = value as Partial<Record<keyof DetailCall, unknown>>;
    const id = asString(call.id),
      name = asString(call.name),
      status = DETAIL_STATUS[asString(call.status) as DetailCall["status"]];
    if (!id || !name || !status) return [];
    return [
      {
        id,
        name,
        preview: asString(call.args) ?? "",
        status,
        error: asString(call.error),
        cost: typeof call.cost === "number" && Number.isFinite(call.cost) ? call.cost : undefined,
      },
    ];
  });
}

export function savedCalls(record: unknown): SavedCall[] {
  if (!isRecord(record) || !Array.isArray(record.calls)) return [];
  return record.calls.flatMap((value: unknown) => {
    if (!isRecord(value)) return [];
    const call = value as Partial<Record<keyof NestedToolCallRecord, unknown>>;
    const id = asString(call.id),
      name = asString(call.name),
      status = SAVED_STATUS[asString(call.status) as NestedToolCallRecord["status"]];
    if (!id || !name || !status) return [];
    return [
      {
        id,
        name,
        args: isRecord(call.arguments) ? call.arguments : undefined,
        omittedBytes: typeof call.argumentsBytes === "number" ? call.argumentsBytes : undefined,
        status,
        error: asString(call.error),
      },
    ];
  });
}

/** `details.calls` previews arguments as JSON, which Pi truncates when long. */
export function previewArgs(preview: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(preview);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

// Pi's own renderer drops the same header, the script's status and wall time.
const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

export function scriptOutput(result: AgentToolResult<unknown> | undefined): string {
  const parts = result?.content ?? [];
  const first = parts[0];
  const body = first?.type === "text" && SCRIPT_HEADER.test(first.text) ? parts.slice(1) : parts;
  return body
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
}

/**
 * Saved edits keep their arguments but not Pi's diff. Rebuild the same numbered format from
 * each replacement, so totals survive reloads. Line numbers are relative to the replaced text.
 */
export function rebuiltDiff(args: Readonly<Record<string, unknown>>): string {
  const edits = Array.isArray(args.edits) ? args.edits : [args];
  return edits
    .flatMap((edit: unknown) =>
      isRecord(edit) && typeof edit.oldText === "string" && typeof edit.newText === "string"
        ? [generateDiffString(edit.oldText, edit.newText).diff]
        : [],
    )
    .join("\n    ...\n");
}
