// The widget above the editor: a line for each background run at work, and for each answer the
// session has yet to take. Only in the terminal.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { Session } from "./session.ts";
import { type Running, widgetLine } from "./view.ts";

/** The key of the widget. */
const WIDGET = "comrade";
/** How often its clocks tick. */
const CLOCK_MS = 1000;

export type Widget = ReturnType<typeof createWidget>;

/** `rows`: its lines now, in order. With none, there is no widget. */
export function createWidget(session: Session, rows: () => Running[]) {
  let tui: TUI | undefined;
  let shown = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const lines = (width: number, theme: Theme) => {
    const list = rows();
    // Ids and titles in columns; titles as wide as the widest, up to a third of the width.
    const idWidth = Math.max(...list.map((row) => `#${row.id}`.length));
    const titleWidth = Math.min(
      Math.max(16, Math.floor(width / 3)),
      Math.max(0, ...list.map((row) => visibleWidth(row.title))),
    );
    return list.map((row) => widgetLine(row, idWidth, titleWidth, width, theme));
  };

  /** Shows the widget, draws it again, or takes it away, as its rows now ask. */
  const refresh = () => {
    const wanted = session.terminal && session.ui !== undefined && rows().length > 0;
    if (wanted && !shown && session.ui) {
      shown = true;
      session.ui.setWidget(
        WIDGET,
        (host, theme) => {
          tui = host;
          return {
            render: (width: number) => lines(width, theme),
            invalidate() {},
            dispose() {
              if (tui === host) tui = undefined;
            },
          };
        },
        { placement: "aboveEditor" },
      );
      // Its clocks tick once a second.
      timer = setInterval(() => tui?.requestRender(), CLOCK_MS);
      timer.unref();
    } else if (!wanted && shown) {
      shown = false;
      clearInterval(timer);
      timer = undefined;
      session.ui?.setWidget(WIDGET, undefined);
      tui = undefined;
    } else tui?.requestRender();
  };

  /** Takes the widget away as the session ends. */
  const close = () => {
    if (!shown) return;
    shown = false;
    clearInterval(timer);
    timer = undefined;
    session.ui?.setWidget(WIDGET, undefined);
    tui = undefined;
  };

  return { refresh, close };
}
