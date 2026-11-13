import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type EditorComponent, matchesKey } from "@earendil-works/pi-tui";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

/** How long a first Escape stays armed. */
const ARMED_MS = 1500;

export default function (pi: ExtensionAPI) {
  let reset = () => {};
  // The guarded editor this extension set, and the editor it guards, so that a second session
  // start guards the same editor again rather than its own guard.
  let guarded: EditorFactory | undefined;
  let inner: EditorFactory | undefined;

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

    // Guard only the main editor: dialogs retain their own Escape handling. An editor that
    // another extension set first is kept, and guarded in its place.
    const current = ctx.ui.getEditorComponent();
    const previous = current === guarded ? inner : current;
    inner = previous;
    guarded = (tui, theme, keybindings) => {
      const editor: EditorComponent =
        previous?.(tui, theme, keybindings) ??
        new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
      const handle = editor.handleInput.bind(editor);
      const completing = () =>
        "isShowingAutocomplete" in editor &&
        typeof editor.isShowingAutocomplete === "function" &&
        editor.isShowingAutocomplete() === true;
      editor.handleInput = (data) => {
        if (
          matchesKey(data, "escape") &&
          keybindings.matches(data, "app.interrupt") &&
          !ctx.isIdle() &&
          !completing() &&
          timer === undefined
        ) {
          timer = setTimeout(reset, ARMED_MS);
          // Replace "Working" beside the existing spinner, without adding a row.
          ctx.ui.setWorkingMessage("Press Esc again to stop");
          return;
        }

        reset();
        // Let Pi perform the normal abort, including restoring queued messages.
        handle(data);
      };
      return editor;
    };
    ctx.ui.setEditorComponent(guarded);
  });

  pi.on("agent_start", () => reset());
  pi.on("agent_end", () => reset());
  pi.on("session_shutdown", () => reset());
}
