import { renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { colours } from "./colours.ts";

type Tone = keyof typeof colours;

function foreground(hex: string): { rgb: string; indexed: string } {
  if (!/^#[\da-f]{6}$/i.test(hex))
    throw new Error(`Invalid tool-display colour: ${hex}. Use #RRGGBB.`);
  const value = Number.parseInt(hex.slice(1), 16);
  const r = value >> 16,
    g = (value >> 8) & 255,
    b = value & 255;
  // Find the nearest fixed xterm colour. Entries 0–15 are theme-dependent.
  const cube = [0, 95, 135, 175, 215, 255];
  let index = 16,
    distance = Infinity;
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

// Validate once at load time, not midway through a terminal render.
const tones = {
  red: foreground(colours.red),
  green: foreground(colours.green),
  blue: foreground(colours.blue),
};

export function paint(theme: Theme, tone: Tone, text: string): string {
  const colour = tones[tone];
  return `${theme.getColorMode() === "truecolor" ? colour.rgb : colour.indexed}${text}\x1b[39m`;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: Strip only ANSI foreground colours; preserve Pi's inverse word-change highlighting.
const FOREGROUND = /\x1b\[(?:39|3[0-7]|9[0-7]|38;5;\d+|38;2;\d+;\d+;\d+)m/g;

export function colouredDiff(theme: Theme, source: string): string {
  return renderDiff(source)
    .split("\n")
    .map((line) => {
      const prefix = stripTerminalSequences(line).match(/^([+-])\s*\d+ /)?.[1];
      return prefix
        ? paint(theme, prefix === "+" ? "green" : "red", line.replace(FOREGROUND, ""))
        : line;
    })
    .join("\n");
}
