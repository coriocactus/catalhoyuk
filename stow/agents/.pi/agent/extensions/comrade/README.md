# Comrade

Comrade adds two tools. `comrade` hands a self-contained task to a fresh Pi process, a comrade, and returns its answer. `comrades` lists the background runs in progress and stops them.

Every comrade has a number (`#N`) and keeps its conversation. The caller continues it with `to: N` instead of briefing a new comrade, and the same call reaches a comrade while it runs. A background run that Pi exited during is resumed when its session next starts.

One `comrade` call does what running Pi from a shell would:

```sh
pi -p --model anthropic/claude-opus-5-5 --thinking xhigh --session comrade-3.jsonl --tools read "$(cat task.md)"
```

`files` attaches files as `@file` arguments do. `output` and `timeout` do what a redirect and `timeout` would.

## Parameters

| Parameter | Default and meaning |
| --- | --- |
| `title` | 3–6 words naming the work, like a commit subject (`Review parser error paths`). It names the comrade's row, its widget line, and its delivery, on one line of at most 60 characters. The schema requires it, so models give one. A call without one still runs: its row is named by the task's first line, dim. With `to`, the comrade keeps its title unless given another. |
| `task` | Required. Complete instructions: the comrade sees nothing else of the caller's conversation. With `to`, only the next message to that comrade. |
| `to` | None, which starts a new comrade. The number of a comrade to continue: `task` becomes the next message in its conversation. While comrade #N runs, `task` is sent to it as a steer, and no other parameter may be given. See [Follow-ups](#follow-ups) and [Steers](#steers). |
| `model` | The caller's model, or with `to`, the comrade's own. Always `provider/id` as Pi lists it, such as `anthropic/claude-fable-5-2` or `openrouter/google/gemini-4-carbon`, optionally with a `:thinking` suffix. It must be a model enabled here, the set Pi's model picker offers: the session's scoped models (`enabledModels` in settings, or `--models`), or with no scope, every model with credentials. A bare, unknown, or disabled name is refused with the names to use. The caller's own model is allowed even outside the scope. The parameter's description names every enabled model, or with no scope, the caller's own as the example. Comrade registers the tool again when `/scoped-models` changes them. The comrade's Pi gets the provider and the id separately (`--provider anthropic --model claude-fable-5-2`), so it cannot resolve the name under another provider that lists the same id, such as OpenRouter. |
| `thinking` | The `:thinking` suffix of `model` if given, otherwise the caller's thinking level, or with `to`, the comrade's own. An explicit `thinking` overrides both. |
| `tools` | Read-only: `["read", "grep", "find", "ls"]`, or with `to`, the comrade's own. Add `"edit"` and `"write"` to let the comrade change files, and `"bash"` to let it run commands. `[]` gives it no tools. Names and `*` patterns must match a tool active in the caller, whose own tools are the ceiling. A Pi started with `--tools read` cannot hand a comrade `bash`, and a tool turned off with `/tools` is off for comrades too. The default leaves out any read-only tool that is not active. Pi's default tools have no `grep`, `find`, or `ls`, so there the default is `["read"]`. The parameter's description names the default as it resolves in this session, and Comrade registers the tool again when `/tools` changes it. |
| `files` | None. Files to attach, text or images. Each follows the task as a `<file name="...">` block, as Pi's `@file` arguments build them, so the comrade has them without reading them. Paths resolve from the working directory, and `~` is the home directory. A missing file or a directory is refused before the comrade starts. Prefer `files` with `tools: []` to letting the comrade read many files: a model reading on its own can loop. |
| `output` | None. Writes the whole answer to this file, creating its directory, and returns only the answer's first 20 lines and the path. For an answer that feeds a file or a build. |
| `cwd` | The caller's working directory, or with `to`, the comrade's own. The directory the comrade runs in, resolved from the working directory, with `~` as the home directory. It must exist. `files` and `output` still resolve from the caller's directory. The caller's project trust is passed on only for a directory inside the caller's own. Elsewhere the comrade runs with `--no-approve`, so no project-local files load there. The row's header says `in <dir>` when the directory is not the caller's, relative to the caller's directory when inside it. |
| `timeout` | None: a comrade runs until it answers, and only `Esc` or `comrades` with `stop` ends it sooner. Seconds before the comrade is stopped, as `Esc` stops it. It is for a hard stop only, and the parameter's description tells the model to leave it unset for open-ended work. The result then says the comrade timed out and gives the text it had. The comrade can be continued with `to`. |
| `background` | `false`: the call waits for the answer and returns it. |

