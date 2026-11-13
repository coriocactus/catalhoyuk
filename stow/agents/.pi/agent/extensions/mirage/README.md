# Mirage

Mirage draws Pi's `read`, `bash`, `edit`, `write`, and `codemode` calls as compact rows, and draws consecutive calls as one group under a summary. It only draws these tools: Pi still runs them.

```text
✓ Ran 2 commands, read 3 files, wrote 2 files (+48) ▸
✓ Explored 4 files ▸
✓ Edited 3 files (+14 −22) ▸
✓ Edited ~/project/index.ts +12 −8 ▸
✓ Wrote ~/project/notes.md +30 ▸
$ npm test ▸
✓ Script: read 3 files, ran 1 command ▸
```

## Rows and summaries

- Rows follow Pi's **Output padding** setting for headers, output, and images, and change with it at once.
- Click a row or the caret at its end to expand or collapse it. In an expanded group, each call has its own toggle. **Ctrl+O** expands or collapses all output, errors and image previews included. Clicks need fullscreen mode.
- A command, and a group of commands only, is marked **$**: green when it succeeded, red when it failed. Other rows and mixed groups are marked **✓** or **✗**.
- A collapsed group is one line. Its mark turns red only when every call in it failed. Expand the group to see which calls failed: each is red on its own line. Error output stays hidden until expanded.
- When a command or script ends, its output ends with a muted `Took 1.2s`: the time Pi recorded, as on Pi's native `bash` and `codemode` rows. It survives `/reload` and `/resume`, also for commands a script ran. Pi's running `Elapsed` counter is not shown.
- Each line marks where its content starts, after its padding and indent, so [`prose`](../prose/README.md) can start a selection there. A tool's output keeps its own indentation when copied.
- Click an underlined filename to open it in your editor through [`inspector`](../inspector/README.md), also while Pi works.

### In progress

While Pi works, a row or group with calls in progress shows Pi's working spinner (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) in the accent colour. This includes the calls inside a script. A call left in progress while Pi is idle shows a muted **…**, or a muted **$** for a command.

A row reads its spinner frame from the clock each time Pi draws it. Pi's own working indicator makes Pi draw a frame every 80 ms, so the rows turn with it and Mirage asks for no frame of its own. Its timer asks Pi for a frame only when 80 ms passed in which no frame drew a spinning row, and then nothing but the frame is drawn again: output already built is kept. The timer stops once nothing is in progress or Pi is idle.

While a write's content streams in, only its new lines are highlighted for each frame, and its first 50 lines together. The finished write is highlighted whole.

Pi reports a result again when it records it, and each event builds the row again. Output whose text comes out the same keeps its highlighting and its wrapped lines, so only what changed costs anything.

### Files

- Consecutive edits become `Edited X files (+A −R) ▸`, each file a row of its own inside, with its diff and line numbers. Files are counted by distinct path in each working directory. Line totals sum the diffs of the edits that succeeded: they are not the net Git diff. Zero counts are left out. A group's summary shows plain counts in grey brackets, and a file row shows them in green and red.
- A group of reads, commands, edits, and writes has one summary, ordered by the first appearance of each kind. Expanded, it shows the calls in the order they were made. A call that is not in a group keeps its filename or command in its header.
- A read row ends with Pi's line range (`:40-89`). A read of an image groups with other reads. Its preview starts hidden, and its row's toggle or **Ctrl+O** shows or hides it.
- A write row says `Wrote`, not `Created`, because `write` may overwrite a file. Pi reports no diff for a write, so a write row counts only the lines written (`+N`) and never lines removed.
- In a summary, each kind totals its own calls that succeeded (`wrote 6 files (+420), edited 3 files (+26 −16)`). Commands and reads have no line totals.
- A call whose arguments are not valid JSON shows a dim `invalid arguments` in its header. Expanded, it shows Pi's error and the text the model sent.

### Commands

Commands are drawn as Amp draws them.

- A chain of `&&`, `||`, `|`, or `;` steps shows one step per line. Each line ends in its operator and a backslash, and the lines after the first are indented.
- Quotes, `$(…)`, subshells, loops, conditionals, and `{ …; }` groups are never split.
- A command's own line breaks are kept. Its later lines are indented by four columns, plus whatever they indent beyond each other.
- A leading `cd DIR &&` shows as a dim italic `(in DIR)` after the command. A failed command ends with `(exit code: N)`, the code in red.
- Command names are bold. Flags, strings, variables, redirects, operators, and comments use the theme's syntax colours.
- A heredoc body is counted, not shown (`python3 - <<'EOF' … 48 lines`), and a header stops after eight lines. The expanded output repeats the whole command only when its header left part of it out.

## Groups, thinking, and scripts

Consecutive calls group across assistant turns as long as nothing visible separates them, and a new call joins the group while its arguments still stream. A boundary ends a group: assistant text, a visible thinking block, a user message, a call Mirage does not draw (MCP tools and `tool_search` included), and a failed, aborted, or truncated assistant turn. If text streams in after a call, that call leaves the group at once. Expanding and collapsing done by hand is forgotten on `/reload` and `/resume`.

