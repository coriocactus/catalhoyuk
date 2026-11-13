// Markers for Pi's fullscreen selection, which prose bounds by them: where a drawn line's content
// starts, and whether the line continues the line above it after a wrap. Private APC sequences:
// zero width to pi-tui, kept by its slicing and wrapping, stripped from copies, and ignored by
// terminals. A producer puts one marker on a line, at its content start.

/** The line's content starts here. What comes before it is layout: margins and indents. */
export const CONTENT_START = "\x1b_pi-select;start\x1b\\";
/** A continuation line: the line above wrapped at a space that the wrap dropped. */
export const CONTINUES_SPACED = "\x1b_pi-select;space\x1b\\";
/** A continuation line: the line above wrapped inside a word. */
export const CONTINUES_JOINED = "\x1b_pi-select;join\x1b\\";

export const MARKERS = [CONTENT_START, CONTINUES_SPACED, CONTINUES_JOINED] as const;
export type Marker = (typeof MARKERS)[number];

/** What every marker starts with, so a line without one is scanned once. */
const PREFIX = "\x1b_pi-select;";

/** The first marker in a drawn line, and its string offset. */
export function findMarker(line: string): { marker: Marker; at: number } | undefined {
  for (let at = line.indexOf(PREFIX); at >= 0; at = line.indexOf(PREFIX, at + 1)) {
    const marker = MARKERS.find((marker) => line.startsWith(marker, at));
    if (marker) return { marker, at };
  }
  return undefined;
}
