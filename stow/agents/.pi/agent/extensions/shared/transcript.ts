import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Synchronous presentation-only notification before Pi reconstructs live rows. */
export const TRANSCRIPT_VIEW = "rearview:transcript-view";
export interface TranscriptView {
  sessionId: string;
  cwd: string;
  entries: readonly SessionEntry[];
  expanded: boolean;
  /** Identity of the mounted transcript, not the saved session. */
  scope?: object;
  /** Already loaded historical entries in displayed order, before the live range. */
  history?: readonly SessionEntry[];
  /** Stage a prepend before constructing native components; caller settles it. */
  prepend?: boolean;
  transaction?: { commit(): void; rollback(): void };
}
export function isTranscriptView(value: unknown): value is TranscriptView {
  if (!value || typeof value !== "object") return false;
  const view = value as Partial<TranscriptView>;
  return (
    typeof view.sessionId === "string" &&
    typeof view.cwd === "string" &&
    typeof view.expanded === "boolean" &&
    (view.scope === undefined || (view.scope !== null && typeof view.scope === "object")) &&
    (view.prepend === undefined || typeof view.prepend === "boolean") &&
    (view.history === undefined || Array.isArray(view.history)) &&
    Array.isArray(view.entries) &&
    view.entries.every(
      (entry) => entry && typeof entry.id === "string" && typeof entry.type === "string",
    )
  );
}
