import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { type FileReference, isOpenFileRequest, OPEN_FILE_EVENT } from "../shared/protocol.ts";
import { type FileLink, fileLink, installLinkOpener, isTextFile, type Opener } from "./links.ts";
import { resolveToolFile } from "./paths.ts";

/**
 * Owns the editor process and terminal handoff, not tool rendering: a call's filename that mirage
 * reports, and a clicked link to a text file.
 */
export default function (pi: ExtensionAPI) {
  let sessionContext: ExtensionContext | undefined;
  let opening: Promise<void> | undefined;
  let editorProcess: ChildProcess | undefined;
  let restoreTerminal: (() => void) | undefined;
  // Never a UI message in the middle of Pi's mouse handling.
  const report = (message: string) =>
    queueMicrotask(() => sessionContext?.ui.notify(`Inspector: ${message}`, "warning"));
  // A link can be clicked as soon as the transcript shows, which Pi draws before session_start.
  let links: { release(): void } | undefined = installLinkOpener(takeLink, report);

  pi.on("session_start", (_event, ctx) => {
    sessionContext = ctx.mode === "tui" ? ctx : undefined;
    links ??= installLinkOpener(takeLink, report);
  });
  pi.on("session_shutdown", async (event) => {
    sessionContext = undefined;
    links?.release();
    links = undefined;
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

  /**
   * A clicked link to a local file is inspector's to open while a session shows the editor. The
   * click is taken at once; a file that turns out not to be text goes back to Pi's opener.
   */
  function takeLink(url: string, fallback: Opener): boolean {
    const link = fileLink(url);
    if (!link || !sessionContext) return false;
    // An editor has the terminal already: the click is spent, as one on a filename is.
    if (opening) return true;
    opening = openLink(link, () => fallback(url)).finally(() => {
      opening = undefined;
    });
    return true;
  }

  async function openLink(link: FileLink, fallback: () => void): Promise<void> {
    const ctx = sessionContext;
    if (!ctx) return;
    // Let mouse dispatch finish before changing terminal ownership.
    await yieldToEventLoop();
    let text = false;
    try {
      text = (await stat(link.path)).isFile() && (await isTextFile(link.path));
    } catch {
      // Gone or unreadable: Pi's opener says so in its own way.
    }
    if (sessionContext !== ctx) return;
    if (!text) return fallback();
    try {
      await edit(ctx, link.path, ctx.cwd, link.line);
    } catch (error) {
      if (sessionContext === ctx)
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }

  async function runEditor(path: string, cwd: string, line?: number): Promise<void> {
    const editor = process.env.VISUAL || process.env.EDITOR || "vim";
    // `+N` opens at a line, as Vim and most terminal editors read it.
    const args = [...(line ? [`+${line}`] : []), "--", path];
    const child = spawn(editor, args, { cwd, stdio: "inherit" });
    editorProcess = child;
    try {
      const [code, signal] = await once(child, "close");
      if (code !== 0) throw new Error(`${basename(editor)} exited with ${signal ?? code}.`);
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
      if (!info.isFile()) throw new Error("Only regular files can be opened in the editor.");
      await edit(ctx, path, file.cwd);
    } catch (error) {
      if (sessionContext === ctx) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    }
  }

  /**
   * Hands the terminal to the editor on `path`, and back once it exits, with the latest draft.
   * Throws why the editor failed.
   */
  async function edit(
    ctx: ExtensionContext,
    path: string,
    cwd: string,
    line?: number,
  ): Promise<void> {
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
          if (sessionContext === ctx) await runEditor(path, cwd, line);
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
  }
}
