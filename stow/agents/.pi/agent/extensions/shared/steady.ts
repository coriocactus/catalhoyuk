// A line that changes what it shows at most once a second, so that work coming and going quickly
// cannot make it flash: comrade's status line, mirage's group headers, and the status on
// interupt's editor box hold their words this way. Each extension loads its own copy of this
// module, so it keeps no state of its own: an owner makes a Steady and holds it, as a Spinner.

/** How long what a line shows stays before a line of another kind may take its place. */
export const STEADY_MS = 1000;

/**
 * A line that changes what it shows at most once every STEADY_MS. Its kind says what the line
 * shows, a wait or a call: another kind waits until the last has shown that long, and is dropped
 * if a third replaces it first. The same kind updates in place, as a clock ticks or a spinner
 * turns. While another waits, `redraw` draws the kind shown from what is known now, so a call held
 * on its line still turns its spinner, or says it has ended; a kind it cannot draw stays as drawn.
 * A line given `now` shows at once, as a hint answering a key should.
 */
export class Steady {
  private kind?: string;
  private line = "";
  private since = 0;
  /**
   * When a line held back may show, while one is: a drawing cached until then is stale from
   * then, even if nothing else has changed.
   */
  heldUntil?: number;

  show(
    kind: string,
    line: string,
    redraw?: (kind: string) => string | undefined,
    now = false,
  ): string {
    const time = Date.now();
    if (kind !== this.kind) {
      if (!now && this.kind !== undefined && time - this.since < STEADY_MS) {
        this.heldUntil = this.since + STEADY_MS;
        this.line = redraw?.(this.kind) ?? this.line;
        return this.line;
      }
      this.kind = kind;
      this.since = time;
    }
    this.heldUntil = undefined;
    this.line = line;
    return line;
  }

  /** Forgets what it showed: the next line shows at once, as after a pause in the work. */
  reset(): void {
    this.kind = undefined;
    this.heldUntil = undefined;
  }
}
