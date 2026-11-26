// The prompt editor in a box, drawn around Pi's own editor: its text between side borders, at
// least three rows tall. The top border carries the model on its right, with one of the session's
// statistics beside it, which a click cycles; the bottom border carries what Pi is doing on its
// left and the directory on its right. Dragging the top border resizes the box. Pi's command menu
// stays below the box. Pi's footer, whose labels these are, is hidden while the box draws.
//
// The box reads what Pi's editor draws (pi-tui's Editor, which upgrade review watches as it is
// imported) and the status Pi hands it, which draws itself
// ("dist/modes/interactive/components/status-indicator.js", watched by that path).
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorComponent,
  stripTerminalSequences,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { paint } from "../shared/colours.ts";
import { CONTENT_END, CONTENT_START } from "../shared/selection.ts";
import { Steady } from "../shared/steady.ts";
import type { Activity } from "./activity.ts";
import { type Labels, STATS, type Stat } from "./labels.ts";

/** The fewest rows of text the box shows, whatever its text. */
export const MIN_ROWS = 3;
/** Narrower than this, the editor is drawn as Pi draws it. */
const NARROWEST = 12;
/** What the terminal sends when it loses focus, after which Pi forgets a press it captured. */
const FOCUS_OUT = "\x1b[O";

/** Pi's editor as the box reads it: rows it counts as it draws, and the status it is handed. */
interface Internals {
  renderedVisibleLineCount?: unknown;
  renderedAutocompleteHeight?: unknown;
  setWorkingStatusIndicator?: (indicator: unknown) => void;
}

/** Pi's status while it works, which draws itself to fit a border. */
interface Indicator {
  /** `working`, or what else Pi waits on: a retry, compaction, a branch summary. */
  kind?: string;
  renderInBorder(width: number): string;
  renderSpinnerInBorder(width: number): string;
}

const isIndicator = (value: unknown): value is Indicator =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Indicator).renderInBorder === "function" &&
  typeof (value as Indicator).renderSpinnerInBorder === "function";

/** What the status on the bottom border says: what Pi is doing, or the Esc hint. */
export interface Status {
  kind: Activity["kind"] | "armed";
  label: string;
  /** Tokens counted so far, dim after the label. */
  tokens?: string;
}

export interface BoxOptions {
  tui: TUI;
  theme(): Theme;
  labels(): Labels;
  /** What Pi is doing while it works, for the status: Pi's own indicator says only `Working`. */
  status(): Status | undefined;
  /** Told once, when the box can no longer draw: the editor is then drawn as Pi draws it. */
  report(message: string): void;
  /** The box no longer draws, for good: Pi's footer, whose labels it carried, comes back. */
  unboxed(): void;
}

/** The box as the footer it hides sees it. */
export interface Boxed {
  /** Whether the box drew since this was last asked: not while a dialog holds the editor's place. */
  drew(): boolean;
  /** The statistic the box shows. */
  stat(): Stat;
}

/**
 * The labels on one line, for a frame without the box: the directory and extensions' statuses on
 * the left, the statistic and the model on the right. What does not fit is cut from the left,
 * then the statistic goes.
 */
export function labelLine(labels: Labels, stat: Stat, width: number): string {
  const left = [labels.pwd, ...labels.statuses].join(" ");
  for (const right of [`${labels.stat(stat)}  ${labels.model}`, labels.model]) {
    const room = width - visibleWidth(right) - 2;
    if (room < Math.min(12, visibleWidth(left))) continue;
    const cut = truncateToWidth(left, room, "…");
    return `${cut}${" ".repeat(width - visibleWidth(cut) - visibleWidth(right))}${right}`;
  }
  return truncateToWidth(`${left}  ${labels.model}`, width, "…");
}

/** Pi's `↑ 3 more` or `↓ 3 more`, from a border Pi drew. */
function scrolled(border: string | undefined): string | undefined {
  return /[↑↓] \d+ more/.exec(stripTerminalSequences(border ?? ""))?.[0];
}

