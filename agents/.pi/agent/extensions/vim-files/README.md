# Vim file clicks

Plain-click a tool filename to open Vim in the same terminal. Exit with `:q`, or
save and exit with `:wq`, to return to Pi with your draft preserved.

Pi keeps working in the background. Avoid saving a file that Pi is also changing.

Uses `$VISUAL`, then `$EDITOR`, then `vim`; the value must be an executable path,
not a shell command. Opens existing regular files only, with asynchronous checks.

`tool-display` supplies fullscreen filename clicks through `file-tools-shared`.
This extension owns only file resolution, the editor process, and terminal handoff.
`paths.ts` isolates the dependency on Pi's installed path resolver (tested with
Pi 0.85.1), including Unicode and macOS filename rules.

No Ghostty, macOS, or editor configuration is modified. Apply changes with `/reload`.

Vim's TypeScript highlighting has reproduced high CPU independently of Pi.
`redrawtime` is a highlighting budget, not a fix or a reliable stall prevention.
The Node terminal test uses clean Vim with syntax **on** to isolate handoff from
personal plugins; it does not establish that the separate highlighting stall is fixed.
