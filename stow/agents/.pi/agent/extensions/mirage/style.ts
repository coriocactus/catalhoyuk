import { renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { paint } from "../shared/colours.ts";

// biome-ignore lint/suspicious/noControlCharactersInRegex: Strip only ANSI foreground colours; preserve Pi's inverse word-change highlighting.
const FOREGROUND = /\x1b\[(?:39|3[0-7]|9[0-7]|38;5;\d+|38;2;\d+;\d+;\d+)m/g;

/** Pi's diff, its added and removed lines in the row colours, word changes still inverse. */
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
