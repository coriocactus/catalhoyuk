import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Row-local tag for read-only historical rendering; never part of a session entry. */
export const HISTORY_PAGE = Symbol.for("rearview.history-page.v1");
export interface HistoryPage {
  readonly entries: readonly SessionEntry[];
  readonly cwd: string;
}
export type HistoryRenderState = { [HISTORY_PAGE]?: HistoryPage };