## How a run works

Comrade starts the same Pi release as the caller: the caller's script under the caller's runtime. If an upgrade such as `brew upgrade node` deleted that runtime mid-session, the runtime of the same name on `PATH` takes its place. The comrade's Pi runs with `--mode rpc --session <file>` in the caller's working directory, or `cwd`, with the caller's project trust (`--approve` or `--no-approve`). Context files, skills, and extensions load as usual. An extension in the comrade sees `ctx.mode` as `"rpc"`, and a dialog it opens (`select`, `confirm`, `input`, `editor`) is cancelled at once, since no one is there to answer. An explicit tool list replaces Pi's default tools, so `codemode` is off unless `tools` names it.

The task is sent as an RPC `prompt` command on the comrade's standard input, never through a shell or the command line. No argument length limit applies, and a task that starts with `@` or `-` is not taken for a file or an option. RPC mode takes no `@file` arguments, so Comrade builds what they would: the task, a blank line, then each file's `<file name="...">` block. A text file's content goes inline, without a byte-order mark. An image goes as an attachment, with an empty block naming it, and Pi converts and resizes it for the model as it does for `@file`. Empty files are skipped, as Pi skips them.

The task goes as a follow-up prompt, so work that an extension in the comrade started first takes it when it is done. Once the comrade's Pi reports `agent_settled` and has answered every message sent to it (see [Steers](#steers)), Comrade closes its standard input, which shuts that Pi down. From then on the answer stands: `timeout` and `Esc` no longer apply, and a Pi that has not exited within ten seconds is stopped. A run ends when its Pi exits. If a process the comrade started still holds its output, Comrade reads what is left for one second and moves on. A prompt that Pi refuses before any work, such as one for a provider without credentials, fails the run with Pi's reason. So does a run that fails before it starts.

An answer over 2000 lines or 50KB is truncated for the caller. The whole answer is saved beside the comrade's conversation as `comrade-N.answer.md` (`comrade-N.answer.2.md` for a later run of the same comrade), readable by the user only, and the result names that file. With `output`, the answer goes to that file instead and no copy is made. A provider failure, a non-zero exit of the comrade's Pi (with its `stderr`), an empty answer, and an unknown model, tool, directory, or file all return to the caller as tool errors.

Comrade reads the comrade's event stream as Pi's `JsonAgentSessionEvent` type declares it. It writes and reads commands, responses, and dialogs as Pi's `RpcCommand`, `RpcResponse`, and `RpcExtensionUIRequest` types declare them. `pi-diff` therefore watches the modules that define that format. The messages in the stream are another process's word, so each is checked before a row draws it (`isConversationMessage`), and one that is not in shape is passed over. Messages read back from a conversation file get the same check. Pi's `agent_end` and `turn_end` records repeat messages it has already sent, so Comrade skips both without parsing them. `npm test` also runs a comrade in the installed Pi, against an offline provider, to check the prompt, the flags, the session file, attached files, a steer, and the events.

A comrade cannot start comrades. The host sets `PI_COMRADE` to its own process id in the comrade's environment, and the extension registers no tool where that variable is set. In a comrade it instead checks every two seconds, from the session's start, that the host is still running, and sends itself `SIGTERM` once it is not. Comrades of a Pi that crashed or was killed therefore do not run on unseen. Pi's own shutdown stops them directly.

