# Inspector

Inspector is a Pi extension that opens tool filenames in Vim inside the same terminal when you plain-click them, including while Pi continues working in the background.

## Usage

Plain-click an underlined filename in a tool row to open it in Vim in the same terminal. Exit with `:q`, or save and exit with `:wq`, to return to Pi with the **latest** editor draft preserved, including background draft updates and cases where the editor fails.

Pi keeps working in the background while the editor owns the terminal, so avoid saving a file that Pi is also modifying.

Inspector resolves the editor executable from `$VISUAL`, then `$EDITOR`, and falls back to `vim`. The setting must be an executable path rather than a shell command. It checks target paths asynchronously and opens only existing regular files. Apply changes to the extension with `/reload`. No Ghostty, macOS, or editor configuration is modified.

## Architecture and limitations

Fullscreen filename clicks are supplied by [`mirage`](../mirage/README.md) through the `shared` protocol. Inspector owns only file resolution, the child editor process, and terminal handoff, while `paths.ts` isolates the dependency on Pi's installed path resolver (including Unicode normalization and macOS filename rules). When a session is replaced or shut down, Inspector waits for both the editor process to exit and the dialog to clean up. If the editor is still running on shutdown and ignores `SIGTERM`, it is killed with `SIGKILL` after one second.

Vim's TypeScript syntax highlighting has reproduced high CPU usage independently of Pi, and Vim's `redrawtime` option is only a highlighting time budget rather than a fix or a reliable stall prevention. The Node terminal test runs clean Vim with syntax **on** to test terminal handoff in isolation from personal Vim plugins. It does not establish that the separate highlighting stall is fixed.