When thinking is hidden, a thinking block takes **no lines**: no `Thinking...` placeholder and no blank gap. **Ctrl+T** shows thinking again and splits groups at each block, and hiding it again joins them back.

A script, a `codemode` call, has a row of its own. The calls a script makes count in the summary of the group around it as direct calls do, and a script that made none counts as `ran 1 script`. Expanded, a script row shows `JavaScript, N lines ▸` (its source, behind its own toggle), a row for each nested call, each `models` call with its cost, and then the script's output. In those rows, filenames can be clicked, edits show diffs, and commands show their output. A script row turns red only when the script itself failed. A nested call that the script's end cut short shows a muted **✗**, or a muted **$** for a command.

A script's nested calls never reach the model as calls of their own, so Pi saves only their arguments, status, time, and error text in the session. Mirage takes their output from live `tool_execution_*` events and keeps it through settings changes and compaction, until `/reload` or `/resume`. After that, a nested read, command, or other call shows `Output not kept in session.` and a nested write shows the content it saved. A nested edit rebuilds its diff and line totals from its saved arguments, with line numbers relative to the replaced text. A nested call whose arguments were too large for Pi to save shows their size in bytes instead. A script's `store()` call writes a session entry before the script's result, and that entry never splits a group.

With [`rearview`](../rearview/README.md), loaded pages and new output form one transcript: a group that a page boundary split becomes one group when the older page loads, and the viewport stays anchored on it. Settings changes keep loaded rows and whether each is expanded. Pages still load one at a time, and saved calls are never run.

## Architecture

Mirage registers renderers through Pi's `registerToolRenderer` for Pi's built-in `read`, `bash`, `edit`, `write`, and `codemode` tools. Pi runs the tools, with its own shell, image, trust, and codemode settings. If another extension registers a tool under one of those five names, that extension draws it, and its calls are boundaries. Apply changes to Mirage with `/reload`.

`index.ts` adapts Pi's events and settings, `model.ts` owns the groups and what is expanded, and `view.ts` draws them. `nested.ts` reads a script result's `details.calls` and the `nestedCalls` Pi saves with it. The `shared` modules connect Mirage to the file opener (`inspector`) and the history pager (`rearview`), which are optional, without putting anything about drawing into saved session messages.

Mirage also draws another agent's calls for an extension that shows that agent's work, as [`comrade`](../comrade/README.md) shows a comrade's. The extension asks over Pi's event bus with `shared/nested.ts`'s `NESTED_ROWS_EVENT`, and Mirage answers with a service that keeps one model per agent. The extension adds each of the agent's messages as it ends, and asks for the row that each group's leader draws. A reply that ended asking for calls has them in progress (`Exploring 2 files`), since Pi runs them at once. These rows are grouped, worded, and coloured as Pi's own are, and their clicks expand groups and open files. They start collapsed whatever `Ctrl+O` says, and they follow `Ctrl+T`, which the service also reports, so the extension can show the agent's thinking only where Pi shows thinking. Without Mirage, no one answers, and the extension draws the calls itself.

Output padding and execution times come from Pi's tool render context (Pi 1.1+). Without `outputPad`, rows are drawn unpadded, with one warning.

Mirage has two adapters, both installed through `shared/patch.ts`:

- `native-images.ts` moves each row's native image previews into its collapsible output, and binds them before the first frame, so a group's leader can show any call's image.
- `native-thinking.ts` leaves thinking blocks out of what an assistant message draws while thinking is hidden, and keeps the message itself for Pi's own toggles. Since Pi 1.5.0, a hidden block with an empty label takes no lines natively, and `ctx.ui.setHiddenThinkingLabel("")` asks for that. Mirage does not use it: Pi puts its own label back and asks for a frame at the start of every `/reload` and session switch (`resetExtensionUI`), before `session_start` can empty it again.

Each adapter refuses to load when Pi lacks a method it replaces, or when another extension has replaced it. It checks the rest of what it reads when Pi calls it. If that has changed, it warns once and leaves native image previews or native thinking blocks in place. No installed Pi file, user setting, or image sent to the model is changed.

## Colours

Edit the three `#RRGGBB` values in **`shared/colours.ts`** and run `/reload`:

- `red`: removed lines and counts, failed status, and error output.
- `green`: added lines and counts, and successful status.
- `blue`: filenames that can be clicked.

Comrade's rows use the same file. `style.ts` keeps Pi's inverse word-change highlights in diffs, and `shared/colours.ts` picks the nearest fixed xterm colour where truecolour is unavailable. Pi's other colours and the theme's syntax colours are unchanged.

## Tests

See [development and tests](../README.md) for setup and commands. All tests run on Node. The terminal suite runs real Pi and Vim over a PTY, with xterm.js, an offline provider, and isolated settings. It checks terminal cells, colours, and Kitty image commands, not pixels. Vim runs clean, with syntax **on**, and your own editor configuration is untouched.