Comrade has no runtime dependencies and uses no private Pi API. Besides the running processes, its only state is each comrade's conversation, an ordinary Pi session file, and a run record beside it (see [Background runs](#background-runs)).

## What the caller reads

The caller never sees the row, so the result's text carries what the row shows. A run line ends every result except a stop, failures included:

```text
[comrade #3: openrouter/google/gemini-4-carbon:high · 1 turn · 0 calls · ↑312k ↓9k · $0.31 · 1m 48s · stop]
```

The number at its start is what a follow-up's `to` takes. Its last part is the stop reason of the comrade's last turn.

| Ending | Result |
| --- | --- |
| Finished | The answer, then the run line. |
| Partial answer: the last turn ended for a reason other than `stop`, usually `length`, the model's output token limit | A result, not an error, since partial text can be useful. Its first line says so: `[Comrade's answer is cut off: its last turn ended with stopReason "length", the model's output token limit. It is not a final answer.]` |
| Timed out | An error. Its first line is `[Comrade timed out after 10m 0s and was stopped. Its last text follows. It is not a final answer.]`, then that text. With no text: `Comrade timed out after 10m 0s and was stopped.` |
| Stopped with `Esc`, in the foreground | `Comrade #N stopped.` |

## Follow-ups

Each comrade's conversation is a Pi session file beside the caller's session. For the session `~/.pi/agent/sessions/<cwd>/<stamp>_<id>.jsonl`, comrade #3 is `<stamp>_<id>.comrades/comrade-3.jsonl`. When the caller's session is not saved, conversations go in `$TMPDIR/pi-comrades/<session id>/`. Pi's session lists ignore the subdirectory. A row never prints the file, but `pi --session <file>` opens it, and an expanded row reads what the comrade did from it.

A call with `to: N` runs Pi again on comrade #N's file, with `task` as the next prompt. The comrade still has its first task, its attached files, what it read, and what it answered, so the caller sends only the new message: a correction, a question about the answer, or the next step. The comrade keeps its model, thinking level, and tools unless the call passes others, which then become its own. `files`, `output`, `timeout`, and `background` apply to that run as usual. The follow-up's row shows that run alone, and a background follow-up's answer arrives as another `[comrade #N …]` delivery.

### After an interrupted run

A comrade whose last run was interrupted (stopped, timed out, or its Pi exited) first reads a note saying so, ahead of the new message. The row shows the message as the caller sent it, without the note. The note:

- Names the calls that had not finished cleanly. Pi gives a call it stops only an error result, so each may or may not have taken effect.
- Asks the comrade to check what they did before it repeats any that change files or run commands.
- Says how long ago the run stopped, if that is more than ten minutes, since files may have changed.

Comrade reads this from the end of the comrade's conversation. A run was interrupted when its task has no reply, or when its last reply asked for calls that did not all answer, ended in an error (Pi was retrying a failed request, or gave up), or was itself aborted. Pi stops a run in the middle of its calls by aborting them and then the reply it was about to request, so the calls named are those of the last reply that ran any.

### Refused follow-ups

A follow-up is refused, before anything starts, when:

- another live Pi runs comrade #N now, as its run record says;
- comrade #N is not on the current branch of the caller's session;
- comrade #N ran before comrades kept their conversations;
- its file is gone, or was never written to because the comrade failed before Pi started.

Comrades are numbered across all branches of the session. A new comrade claims its number by creating its conversation file empty before Pi starts (Pi starts a session in an empty file as in a missing one), and a number whose file exists is skipped. A new comrade therefore never continues another's conversation, even with a session and its fork open side by side. Branches of the caller's session share their comrades' files: continuing comrade #N on two branches continues one conversation.

### Steers

A call with `to: N` while comrade #N runs sends `task` to it as a steer and starts no run. Pi queues the steer and gives it to the comrade once its current calls finish, before its next model request. The call returns once Pi has taken the steer, saying it was sent. The comrade's answer comes as it would have: from the call that started the run, or as a delivery.

