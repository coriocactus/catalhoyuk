import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type ReadonlyFooterDataProvider,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { type EditorComponent, matchesKey } from "@earendil-works/pi-tui";
import { trackActivity } from "./activity.ts";
import { type Boxed, boxEditor, labelLine } from "./box.ts";
import { createLabels } from "./labels.ts";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

/** How long a first Escape stays armed. */
const ARMED_MS = 1500;

/**
 * The session's prompts, oldest first, as Pi adds them to the editor's history when it draws
 * the session: the text of each user message on the current branch.
 */
function prompts(ctx: ExtensionContext): string[] {
  const texts: string[] = [];
  for (const entry of ctx.sessionManager.buildContextEntries()) {
    for (const message of sessionEntryToContextMessages(entry)) {
      if (message.role !== "user") continue;
      const { content } = message;
      const text =
        typeof content === "string"
          ? content
          : content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
      if (text) texts.push(text);
    }
  }
  return texts;
}

export default function (pi: ExtensionAPI) {
  let reset = () => {};
  const labels = createLabels(pi);
  const activity = trackActivity(pi);
  // Whether Pi's working indicator, which carries the hint, is up for a running response: from a
  // turn's start until the response ends, or until compaction replaces it for the rest of the turn.
  // Elsewhere, as while Pi compacts or waits to retry, Pi's own indicator says that Esc cancels.
  let working = false;
  // The guarded editor this extension set, and the editor it guards, so that a second session
  // start guards the same editor again rather than its own guard.
  let guarded: EditorFactory | undefined;
  let inner: EditorFactory | undefined;
  // Once the box could not draw, it is not tried again until /reload: a new session would hide
  // the footer and warn again for the same reason.
  let unboxable = false;

  pi.on("session_start", (event, ctx) => {
    reset();
    if (ctx.mode !== "tui") return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    reset = () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      ctx.ui.setWorkingMessage();
    };

    // Pi's footer is hidden: the editor's box carries its labels. Its data provider is kept, for
    // the git branch, how many providers there are, and extensions' statuses. Pi draws the editor
    // before the footer, so the footer knows whether the box drew: on a frame without it, as
    // while a dialog takes the editor's place, the footer draws the labels on one line.
    let footer: ReadonlyFooterDataProvider | undefined;
    let boxed: Boxed | undefined;
    if (!unboxable)
      ctx.ui.setFooter((_tui, _theme, data) => {
        footer = data;
        return {
          render: (width) =>
            !boxed || boxed.drew() ? [] : [labelLine(labels(ctx, footer), boxed.stat(), width)],
          invalidate() {},
        };
      });
    // Never a UI message in the middle of a render. The session may have ended by then.
    const later = (change: () => void) =>
      queueMicrotask(() => {
        try {
          change();
        } catch {}
      });
    const report = (message: string) =>
      later(() => ctx.ui.notify(`Interupt: ${message}`, "warning"));

    // Guard only the main editor: dialogs retain their own Escape handling. An editor that
    // another extension set first is kept, and guarded in its place.
    const current = ctx.ui.getEditorComponent();
    const previous = current === guarded ? inner : current;
    inner = previous;
    // Pi keeps the prompt history in the editor and does not hand it to an editor that replaces
    // its own. Only after a startup's session_start does Pi fill the history of the editor set
    // here; after a reload, new session, resume or fork, fill it the way Pi does.
    const history = event.reason === "startup" ? [] : prompts(ctx);
    guarded = (tui, theme, keybindings) => {
      const editor: EditorComponent =
        previous?.(tui, theme, keybindings) ??
        new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
      for (const text of history) editor.addToHistory?.(text);
      boxed = unboxable
        ? undefined
        : boxEditor(editor, {
            tui,
            theme: () => ctx.ui.theme,
            labels: () => labels(ctx, footer),
            // The box no longer draws: Pi's footer, whose labels it carried, comes back.
            unboxed: () => {
              unboxable = true;
              later(() => ctx.ui.setFooter(undefined));
            },
            // Armed, the hint; else what Pi is doing.
            status: () =>
              timer === undefined
                ? activity()
                : { kind: "armed", label: "Press Esc again to stop" },
            report,
          });
      const handle = editor.handleInput.bind(editor);
      const completing = () =>
        "isShowingAutocomplete" in editor &&
        typeof editor.isShowingAutocomplete === "function" &&
        editor.isShowingAutocomplete() === true;
      editor.handleInput = (data) => {
        if (
          matchesKey(data, "escape") &&
          keybindings.matches(data, "app.interrupt") &&
          working &&
          !ctx.isIdle() &&
          !completing() &&
          timer === undefined
        ) {
          timer = setTimeout(reset, ARMED_MS);
          // Replace "Working" beside the existing spinner, without adding a line.
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

  pi.on("turn_start", () => {
    working = true;
  });
  pi.on("session_before_compact", () => {
    working = false;
    reset();
  });
  pi.on("agent_start", () => reset());
  pi.on("agent_end", () => {
    working = false;
    reset();
  });
  pi.on("session_shutdown", () => reset());
}
