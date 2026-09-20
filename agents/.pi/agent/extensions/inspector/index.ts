import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { stat } from "node:fs/promises";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { type FileReference, isOpenFileRequest, OPEN_FILE_EVENT } from "../shared/protocol.ts";
import { resolveToolFile } from "./paths.ts";

/** Owns the editor process and terminal handoff, not tool rendering. */
export default function (pi: ExtensionAPI) {
  let sessionContext: ExtensionContext | undefined;
  let opening: Promise<void> | undefined;
  let editorProcess: ChildProcess | undefined;
  let restoreTerminal: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx.mode === "tui" ? ctx : undefined;
  });
  pi.on("session_shutdown", async (event) => {
    sessionContext = undefined;
    const restore = restoreTerminal;
    const child = editorProcess;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (child) {
        child.kill("SIGTERM");
        // An uncooperative editor must not hold session replacement indefinitely.
        timeout = setTimeout(() => child.kill("SIGKILL"), 1000);
        timeout.unref();
      }
      // Pi keeps the outgoing context valid until this handler completes. Wait
      // for BOTH process exit and dialog cleanup before a new editor can exist.
      await opening;
      if (event && event.reason !== "quit") restore?.();
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  });
  pi.events.on(OPEN_FILE_EVENT, (data) => {
    if (!sessionContext || !isOpenFileRequest(data) || data.accepted) return;
    data.accepted = true;
    if (opening) return;
    opening = openFile({ path: data.path, cwd: data.cwd, tool: data.tool }).finally(() => {
      opening = undefined;
    });
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
    if (!ctx) return;

    try {
      // Let mouse dispatch finish before changing terminal ownership.
      await yieldToEventLoop();
      if (sessionContext !== ctx) return;
      const path = await resolveToolFile(file);
      if (sessionContext !== ctx) return;
      const info = await stat(path);
      if (sessionContext !== ctx) return;
      if (!info.isFile()) throw new Error("Only regular files can be opened in Vim.");

      const failure = await ctx.ui.custom<{ error: unknown } | undefined>(
        async (tui, _theme, _keys, done) => {
          let failure: { error: unknown } | undefined;
          let restored = false;
          const restore = () => {
            if (restored) return;
            restored = true;
            tui.start();
            tui.requestRender(true);
          };
          restoreTerminal = restore;
          try {
            tui.stop();
            process.stdout.write("\x1b[2J\x1b[H");
            // Let stdin pause before starting the child; never block Pi's event loop.
            await yieldToEventLoop();
            if (sessionContext === ctx) await runEditor(path, file.cwd);
          } catch (error) {
            failure = { error };
          } finally {
            // done() synchronously restores Pi's opening snapshot. Replace it
            // with the LATEST draft in the same turn, including on spawn/exit
            // failure. Never reject the factory into Pi's separate error cleanup.
            const draft = ctx.ui.getEditorText();
            done(failure);
            ctx.ui.setEditorText(draft);
            if (sessionContext === ctx) restore();
            if (restoreTerminal === restore) restoreTerminal = undefined;
          }
          return { render: () => [], invalidate() {} };
        },
      );
      if (failure) throw failure.error;
    } catch (error) {
      if (sessionContext === ctx) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    }
  }
}