- The steer reaches the comrade behind a line saying it came from the agent that started it. The line asks for a complete final answer covering the task and the steer: the comrade may have been finishing its answer when the steer arrived, and its last reply is what comes back.
- Only `task` may be given. A running comrade's model, tools, files, directory, output, and timeout are fixed until its answer arrives.
- Its row is one line, `→ Comrade #N  <message>  sent`. Expanded, it shows the whole message.

Each steer goes as an RPC `prompt` with `streamingBehavior: "steer"`, so none is left in a queue that nothing reads. One that arrives while the comrade works joins that work, and Pi takes what is still queued before it settles. One that arrives as the comrade's Pi settles makes it work again, and Comrade waits for Pi's answer to every steer before it closes the comrade's standard input, so the run takes it in. A steer sent before the comrade's Pi has started is held and sent once it has. A steer that an extension in the comrade takes instead (Pi answers `handled`) is an error. So is one sent after the comrade has ended, which says its answer is on its way. `Esc` ends the wait for Pi to take a steer, not the comrade, and the steer may still reach it.

## Foreground runs

By default (`background: false`) the call waits until the comrade finishes. Several `comrade` calls in one message run in parallel. `Esc` stops the running comrade with `SIGTERM`, and with `SIGKILL` five seconds later if it has not exited. The tokens and cost of foreground runs count in the caller's session totals.

## Background runs

Background is for a caller with other work to do before it needs the answer. A caller that would only wait does better in the foreground, which shows progress, and several foreground calls in one message already run in parallel.

With `background: true` the call returns at once with the comrade's number, and the caller works on. When the run ends, its answer arrives as a `[comrade #N finished]` (or `failed`) delivery. It is delivered after the caller's current work, or at once if the caller is idle, when it starts a turn to handle the answer.

A caller does not end its turn while its background runs go on. If it finishes its other work first, its turn waits, using no tokens. The editor then shows `Waiting for comrade #N` in place of `Working`, or `Waiting for comrades` with several, which the widget above the editor names. The first answer to arrive continues the turn, and the caller waits again if more runs go on. A message you type, or `Esc`, ends the wait at once: the comrades keep running, and their answers arrive as before. The wait happens only in the terminal UI, where `Esc` can end it.

- **Listing and stopping.** `comrades` lists the runs in progress by number and title, with what each is doing and its cost so far, and a total when there are several, since background costs are not in the session's totals. `comrades` with `stop: [N]` stops runs the caller no longer needs: the call waits for them to exit, and no delivery arrives for them. `/comrades` and `/comrades stop <n|all>` do the same for you. When you stop a comrade, the caller is told without a turn starting.
- **Limits.** At most four background runs go on at once. A background run's `timeout` still applies, and one that runs out is delivered as `failed`.
- **`/reload`.** Background runs keep going, and the reloaded extension delivers their answers, including any that finished during the reload.
- **Leaving the session.** Quitting Pi, `/new`, `/resume`, and `/fork` stop the runs and wait for their Pis to exit. Each Pi records the calls it interrupted as it stops.
- **Print and JSON modes.** These exit when the turn ends, before a delivery could arrive, so a `background: true` call there waits in the foreground and says so in its result.
- **Cost.** Pi leaves custom messages out of session usage totals, so a background run's cost shows on its delivery and is not added to the session's totals.

### Run records

Each run has a run record beside its conversation (`comrade-N.runs.json`). It holds:

- which Pi hosts the run, and the comrade's Pi;
- whether Pi has saved the run's prompt in the comrade's conversation;
- what the run sends: task, files, output, timeout;
- once it ends, a background run's answer.

The answer is saved before it is sent. Pi holds a message that arrives during a turn in memory until the turn ends, so an answer that Pi exits with first, or that `Esc` clears, would otherwise be lost. A record goes once the caller's session holds the run's answer, or for a foreground run, once its call returns.

