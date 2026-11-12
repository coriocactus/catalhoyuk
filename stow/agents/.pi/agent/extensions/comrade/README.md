# Comrade

Comrade registers a `comrade` tool that lets the model delegate a self-contained task to a fresh Pi process and receive its final answer, and a `comrades` tool for checking on and stopping background comrades. Every comrade is numbered (`#N`) and keeps its conversation, so the model can continue it with `to: N` instead of briefing a new one, or send it a message the same way while it runs. A background comrade that Pi exited during carries on when its session next starts. A single `comrade` call performs the equivalent of running Pi manually from the shell:

```sh
pi -p --model anthropic/claude-opus-5-5 --thinking xhigh --session comrade-3.jsonl --tools read "$(cat task.md)"
```

With `files`, it also attaches files as `@file` arguments do, and with `output` and `timeout` it does what a shell would do with a redirect and `timeout`.

## Parameters

| Parameter | Default |
| --- | --- |
| `title` | 3–6 words naming the job, like a commit subject (`Review parser error paths`). It names the comrade's row, its widget line and its delivered answer, and is kept to one line of at most 60 characters. The schema marks it required, so models give one; a call without one still runs, its row named by the task's first line, dim. With `to`, the comrade keeps its own unless given another. |
| `task` | Required. Complete instructions for the comrade, which sees nothing else from the parent conversation. With `to`, only the next message to that comrade. |
| `to` | None (start a new comrade). The number of a comrade to continue: `task` becomes the next message in its conversation. While comrade #N runs, `task` is sent to it instead, and no other parameter may be given. See [Follow-ups](#follow-ups) and [Messages while it runs](#messages-while-it-runs). |
| `model` | The caller's current model, or with `to`, the comrade's own. Always `provider/id`, exactly as Pi lists it, such as `anthropic/claude-fable-5-2` or `openrouter/google/gemini-4-argon`, optionally with a `:thinking` suffix. It must be one of the models enabled here, the same set Pi's model picker offers: the session's scoped models (`enabledModels` in settings, or `--models`), or with no scope, every model with credentials. Bare, unknown or disabled names are refused with the names to use. The parameter's description names every enabled model, or with no scope, the caller's own as the example, and Comrade re-registers the tool when `/scoped-models` changes them. The default, the caller's own model, is allowed even outside the scope. The comrade gets the provider and the id separately (`--provider anthropic --model claude-fable-5-2`), so Pi cannot resolve the name under another provider, such as OpenRouter, whose id for that model is the same text. |
| `thinking` | The `:thinking` suffix of `model` if given, otherwise the caller's current thinking level (with `to`, the comrade's own). An explicit `thinking` overrides both. |
| `tools` | Read-only: `["read", "grep", "find", "ls"]`, or with `to`, the comrade's own. Add `"edit"` and `"write"` to let the comrade change files, or `"bash"` to let it run commands. Names and `*` patterns must match a tool that is active in the caller: the caller's own tool set is the ceiling, so a Pi started with `--tools read` cannot hand a comrade `bash`, and a tool turned off with `/tools` is off for comrades too. The default drops any read-only tool that is not active: Pi's own default tool set has no `grep`, `find` or `ls`, so there it is just `["read"]`. The parameter's description names the default as it resolves in this session, so the model is not told of tools it cannot hand on, and Comrade re-registers the tool when `/tools` changes them. Pass `[]` to disable all tools. |
| `files` | None. Files to attach, text or images. Each follows the task as a `<file name="...">` block, as Pi's `@file` arguments build them, so the comrade has them without reading them. Paths resolve from the working directory, and `~` is the home directory. A missing file or a directory is refused before the comrade starts. Prefer `files` with `tools: []` over letting the comrade read a large set of files: a model reading on its own can loop. |
| `output` | None. Write the whole answer to this file, creating its directory, and return only its first 20 lines and the path. For an answer that feeds a file or a build rather than the caller. |
| `cwd` | The caller's working directory, or with `to`, the comrade's own. The directory the comrade runs in, resolved from the working directory with `~` as the home directory; it must exist. `files` and `output` still resolve from the caller's directory. The caller's project trust is forwarded only for a directory inside its own; elsewhere the comrade runs with `--no-approve`, so no project-local files load there. The row's header says `in <dir>` when it is not the caller's, named from the caller's directory when inside it. |
| `timeout` | None: a comrade runs until it answers, however long, and only Esc or `comrades` with `stop` ends it sooner. Seconds before the comrade is stopped, as Esc stops it, for a hard stop only; the parameter's description tells the model to leave it unset for open-ended work. The result then says it timed out and gives any text the comrade had, and the comrade can be continued with `to`. |
| `background` | `false` (wait for the comrade to finish and return its answer directly). |

