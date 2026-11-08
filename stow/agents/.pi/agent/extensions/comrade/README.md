# Comrade

Comrade registers a `comrade` tool that lets the model delegate a self-contained task to a fresh, one-shot Pi process and receive its final answer, and a `comrades` tool for checking on and stopping background comrades. A single `comrade` call performs the equivalent of running Pi manually from the shell:

```sh
pi -p --model anthropic/claude-opus-5-5 --thinking xhigh --no-session --tools read "$(cat task.md)"
```

With `files`, it also attaches files as `@file` arguments do, and with `output` and `timeout` it does what a shell would do with a redirect and `timeout`.

## Parameters

| Parameter | Default |
| --- | --- |
| `task` | Required. Complete instructions for the comrade, which sees nothing else from the parent conversation. |
| `model` | The caller's current model. Always `provider/id`, exactly as Pi lists it, such as `anthropic/claude-fable-5-1` or `openrouter/google/gemini-4-argon`, optionally with a `:thinking` suffix. It is checked against Pi's model registry, and bare or unknown names are refused with the names to use. The comrade gets the provider and the id separately (`--provider anthropic --model claude-fable-5-1`), so Pi cannot resolve the name under another provider, such as OpenRouter, whose id for that model is the same text. |
| `thinking` | The `:thinking` suffix of `model` if given, otherwise the caller's current thinking level. An explicit `thinking` overrides both. |
| `tools` | Read-only: `["read", "grep", "find", "ls"]`. Add `"edit"` and `"write"` to let the comrade change files, or `"bash"` to let it run commands. Names and `*` patterns must match a tool this Pi has. Pass `[]` to disable all tools. |
| `files` | None. Files to attach, text or images. Pi appends each to the task as a `<file name="...">` block, so the comrade has them without reading them. Paths resolve from the working directory, and `~` is the home directory. A missing file or a directory is refused before the comrade starts. Prefer `files` with `tools: []` over letting the comrade read a large set of files: a model reading on its own can loop. |
| `output` | None. Write the whole answer to this file, creating its directory, and return only its first 20 lines and the path. For an answer that feeds a file or a build rather than the caller. |
| `timeout` | None. Seconds before the comrade is stopped, as Esc stops it. The result then says it timed out and gives any text the comrade had. |
| `background` | `false` (wait for the comrade to finish and return its answer directly). |

## How it works

Comrade spawns the same Pi release as the caller with `--mode json --no-session` in the caller's working directory, forwarding the caller's project trust setting (`--approve` or `--no-approve`). Context files, skills, and extensions load as usual. Because passing an explicit tool list replaces Pi's default tool set, `codemode` is disabled unless explicitly included in `tools`.

The `task` string is written verbatim to the child Pi process on standard input rather than passed through a shell. This avoids command-line argument length limits and ensures that a task beginning with `@` or `-` is never mistaken for a file reference or CLI option. Attached files are passed after the flags as `@/absolute/path` arguments. Pi builds the prompt as the task, then each file's `<file name="...">` block. Pi trims the task, so its last line and the first block meet without a blank line between them.

If an answer exceeds 2000 lines or 50KB, Comrade truncates the text returned to the model and saves the full output to a private file at `$TMPDIR/comrade-*/answer.md`, including that file path in the tool result. With `output`, the answer goes to that file instead, and no private copy is made. Provider failures, non-zero Pi exit codes (along with `stderr`), empty answers, and unknown model, tool or file names are returned to the model as tool error results.

## What the model reads

The calling model never sees the row, so the result's text carries what the row shows. A run line ends the result of every comrade that ran, failed ones included:

```text
[comrade: openrouter/google/gemini-4-argon:high · 1 turn · 0 calls · ↑312k ↓9k · $0.31 · 1m 48s · stop]
```

The last part is the comrade's stop reason. An answer whose last turn ended for any reason other than `stop`, usually `length` (the model reached its output token limit), is cut off. It is returned as a result, not an error, because the partial text can be useful, but its first line says so:

```text
[Comrade's answer is cut off: its last turn ended with stopReason "length", the model's output token limit. It is not a final answer.]
```

A comrade stopped by its `timeout` is an error. Its first line is `[Comrade timed out after 10m 0s and was stopped. Its last text follows. It is not a final answer.]`, followed by that text, or `Comrade timed out after 10m 0s and was stopped.` if it had none. A stop by Esc or the comrades tool is still just `Comrade stopped.`

