import type { Component } from "@earendil-works/pi-tui";

/** Presentation-only anchors survive a tool group's leader moving to an older page. */
export const ROW_ANCHOR = Symbol.for("rearview.row-anchor.v1");
export interface RowAnchor {
  key: object;
  offset: number;
  /** Anchored at the top of the key's group (offset <= 0), wherever that group now starts. */
  top?: boolean;
}
export interface RowAnchors {
  capture(line: number, width: number): RowAnchor | undefined;
  locate(anchor: RowAnchor, width: number): number | undefined;
}
export type AnchoredComponent = Component & { [ROW_ANCHOR]?: RowAnchors };
export type AnchorState = { [ROW_ANCHOR]?: RowAnchors };