## How it works

Comrade spawns the same Pi release as the caller (its script, under the caller's runtime, or the runtime of the same name on `PATH` if an upgrade such as `brew upgrade node` has deleted it mid-session) with `--mode rpc --session <file>` in the caller's working directory (or `cwd`), forwarding the caller's project trust setting (`--approve` or `--no-approve`). Context files, skills, and extensions load as usual. Extensions in the comrade see `ctx.mode` as `"rpc"`, and any dialog one opens (`select`, `confirm`, `input`, `editor`) is cancelled at once, since no one is there to answer it. Because passing an explicit tool list replaces Pi's default tool set, `codemode` is disabled unless explicitly included in `tools`.

The `task` string is sent verbatim as an RPC `prompt` command on the child's standard input, never through a shell or the command line. This avoids argument length limits and ensures that a task beginning with `@` or `-` is never mistaken for a file reference or CLI option. RPC mode takes no `@file` arguments, so Comrade builds what they would: the task, a blank line, then each file's `<file name="...">` block, a text file's content inline (without a byte-order mark) and an image as an attachment with an empty block naming it. Pi converts and resizes the images for the model it runs, as it does for `@file`. Empty files are skipped, as Pi skips them.

The task goes as a follow-up, so a run that an extension in the comrade started first takes it when it is done. Once the comrade's Pi reports `agent_settled` and has answered every message sent to it (see [Messages while it runs](#messages-while-it-runs)), Comrade closes its standard input, which shuts Pi down. From then on its answer stands: its `timeout` and Esc no longer apply, and a Pi that has not exited within ten seconds is stopped. A comrade is done when its Pi exits; if a process it started still holds its output, Comrade reads what is left for a second and moves on. A prompt Pi refuses before any run, such as one for a provider without credentials, is a failure that gives Pi's reason, and so is a run that fails before it starts.

If an answer exceeds 2000 lines or 50KB, Comrade truncates the text returned to the model and saves the full output beside the comrade's conversation as `comrade-N.answer.md` (`comrade-N.answer.2.md` for a later run of the same comrade), readable by the user only, including that file path in the tool result. With `output`, the answer goes to that file instead, and no copy is made. Provider failures, non-zero Pi exit codes (along with `stderr`), empty answers, and unknown model, tool, directory or file names are returned to the model as tool error results.

Comrade reads the child's event stream as Pi's `JsonAgentSessionEvent` type declares it, and writes and reads commands, responses and dialogs as Pi's `RpcCommand`, `RpcResponse` and `RpcExtensionUIRequest` types declare them, so `pi-diff` watches the modules that define that wire format. `npm test` also runs a comrade in the installed Pi itself, against an offline provider, to check that the prompt, the flags, the session file, attached files, a message sent while it runs, and the events are still what Comrade expects.

## What the model reads

The calling model never sees the row, so the result's text carries what the row shows. A run line ends every result except a stop, including failures, even a comrade that failed at once:

```text
[comrade #3: openrouter/google/gemini-4-argon:high · 1 turn · 0 calls · ↑312k ↓9k · $0.31 · 1m 48s · stop]
```

The comrade's number at its start is what a follow-up's `to` takes.

The last part is the comrade's stop reason. An answer whose last turn ended for any reason other than `stop`, usually `length` (the model reached its output token limit), is cut off. It is returned as a result, not an error, because the partial text can be useful, but its first line says so:

```text
[Comrade's answer is cut off: its last turn ended with stopReason "length", the model's output token limit. It is not a final answer.]
```

A comrade stopped by its `timeout` is an error. Its first line is `[Comrade timed out after 10m 0s and was stopped. Its last text follows. It is not a final answer.]`, followed by that text, or `Comrade timed out after 10m 0s and was stopped.` if it had none. A foreground comrade stopped with Esc returns just `Comrade #N stopped.`

Comrades cannot spawn further comrades: the parent sets `PI_COMRADE` to its own process id in the child environment, and the extension registers nothing when that variable is present. Instead, in a comrade it checks every two seconds that the parent is still running and sends itself `SIGTERM` once it is not, so comrades of a Pi that crashed or was killed do not run on unseen (Pi's own shutdown stops them directly). The extension uses no runtime dependencies or private Pi APIs. Its only state besides the running comrade processes is their conversations, which are ordinary Pi session files, and a record of each run beside them (see [Background](#background)).

## Follow-ups

Each comrade's conversation is saved as a Pi session file beside the caller's session: for the session `~/.pi/agent/sessions/<cwd>/<stamp>_<id>.jsonl`, comrade #3 is `<stamp>_<id>.comrades/comrade-3.jsonl`. When the caller's session is not saved, they go in `$TMPDIR/pi-comrades/<session id>/`. Pi's session lists ignore the subdirectory. A row never prints the file, but a comrade's run can be inspected or opened later with `pi --session <file>`, and an opened row reads what the comrade did from it.

A call with `to: N` runs Pi again on comrade #N's file with `task` as the next prompt, so the comrade still has its brief, its attached files, what it read and what it answered, and the caller sends only the new message: a correction, a question about the answer, or the next step. It keeps the comrade's model, thinking level and tools unless the call passes others, and those then stay the comrade's own for its later follow-ups. `files`, `output`, `timeout` and `background` apply to that run as usual. Its row shows that run alone, and a background follow-up arrives as another `[comrade #N …]` message.

A comrade whose last run was cut off (stopped, timed out, or Pi exited) first reads a note saying so, ahead of the new message. It names the calls that had not finished cleanly, since Pi gives a call it stops only an error result, so each may or may not have taken effect, and asks the comrade to check what they did before repeating any that change files or run commands. If that run stopped more than ten minutes ago, the note also says how long ago, since files may have changed. Comrade reads this from the end of the comrade's conversation: a run is cut off when its task came with no reply, or its last reply asked for tools that never all answered, ended in an error (Pi was retrying a failed request, or gave up), or was itself aborted. Pi stops a run mid-call by aborting the calls and then the reply it was about to request, so the calls named are those of the last reply that ran any. The row shows the message as the caller sent it, without the note.

A follow-up is refused, before anything starts, when another Pi runs comrade #N now (its record says so, and that Pi is alive), when comrade #N is not on the current branch of the caller's session, ran before comrades kept their conversations, or its file is gone or was never written to (the comrade failed before Pi started). Comrades are numbered across all branches of the session. A new comrade claims its number by creating its conversation file empty before Pi starts (Pi starts a session in an empty file as in a missing one), and a number whose file already exists is skipped, so a new comrade never continues another's conversation, even when a session and its fork are open side by side. Branches of the caller's session share their comrades' files: continuing comrade #N on two branches continues the same conversation.

### Messages while it runs

A call with `to: N` while comrade #N runs sends `task` to it rather than starting a run: Pi queues the message and gives it to the comrade once its current tool calls finish, before its next model request. The call returns once Pi has taken it, saying the message was sent, and the comrade's answer comes as it would have, from the call that started it or as a `[comrade #N …]` message. The message reaches the comrade behind a line saying it came from the agent that started it, asking it to end with a complete final answer covering its task and the message, since the comrade may have been finishing its answer when the message arrived, and its last reply is what comes back. Only `task` may be given: a running comrade's model, tools, files, directory, output and timeout are fixed until its answer arrives. Its row is one line, `→ Comrade #N  <message>  sent`, and Ctrl+O shows the whole message.

Each message goes as an RPC `prompt` with `streamingBehavior: "steer"`, so none is left in a queue nothing reads: one that arrives while the comrade runs joins the run, and Pi takes what is still queued before the run settles; one that arrives as it settles starts a run of its own, and Comrade, waiting for Pi's answer to every message before closing, lets that run finish. A message sent before the comrade's Pi has started is held and sent once it has. One an extension in the comrade takes instead (Pi answers `handled`) is an error, as is one sent once the comrade has ended, which says its answer is on its way. Esc ends the wait for Pi to take a message, not the comrade, and the message may still reach it.

## Waiting

By default (`background: false`), the tool call blocks until the comrade finishes. If the model invokes `comrade` multiple times in a single message, those comrades run in parallel. Pressing `Esc` stops the running comrade by sending `SIGTERM`, followed by `SIGKILL` after 5 seconds if it has not exited. Token usage and cost from foreground comrades count toward the parent session's totals.

## Background

Background mode is for when the agent has other work to do before it needs the answer. If it would only wait, the foreground is better: it shows live progress, and several foreground calls in one message already run in parallel.

When called with `background: true`, the tool returns immediately with a comrade number (`#N`) so the agent can continue working. When the background comrade finishes, its result arrives later as a `[comrade #N finished]` (or `failed`) follow-up message. It is delivered after the agent's current work completes, or immediately if the agent is idle, in which case it starts a new turn to handle the answer.

An agent does not end its turn while its background comrades run. When it finishes its other work first, its turn waits, using no tokens, and the editor shows `Waiting for comrade #N` (or with several, `Waiting for comrades`, the widget above the editor saying which) in place of `Working`. The first answer to arrive continues the turn, and the agent waits again if more comrades are still running. A message you type, or Esc, ends the wait at once. The comrades keep running, and their answers then arrive as before. The wait only happens in the terminal UI, where Esc can end it.

- The agent calls `comrades` to list its running comrades by number and title, with what they are doing and their cost so far (with a total when there are several, since background costs are not in the session's totals), or `comrades` with `stop: [N]` to stop ones it no longer needs. That call waits for them to exit, and no message arrives for them afterwards.
- You can do the same with `/comrades` and `/comrades stop <n|all>`. When you stop a comrade, the agent is told without starting a turn.
- At most four background comrades can run concurrently. A background comrade's `timeout` still applies, and one that runs out is delivered as `failed`.
- Background comrades keep running through `/reload`, and the reloaded extension delivers their answers, including any that finished during the reload.
- Quitting Pi or running `/new`, `/resume`, or `/fork` stops them, and waits for their Pis to exit, which record the calls they cut off as they stop.
- Each run has a record beside its conversation (`comrade-N.runs.json`): which Pi runs it and its comrade's Pi, whether Pi has saved its prompt in the comrade's conversation, what it sends (task, files, output, timeout), and once it ends, a background run's answer. The answer is saved before it is sent, because Pi holds a message that arrives during a turn in memory until the turn ends, so one Pi exits with first, or that Esc clears, would be lost. In the terminal, once the agent has settled and stayed idle for a second, saved answers the session does not hold, such as one Esc or Pi's dequeue key took from the queue, are sent again without starting a turn. Only there: the terminal clears the queue whenever it aborts a turn, but an abort elsewhere, such as RPC's `abort`, leaves the answer queued for the next run, so sending it again would deliver it twice. There, an answer that never arrived is delivered when the session next starts. A record goes once the caller's session holds the run's answer, or, for a foreground run, once its call returns.
- When the session starts again in the terminal or RPC mode, each background run on the current branch that never answered is settled, without starting a turn:
  - its answer saved in its record is delivered;
  - an answer another branch holds is delivered here too;
  - one that another live Pi runs now is left to it, with a notice;
  - one whose conversation shows it answered (Pi exited before the answer came back) is delivered from there, without running again;
  - one cut off within the last day carries on in its conversation, with its model, thinking level, tools and directory, and its call's `output` and `timeout`. If its prompt never reached the comrade, it is sent again; otherwise the comrade reads the note described in [Follow-ups](#follow-ups) and is asked to carry on and end with its final answer. A `[comrade #N resumed]` message records this, and the answer arrives as another `[comrade #N …]` message, which does start a turn. Opened, the answer shows what both runs did, with the note between them;
  - one cut off longer ago, or that cannot carry on (its directory or an attached file gone, or it ran before comrades kept records and its conversation shows no cut), is reported `lost` with why, and `continue it with to: N` when its conversation is saved.

  At most four carry on at once; beyond that, a run waits for the session's next start. Print and JSON modes end with their turn, so nothing carries on there, and such runs are left for a session that can. Comrade numbers remain unique across the session.
- Because print and JSON modes exit as soon as the turn finishes, before a follow-up message could arrive, calls with `background: true` in those modes wait in the foreground instead and note that in the result.
- Because Pi does not include custom messages in session usage totals, a background comrade's cost is displayed on its delivered message rather than added to the session's totals.

## The row

Rows are flat, drawn as mirage draws its own, with no box behind them, and in mirage's green and red rather than the theme's: `comrade/colours.ts` copies `mirage/colours.ts`, and a test keeps the two equal, so change them together. At rest a comrade is one line: a glyph, `Comrade #N`, its title, what it ran with that is not the caller's (another model, another directory), then how it went, its cost and its time, and a caret.

```text
✓ Comrade #3  Review parser error paths  $0.71 · 12m 43s ▸
✓ Comrade #4  List lexer exports  claude-fable-5-2:high · in packages/lexer  $0.08 · 1m 2s ▸
✗ Comrade #5  Port tabs to motion  failed · $0.02 · 3.1s ▸
  No credentials for provider openrouter
! Comrade #6  Draft migration guide  cut off · $2.40 · 6m 11s ▸
  Reached its output token limit. The answer is partial.
✗ Comrade #7  Check Safari focus ring  stopped · $0.12 · 48.0s ▸
```

A comrade that did not succeed says why under its header, in up to three lines, all of it once opened: Pi's error for a failure, the limit it ran past for a timeout, the output limit for an answer cut off. Stopped needs no reason. A row without a title is named by the task's first line, dim.

The title gives way so the rest of the header always fits. Below 80 columns the model and directory go, and below 60 the cost. Nothing else is said about how it ran: its tools, turns and tokens are in the run line the model reads, and the conversation's file is never printed (it is `<session>.comrades/comrade-N.jsonl` beside the caller's session, as [Follow-ups](#follow-ups) says).

### While it runs

A running comrade's glyph is Pi's working spinner in the accent colour, as on the editor and mirage's rows, its clock ticks in whole seconds, and two lines follow its header, changing in place, so the row never changes height while it runs:

```text
⠋ Comrade #3  Review parser error paths  $0.31 · 4m 12s ▸
  ⠋ Reading ~/project/src/lexer.ts:40-120
  parseList swallows the error that parseBlock rethrows.
```

1. **What it is doing:** the call it runs, as mirage names it, with the spinner, or mirage's line for its group when it runs several at once (`⠋ Exploring 3 files`); between calls, what it waits on; else the last call it ran. While the words it thinks or writes show on the line below, this line names the last call it ran instead, rather than labelling them.
2. **What it said last:** the last complete sentence or line it said, in italics, without Markdown's marks. A half-written sentence never shows: the line changes when one is complete. When it does not fit, the newest words win: earlier sentences on the line go first, and only a sentence too long on its own is cut. It stays through later turns, dimmer, until the comrade says more. Its thinking shows here only where Pi shows thinking (`Ctrl+T`); elsewhere the line keeps to what it wrote. Until it has said anything, the line has its tokens so far.

| What it waits on | While |
| --- | --- |
| `starting` | Pi loads. |
| `waiting` | A request is out and nothing has streamed back. Some providers, such as Gemini through OpenRouter, send nothing until the reply is done, so this can last minutes on a long first turn. After the first turn it says how long: `waiting 48s`. |
| `thinking`, `writing` | The reply streams. Streamed text updates the row at most every 250ms. |
| `calling edit` | The model writes a call's arguments. |
| `retrying · 1/3 · 529 overloaded` | Pi retries a failed request, in the warning colour. |
| `compacting its context` | Pi compacts the comrade's context. |

The tokens, `↑1.0k ↓~2.0k`, are the finished messages' plus the streaming message's, in Pi's footer format (`805`, `7.2k`, `41k`). Providers differ in what they count as they go: Google reports cumulative usage with every chunk, Anthropic reports the input at the start and the output only at the end, and OpenAI and OpenRouter report only at the end. So `↑` appears as soon as the provider has counted the input, and `↓` is estimated from the streamed characters at four per token and marked `~` until the provider's own count has moved, when it takes over exactly.

### Expanded

`Ctrl+O` expands every row, and a click on a row opens or closes it alone, as on any tool row. Expanded, a row is the comrade's conversation in order: its task behind a bar, then what it did, as Pi's own transcript shows Pi's work: what it said, its thinking where Pi shows thinking, messages sent to it while it ran, and its calls.

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

Where mirage is loaded, mirage draws the comrade's calls, grouped by mirage's rules, exactly as it draws Pi's own, so they read the same everywhere: a click opens a group, a command shows on its own lines with how it exited (`(exit code: 1)`), an edit shows its diff, and a file name opens in inspector. Comrade asks for them over Pi's event bus (`shared/nested.ts`), so neither extension needs the other. They start closed, whatever `Ctrl+O` says, so an opened comrade reads at a glance. Without mirage, each call is one line in mirage's wording: `✓ Read ~/p`, `$ npm test (exit code: 1)`, `✗ Read ~/q  ENOENT: no such file or directory`, a command of several lines by its first and `…`.

An opened row shows the latest 24 pieces of the comrade's work, its words, thoughts and groups of calls, after `… N earlier ▸`, which a click opens. Its thinking follows Pi's `Ctrl+T` in rows already drawn: through mirage, at once; without mirage, from Pi's settings, which `Ctrl+T` saves, the next time the row is drawn.

While it runs, an open row grows as the comrade works, and ends with what it waits on when not a call. Once it has ended, it reads the conversation from the comrade's file the first time it is opened, so a row from an earlier session opens the same; a row from before comrades showed their work, or whose conversation has been deleted, shows a summary of its calls and the ones worth naming instead. A follow-up's row shows its own run, not the conversation before or after it. To keep memory in check while a comrade runs, its row keeps its messages without images, and each call's result to its first 32,000 characters.

A task longer than six lines shows its first six and `… N more lines ▸`, which a click opens. When the full answer is in a file, the expanded row ends with `Full answer:` and its path. The row never shows the run line or the cut-off and timed-out first lines the model reads: it shows the same facts in its own places.

### Background comrades

A background comrade's start row is one line, spinning with its cost and clock while its run goes on, then dim history once it has ended, saying how it went once the session holds its answer. Expanded while the run goes on, it shows the task and the work so far, after a `/reload` too. Its answer arrives as a message that looks exactly like a finished foreground row, linked to its start row by `#N` and title, with the task its start row was given and, opened, what the comrade did.

```text
⠋ Comrade #12  Glide indicators  background · $1.20 · 3m 2s ▸
↗ Comrade #12  Glide indicators  background · finished ▸
✓ Comrade #12  Glide indicators  $3.00 · 7m 40s ▸
```

Their progress is in a widget above the editor, in the terminal only, one column in as Pi's own lines are: one line per background comrade at work, its number and title in columns, what it is doing, then its cost and clock at the right. A comrade that has ended keeps its line, saying its answer is queued, until the session holds the answer (Pi holds one that arrives during a turn until the turn ends). Stopped ones leave at once, and the widget goes once it is empty. Its clocks tick once a second; it has no spinner, so Pi's own stays the only animation near the editor. Below 70 columns, what each is doing goes, then the title shrinks and goes, then the cost; the clock stays.

```text
 • #12  Glide indicators   Edited ~/x-govuk-ui/packages/core/src/tabs.tsx +12 −4   $1.20 · 3m 2s
 • #13  Small fixes        waiting 48s                                             $0.40 · 3m 1s
 ✓ #14  Audit bundle size  finished · answer queued                                $0.90 · 2m 10s
```

A turn waiting for its background comrades says `Waiting for comrade #12`, or with several, `Waiting for comrades`, the widget beside it saying which.

### Other rows

```text
→ Comrade #12  Glide indicators  "Keep the reduced-motion guard on every indicator"  sent ▸
↻ Comrade #12  Glide indicators  resumed ▸
✗ Comrade #9  Compare token sets  lost
  Not carried on: it stopped 25h 0m 3s ago. Continue it with to: 9.
```

A message sent to a running comrade is one line naming the comrade by its title, and expands to the whole message. A resumed comrade's message expands to the note the model reads. A lost one says why, and how to continue it when it can be.
