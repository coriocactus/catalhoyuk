# Mirage

Mirage is a Pi extension that renders `read`, `bash`, `edit`, `write`, and `codemode` tool calls as compact, collapsible rows and groups consecutive tool runs into a single expandable summary. It only draws these tools, and Pi still runs them.

```text
✓ Ran 2 commands, read 3 files, wrote 2 files (+48) ▸
✓ Explored 4 files ▸
✓ Edited 3 files (+14 −22) ▸
✓ Edited ~/project/index.ts +12 −8 ▸
✓ Wrote ~/project/notes.md +30 ▸
$ npm test ▸
✓ Script: read 3 files, ran 1 command ▸
```

## Tool rows and summaries

- Rows respect Pi's **Output padding** setting for headers, bodies, and images, updating live when the setting changes.
- Click a row or its trailing caret to expand or collapse it. Inside an expanded group, each member row has its own toggle. **Ctrl+O** also expands or collapses text output (including errors) and image previews. Mouse clicks require fullscreen mode.
- Command rows and command-only groups use **$**, rendered in green on success and red on failure. Mixed groups and non-command rows use **✓** or **✗**.
- While Pi is working, rows and groups with calls in progress show Pi's working spinner (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) in the accent colour, matching the one on the editor. This includes the calls inside a script. A call left in progress while Pi is idle shows a muted **…**, or a muted **$** for a command. Only rows in progress are redrawn, 12.5 times a second, and the timer stops once nothing is in progress or Pi goes idle.
- A closed group occupies a single line. Its leading **✓** or **$** turns red only when every call in the group failed. Expand the group to inspect individual failed calls, which appear in red on their own rows. Error output remains hidden until expanded.
- When a command or codemode script finishes, its output ends with a muted `Took 1.2s` line showing the execution time recorded by Pi, matching Pi's built-in `bash` and `codemode` rows. This duration survives `/reload` and `/resume`, including for commands called inside scripts. Pi's live `Elapsed` counter is not shown.
- Each row marks where its content starts, after its padding and indent, so [`prose`](../prose/README.md) can start a selection there. A tool's output keeps its own indentation when copied.
- Click any underlined filename to open it in Vim through [`inspector`](../inspector/README.md), even while Pi is working.
- Consecutive edits collapse into `Edited X files (+X −Y) ▸`, with independently expandable file rows and line-numbered diffs. File counts reflect distinct paths within each working directory, and line totals sum the diffs of successful edits rather than the net Git diff. Zero counts are omitted. Group summaries wrap plain counts in grey brackets, while individual file rows keep green and red counts.
- Mixed runs of reads, commands, edits, and writes share a single summary ordered by the first appearance of each tool kind, while expanding the group shows the calls in their original chronological order. Single ungrouped calls keep their filename or command in the header.
- Commands are drawn as Amp draws them. A chain of `&&`, `||`, `|` or `;` steps shows one step per line, each ending in its operator and a backslash, with continuation lines indented. Quotes, `$(…)`, subshells, loops, conditionals and `{ …; }` groups are never split, and a command's own line breaks are kept, its later lines indented as continuations are, by four columns plus whatever they indent beyond each other. A leading `cd DIR &&` is shown as a dim italic `(in DIR)` after the command, and a failed command ends with `(exit code: N)`, the code in red. Command names are bold, and flags, strings, variables, redirects, operators and comments use the theme's syntax colours. Heredoc bodies are counted (`python3 - <<'EOF' … 48 lines`) and a header stops after eight lines. The expanded output repeats the full command only when its header left part of it out.
- Read rows include Pi's line-range suffix (`:40-89`). Image reads group alongside other reads. Their previews start hidden, and each image row's toggle or **Ctrl+O** expands or collapses its own preview.
- Write rows say `Wrote` rather than `Created` because `write` may overwrite an existing file. Because Pi reports no diff for a write, a write row counts only the lines written (`+N`) and never reports removals.
- In group summaries, each tool kind totals its own successful calls (for example, `wrote 6 files (+420), edited 3 files (+26 −16)`), whereas commands and reads have no line totals.
- If a tool call's arguments are not valid JSON, its header shows a dim `invalid arguments` label instead, and its expanded output shows Pi's error along with the raw text the model sent.

## Grouping, thinking, and codemode

Consecutive supported tool calls group across assistant turns whenever no visible assistant content separates them, and a new call joins the active group while its arguments are still streaming. Assistant commentary, visible thinking blocks, user messages, unsupported tools (including MCP tools and `tool_search`), and failed, aborted, or truncated assistant turns separate groups. If commentary streams in after a tool call, that call splits off from the group immediately. Local expand and collapse states reset on `/reload` or `/resume`.

