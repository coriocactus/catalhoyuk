# Comrade

Comrade registers a `comrade` tool that lets the model delegate a self-contained task to a fresh Pi process and receive its final answer, and a `comrades` tool for checking on and stopping background comrades. Every comrade is numbered (`#N`) and keeps its conversation, so the model can continue it with `to: N` instead of briefing a new one. A single `comrade` call performs the equivalent of running Pi manually from the shell:

```sh
pi -p --model anthropic/claude-opus-5-5 --thinking xhigh --session comrade-3.jsonl --tools read "$(cat task.md)"
```

With `files`, it also attaches files as `@file` arguments do, and with `output` and `timeout` it does what a shell would do with a redirect and `timeout`.

## Parameters

| Parameter | Default |
| --- | --- |
| `task` | Required. Complete instructions for the comrade, which sees nothing else from the parent conversation. With `to`, only the next message to that comrade. |
| `to` | None (start a new comrade). The number of a comrade to continue: `task` becomes the next message in its conversation. See [Follow-ups](#follow-ups). |
| `model` | The caller's current model, or with `to`, the comrade's own. Always `provider/id`, exactly as Pi lists it, such as `anthropic/claude-fable-5-1` or `openrouter/google/gemini-4-argon`, optionally with a `:thinking` suffix. It is checked against Pi's model registry, and bare or unknown names are refused with the names to use. The comrade gets the provider and the id separately (`--provider anthropic --model claude-fable-5-1`), so Pi cannot resolve the name under another provider, such as OpenRouter, whose id for that model is the same text. |
| `thinking` | The `:thinking` suffix of `model` if given, otherwise the caller's current thinking level (with `to`, the comrade's own). An explicit `thinking` overrides both. |
| `tools` | Read-only: `["read", "grep", "find", "ls"]`, or with `to`, the comrade's own. Add `"edit"` and `"write"` to let the comrade change files, or `"bash"` to let it run commands. Names and `*` patterns must match a tool that is active in the caller: the caller's own tool set is the ceiling, so a Pi started with `--tools read` cannot hand a comrade `bash`, and a tool turned off with `/tools` is off for comrades too. The default drops any read-only tool that is not active. Pass `[]` to disable all tools. |
| `files` | None. Files to attach, text or images. Pi appends each to the task as a `<file name="...">` block, so the comrade has them without reading them. Paths resolve from the working directory, and `~` is the home directory. A missing file or a directory is refused before the comrade starts. Prefer `files` with `tools: []` over letting the comrade read a large set of files: a model reading on its own can loop. |
| `output` | None. Write the whole answer to this file, creating its directory, and return only its first 20 lines and the path. For an answer that feeds a file or a build rather than the caller. |
| `cwd` | The caller's working directory, or with `to`, the comrade's own. The directory the comrade runs in, resolved from the working directory with `~` as the home directory; it must exist. `files` and `output` still resolve from the caller's directory. The caller's project trust is forwarded only for a directory inside its own; elsewhere the comrade runs with `--no-approve`, so no project-local files load there. The expanded row shows `in <dir>` when it is not the caller's. |
| `timeout` | None. Seconds before the comrade is stopped, as Esc stops it. The result then says it timed out and gives any text the comrade had. |
| `background` | `false` (wait for the comrade to finish and return its answer directly). |

## How it works

Comrade spawns the same Pi release as the caller with `--mode json --session <file>` in the caller's working directory (or `cwd`), forwarding the caller's project trust setting (`--approve` or `--no-approve`). Context files, skills, and extensions load as usual. Because passing an explicit tool list replaces Pi's default tool set, `codemode` is disabled unless explicitly included in `tools`.

The `task` string is written verbatim to the child Pi process on standard input rather than passed through a shell. This avoids command-line argument length limits and ensures that a task beginning with `@` or `-` is never mistaken for a file reference or CLI option. Attached files are passed after the flags as `@/absolute/path` arguments. Pi builds the prompt as the task, then each file's `<file name="...">` block. Pi trims the task and appends the first block straight after its last character, so `…last line<file name="…">` is what the comrade reads; the tag delimits itself.

If an answer exceeds 2000 lines or 50KB, Comrade truncates the text returned to the model and saves the full output beside the comrade's conversation as `comrade-N.answer.md` (`comrade-N.answer.2.md` for a later run of the same comrade), readable by the user only, including that file path in the tool result. With `output`, the answer goes to that file instead, and no copy is made. Provider failures, non-zero Pi exit codes (along with `stderr`), empty answers, and unknown model, tool, directory or file names are returned to the model as tool error results.

