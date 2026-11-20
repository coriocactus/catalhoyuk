# Interupt

Interupt makes `Esc` stop a running response only on its second press. The first press arms the stop for 1.5 seconds.

## Usage

- While a response runs, press `Esc`. The working message becomes `Press Esc again to stop`.
- Press `Esc` again within 1.5 seconds. Pi stops the response natively, restoring queued messages.
- Press any other key, or wait 1.5 seconds. The stop is disarmed, the working message returns, and the key is handled as usual.

`Esc` stays native when Pi is idle, while it compacts the context or waits to retry a failed request (its own message then says that `Esc` cancels), when the autocomplete menu is open, in dialogs, and when `app.interrupt` is bound to another key.

## How it works

Interupt guards the prompt editor's input: the first `Esc` that matches `app.interrupt` arms the stop, and every other key reaches the editor. It guards the editor that another extension set through `ctx.ui.setEditorComponent`, if one did, and otherwise Pi's `CustomEditor` with the working indicator in its top border, as Pi's own editor has it (`embedWorkingStatus`). It arms only while that indicator shows a response running, where the hint can show: from the start of a turn until the response ends, or until compaction takes the indicator's place for the rest of the turn. A response starting or ending, compaction starting, and a session starting or shutting down, disarm the stop. Interupt runs in the interactive terminal only and uses no private Pi API.

Pi keeps the `Up`/`Down` prompt history in the editor and does not copy it to an editor that replaces its own. It fills the guarded editor's history itself only after startup, so after `/reload`, `/new`, `/resume` or a fork, Interupt fills it the way Pi does: with the text of each user message on the session's current branch. Commands such as `/reload` and `!` shell commands entered before then are not restored, since the session does not record them as prompts.

An extension that sets its editor after Interupt replaces the guard unless it wraps the editor it finds, as Interupt does.

Apply changes with `/reload`.

See [development and tests](../README.md) for test instructions.
