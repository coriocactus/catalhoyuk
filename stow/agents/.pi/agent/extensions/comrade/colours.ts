// Mirage's green and red, so comrade's rows match the tool rows around them. Comrade keeps its
// own copy, as it does of mirage's counts and wording, so the extensions stay independent; a
// test keeps the two equal, so change mirage/colours.ts and this together.
import type { Theme } from "@earendil-works/pi-coding-agent";

export const colours = {
  red: "#dd331d", // Removed counts, failed status, and errors.
  green: "#65bd55", // Added counts and successful status.
} as const;

type Tone = keyof typeof colours;

/** The truecolour sequence, and the nearest fixed xterm colour for terminals without it. */
function foreground(hex: string): { rgb: string; indexed: string } {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = value >> 16;
  const g = (value >> 8) & 255;
  const b = value & 255;
  // Entries 0–15 are theme-dependent, so only the cube and the greys.
  const cube = [0, 95, 135, 175, 215, 255];
  let index = 16;
  let distance = Number.POSITIVE_INFINITY;
  for (let candidate = 16; candidate < 256; candidate++) {
    const n = candidate - 16;
    const rgb =
      candidate < 232
        ? [cube[Math.floor(n / 36)], cube[Math.floor(n / 6) % 6], cube[n % 6]]
        : Array(3).fill(8 + (candidate - 232) * 10);
    const difference = (r - rgb[0]) ** 2 + (g - rgb[1]) ** 2 + (b - rgb[2]) ** 2;
    if (difference < distance) {
      index = candidate;
      distance = difference;
    }
  }
  return { rgb: `\x1b[38;2;${r};${g};${b}m`, indexed: `\x1b[38;5;${index}m` };
}

const tones = { red: foreground(colours.red), green: foreground(colours.green) };

/** Text in mirage's green or red, ending with a foreground reset that keeps other styles. */
export function paint(theme: Theme, tone: Tone, text: string): string {
  const colour = tones[tone];
  return `${theme.getColorMode() === "truecolor" ? colour.rgb : colour.indexed}${text}\x1b[39m`;
}