Comrade reads the child's event stream as Pi's `JsonAgentSessionEvent` type declares it, so `pi-diff` watches the module that defines that wire format. `npm test` also runs a comrade in the installed Pi itself, against an offline provider, to check that the task on stdin, the flags, the session file, attached files and the events are still what Comrade expects.

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

Comrades cannot spawn further comrades: the parent sets `PI_COMRADE` to its own process id in the child environment, and the extension registers nothing when that variable is present. Instead, in a comrade it checks every two seconds that the parent is still running and sends itself `SIGTERM` once it is not, so comrades of a Pi that crashed or was killed do not run on unseen (Pi's own shutdown stops them directly). The extension uses no runtime dependencies or private Pi APIs. Its only state besides the running comrade processes is their conversations, which are ordinary Pi session files.

## Follow-ups

Each comrade's conversation is saved as a Pi session file beside the caller's session: for the session `~/.pi/agent/sessions/<cwd>/<stamp>_<id>.jsonl`, comrade #3 is `<stamp>_<id>.comrades/comrade-3.jsonl`. When the caller's session is not saved, they go in `$TMPDIR/pi-comrades/<session id>/`. Pi's session lists ignore the subdirectory. The expanded row shows the file, cut from its start so the file name stays visible, and a comrade's run can be inspected or opened later with `pi --session <file>`.

A call with `to: N` runs Pi again on comrade #N's file with `task` as the next prompt, so the comrade still has its brief, its attached files, what it read and what it answered, and the caller sends only the new message: a correction, a question about the answer, or the next step. It keeps the comrade's model, thinking level and tools unless the call passes others, and those then stay the comrade's own for its later follow-ups. `files`, `output`, `timeout` and `background` apply to that run as usual. Its row shows `follow-up` when expanded, and a background follow-up arrives as another `[comrade #N …]` message.

A follow-up is refused, before anything starts, when comrade #N is still running, is not on the current branch of the caller's session, ran before comrades kept their conversations, or its file is gone or was never written to (the comrade failed before Pi started). Comrades are numbered across all branches of the session. A new comrade claims its number by creating its conversation file empty before Pi starts (Pi starts a session in an empty file as in a missing one), and a number whose file already exists is skipped, so a new comrade never continues another's conversation, even when a session and its fork are open side by side. Branches of the caller's session share their comrades' files: continuing comrade #N on two branches continues the same conversation. The running check covers only this Pi, so do not continue one comrade from two Pi processes at once: both would write to its file.

## Waiting

By default (`background: false`), the tool call blocks until the comrade finishes. If the model invokes `comrade` multiple times in a single message, those comrades run in parallel. Pressing `Esc` stops the running comrade by sending `SIGTERM`, followed by `SIGKILL` after 5 seconds if it has not exited. Token usage and cost from foreground comrades count toward the parent session's totals.

## Background

Background mode is for when the agent has other work to do before it needs the answer. If it would only wait, the foreground is better: it shows live progress, and several foreground calls in one message already run in parallel.

When called with `background: true`, the tool returns immediately with a comrade number (`#N`) so the agent can continue working. When the background comrade finishes, its result arrives later as a `[comrade #N finished]` (or `failed`) follow-up message. It is delivered after the agent's current work completes, or immediately if the agent is idle, in which case it starts a new turn to handle the answer.

An agent does not end its turn while its background comrades run. When it finishes its other work first, its turn waits, using no tokens, and the editor shows `Waiting for comrade #N` in place of `Working`. The first answer to arrive continues the turn, and the agent waits again if more comrades are still running. A message you type, or Esc, ends the wait at once. The comrades keep running, and their answers then arrive as before. The wait only happens in the terminal UI, where Esc can end it.

- The agent calls `comrades` to list its running comrades with what they are doing and their cost so far (with a total when there are several, since background costs are not in the session's totals), or `comrades` with `stop: [N]` to stop ones it no longer needs. That call waits for them to exit, and no message arrives for them afterwards.
- You can do the same with `/comrades` and `/comrades stop <n|all>`. When you stop a comrade, the agent is told without starting a turn.
- At most four background comrades can run concurrently. A background comrade's `timeout` still applies, and one that runs out is delivered as `failed`.
- Background comrades keep running through `/reload`, and the reloaded extension delivers their answers, including any that finished during the reload.
- Quitting Pi or running `/new`, `/resume`, or `/fork` stops them. When that session next starts, Comrade posts a message recording which comrades were lost so the agent does not wait for them. A lost comrade's conversation keeps what it saved, so it can still be continued with `to`. Comrade numbers remain unique across the session.
- Because print and JSON modes exit as soon as the turn finishes, before a follow-up message could arrive, calls with `background: true` in those modes wait in the foreground instead and note that in the result.
- Because Pi does not include custom messages in session usage totals, a background comrade's cost is displayed on its delivered message rather than added to the session's totals.

## The row

Collapsed, a comrade is one line: a status glyph, `Comrade #N`, the task's first line cut to fit, then the cost and duration. Rows saved by older versions number only background comrades.

```text
✓ Comrade #3  Review the parser for unhandled errors  $0.71 · 12m 43s
```

While it runs, its glyph is Pi's working spinner in the accent colour, as on the editor and mirage's rows, its cost and a clock in whole seconds stay at the right, and a second line shows the turn (counted from Pi's turn starts, so a turn's tool calls belong to it), the number of calls, and what it is doing, read from the comrade's event stream. The row never grows while it runs.

```text
⠋ Comrade #3  Review the parser for unhandled errors              $0.31 · 4m 12s
turn 12 · 48 calls · Reading ~/project/src/parser.ts
```

| Second line | While |
| --- | --- |
| `starting anthropic/claude-fable-5-1` | Pi loads. |
| `waiting for anthropic/claude-fable-5-1` | A request is out and nothing has streamed back. Some providers, such as Gemini through OpenRouter, send nothing until the reply is done, so this can last minutes on a long first turn. After the first turn it says how long the wait has lasted: `waiting 48s for …`. |
| `thinking · ~2k tokens`, `writing · ~300 tokens` | The reply streams, with its tokens estimated from the streamed characters. Streamed text updates the row at most every 250ms. |
| `calling edit · ~1k tokens` | The model writes a tool call's arguments. Each call starts its count over. |
| `Reading ~/x`, `$ npm test` | Its tools run: the latest call, as mirage names it. |
| `retrying · 1/3 · 529 overloaded` | Pi retries a failed request. A retry that gives up leaves the row as it was until the comrade ends. |
| `compacting its context` | Pi compacts the comrade's context. |

A background comrade's start row shows the same clock and second line for as long as that run goes, even while Pi is idle, then returns to one line ending in `background`.

Press `Ctrl+O` to expand it. While the comrade runs, that adds the whole task under the progress line, as it was sent, each line behind a bar, so the brief can be read while its answer is still coming; the row still does not change size on its own. Once it has finished, the expanded row adds the model, tools, attached files, turns and tokens, the conversation's file, a summary of the comrade's calls in mirage's wording, then the calls worth naming: failures with their error, the files it changed with their line counts, and the commands it ran. Reads and searches are counted but not listed. Then comes the whole task, and last the answer, as Markdown, so the question and its answer read together.

```text
✓ Comrade #3  Review the parser for unhandled errors  $0.71 · 12m 43s
anthropic/claude-fable-5-1:xhigh · read, grep, find, ls · 39 turns · ↑938k ↓36k
Conversation: ~/.pi/agent/sessions/--project--/2026-11-08T13-55-31-787Z_01a1….comrades/comrade-3.jsonl
✓ Explored 41 files, ran 12 searches
  ✗ Read ~/project/src/legacy.ts  ENOENT: no such file or directory

│ Review the parser for unhandled errors.
│
│ Read ~/project/src/parser.ts and every module it imports. Report each place
│ where an error can escape uncaught, with file and line, as a Markdown list.

(the answer)
```

A failed comrade shows `failed` and its error, one that ran out of time shows `timed out`, one whose answer is cut off shows `cut off`, and one stopped with `Esc` or `/comrades stop` shows `stopped`. The row never shows the run line or the cut-off and timed-out first lines: it shows the same facts in its own places. When the full answer is in a file, the expanded row ends with `Full answer:` and its path. A background comrade's start row says `background`, and its delivered message has the same shape, linked by `#N`. The start row is final, so the work summary only appears on the delivered message, and the whole task only on the start row.
