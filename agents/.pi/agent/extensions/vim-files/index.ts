import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { stat } from "node:fs/promises";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  type FileReference,
  isOpenFileRequest,
  OPEN_FILE_EVENT,
} from "../file-tools-shared/protocol.ts";
import { resolveToolFile } from "./paths.ts";

/** Owns the editor process and terminal handoff, not tool rendering. */
export default function (pi: ExtensionAPI) {
  let sessionContext: ExtensionContext | undefined;
  let opening = false;
  let editorProcess: ChildProcess | undefined;

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx.mode === "tui" ? ctx : undefined;
  });
  pi.on("session_shutdown", () => {
    sessionContext = undefined;
    editorProcess?.kill("SIGTERM");
  });
  pi.events.on(OPEN_FILE_EVENT, (data) => {
    if (!sessionContext || !isOpenFileRequest(data) || data.accepted) return;
    data.accepted = true;
    void openFile({ path: data.path, cwd: data.cwd, tool: data.tool });
  });

  async function runEditor(path: string, cwd: string): Promise<void> {
    const editor = process.env.VISUAL || process.env.EDITOR || "vim";
    const child = spawn(editor, ["--", path], { cwd, stdio: "inherit" });
    editorProcess = child;
    try {
      const [code, signal] = await once(child, "close");
      if (code !== 0) throw new Error(`Vim exited with ${signal ?? code}.`);
    } finally {
      if (editorProcess === child) editorProcess = undefined;
    }
  }

  async function openFile(file: FileReference): Promise<void> {
    const ctx = sessionContext;
    if (!ctx || opening) return;

    opening = true;
    try {
      // Let mouse dispatch finish before changing terminal ownership.
      await yieldToEventLoop();
      if (sessionContext !== ctx) return;
      const path = await resolveToolFile(file);
      if (sessionContext !== ctx) return;
      const info = await stat(path);
      if (sessionContext !== ctx) return;
      if (!info.isFile()) throw new Error("Only regular files can be opened in Vim.");

      await ctx.ui.custom<void>(async (tui, _theme, _keys, done) => {
        tui.stop();
        try {
          process.stdout.write("\x1b[2J\x1b[H");
          // Let stdin pause before starting the child; never block Pi's event loop.
          await yieldToEventLoop();
          if (sessionContext === ctx) await runEditor(path, file.cwd);
        } finally {
          if (sessionContext === ctx) {
            tui.start();
            tui.requestRender(true);
          }
        }
        done(undefined);
        return { render: () => [], invalidate() {} };
      });
    } catch (error) {
      if (sessionContext === ctx) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    } finally {
      opening = false;
    }
  }
}
