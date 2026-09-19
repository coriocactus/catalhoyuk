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
  let pending: { page: Component; top: number } | undefined;
  let awaitingLayout = false;
  const originals = {
    scrollBy: scroll.scrollBy,
    scrollTo: scroll.scrollTo,
    scrollToStart: scroll.scrollToStart,
    scrollToEnd: scroll.scrollToEnd,
    updateLayout: scroll.updateLayout,
  };
  const keys = Object.keys(originals) as (keyof typeof originals)[];
  if (keys.some((key) => typeof originals[key] !== "function"))
    throw new Error("Pi's scroll API changed.");
  const descriptors = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(scroll, key)]),
  );
  const atTop = () => {
    if (!closed && options.active() && scroll.scrollTop === 0) options.load();
  };
  const wrappers: typeof originals = {
    scrollBy(this: ScrollView, lines) {
      pending = undefined;
      const result = originals.scrollBy.call(this, lines);
      if (lines < 0) atTop();
      if (lines > 0 && this.isFollowingEnd) options.end();
      return result;
    },
    scrollTo(this: ScrollView, top, opts) {
      pending = undefined;
      const previous = this.scrollTop;
      originals.scrollTo.call(this, top, opts);
      if (top <= previous) atTop();
      else if (this.isFollowingEnd) options.end();
    },
    scrollToStart(this: ScrollView) {
      pending = undefined;
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
      pending = { page, top: scroll.scrollTop };
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
      restore();
    },
  };
}
