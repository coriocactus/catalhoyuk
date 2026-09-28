# Mirage

```text
✓ Ran 2 commands, read 3 files, wrote 2 files ▸
✓ Explored 4 files ▸
✓ Edited 3 files (+14 −22) ▸
✓ Edited ~/project/index.ts +12 −8 ▸
$ npm test ▸
```

- Follows Pi's **Output padding** setting for headers, bodies, and images, including live changes.
- Click rows/trailing carets to expand or collapse; group members have their own toggles.
- Command rows and command-only groups use **$**: green on success, red on failure,
  muted while pending/running. Mixed groups use **✓**, **✗**, or **…**.
- A closed group is one line. Its **✓**/**$** turns red only when every call failed;
  open it to see failed calls, red on their own rows. Error output stays hidden until expanded.
- Images group like other reads. Previews start hidden; each image row's toggle and
  **Ctrl+O** expand/collapse its own preview.
- **Ctrl+O** also controls text output, including errors.
- Click underlined filenames to open Vim through `inspector`, even while Pi is working.
- Consecutive edits collapse into `Edited X files (+X −Y) ▸`, with independently expandable
  file rows and line-numbered diffs. File counts are distinct paths within each working
  directory; totals sum successful edit diffs, not the net Git diff. Zero counts are omitted.
  Group summaries use grey brackets around plain counts; file rows keep green/red counts.
- Mixed reads, commands, edits, and writes share one summary, in first-tool order.
  Expanding shows the calls in their original order. Single calls keep their filename/command.
  Writes say `Wrote`, not `Created`: they may overwrite files. Only edits report diff totals.
- Hidden thinking occupies **no rows**, including no `Thinking...` placeholder or blank gap.
  **Ctrl+T** restores thinking and splits groups at those blocks; hiding it joins them again.

Consecutive supported tools group across turns without visible assistant content.
A new call joins its group while its arguments are still streaming. Commentary,
visible thinking, user messages, other tools (including MCP/codemode), and
failed/aborted/truncated assistant turns separate groups; commentary that arrives
after a call splits it off at once. Nested codemode calls keep Pi's native parent
rendering; they are not counted again. Local expansion choices reset on reload/resume.

With `rearview`, loaded history and live work form one grouped transcript: a run split
by a page boundary becomes one group when the older page loads, and the viewport stays
on it. Settings rebuilds keep rows and expansion. Pages are still fetched in bounded
batches, and archived calls are never executed.

`index.ts` adapts Pi events/settings, `model.ts` owns display state, and `view.ts`
only renders it. `shared` connects the independent opener and optional
history pager without putting presentation metadata in saved messages.
`native-images.ts` moves each row's native previews into its collapsible body, binding
them before the first paint, so a group leader can show any member's image;
`native-padding.ts` supplies the live output padding omitted from tool render contexts;
`native-thinking.ts` filters only assistant render inputs, retaining the original message
for native visibility toggles. All three adapters check capabilities and patch ownership.
Detected layout changes warn and fall back to native previews/thinking or unpadded rows.
No installed Pi files, settings, or model image payloads are modified.

This extension owns Pi's four **local built-in tools**, preserving global and
trusted project shell/image settings. Pi requires tool overrides for custom
rendering; do not combine this with other overrides of those tools or SDK custom
execution backends. Apply changes with `/reload`. Mouse clicks require fullscreen.

## Colours

Edit the three `#RRGGBB` values in **`colours.ts`**, then `/reload`:

- `red`: removed lines/counts, failed status, error output.
- `green`: added lines/counts, successful status.
- `blue`: clickable, underlined filenames.

`style.ts` applies these consistently, preserves inverse word-change highlights,
and chooses the nearest fixed xterm colour when truecolour is unavailable.
Other Pi UI and syntax colours are unchanged.

## Tests

See [the extensions development instructions](../README.md). All tests use Node;
the terminal suite uses xterm.js and real Pi/Vim PTYs, with an offline provider
and isolated settings. It checks cells/colours and Kitty image commands, not
GPU-rendered images. Clean Vim has syntax **on**; your editor config is untouched.
