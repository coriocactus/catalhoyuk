# Interupt

Interupt makes `Esc` stop a running response only on its second press. The first press arms the stop for 1.5 seconds. It also draws the prompt editor in a box, which carries the labels of Pi's footer, and hides the footer.

## Usage

- While a response runs, press `Esc`. The working message becomes `Press Esc again to stop`.
- Press `Esc` again within 1.5 seconds. Pi stops the response natively, restoring queued messages.
- Press any other key, or wait 1.5 seconds. The stop is disarmed, the working message returns, and the key is handled as usual.

`Esc` stays native when Pi is idle, while it compacts the context or waits to retry a failed request (its own message then says that `Esc` cancels), when the autocomplete menu is open, in dialogs, and when `app.interrupt` is bound to another key.

## The box

```text
╭────────────────────────────────────────── ↑6.7k ↓359k ─ (anthropic) claude-opus-5-5 • xhigh ─╮
│ the draft                                                                                    │
│                                                                                              │
│                                                                                              │
╰─ ⠋ Working ─────────────────────────────────────────────────────────── ~/catalhoyuk (main) ─╯
```

- **Borders** are in the theme's text colour, whatever the thinking level.
- **Top border:** the model on the right, as Pi's footer names it, and one of the session's statistics beside it, in Pi's footer format. A click on the statistic shows the next: tokens (`↑ ↓`), cache (`R W CH`), cost (`$`, with `(sub)` on a subscription), context (`%/window`, with `(auto)` while auto-compaction is on, in the warning colour past 70% and the error colour past 90%), then tokens again. On the left, `bash` or `bash (no context)` in Pi's colour for a shell command while the draft starts with `!` or `!!`, which Pi otherwise shows only as its border's colour, and Pi's `↑ N more` when its text scrolls. The wheel and other buttons on the top border reach Pi.
- **Bottom border:** on the left, while Pi works, what it is doing, then Pi's `↓ N more` and extensions' statuses (`ctx.ui.setStatus`), which Pi's footer showed on a line of their own. The directory on the right, with its git branch and the session's name.
- **Status:** Pi's spinner, in the terminal's cyan (`sky` in `shared/colours.ts`), and in the text colour what Pi is doing, from its own events, in the words of comrade's status line: `Waiting` while a request is out and nothing has come back, `Thinking` and `Writing` while the reply streams, with its output tokens, dim, when the provider counts them as it goes (once the count has moved past what it reported as the reply started, as Anthropic's does not until the reply ends), `Calling edit` while the model writes a call's arguments, and `Running bash`, or `Running 3 tools`, while Pi runs them. A script's own calls are the script's. One kind of these shows at least a second before another takes its place, so a quick call does not flash by; the same kind changes in place. `Press Esc again to stop` shows at once, and so does what else Pi waits on, in Pi's words: a retry's countdown, compaction, a branch summary. What does not fit is cut short with `…`. Idle, the left is empty.
- **Height:** at least three rows of text, more as the text grows, up to where Pi's editor scrolls its text (30% of the terminal, and at least five rows). Drag the top border up or down to resize the box within those bounds. A box dragged tall shrinks with the terminal, so its top border stays on screen. A drag ends when the terminal loses focus, as Pi's own capture does. A new session starts at three rows.
- **Command menu:** Pi's menu, and its clicks, stay below the box.
- **Selection:** each row marks where its text starts and ends, so [`prose`](../prose/README.md) leaves the borders, and the blank rows below the text, out of a selection.
- **Footer:** Pi's footer is hidden. While the box is not drawn, as while a dialog takes the editor's place or the terminal is too narrow, the labels show on one line where the footer was: the directory and extensions' statuses on the left, the statistic and the model on the right. The labels follow its rules from what Pi gives an extension: token counts summed from the session's entries, context usage from `ctx.getContextUsage()`, the model and thinking level, the git branch and provider count from the footer's data. A virtual model's routed model is not shown. Pi decides `(sub)` from its own subscription state; Interupt asks whether the provider uses OAuth.
- **Narrow:** the statistic goes first, then the model and directory are cut. Narrower than 12 columns, the editor is drawn as Pi draws it, with Pi's status on its top border and the labels' line below it, until the terminal widens.

## How it works

Interupt guards the prompt editor's input: the first `Esc` that matches `app.interrupt` arms the stop, and every other key reaches the editor. It guards the editor that another extension set through `ctx.ui.setEditorComponent`, if one did, and otherwise Pi's `CustomEditor` with the working indicator in its top border, as Pi's own editor has it (`embedWorkingStatus`). It arms only while that indicator shows a response running, where the hint can show: from the start of a turn until the response ends, or until compaction takes the indicator's place for the rest of the turn. A response starting or ending, compaction starting, and a session starting or shutting down, disarm the stop. Interupt runs in the interactive terminal only.

Pi keeps the `Up`/`Down` prompt history in the editor and does not copy it to an editor that replaces its own. It fills the guarded editor's history itself only after startup, so after `/reload`, `/new`, `/resume` or a fork, Interupt fills it the way Pi does: with the text of each user message on the session's current branch. Commands such as `/reload` and `!` shell commands entered before then are not restored, since the session does not record them as prompts.

An extension that sets its editor after Interupt replaces the guard unless it wraps the editor it finds, as Interupt does.

`box.ts` draws the box around the guarded editor, replacing its `render` and `handleMouse` on that editor alone, so another extension's editor is boxed as Pi's is. It draws Pi's editor two columns narrower and reads where Pi's text ends and its menu starts from two counts Pi's editor keeps as it draws (`renderedVisibleLineCount`, `renderedAutocompleteHeight`), which are private. It takes Pi's working status as Pi hands it to the editor (`setWorkingStatusIndicator`). If the editor is not Pi's, or Pi's editor or status draws in another shape, or anything the box reads throws as it draws, the box warns once and for good: the editor is drawn as Pi draws it, with the status on its top border, and Pi's footer comes back. Until `/reload`, later sessions keep Pi's footer and editor without trying the box again. Upgrade review watches the modules the box follows: Pi's editor, footer, and status indicator. `labels.ts` builds the footer's labels as the box draws them: the session's totals are kept until its leaf or model changes, only the statistic shown is worked out, and whether auto-compaction is on is read from the settings at most once a second. Pi draws the editor before the footer, so the footer's stand-in knows whether the box drew in a frame. Clicks below the top border reach Pi's editor on the rows where Pi drew them: blank rows count as below its text.

Apply changes with `/reload`.

See [development and tests](../README.md) for test instructions.