In the terminal, once the caller has settled and stayed idle for one second, saved answers that the session does not hold are sent again without starting a turn. An answer that `Esc` or Pi's dequeue key took from the queue is one. This happens only in the terminal, which clears the queue whenever it aborts a turn. An abort elsewhere, such as RPC's `abort`, leaves the answer queued for the next turn, so sending it again would deliver it twice. There, an answer that never arrived is delivered when the session next starts.

### Reconciling

When the session starts again, in the terminal or in RPC mode, Comrade reconciles each background run on the current branch that never answered, without starting a turn:

| The run | What happens |
| --- | --- |
| Its run record holds its answer. | The answer is delivered. |
| Another branch holds its answer. | The answer is delivered here too. |
| Another live Pi hosts it now. | It is left to that Pi, with a notice. |
| Its conversation shows that it answered: Pi exited before the answer came back. | The answer is delivered from the conversation, without running again. |
| It was interrupted within the last day. | It is resumed: see below. |
| It was interrupted longer ago, or cannot be resumed. | It is reported `lost` with the reason, and with `Continue it with to: N` when its conversation is saved. |

A resumed run continues in its conversation with its model, thinking level, tools, and directory, and with its call's `output` and `timeout`. If its prompt never reached the comrade, the prompt is sent again. Otherwise the comrade reads the note described in [After an interrupted run](#after-an-interrupted-run) and is asked to carry on and end with its final answer. A `[comrade #N resumed]` message records this. The answer arrives as another `[comrade #N …]` delivery, which does start a turn. Expanded, that delivery shows what both runs did, with the note between them.

A run cannot be resumed when its directory or an attached file is gone, or when it ran before comrades kept run records and its conversation shows no interruption. At most four runs are resumed at once, and the rest wait for the session's next start. Print and JSON modes end with their turn, so nothing is resumed there, and such runs are left for a session that can. Comrade numbers stay unique across the session.

## Rows

Rows are flat, as mirage draws its own, with no box behind them. They use mirage's green and red, not the theme's: both extensions take them from `shared/colours.ts`.

Collapsed, a row is one line: a glyph, `Comrade #N`, its title, what the run used that is not the caller's (another model, another directory), then its ending, cost, and time, and a caret.

```text
✓ Comrade #3  Review parser error paths  $0.71 · 12m 43s ▸
✓ Comrade #4  List lexer exports  claude-fable-5-2:high · in packages/lexer  $0.08 · 1m 2s ▸
✗ Comrade #5  Port tabs to motion  failed · $0.02 · 3.1s ▸
  No credentials for provider openrouter
! Comrade #6  Draft migration guide  cut off · $2.40 · 6m 11s ▸
  Reached its output token limit. The answer is partial.
✗ Comrade #7  Check Safari focus ring  stopped · $0.12 · 48.0s ▸
```

A run that did not finish says why under its header, in up to three lines, and in full once expanded. The reason is Pi's error for a failure, the limit it ran past for a timeout, and the output limit for a partial answer. A stopped run gives no reason. A row without a title is named by the task's first line, dim.

The title gives way so that the rest of the header always fits. Below 80 columns the model and directory go, and below 60 the cost. The header says nothing else about the run: its tools, turns, and tokens are in the run line the caller reads, and the conversation's file is never printed.

### In progress

A run in progress shows Pi's working spinner in the accent colour, as the editor and mirage's rows do, and its clock ticks in whole seconds. Two lines follow its header and change in place, so the row keeps its height:

```text
⠋ Comrade #3  Review parser error paths  $0.31 · 4m 12s ▸
  ⠋ Reading ~/project/src/lexer.ts:40-120
  parseList swallows the error that parseBlock rethrows.
```

