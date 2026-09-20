import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import xterm from "@xterm/headless";
import pty from "node-pty";

function foreground(cell) {
  const value = cell.getFgColor();
  if (cell.isFgRGB())
    return { kind: "rgb", red: value >>> 16, green: (value >>> 8) & 255, blue: value & 255 };
  if (cell.isFgPalette()) return { kind: "palette", index: value };
  return null;
}

/** Real PTY transport and xterm.js VT state; no DOM or handwritten ANSI parser. */
export class HeadlessTerminal {
  #changed = new EventEmitter();
  #snapshot;
  #raw = "";
  #parsed = 0;
  #exit;
  #output;
  #input;

  static async start(
    command,
    args,
    { cwd, env, artifacts, name = "terminal", cols = 150, rows = 72 },
  ) {
    const terminal = new xterm.Terminal({ cols, rows, scrollback: 200, allowProposedApi: true });
    try {
      const child = pty.spawn(command, args, {
        cwd,
        env,
        cols,
        rows,
        name: "xterm-256color",
        encoding: null,
      });
      return new HeadlessTerminal(terminal, child, join(artifacts, name));
    } catch (error) {
      terminal.dispose();
      throw error;
    }
  }

  constructor(terminal, child, artifactPrefix) {
    this.terminal = terminal;
    this.child = child;
    this.artifactPrefix = artifactPrefix;
    this.#input = terminal.onData((bytes) => child.write(bytes));
    this.#output = child.onData((bytes) => {
      appendFileSync(`${artifactPrefix}.raw`, bytes);
      // Protocol offsets count bytes. xterm, not this harness, decodes UTF-8.
      this.#raw += bytes.toString("latin1");
      const end = this.#raw.length;
      terminal.write(bytes, () => {
        // xterm parses asynchronously: only expose fully consumed output.
        this.#parsed = end;
        this.#snapshot = undefined;
        this.#changed.emit("change");
      });
    });
    child.onExit((exit) => {
      this.#exit = exit;
      this.#changed.emit("change");
    });
  }

  get snapshot() {
    if (this.#snapshot) return this.#snapshot;
    const { terminal } = this,
      buffer = terminal.buffer.active;
    const rows = Array.from({ length: terminal.rows }, (_, y) => {
      const line = buffer.getLine(buffer.baseY + y),
        cells = [];
      for (let x = 0; x < terminal.cols; x++) {
        const cell = line?.getCell(x);
        if (!cell?.getWidth()) continue; // Skip the continuation of a wide cell.
        cells.push({
          x,
          width: cell.getWidth(),
          text: cell.getChars() || " ",
          style: {
            foreground: foreground(cell),
            inverse: Boolean(cell.isInverse()),
            underline: Boolean(cell.isUnderline()),
          },
        });
      }
      return { text: line?.translateToString(true) ?? "", cells };
    });
    this.#snapshot = {
      cols: terminal.cols,
      rows,
      cursor: { x: buffer.cursorX, y: buffer.cursorY },
      synchronizedOutputActive: terminal.modes.synchronizedOutputMode,
    };
    return this.#snapshot;
  }
  get screen() {
    return this.snapshot.rows.map((row) => row.text).join("\n");
  }
  get pid() {
    return this.child.pid;
  }
  mark() {
    return this.#parsed;
  }
  rawSince(offset = 0) {
    return this.#raw.slice(offset, this.#parsed);
  }
  send(bytes) {
    this.child.write(bytes);
  }

  async waitFor(predicate, label, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.#changed.off("change", check);
      };
      const check = () => {
        try {
          if (this.#exit) throw new Error(`PTY exited early: ${JSON.stringify(this.#exit)}`);
          if (this.snapshot.synchronizedOutputActive || !predicate(this.screen, this.snapshot))
            return;
          cleanup();
          resolve(this.screen);
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`${label}\n${this.screen}\nArtifacts: ${this.artifactPrefix}`));
      }, timeout);
      this.#changed.on("change", check);
      check();
    });
  }

  locate(needle) {
    for (const [y, row] of this.snapshot.rows.entries()) {
      const offset = row.text.indexOf(needle);
      if (offset < 0) continue;
      let stringOffset = 0;
      for (const cell of row.cells) {
        if (offset >= stringOffset && offset < stringOffset + cell.text.length)
          return { x: cell.x, y, cell, row };
        stringOffset += cell.text.length;
      }
    }
    throw new Error(`Not visible: ${needle}\n${this.screen}`);
  }

  click(needle, filename = false) {
    const target = this.locate(needle);
    const cell = filename
      ? target.cell
      : target.row.cells.find((cell) => cell.text === "▸" || cell.text === "▾");
    assert(cell, `No toggle caret on ${needle}`);
    const x = cell.x + 1,
      y = target.y + 1;
    this.send(`\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`);
  }

  assertColour(needle, hex) {
    assert.deepEqual(
      this.locate(needle).cell.style.foreground,
      {
        kind: "rgb",
        red: Number.parseInt(hex.slice(1, 3), 16),
        green: Number.parseInt(hex.slice(3, 5), 16),
        blue: Number.parseInt(hex.slice(5, 7), 16),
      },
      `Foreground of ${needle}`,
    );
  }

  resize(cols, rows) {
    this.terminal.resize(cols, rows);
    this.child.resize(cols, rows);
    this.#snapshot = undefined;
  }

  save() {
    writeFileSync(`${this.artifactPrefix}.screen.txt`, this.screen);
    writeFileSync(`${this.artifactPrefix}.snapshot.json`, JSON.stringify(this.snapshot, null, 2));
  }

  async close() {
    const kill = (signal) => {
      if (this.#exit) return;
      try {
        process.kill(-this.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    try {
      kill("SIGTERM");
      for (let attempt = 0; attempt < 40 && !this.#exit; attempt++) await delay(25);
      kill("SIGKILL");
      for (let attempt = 0; attempt < 40 && !this.#exit; attempt++) await delay(25);
      assert(this.#exit, "Owned PTY process did not exit after SIGKILL");
    } finally {
      this.#output.dispose();
      this.#input.dispose();
      await new Promise((resolve) => this.terminal.write("", resolve));
      this.terminal.dispose();
    }
  }
}
