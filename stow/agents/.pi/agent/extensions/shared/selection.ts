// Markers for Pi's fullscreen selection, which prose bounds by them: where a drawn line's content
// starts, whether the line continues the line above it after a wrap, and where its content ends
// before a caret. Private APC sequences: zero width to pi-tui, kept by its slicing and wrapping,
// stripped from copies, and ignored by terminals. A producer puts one start marker on a line, at
// its content start, and at most one end marker.

/** The line's content starts here. What comes before it is layout: margins and indents. */
export const CONTENT_START = "\x1b_pi-select;start\x1b\\";
/** A continuation line: the line above wrapped at a space that the wrap dropped. */
export const CONTINUES_SPACED = "\x1b_pi-select;space\x1b\\";
/** A continuation line: the line above wrapped inside a word. */
export const CONTINUES_JOINED = "\x1b_pi-select;join\x1b\\";

/** The line's content ends here. What follows is layout: the caret that expands or collapses it. */
export const CONTENT_END = "\x1b_pi-select;end\x1b\\";

/** The markers of where a line starts, one to a line. */
export const MARKERS = [CONTENT_START, CONTINUES_SPACED, CONTINUES_JOINED] as const;
export type Marker = (typeof MARKERS)[number];
/** Every marker, to take them all out of a line. */
export const ALL_MARKERS = [...MARKERS, CONTENT_END] as const;

/** What every marker starts with, so a line without one is scanned once. */
const PREFIX = "\x1b_pi-select;";

/** The string offset of a drawn line's end marker, if it has one. */
export function findEnd(line: string): number | undefined {
  const at = line.indexOf(CONTENT_END);
  return at < 0 ? undefined : at;
}

/** The first start marker in a drawn line, and its string offset. */
export function findMarker(line: string): { marker: Marker; at: number } | undefined {
  for (let at = line.indexOf(PREFIX); at >= 0; at = line.indexOf(PREFIX, at + 1)) {
    const marker = MARKERS.find((marker) => line.startsWith(marker, at));
    if (marker) return { marker, at };
  }
  return undefined;
}
