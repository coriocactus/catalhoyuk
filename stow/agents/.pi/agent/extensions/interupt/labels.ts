// The labels of Pi's footer, for the editor's box, which hides the footer: the directory, the
// model, and the session's statistics. Pi gives a footer that replaces its own the data, not the
// labels: context usage on ctx.getContextUsage(), token counts on the session's entries, model
// info on ctx.model. These follow the rules of Pi's own footer
// ("dist/modes/interactive/components/footer.js", which upgrade review watches by that path).
import type { Usage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { formatTokens } from "../shared/format.ts";

/** The statistics a click on them cycles through, in order. */
export const STATS = ["tokens", "cache", "cost", "context"] as const;
export type Stat = (typeof STATS)[number];

export interface Labels {
  /** The directory, its git branch, and the session's name. */
  pwd: string;
  /** The model and its thinking level. */
  model: string;
  /** One statistic, styled as Pi's footer styles it: only the one shown is worked out. */
  stat(which: Stat): string;
  /** Extensions' statuses, set with ctx.ui.setStatus(), by key, each on one line. */
  statuses: string[];
}

/** The directory with the home directory as `~`, as Pi's footer has it: from `$HOME`. */
export function footerPath(
  cwd: string,
  home = process.env.HOME || process.env.USERPROFILE,
): string {
  if (!home) return cwd;
  if (cwd === home) return "~";
  return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** The share of the latest prompt read from cache, in percent. */
  cacheHit?: number;
}

/** The session's usage, as Pi's footer sums it: every entry that cost something. */
function totals(entries: readonly SessionEntry[]): Totals {
  const sum: Totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const add = (usage: Usage | undefined) => {
    if (!usage) return;
    sum.input += usage.input;
    sum.output += usage.output;
    sum.cacheRead += usage.cacheRead;
    sum.cacheWrite += usage.cacheWrite;
    sum.cost += usage.cost.total;
  };
  for (const entry of entries) {
    if (entry.type === "usage") add(entry.usage);
    else if (entry.type === "message" && entry.message.role === "assistant") {
      const usage = entry.message.usage;
      add(usage);
      const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
      sum.cacheHit = prompt > 0 ? (usage.cacheRead / prompt) * 100 : undefined;
    } else if (entry.type === "message" && entry.message.role === "toolResult")
      add(entry.message.usage);
    else if (entry.type === "branch_summary" || entry.type === "compaction") add(entry.usage);
  }
  return sum;
}

/** What the labels read from the session, kept until it moves on: every new entry moves the leaf. */
interface Kept {
  session: string;
  leaf: string | null;
  model: ExtensionContext["model"];
  totals: Totals;
  context: ReturnType<ExtensionContext["getContextUsage"]>;
  name: string | undefined;
}

/**
 * Builds the labels as the box draws them, every frame. The scan of the session's entries, its
 * context usage and its name are kept until the session, its leaf, or its model changes.
 */
export function createLabels(pi: ExtensionAPI) {
  let kept: Kept | undefined;
  // Whether auto-compaction is on, read again at most once a second: Pi copies all its settings
  // to answer, and says nothing when they change.
  let compacts: { at: number; on: boolean } | undefined;
  const autoCompacts = () => {
    const now = Date.now();
    if (!compacts || now - compacts.at >= 1000)
      compacts = { at: now, on: pi.getSettings().compaction?.enabled !== false };
    return compacts.on;
  };
  return (ctx: ExtensionContext, footer: ReadonlyFooterDataProvider | undefined): Labels => {
    const { sessionManager, model } = ctx;
    const theme = ctx.ui.theme;
    const session = sessionManager.getSessionId();
    const leaf = sessionManager.getLeafId();
    if (kept?.session !== session || kept.leaf !== leaf || kept.model !== model)
      kept = {
        session,
        leaf,
        model,
        totals: totals(sessionManager.getEntries()),
        context: ctx.getContextUsage(),
        name: sessionManager.getSessionName(),
      };
    const { totals: sum, context, name } = kept;

    let pwd = footerPath(sessionManager.getCwd());
    const branch = footer?.getGitBranch();
    if (branch) pwd += ` (${branch})`;
    if (name) pwd += ` • ${name}`;

    let modelLabel = model?.id ?? "no-model";
    if (model?.reasoning) {
      const level = pi.getThinkingLevel();
      modelLabel += level === "off" ? " • thinking off" : ` • ${level}`;
    }
    if (model && (footer?.getAvailableProviderCount() ?? 0) > 1)
      modelLabel = `(${model.provider}) ${modelLabel}`;

    const parts = (...items: (string | false)[]) => items.filter(Boolean).join(" ");
    const stat = (which: Stat): string => {
      switch (which) {
        case "tokens":
          return theme.fg(
            "dim",
            parts(
              sum.input > 0 && `↑${formatTokens(sum.input)}`,
              sum.output > 0 && `↓${formatTokens(sum.output)}`,
            ) || "↑0 ↓0",
          );
        case "cache": {
          const cached = sum.cacheRead > 0 || sum.cacheWrite > 0;
          return theme.fg(
            "dim",
            parts(
              sum.cacheRead > 0 && `R${formatTokens(sum.cacheRead)}`,
              sum.cacheWrite > 0 && `W${formatTokens(sum.cacheWrite)}`,
              cached && sum.cacheHit !== undefined && `CH${sum.cacheHit.toFixed(1)}%`,
            ) || "R0 W0",
          );
        }
        case "cost": {
          // Kimi Coding is subscription-backed despite its API key, as Pi's footer knows.
          const subscription =
            model !== undefined &&
            (model.provider === "kimi-coding" || ctx.modelRegistry.isUsingOAuth(model));
          return theme.fg("dim", `$${sum.cost.toFixed(3)}${subscription ? " (sub)" : ""}`);
        }
        case "context": {
          const window = context?.contextWindow ?? model?.contextWindow ?? 0;
          const percent = context?.percent;
          const auto = autoCompacts() ? " (auto)" : "";
          const shown =
            percent === null || percent === undefined
              ? `?/${formatTokens(window)}${auto}`
              : `${percent.toFixed(1)}%/${formatTokens(window)}${auto}`;
          const value = percent ?? 0;
          return value > 90
            ? theme.fg("error", shown)
            : value > 70
              ? theme.fg("warning", shown)
              : theme.fg("dim", shown);
        }
      }
    };

    // As Pi's footer shows them: by key, each on one line.
    const statuses = [...(footer?.getExtensionStatuses() ?? new Map<string, string>())]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, text]) =>
        text
          .replace(/[\r\n\t]/g, " ")
          .replace(/ +/g, " ")
          .trim(),
      )
      .filter(Boolean);

    return {
      pwd: theme.fg("dim", pwd),
      model: theme.fg("dim", modelLabel),
      stat,
      statuses,
    };
  };
}
