// A comrade's titled thoughts: what a running row says of its thinking. Some models stream their
// thinking as summaries, each a title alone on a line in bold, then its paragraphs. Gemini does:
// `**Charting Bipartite Cycles**\n\nI'm now focusing on…`. No API marks a title: it is a line that
// is wholly bold. A running row says the latest title, never the thinking's words. An expanded row
// shows the thinking itself only as Pi shows its own, by Ctrl+T (transcripts.ts).
import { oneLine } from "./work.ts";

/** A line that is wholly bold: `**Title**`, with nothing else on it. */
const TITLE = /^[ \t]*\*\*((?:(?!\*\*)[^\n])+)\*\*[ \t]*$/gm;
/** The longest title shown, in characters: a model may bold a sentence. */
const TITLE_MAX = 200;

export interface Thought {
  /** Without its marks, on one line. */
  title: string;
  /** Its paragraphs, up to the next title. */
  body: string;
}

function titleOf(marked: string): string {
  const title = oneLine(marked.replaceAll("`", ""));
  const characters = Array.from(title);
  return characters.length > TITLE_MAX ? `${characters.slice(0, TITLE_MAX - 1).join("")}…` : title;
}

/** The titled thoughts in a thinking block, in order. */
export function thoughts(thinking: string): Thought[] {
  const found = [...thinking.matchAll(TITLE)];
  return found.flatMap((match, i) => {
    const title = titleOf(match[1]);
    const end = found[i + 1]?.index ?? thinking.length;
    const body = thinking.slice(match.index + match[0].length, end).trim();
    return title ? [{ title, body }] : [];
  });
}

/**
 * The title of the latest thought in thinking still streaming. Only complete lines count: until
 * its line ends, `**Title**` may yet go on.
 */
export function lastTitle(thinking: string): string | undefined {
  const end = thinking.lastIndexOf("\n");
  return end < 0 ? undefined : thoughts(thinking.slice(0, end)).at(-1)?.title;
}
