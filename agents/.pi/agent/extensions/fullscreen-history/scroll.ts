import type { Component, ScrollView } from "@earendil-works/pi-tui";

/** Observe explicit upward scrolling, not layout/resize or passive paints. */
export function attachTopPaging(
  scroll: ScrollView,
  options: {
    active(): boolean;
    width(): number;
    load(): void;
    settled(): void;
    end(): void;
  },
): { anchor(page: Component): void; reset(): void; dispose(): void } {
  let closed = false;
  let pending: { page: Component; top: number; moves: ((added: number) => void)[] } | undefined;
  let awaitingLayout = false;
  const originals = {
    scrollBy: scroll.scrollBy,
    scrollTo: scroll.scrollTo,
    scrollToStart: scroll.scrollToStart,
    scrollToEnd: scroll.scrollToEnd,
    updateLayout: scroll.updateLayout,
  };
  const keys = Object.keys(originals) as (keyof typeof originals)[];
  if (
    keys.some((key) => typeof originals[key] !== "function") ||
    typeof scroll.getContentWidth !== "function" ||
    !Number.isFinite(scroll.scrollTop) ||
    !Number.isFinite(scroll.viewportHeight) ||
    typeof scroll.isFollowingEnd !== "boolean"
  )
    throw new Error("Pi's scroll API changed.");
  const descriptors = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(scroll, key)]),
  );
  const atTop = () => {
    if (!closed && options.active() && scroll.scrollTop === 0) options.load();
  };
  const defer = (move: (added: number) => void) => {
    if (pending && awaitingLayout) {
      pending.moves.push(move);
      return true;
    }
    pending = undefined;
    return false;
  };
  const wrappers: typeof originals = {
    scrollBy(this: ScrollView, lines) {
      if (!Number.isFinite(lines) || Math.trunc(lines) === 0) return 0;
      const move = () => {
        const result = originals.scrollBy.call(this, lines);
        if (lines > 0 && this.isFollowingEnd) options.end();
        return result;
      };
      // Consume input until layout knows the new bounds. Replay in order, so an
      // upward overshoot followed by downward input clamps each move separately.
      if (defer(move)) return 0;
      const result = move();
      if (lines < 0) atTop();
      return result;
    },
    scrollTo(this: ScrollView, top, opts) {
      const previous = this.scrollTop;
      const move = (added: number) => {
        // Absolute coordinates still refer to the pre-prepend layout.
        originals.scrollTo.call(this, top + added, opts);
        if (top > previous && this.isFollowingEnd) options.end();
      };
      if (defer(move)) return;
      move(0);
      if (top <= previous) atTop();
    },
    scrollToStart(this: ScrollView) {
      // Coalesce Home repeats against the currently displayed start. After the
      // first layout, a new Home goes to the beginning of the loaded page.
      if (defer((added) => originals.scrollTo.call(this, added, { disableFollow: true }))) return;
      originals.scrollToStart.call(this);
      atTop();
    },
    scrollToEnd(this: ScrollView) {
      pending = undefined;
      options.end();
      originals.scrollToEnd.call(this);
    },
    updateLayout(this: ScrollView, height, viewport, requestRender) {
      originals.updateLayout.call(this, height, viewport, requestRender);
      if (closed) return;
      const anchor = pending;
      // Measure just the prepended page at the current width. Appended streaming
      // output and concurrent resizes must not be counted as a prepend delta.
      if (anchor) {
        const added = anchor.page.render(scroll.getContentWidth(options.width())).length;
        originals.scrollTo.call(this, anchor.top + added, { disableFollow: true });
        if (anchor.moves.length) {
          pending = undefined;
          for (const move of anchor.moves) move(added);
        }
      }
      if (awaitingLayout) {
        awaitingLayout = false;
        options.settled();
      }
    },
  };
  const restore = () => {
    for (const key of keys) {
      if (scroll[key] !== wrappers[key]) continue;
      const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(scroll, key, descriptor);
      else Reflect.deleteProperty(scroll, key);
    }
  };
  try {
    Object.assign(scroll, wrappers);
  } catch (error) {
    closed = true;
    restore();
    throw error;
  }
  return {
    anchor(page) {
      pending = { page, top: scroll.scrollTop, moves: [] };
      awaitingLayout = true;
    },
    reset() {
      pending = undefined;
      awaitingLayout = false;
    },
    dispose() {
      if (closed) return;
      closed = true;
      pending = undefined;
      awaitingLayout = false;
      restore();
    },
  };
}
