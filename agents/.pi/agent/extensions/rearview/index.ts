import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { TRANSCRIPT_VIEW } from "../shared/transcript.ts";
import { PAGE_SIZE } from "./model.ts";
import { installHistoryAdapter } from "./native.ts";

export default function (pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  let unsubscribe: (() => void) | undefined;
  let pending: ReturnType<typeof setImmediate> | undefined;
  const warnings: string[] = [];
  const adapter = installHistoryAdapter(
    (error) => {
      const message = `Rearview: ${error instanceof Error ? error.message : String(error)}`;
      if (context?.mode === "tui") context.ui.notify(message, "error");
      else warnings.push(message);
    },
    PAGE_SIZE,
    (view) => pi.events.emit(TRANSCRIPT_VIEW, view),
  );
  // Load-time registration also covers Pi's pre-session_start /reload rebuild.
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    if (ctx.mode !== "tui") return;
    for (const message of warnings.splice(0)) ctx.ui.notify(message, "error");
    unsubscribe?.();
    unsubscribe = ctx.ui.onTerminalInput(() => {
      // Run after Pi's key/settings handlers and their promise continuations.
      pending ??= setImmediate(() => {
        pending = undefined;
        adapter.synchronize();
      });
    });
    adapter.synchronize();
  });
  pi.on("session_tree", () => adapter.reset());
  pi.on("session_shutdown", () => {
    unsubscribe?.();
    unsubscribe = undefined;
    if (pending) clearImmediate(pending);
    pending = undefined;
    context = undefined;
    // Every replacement gets a new factory before transcript reconstruction.
    // The outgoing registration must never outlive its runtime.
    adapter.dispose();
  });
}
