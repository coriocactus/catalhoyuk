import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
  let reset = () => {};

  pi.on("session_start", (_event, ctx) => {
    reset();
    if (ctx.mode !== "tui") return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    reset = () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      ctx.ui.setWorkingMessage();
    };

    // Guard only the main editor: dialogs retain their own Escape handling.
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) =>
        new (class extends CustomEditor {
          handleInput(data: string): void {
            if (
              matchesKey(data, "escape") &&
              keybindings.matches(data, "app.interrupt") &&
              !ctx.isIdle() &&
              !this.isShowingAutocomplete() &&
              timer === undefined
            ) {
              timer = setTimeout(reset, 1500);
              // Replace "Working" beside the existing spinner, without adding a row.
              ctx.ui.setWorkingMessage("Press Esc again to stop");
              return;
            }

            reset();
            // Let Pi perform the normal abort, including restoring queued messages.
            super.handleInput(data);
          }
        })(tui, theme, keybindings, { embedWorkingStatus: true }),
    );
  });

  pi.on("agent_start", () => reset());
  pi.on("agent_end", () => reset());
  pi.on("session_shutdown", () => reset());
}
