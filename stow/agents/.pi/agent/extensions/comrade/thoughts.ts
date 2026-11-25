// A comrade's titled thoughts: what its rows show of its thinking. Some models stream their
// thinking as summaries, each a title alone on a line in bold, then its paragraphs. Gemini does:
// `**Charting Bipartite Cycles**\n\nI'm now focusing on…`. No API marks a title: it is a line that
// is wholly bold. A running row says the latest title, and an expanded row shows a block's
// thoughts behind `Chain of thought ▸`. Thinking without titles, such as Anthropic's summaries,
// is never shown, and neither is thinking before a block's first title.
import type { AgentMessage } from "@earendil-works/pi-agent-core";
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

/** A thinking block from its first title on, as Markdown, or nothing when it has no title. */
export function titledThinking(thinking: string): string | undefined {
  for (const match of thinking.matchAll(TITLE))
    if (titleOf(match[1])) return thinking.slice(match.index).trim();
  return undefined;
}

/**
 * The title of the latest thought in thinking still streaming. Only complete lines count: until
 * its line ends, `**Title**` may yet go on.
 */
export function lastTitle(thinking: string): string | undefined {
  const end = thinking.lastIndexOf("\n");
  return end < 0 ? undefined : thoughts(thinking.slice(0, end)).at(-1)?.title;
}

/**
 * A message as a comrade's row shows it: without thinking that has no title, which shows nothing
 * and so separates no calls. The same message when there is none to leave out.
 */
export function shownMessage(message: AgentMessage): AgentMessage {
  if (message.role !== "assistant") return message;
  const content = message.content.filter(
    (part) => part.type !== "thinking" || thoughts(part.thinking).length > 0,
  );
  return content.length === message.content.length ? message : { ...message, content };
}