1. **What it is doing.** The call in progress, as mirage names it, with the spinner, or mirage's line for the group when several are in progress (`⠋ Exploring 3 files`). Between calls, what it waits on, and otherwise the last call it made. While the line below shows the words it thinks or writes, this line names the last call instead of labelling them.
2. **What it said last.** The last complete sentence or line it said, in italics, without Markdown's marks. A half-written sentence never shows: the line changes when one is complete. When it does not fit, the newest words win: earlier sentences on the line go first, and only a sentence too long by itself is cut. It stays through later turns, dimmer, until the comrade says more. Its thinking shows here only where Pi shows thinking (`Ctrl+T`). Until it has said anything, the line has its tokens so far.

| What it waits on | While |
| --- | --- |
| `starting` | Pi loads. |
| `waiting` | A request is out and nothing has streamed back. Some providers, such as Gemini through OpenRouter, send nothing until the reply is done, so this can last minutes on a long first turn. After the first turn it says how long: `waiting 48s`. |
| `thinking`, `writing` | The reply streams. Streamed text updates the row at most every 250ms. |
| `calling edit` | The model writes a call's arguments. |
| `retrying · 1/3 · 529 overloaded` | Pi retries a failed request, in the warning colour. |
| `compacting its context` | Pi compacts the comrade's context. |

The tokens, `↑1.0k ↓~2.0k`, are those of the finished messages plus the streaming one, in Pi's footer format (`805`, `7.2k`, `41k`). Providers count differently as they go. Google reports cumulative usage with every chunk, Anthropic reports the input at the start and the output at the end, and OpenAI and OpenRouter report only at the end. So `↑` appears once the provider has counted the input. `↓` is estimated from the streamed characters, at four per token, and marked `~` until the provider's own count has moved, which then replaces it.

The spinner costs no frame of its own while Pi's working indicator turns: a row reads its frame from the clock when Pi draws it (`shared/spinner.ts`). A row drawn again builds nothing until its run has said or done more (`transcripts.ts`).

### Expanded

`Ctrl+O` expands every row, and a click expands or collapses one row, as on any tool row. Expanded, a row is the run in order: its task behind a bar, then what the comrade did, as Pi's transcript shows Pi's own work. That is what it said, its thinking where Pi shows thinking, the steers sent to it, and its calls.

```text
✓ Comrade #3  Review parser error paths  $0.71 · 12m 43s ▾

  │ Review the parser for unhandled errors.
  │ …
  … 4 more lines ▸

  Reading the parser first.

  ✓ Explored 3 files, ran 2 searches ▸

  parseList swallows the error that parseBlock rethrows. Fixing it.

  ✓ Edited ~/project/src/parser.ts +14 −3 ▸
  $ npm test -- parser ▸

  (the answer)
```

- **Calls.** Where mirage is loaded, mirage draws the comrade's calls, in groups by its own rules, as it draws Pi's. A click expands a group, a command shows on its own lines with how it exited (`(exit code: 1)`), an edit shows its diff, and a filename opens in inspector. Comrade asks for them over Pi's event bus (`shared/nested.ts`), so neither extension needs the other. They start collapsed whatever `Ctrl+O` says, so an expanded row reads at a glance. Without mirage, each call is one line in mirage's wording: `✓ Read ~/p`, `$ npm test (exit code: 1)`, `✗ Read ~/q  ENOENT: no such file or directory`. A command of several lines shows its first and `…`.
- **Length.** An expanded row shows the latest 24 pieces of the run (its words, thoughts, and groups of calls) after `… N earlier ▸`, which a click expands. A task longer than six lines shows its first six and `… N more lines ▸`, which a click expands.
- **Thinking.** It follows Pi's `Ctrl+T` in rows already drawn. Through mirage, it changes at once. Without mirage, it comes from Pi's `hideThinkingBlock` setting, which `Ctrl+T` saves, read at most every 250ms when a row is drawn.
- **In progress.** An expanded row grows as the comrade works, and ends with what it waits on when that is not a call. To bound memory, the row keeps the run's messages without images, and each call's result up to its first 32,000 characters.
- **Ended.** The first time it is expanded, a row reads the run from the last 4 MB of the comrade's conversation, so a row from an earlier session expands the same. A run that ended before those 4 MB, a row from before comrades showed their work, and a row whose conversation was deleted show a summary of the run's calls instead, with the ones worth naming. A follow-up's row shows its own run, not the conversation before or after it.
- **Answer.** When the whole answer is in a file, the expanded row ends with `Full answer:` and its path. The row never shows the run line, or the first lines that tell the caller of a partial answer or a timeout: it shows the same facts in its own places.