/**
 * Draws `editor` in a box. Its methods are replaced on this editor alone, so another extension's
 * editor, if it is Pi's editor, is boxed as Pi's is. An editor that is not, or Pi's editor drawn
 * in another shape, or anything the box reads that throws, leaves the editor as Pi draws it, with
 * one warning, and Pi's footer back.
 */
export function boxEditor(editor: EditorComponent, options: BoxOptions): Boxed | undefined {
  if (!(editor instanceof Editor)) {
    options.report("the editor in use is not Pi's: it is drawn without its box.");
    options.unboxed();
    return undefined;
  }
  const piEditor = editor;
  const internals = editor as unknown as Internals;
  const render = editor.render.bind(editor);
  const handleMouse = editor.handleMouse?.bind(editor);
  // Pi hands its status to the editor, which would draw it on its top border. The box draws it on
  // its own bottom border instead, and hands it on only once it no longer draws.
  const setIndicator = internals.setWorkingStatusIndicator?.bind(editor);
  let given: unknown;
  let indicator: Indicator | undefined;
  let failed = false;
  if (setIndicator)
    internals.setWorkingStatusIndicator = (value) => {
      given = value;
      indicator = isIndicator(value) ? value : undefined;
      if (failed) setIndicator(value);
    };

  // The box's rows of text, which dragging its top border changes: reset with each editor, as
  // is the statistic shown.
  let rows = MIN_ROWS;
  let stat = 0;
  /** The last drawing: its rows of Pi's text, its height, and where the statistic sits. */
  let drawn: { text: number; height: number; stat?: [number, number] } | undefined;
  /** A press on the top border, which it follows up and down until released. */
  let drag: { screenY: number; rows: number } | undefined;
  let unlisten: (() => void) | undefined;
  const endDrag = () => {
    drag = undefined;
    unlisten?.();
    unlisten = undefined;
  };
  const startDrag = (screenY: number, height: number) => {
    endDrag();
    drag = { screenY, rows: height };
    // Pi forgets the press when the terminal loses focus, and then sends no release. A terminal
    // multiplexer sends no move without a button either, so the focus going is the only sign.
    unlisten = options.tui.addInputListener?.((data) => {
      if (data === FOCUS_OUT) endDrag();
      return undefined;
    });
  };
  /** Whether the box drew since the footer last asked. */
  let drew = false;
  const status = new Steady();
  /** Whether the status shown is one that holds steady: leaving one that does not is at once. */
  let shownHeld = true;

  /**
   * The status while Pi works: what it is doing, held steady, or the Esc hint and what else Pi
   * waits on, in Pi's words, at once. Its spinner is Pi's, in the terminal's cyan; its words are
   * in the text colour.
   */
  const statusLine = (theme: Theme, room: number): string => {
    if (!indicator) {
      status.reset();
      shownHeld = true;
      return "";
    }
    const frame = stripTerminalSequences(indicator.renderSpinnerInBorder(4)).trim();
    let kind: string;
    let words: string;
    if (indicator.kind !== undefined && indicator.kind !== "working") {
      const message = stripTerminalSequences(indicator.renderInBorder(200)).trim();
      kind = indicator.kind;
      words = theme.fg("text", message.slice(frame.length).trim());
    } else {
      const now = options.status() ?? { kind: "waiting", label: "Working" };
      kind = now.kind;
      words = [theme.fg("text", now.label), now.tokens ? theme.fg("dim", now.tokens) : ""]
        .filter(Boolean)
        .join(" ");
    }
    // What Pi is doing holds steady; the hint and Pi's own words show at once. The spinner turns
    // whatever the words show.
    const held = kind !== "armed" && (indicator.kind ?? "working") === "working";
    const shown = status.show(kind, words, undefined, !held || !shownHeld);
    shownHeld = held;
    const spinner = frame ? paint(theme, "sky", frame) : "";
    const full = [spinner, shown].filter(Boolean).join(" ");
    if (visibleWidth(full) <= room) return full;
    // Too long, as Pi's own words can be: cut to fit, as Pi's border cuts them.
    const fits = room - (spinner ? visibleWidth(spinner) + 1 : 0);
    return fits > 1
      ? [spinner, truncateToWidth(shown, fits, "…")].filter(Boolean).join(" ")
      : spinner;
  };

  /** Pi's editor scrolls its text beyond 30% of the terminal, and at least 5 rows. */
  const tallest = () => Math.max(MIN_ROWS, 5, Math.floor(options.tui.terminal.rows * 0.3));

  const fail = (width: number, why: string) => {
    failed = true;
    drawn = undefined;
    endDrag();
    options.report(`${why}: the editor is drawn as Pi draws it, without its box.`);
    options.unboxed();
    if (setIndicator && given !== undefined) setIndicator(given);
    return render(width);
  };

  const box = (width: number, lines: readonly string[], text: number): string[] => {
    const inner = width - 2;
    const theme = options.theme();
    const line = (value: string) => theme.fg("text", value);
    const labels = options.labels();
    // A box dragged tall stays no taller than the terminal now allows.
    const height = Math.max(Math.min(rows, tallest()), text);

    // Top: on the left, a shell command's mark, which Pi gives only as its border's colour, and
    // Pi's `↑ N more`; on the right, the statistic and the model.
    const above = scrolled(lines[0]);
    const draft = piEditor.getText().trimStart();
    const shell = draft.startsWith("!!")
      ? "bash (no context)"
      : draft.startsWith("!")
        ? "bash"
        : "";
    const marks = [shell && theme.fg("bashMode", shell), above && line(above)].filter(Boolean);
    const left = marks.length ? `${line("─ ")}${marks.join(line(" ─ "))}${line(" ")}` : line("─");
    const statLabel = labels.stat(STATS[stat]);
    // Between the corner's `╭`, the left part, and the closing `─╮`.
    const room = width - 3 - visibleWidth(left);
    let right = ` ${statLabel} ${line("─")} ${labels.model} `;
    let showsStat = true;
    if (visibleWidth(right) > room) {
      // Narrow: the model alone, cut to fit.
      showsStat = false;
      const model = truncateToWidth(labels.model, Math.max(0, room - 2), "…");
      right = room > 2 ? ` ${model} ` : "";
    }
    const topFill = Math.max(0, room - visibleWidth(right));
    const top = `${line("╭")}${left}${line("─".repeat(topFill))}${right}${line("─╮")}`;
    const statStart = 1 + visibleWidth(left) + topFill + 1;
    const statRange: [number, number] | undefined = showsStat
      ? [statStart, statStart + visibleWidth(statLabel)]
      : undefined;

    // Pi's rows of text between the side borders, then blank rows down to the box's height. Each
    // row marks where its text starts and ends, so prose's selection leaves the borders, and the
    // spaces Pi pads the text with, out.
    const body = lines.slice(1, 1 + text).map((row) => {
      const content = row.replace(/ +$/, "");
      const pad = Math.max(0, inner - visibleWidth(content));
      return `${line("│")}${CONTENT_START}${content}${CONTENT_END}${" ".repeat(pad)}${line("│")}`;
    });
    while (body.length < height)
      body.push(`${line("│")}${CONTENT_START}${CONTENT_END}${" ".repeat(inner)}${line("│")}`);

    // Bottom: what Pi is doing on the left, with Pi's `↓ N more` and extensions' statuses; the
    // directory on the right.
    const below = scrolled(lines[1 + text]);
    const pwd = labels.pwd;
    const leftRoom = width - 4;
    const now = statusLine(theme, Math.max(1, leftRoom - 2));
    const extras = [below && theme.fg("dim", below), ...labels.statuses].filter(Boolean).join(" ");
    let bottomLeft = [now, extras].filter(Boolean).join(" ");
    if (bottomLeft) bottomLeft = ` ${bottomLeft} `;
    let bottomRight = ` ${pwd} `;
    if (visibleWidth(bottomLeft) + visibleWidth(bottomRight) > width - 4) {
      const pwdRoom = width - 4 - visibleWidth(bottomLeft) - 2;
      bottomRight = pwdRoom > 4 ? ` ${truncateToWidth(pwd, pwdRoom, "…")} ` : "";
    }
    if (visibleWidth(bottomLeft) > width - 4)
      bottomLeft = truncateToWidth(bottomLeft, width - 4, "…");
    const bottomFill = Math.max(
      0,
      width - 4 - visibleWidth(bottomLeft) - visibleWidth(bottomRight),
    );
    const bottom = `${line("╰─")}${bottomLeft}${line("─".repeat(bottomFill))}${bottomRight}${line("─╯")}`;

    // Pi's command menu below the box, one column in, under its text.
    const menuRows = lines.slice(2 + text).map((row) => ` ${row}`);

    drawn = { text, height, stat: statRange };
    drew = true;
    return [top, ...body, bottom, ...menuRows];
  };

  editor.render = (width) => {
    if (failed) return render(width);
    if (width < NARROWEST) {
      // Too narrow for the box, for now: Pi draws its editor, with the status on its top border.
      drawn = undefined;
      if (!setIndicator) return render(width);
      setIndicator(given);
      try {
        return render(width);
      } finally {
        setIndicator(undefined);
      }
    }
    const lines = render(width - 2);
    const text = internals.renderedVisibleLineCount;
    const menu = internals.renderedAutocompleteHeight;
    if (typeof text !== "number" || typeof menu !== "number" || lines.length !== text + 2 + menu)
      return fail(width, "Pi's editor changed");
    if (given !== undefined && !indicator) return fail(width, "Pi's working status changed");
    // What the box reads from Pi, such as the labels, may have changed with Pi: a throw in a
    // frame would end Pi, so it leaves the editor to Pi.
    try {
      return box(width, lines, text);
    } catch (error) {
      return fail(width, `the box failed (${error instanceof Error ? error.message : error})`);
    }
  };

  editor.handleMouse = (event) => {
    // Pi forgets a capture when the terminal loses focus, without a release: any other press, or
    // a move without a button, ends a drag.
    if (event.type === "press" || event.type === "move" || !drawn) endDrag();
    if (!drawn) return handleMouse?.(event);
    if (drag && event.type === "drag") {
      const next = Math.min(
        tallest(),
        Math.max(MIN_ROWS, drag.rows + drag.screenY - event.screenY),
      );
      if (next !== rows) {
        rows = next;
        options.tui.requestRender();
      }
      return { handled: true };
    }
    if (drag && event.type === "release") {
      endDrag();
      return { handled: true };
    }
    if (event.y === 0) {
      // The top border: a left press starts a drag; a click on the statistic, which Pi sends only
      // for a press that did not move, shows the next one. The wheel and other buttons pass on.
      if (event.button === "left" && event.type === "press") {
        startDrag(event.screenY, drawn.height);
        return { handled: true, capture: true };
      }
      if (event.button === "left" && event.type === "click") {
        const [start, end] = drawn.stat ?? [-1, -1];
        if (event.x >= start && event.x < end) {
          stat = (stat + 1) % STATS.length;
          options.tui.requestRender();
        }
        return { handled: true };
      }
      return undefined;
    }
    // Below it, Pi's editor, its rows where Pi drew them: blank rows are below its text.
    const { text, height } = drawn;
    let y = event.y;
    if (y > text && y <= height) y = text + 1;
    else if (y > height) y -= height - text;
    return handleMouse?.({
      ...event,
      x: Math.max(0, event.x - 1),
      y,
      width: Math.max(1, event.width - 2),
    });
  };

  return {
    drew: () => {
      const was = drew;
      drew = false;
      return was;
    },
    stat: () => STATS[stat],
  };
}
