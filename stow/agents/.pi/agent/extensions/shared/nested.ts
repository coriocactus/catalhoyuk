import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

// This directory has no extension entry point; both extensions import this contract.
// An extension that shows another agent's work, such as comrade showing its comrades, asks
// mirage to draw that agent's tool calls the way mirage draws Pi's own, so they look the same
// everywhere. Without mirage, no one answers, and the asker draws them itself.

/** Emitted on Pi's event bus with a NestedRowsRequest. Mirage, if loaded, fills in `rows`. */
export const NESTED_ROWS_EVENT = "mirage:nested-rows";

export interface NestedRowsRequest {
  rows?: NestedRows;
}

export interface NestedRows {
  /**
   * Rows for one agent's calls, made in `cwd`. `spinner` gives the working spinner's frame while
   * that agent runs, for its calls still in progress.
   */
  transcript(cwd: string, spinner: () => string | undefined): NestedTranscript;
}

export interface NestedTranscript {
  /**
   * Adds one of the agent's messages once it has ended: replies with their calls, and results.
   * The calls of a reply that ended asking for them are under way, as Pi runs them at once.
   * Thinking in a reply separates calls as visible thinking does, whatever Ctrl+T says, so the
   * asker leaves out of it the thinking it does not show.
   */
  add(message: AgentMessage): void;
  /** Whether mirage draws calls of this tool. Others are the asker's to draw, and end a group. */
  draws(name: string): boolean;
  /**
   * The row a call leads, as mirage draws calls, its group's later calls inside it. Nothing
   * for a call an earlier call's row holds. Its clicks expand and collapse it, and open files.
   */
  row(toolCallId: string, theme: Theme): Component | undefined;
}

export function isNestedRowsRequest(value: unknown): value is NestedRowsRequest {
  return typeof value === "object" && value !== null;
}
