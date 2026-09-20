import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const directory = join(getAgentDir(), "echo");
  const names = () =>
    readdirSync(directory, { withFileTypes: true })
      .filter(
        (entry) =>
          (entry.isFile() || entry.isSymbolicLink()) &&
          !entry.name.startsWith(".") &&
          entry.name.endsWith(".md"),
      )
      .map((entry) => entry.name.slice(0, -3))
      .sort();

  const completions = (prefix: string) => {
    try {
      const matches = names()
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ value: name, label: name }));
      return matches.length ? matches : null;
    } catch {
      // Completion stays quiet; loading a snippet reports filesystem errors.
      return null;
    }
  };
  const tokenAt = (lines: string[], line: number, col: number) =>
    lines[line].slice(0, col).match(/(?:^|[ \t])(@@[^@]*)$/)?.[1];

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: [...(current.triggerCharacters ?? []), "@"],
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const prefix = tokenAt(lines, cursorLine, cursorCol);
        if (prefix === undefined)
          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        if (options.signal.aborted) return null;
        const items = completions(prefix.slice(2));
        return items ? { items, prefix } : null;
      },
      applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
        if (!prefix.startsWith("@@"))
          return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        try {
          if (!names().includes(item.value))
            throw new Error(`Echo snippet not found: ${item.value}`);
          const content = readFileSync(join(directory, `${item.value}.md`), "utf8");
          const line = lines[cursorLine];
          const inserted = (line.slice(0, cursorCol - prefix.length) + content).split("\n");
          const last = inserted.length - 1;
          const end = inserted[last].length;
          inserted[last] += line.slice(cursorCol);
          return {
            lines: [...lines.slice(0, cursorLine), ...inserted, ...lines.slice(cursorLine + 1)],
            cursorLine: cursorLine + last,
            cursorCol: end,
          };
        } catch (error) {
          ctx.ui.notify(
            `Could not load echo snippet: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
          return { lines, cursorLine, cursorCol };
        }
      },
      shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
        return (
          tokenAt(lines, cursorLine, cursorCol) !== undefined ||
          (current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true)
        );
      },
    }));
  });
}