### Background runs' rows

The start row of a background run is one line. It spins, with its cost and clock, while the run goes on, and becomes dim history once the run has ended, saying how it went once the session holds the answer. Expanded while the run goes on, it shows the task and the work so far, also after `/reload`. The delivery looks like a finished foreground row. It shares its `#N` and title with the start row, repeats the task, and expanded, shows what the comrade did.

```text
⠋ Comrade #12  Glide indicators  background · $1.20 · 3m 2s ▸
↗ Comrade #12  Glide indicators  background · finished ▸
✓ Comrade #12  Glide indicators  $3.00 · 7m 40s ▸
```

A widget above the editor shows the runs in progress, in the terminal only, one column in as Pi's own lines are. Each run has one line: its number and title in columns, what it is doing, then its cost and clock at the right. A run that has ended keeps its line, saying its answer is queued, until the session holds the answer. Stopped runs leave at once, and the widget goes when it is empty. Its clocks tick once a second. It has no spinner, so Pi's own stays the only animation near the editor. Below 70 columns, what each run is doing goes first, then the title shrinks and goes, then the cost. The clock stays.

```text
 • #12  Glide indicators   Edited ~/x-govuk-ui/packages/core/src/tabs.tsx +12 −4   $1.20 · 3m 2s
 • #13  Small fixes        waiting 48s                                             $0.40 · 3m 1s
 ✓ #14  Audit bundle size  finished · answer queued                                $0.90 · 2m 10s
```

### Other rows

```text
→ Comrade #12  Glide indicators  "Keep the reduced-motion guard on every indicator"  sent ▸
↻ Comrade #12  Glide indicators  resumed ▸
✗ Comrade #9  Compare token sets  lost
  Not carried on: it stopped 25h 0m 3s ago. Continue it with to: 9.
```

A steer's row names the comrade by its title and expands to the whole message. A resumed run's message expands to the note the comrade read. A lost run's message says why, and how to continue the comrade when that is possible.

## Architecture

`index.ts` wires the parts together and listens to Pi's session events. Each part is one module:

| Module | What it owns |
| --- | --- |
| `tool.ts` | The `comrade` tool: its parameters, what running it does, and how a steer reaches a comrade. |
| `request.ts` | Turning the caller's arguments into a run request, and refusing what the comrade could not use. |
| `run.ts` | One run: the comrade's Pi, its event stream folded into progress, and its outcome. |
| `answer.ts` | What the caller reads of a run. |
| `conversation.ts` | Where a conversation is kept, and what a later run needs to continue it. |
| `runs.ts` | Run records. |
| `resume.ts` | A run as its conversation shows it: interrupted, with the calls that may have taken effect, or finished. |
| `background.ts` | Jobs: the background runs in progress in this Pi. |
| `outbox.ts` | Delivering a background run's answer into the session, at least once. |
| `reconcile.ts` | Reconciling at session start. |
| `rows.ts` | What each row shows, and keeping the rows in progress turning. |
| `view.ts` | How a row looks. |
| `transcripts.ts` | What each run did, for its row, built as the run's messages arrive. |
| `work.ts` | What a comrade did, folded into counts by kind and the calls worth naming. |
| `details.ts` | Run details: what the session keeps of each row. |
| `widget.ts` | The widget above the editor. |
| `pi.ts`, `session.ts` | The Pi a comrade runs and the watch on its host, and what every part knows of the open session. |

See [development and tests](../README.md) for test instructions.
