import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installProse } from "./markdown.ts";

export default function (pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  let unsubscribe: (() => void) | undefined;
  const warnings: string[] = [];
  const flush = () => {
    if (context) for (const message of warnings.splice(0)) context.ui.notify(message, "warning");
  };
  const report = (message: string) => {
    warnings.push(message);
    queueMicrotask(flush); // Never add UI messages in the middle of a render.
  };
  // Pi rebuilds the transcript before session_start, so the adapter must exist at load.
  let release: (() => void) | undefined = installProse(report);
  pi.on("session_start", (event, ctx) => {
    release ??= installProse(report);
    // At startup Pi draws the transcript only after session_start, so a warning now would sit
    // above it, out of sight. It waits for the first key instead, and lands below the transcript.
    if (ctx.mode === "tui" && event.reason === "startup" && warnings.length) {
      unsubscribe = ctx.ui.onTerminalInput(() => {
        unsubscribe?.();
        unsubscribe = undefined;
        context = ctx;
        queueMicrotask(flush);
        return undefined;
      });
      return;
    }
    context = ctx;
    flush();
  });
  pi.on("session_shutdown", () => {
    unsubscribe?.();
    unsubscribe = undefined;
    context = undefined;
    release?.();
    release = undefined;
  });
}
