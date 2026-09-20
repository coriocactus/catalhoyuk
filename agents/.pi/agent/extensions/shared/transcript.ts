import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Synchronous presentation-only notification before Pi reconstructs live rows. */
export const TRANSCRIPT_VIEW = "rearview:transcript-view";
export interface TranscriptView {
  sessionId: string;
  cwd: string;
  entries: readonly SessionEntry[];
  expanded: boolean;
}
export function isTranscriptView(value: unknown): value is TranscriptView {
  if (!value || typeof value !== "object") return false;
  const view = value as Partial<TranscriptView>;
  return (
    typeof view.sessionId === "string" &&
    typeof view.cwd === "string" &&
    typeof view.expanded === "boolean" &&
    Array.isArray(view.entries) &&
    view.entries.every(
      (entry) => entry && typeof entry.id === "string" && typeof entry.type === "string",
    )
  );
}
