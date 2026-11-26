// Edit these colours, then /reload. Each is a six-digit RGB value, or a number for one of the
// terminal's own 256 palette entries, which follow its theme (0–15: 1 red,
// 2 green, 3 yellow, 4 blue). Mirage's and comrade's rows use them, and prose's inline code and
// user messages; Pi's own colours and the theme's syntax colours do not change.
import type { Theme } from "@earendil-works/pi-coding-agent";

export const colours = {
  red: "#dd331d", // Removed lines and counts, failed status, and error output.
  green: "#65bd55", // Added lines and counts, and successful status.
  blue: "#265b81", // Clickable filenames.
  yellow: 3, // Inline code, in bold, and flags in commands.
  sky: 6, // Markdown headings, in bold, and the spinner on rows at work.
  moss: 2, // User messages, and strings in commands, dimmed.
} as const;

export type Tone = keyof typeof colours;

/** The truecolour sequence, and the nearest fixed xterm colour for terminals without it. */
function foreground(value: string | number): { rgb: string; indexed: string } {
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0 || value > 255)
      throw new Error(`Invalid row colour: ${value}. Use a palette entry from 0 to 255.`);
    // The terminal's own entry, whatever its colour depth.
    const own = `\x1b[38;5;${value}m`;
    return { rgb: own, indexed: own };
  }
  if (!/^#[\da-f]{6}$/i.test(value))
    throw new Error(`Invalid row colour: ${value}. Use #RRGGBB, or a palette entry from 0 to 255.`);
  const hex = Number.parseInt(value.slice(1), 16);
  const r = hex >> 16;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
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

// Validated once when the module loads, not midway through a terminal render.
const tones = Object.fromEntries(
  Object.entries(colours).map(([tone, value]) => [tone, foreground(value)]),
) as Record<Tone, ReturnType<typeof foreground>>;

/**
 * Text in one of the row colours, ending with a foreground reset that keeps other styles. Without
 * a theme to say whether the terminal shows truecolour, an RGB colour takes its nearest fixed
 * one: prose draws Markdown, which Pi hands no theme.
 */
export function paint(theme: Pick<Theme, "getColorMode"> | undefined, tone: Tone, text: string) {
  const colour = tones[tone];
  return `${theme?.getColorMode() === "truecolor" ? colour.rgb : colour.indexed}${text}\x1b[39m`;
}

/** Text in a row colour, dimmed, as the strings in a command are. */
export function muted(theme: Pick<Theme, "getColorMode"> | undefined, tone: Tone, text: string) {
  return `\x1b[2m${paint(theme, tone, text)}\x1b[22m`;
}
