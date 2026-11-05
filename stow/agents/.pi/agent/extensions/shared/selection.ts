// Zero-width markers for Pi's fullscreen selection, which prose bounds by them: where a rendered
// row's content starts, and whether the row continues the line above it after a wrap. Private APC
// sequences: zero width to pi-tui, kept by its slicing and wrapping, stripped from copies, and
// ignored by terminals. Producers put one marker on a row, at its content start.

/** The row's content starts here. What comes before it is layout: margins and indents. */
export const CONTENT_START = "\x1b_pi-select;start\x1b\\";
/** The row continues the line above, which wrapped at a space that the wrap dropped. */
export const CONTINUES_SPACED = "\x1b_pi-select;space\x1b\\";
/** The row continues the line above, which wrapped inside a word. */
export const CONTINUES_JOINED = "\x1b_pi-select;join\x1b\\";

export const MARKERS = [CONTENT_START, CONTINUES_SPACED, CONTINUES_JOINED] as const;
export type Marker = (typeof MARKERS)[number];

/** The first marker in a rendered row, and its string offset. */
export function findMarker(line: string): { marker: Marker; at: number } | undefined {
  let found: { marker: Marker; at: number } | undefined;
  for (const marker of MARKERS) {
    const at = line.indexOf(marker);
    if (at >= 0 && (!found || at < found.at)) found = { marker, at };
  }
  return found;
}
