import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { installProse } from "./markdown.ts";

export default function (pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
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
  pi.on("session_start", (_event, ctx) => {
    context = ctx;
    release ??= installProse(report);
    flush();
  });
  pi.on("session_shutdown", () => {
    context = undefined;
    release?.();
    release = undefined;
  });
}