When thinking is hidden, thinking blocks occupy **no rows** at all, leaving no `Thinking...` placeholder or blank gap. Pressing **Ctrl+T** restores thinking blocks and splits tool groups at those boundaries, and hiding thinking again merges the groups back together.

Codemode scripts receive their own rows. The tool calls made inside a script count toward the surrounding run's summary just like direct calls, and a script that called no tools counts as `ran 1 script`. Expanding a script row shows `JavaScript, N lines ▸` (its expandable source code), a row for each nested call, any `models` calls with their cost, and then the script's output. Within those nested rows, filenames are clickable links, edit rows show diffs, and command rows show their output. A script row turns red only when the script itself failed. Nested calls that were cut off when the script ended show a muted **✗**, or a muted **$** for commands.

Because a script's nested calls never reach the model as top-level tool calls, Pi saves only their arguments, status, execution time, and error text in the session. Mirage captures their full outputs from live `tool_execution_*` events and retains them across settings rebuilds and compaction until `/reload` or `/resume`. After a reload or resume, nested read, command, and other tool rows display `Output not kept in session.`, write rows display their saved content, and edit rows rebuild their diff and line totals from the saved arguments (with line numbers relative to the replaced text). Nested rows whose arguments were too large for Pi to save display the omitted size in bytes instead. A script's `store()` call writes a session entry before the script's result, and that entry never splits a tool group.

When used with [`rearview`](../rearview/README.md), loaded history pages and live work form a single grouped transcript: a tool run split by a page boundary merges into one group when the older page loads, and the viewport stays anchored on it. Settings rebuilds preserve loaded rows and their expansion state. History pages are still fetched in bounded batches, and archived calls are never executed.

## Architecture

Mirage registers custom renderers through Pi's `registerToolRenderer` for Pi's built-in `read`, `bash`, `edit`, `write`, and `codemode` tools, while Pi executes the tools using its own shell, image, trust, and codemode settings. If another extension registers a tool under one of those five names, that extension's renderer draws it and its calls separate tool groups. Apply changes to Mirage with `/reload`.

Internally, `index.ts` adapts Pi events and settings, `model.ts` owns the grouping and display state, and `view.ts` renders that state. `nested.ts` reads a script result's `details.calls` and the `nestedCalls` records that Pi saves with it. The `shared` modules connect the independent file opener (`inspector`) and optional history pager (`rearview`) without storing presentation metadata in saved session messages.

Mirage also draws another agent's calls for an extension that shows that agent's work, such as [`comrade`](../comrade/README.md) showing its sub-agents. The extension asks over Pi's event bus with `shared/nested.ts`'s `NESTED_ROWS_EVENT`, and mirage answers with a service that keeps one model per transcript: the extension adds each of the agent's messages as it ends, and asks for the row each group's first call leads. A reply that ended asking for calls has them under way (`Exploring 2 files`), as Pi runs them at once. The rows are grouped, worded and coloured as Pi's own, their clicks open groups and files, they start collapsed whatever `Ctrl+O` says, and they follow `Ctrl+T`, which the service also reports, so the extension can show the agent's thinking only where Pi shows thinking. Without mirage, no one answers, and the extension draws the calls itself.

Output padding and execution times come from Pi's tool render context (Pi 1.1+). If `outputPad` is unavailable, rows render unpadded and emit a single warning. `native-images.ts` moves each row's native image previews into its collapsible body and binds them before the first paint so that a group leader can display any member's image. `native-thinking.ts` filters thinking blocks out of assistant render inputs when hidden while retaining the original message for native visibility toggles. Both adapters check required capabilities and patch ownership on load, and warn and fall back to Pi's native image previews or thinking blocks if they detect a layout change. No installed Pi files, user settings, or model image payloads are modified.

## Colours

Edit the three `#RRGGBB` values in **`colours.ts`** and run `/reload`:

- `red`: Removed lines and counts, failed status indicators, and error output.
- `green`: Added lines and counts, and successful status indicators.
- `blue`: Clickable, underlined filenames.

`style.ts` applies these colours consistently, preserves inverse word-change highlights in diffs, and selects the nearest fixed xterm colour when truecolour is unavailable. Other Pi UI and syntax colours are unchanged.

## Tests

See [the extensions development instructions](../README.md) for setup and commands. All tests run on Node, and the terminal suite uses xterm.js and real Pi and Vim PTYs with an offline provider and isolated settings. It verifies terminal cells, colours, and Kitty image commands rather than GPU-rendered pixels. Clean Vim runs with syntax **on**, and your personal editor configuration is untouched.
