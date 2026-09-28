import type { Component } from "@earendil-works/pi-tui";
import { type AnchoredComponent, ROW_ANCHOR } from "../shared/anchors.ts";

/**
 * Capture the first visible chat row before a prepend regroups tool rows, then
 * return how far it moved. Positions are chat-relative, so Pi's startup header
 * above the chat is never the anchor and its rewrapping is not counted.
 */
export function captureViewportAnchor(
  components: () => readonly Component[],
  anchorable: (component: Component) => boolean,
  top: number,
  width: number,
): ((width: number) => number) | undefined {
  const lead = (list: readonly Component[], at: number) => {
    let lines = 0;
    for (const component of list) {
      if (anchorable(component)) break;
      lines += component.render(at).length;
    }
    return lines;
  };
  const list = components();
  let before = 0;
  for (const component of list) {
    const height = component.render(width).length;
    if (height && before + height > top && anchorable(component)) {
      const offset = Math.max(0, top - before);
      const origin = before + offset - lead(list, width);
      const anchor = (component as AnchoredComponent)[ROW_ANCHOR]?.capture(offset, width);
      let last = 0;
      return (nextWidth) => {
        const next = components();
        let position = -lead(next, nextWidth);
        for (const candidate of next) {
          const lines = candidate.render(nextWidth).length;
          const local = anchor
            ? (candidate as AnchoredComponent)[ROW_ANCHOR]?.locate(anchor, nextWidth)
            : candidate === component && lines
              ? Math.min(offset, lines - 1)
              : undefined;
          if (local !== undefined) {
            last = position + local - origin;
            return last;
          }
          position += lines;
        }
        // Pi rebuilt the chat (settings, compaction) and replaced the anchored
        // component. Loaded pages are unchanged, so keep the last offset.
        return last;
      };
    }
    before += height;
  }
  return undefined;
}
