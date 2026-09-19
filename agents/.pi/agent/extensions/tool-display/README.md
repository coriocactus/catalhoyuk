# Compact tool display

```text
✓ Explored 4 files ▸
✓ Edited ~/project/index.ts +12 −8 ▸
$ npm test ▸
```

- Follows Pi's **Output padding** setting for headers, bodies, and images, including live changes.
- Click rows/trailing carets to expand or collapse; group members have their own toggles.
- Command headers use **$**: green on success, red on failure, muted while pending/running.
- Failed rows stay visible; file tools retain **✗**. Error output stays hidden until expanded.
- Images start hidden; row toggles and **Ctrl+O** expand/collapse their previews.
- **Ctrl+O** also controls text output, including errors.
- Click underlined filenames to open Vim through `vim-files`, even while Pi is working.
- Edits have change counts and expandable, line-numbered diffs.

Consecutive reads/commands group across tool-only turns. Commentary, thinking,
user messages, other tools, and image results separate groups. Image reads stay
standalone with a visible filename. Local expansion choices reset on reload/resume.
With `fullscreen-history`, each older page has independent groups: browsing never
merges archived calls into live work. Filename clicks and Ctrl+O still work.

`index.ts` adapts Pi events/settings, `model.ts` owns display state, and `view.ts`
only renders it. `file-tools-shared` connects the independent opener and optional
history pager without putting presentation metadata in saved messages.
`native-images.ts` moves Pi's native previews into collapsible bodies;
`native-padding.ts` supplies the live output padding omitted from tool render contexts.
Both scoped adapters check capabilities rather than requiring an exact Pi version.
Detected layout changes warn and fall back to native previews or unpadded rows.
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
