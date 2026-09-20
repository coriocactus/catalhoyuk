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

  pi.registerCommand("echo", {
    description: "Load a Markdown snippet into the editor without sending it",
    getArgumentCompletions(prefix) {
      try {
        const matches = names()
          .filter((name) => name.startsWith(prefix))
          .map((name) => ({ value: name, label: name }));
        return matches.length ? matches : null;
      } catch {
        // Completion stays quiet; invoking the command reports filesystem errors.
        return null;
      }
    },
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const name = args.trim();
      if (!name) {
        ctx.ui.notify(`Usage: /echo <name> — snippets live in ${directory}/*.md`, "info");
        return;
      }
      try {
        // Only direct directory entries are accepted, never arbitrary paths.
        if (!names().includes(name)) {
          ctx.ui.notify(`Echo snippet not found: ${name}`, "warning");
          return;
        }
        ctx.ui.setEditorText(readFileSync(join(directory, `${name}.md`), "utf8"));
        // Notification also redraws hosts where setEditorText alone does not.
        ctx.ui.notify(`Loaded echo: ${name}`, "info");
      } catch (error) {
        ctx.ui.notify(
          `Could not load echo snippet: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}