Comrades cannot spawn further comrades: the parent sets `PI_COMRADE=1` in the child environment, and the extension registers nothing when that variable is present. The extension uses no runtime dependencies, private Pi APIs, or state beyond the currently running comrade processes.

## Waiting

By default (`background: false`), the tool call blocks until the comrade finishes. If the model invokes `comrade` multiple times in a single message, those comrades run in parallel. Pressing `Esc` stops the running comrade by sending `SIGTERM`, followed by `SIGKILL` after 5 seconds if it has not exited. Token usage and cost from foreground comrades count toward the parent session's totals.

## Background

Background mode is for when the agent has other work to do before it needs the answer. If it would only wait, the foreground is better: it shows live progress, and several foreground calls in one message already run in parallel.

When called with `background: true`, the tool returns immediately with a comrade number (`#N`) so the agent can continue working. When the background comrade finishes, its result arrives later as a `[comrade #N finished]` (or `failed`) follow-up message. It is delivered after the agent's current work completes, or immediately if the agent is idle, in which case it starts a new turn to handle the answer.

An agent does not end its turn while its background comrades run. When it finishes its other work first, its turn waits, using no tokens, and the editor shows `Waiting for comrade #N` in place of `Working`. The first answer to arrive continues the turn, and the agent waits again if more comrades are still running. A message you type, or Esc, ends the wait at once. The comrades keep running, and their answers then arrive as before. The wait only happens in the terminal UI, where Esc can end it.

- The agent calls `comrades` to list its running comrades with their progress and cost so far, or `comrades` with `stop: [N]` to stop ones it no longer needs. That call waits for them to exit, and no message arrives for them afterwards.
- You can do the same with `/comrades` and `/comrades stop <n|all>`. When you stop a comrade, the agent is told without starting a turn.
- At most four background comrades can run concurrently. A background comrade's `timeout` still applies, and one that runs out is delivered as `failed`.
- Background comrades keep running through `/reload`, and the reloaded extension delivers their answers, including any that finished during the reload.
- Quitting Pi or running `/new`, `/resume`, or `/fork` stops them. When that session next starts, Comrade posts a message recording which comrades were lost so the agent does not wait for them. Comrade numbers remain unique across the session.
- Because print and JSON modes exit as soon as the turn finishes, before a follow-up message could arrive, calls with `background: true` in those modes wait in the foreground instead and note that in the result.
- Because Pi does not include custom messages in session usage totals, a background comrade's cost is displayed on its delivered message rather than added to the session's totals.

## The row

Collapsed, a comrade is one line: a status glyph, `Comrade` (with `#N` for a background comrade), the task's first line cut to fit, then the cost and duration.

```text
✓ Comrade  Review the parser for unhandled errors  $0.71 · 12m 43s
```

While it runs, its glyph is Pi's working spinner in the accent colour, as on the editor and mirage's rows, and a second line shows the turn, the number of calls, the cost so far, and the latest call. The row never grows while it runs. A background comrade's start row spins for as long as that comrade runs, even while Pi is idle.

```text
⠋ Comrade  Review the parser for unhandled errors
turn 12 · 48 calls · $0.31 · Reading ~/project/src/parser.ts
```

Press `Ctrl+O` to expand it. The expanded row adds the model, tools, attached files, turns and tokens, a summary of the comrade's calls in mirage's wording, then the calls worth naming: failures with their error, the files it changed with their line counts, and the commands it ran. Reads and searches are counted but not listed. The answer comes last, as Markdown.

```text
✓ Comrade  Review the parser for unhandled errors  $0.71 · 12m 43s
anthropic/claude-fable-5-1:xhigh · read, grep, find, ls · 39 turns · ↑938k ↓36k
✓ Explored 41 files, ran 12 searches
  ✗ Read ~/project/src/legacy.ts  ENOENT: no such file or directory
(the answer)
```

A failed comrade shows `failed` and its error, one that ran out of time shows `timed out`, one whose answer is cut off shows `cut off`, and one stopped with `Esc` or `/comrades stop` shows `stopped`. The row never shows the run line or the cut-off and timed-out first lines: it shows the same facts in its own places. When the full answer is in a file, the expanded row ends with `Full answer:` and its path. A background comrade's start row says `background`, and its delivered message has the same shape, linked by `#N`. The start row is final, so the work summary only appears on the delivered message.
