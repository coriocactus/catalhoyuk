// Pi's working spinner on rows with work in progress. Each extension loads its own copy of this
// module, so it keeps no state of its own: an extension makes a Spinner and holds it.

/** The frames and interval of pi-tui's Loader, which draws Pi's working indicator. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export const SPINNER_MS = 80;

/** The frame a spinning row shows now. It follows the clock, so every row shows the same one. */
export const spinnerFrame = (now = Date.now()) =>
  SPINNER_FRAMES[Math.floor(now / SPINNER_MS) % SPINNER_FRAMES.length];

export interface SpinningRow {
  /** Asks Pi to draw the row again. */
  redraw(): void;
  /** Whether it still spins. A row that does not is forgotten at the next tick. */
  spinning(): boolean;
  /** Draw it once more as it is forgotten, for a row nothing else draws at rest. */
  settle?: boolean;
  /** Told once it is forgotten. */
  forgotten?(): void;
}

/**
 * Keeps spinning rows turning. A row reads its frame from the clock each time Pi draws it, and
 * Pi draws every row in every frame, so while anything else draws frames (Pi's working indicator,
 * streaming text) the rows turn without help. The timer asks Pi for a frame only when an interval
 * passed in which none drew a spinning row.
 */
export class Spinner<Key> {
  private readonly rows = new Map<Key, SpinningRow>();
  private readonly active: () => boolean;
  private timer?: ReturnType<typeof setInterval>;
  /** A frame this spinner did not ask for drew a spinning row since the last tick. */
  private drawn = false;
  /** This spinner asked for a frame that Pi has not drawn yet. */
  private asked = false;
  /** True while this spinner asks Pi to redraw rows: nothing but their frame has changed. */
  animating = false;

  /** `active`: whether rows may spin at all now, such as only while Pi works. */
  constructor(active: () => boolean = () => true) {
    this.active = active;
  }

  /** Spins a row, replacing how it was spun before, and starts the timer when rows may spin. */
  add(key: Key, row: SpinningRow): void {
    this.rows.set(key, row);
    if (this.timer || !this.active()) return;
    this.timer = setInterval(() => this.tick(), SPINNER_MS);
    this.timer.unref();
  }

  /** Forgets a row that no longer spins, without drawing it. */
  delete(key: Key): void {
    this.rows.delete(key);
  }

  /**
   * A spinning row tells that a frame drew it. Only the first row is counted, so a frame that
   * draws several counts once.
   */
  drew(key: Key): void {
    if (this.rows.keys().next().value !== key) return;
    if (this.asked) this.asked = false;
    else this.drawn = true;
  }

  /** Stops the timer and forgets every row, each redrawn once to rest unless `quiet`. */
  stop(quiet = false): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.drawn = false;
    this.asked = false;
    const rows = [...this.rows.values()];
    this.rows.clear();
    if (!quiet) for (const row of rows) row.redraw();
  }

  private tick(): void {
    if (!this.active()) {
      this.stop();
      return;
    }
    const idle = !this.drawn;
    this.drawn = false;
    const stopped: SpinningRow[] = [];
    this.animating = true;
    try {
      for (const [key, row] of this.rows) {
        if (!row.spinning()) {
          this.rows.delete(key);
          stopped.push(row);
        } else if (idle) {
          this.asked = true;
          row.redraw();
        }
      }
    } finally {
      this.animating = false;
    }
    // A row that stopped has more than its frame to change, so it is redrawn as any row is.
    for (const row of stopped) {
      if (row.settle) row.redraw();
      row.forgotten?.();
    }
    if (!this.rows.size) this.stop(true);
  }
}
