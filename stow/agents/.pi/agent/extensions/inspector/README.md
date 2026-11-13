# Inspector

Inspector opens the filename of a tool row in your editor, in the same terminal, when you click it. Pi keeps working while the editor is open.

## Usage

Click an underlined filename in a tool row. The editor opens that file in the same terminal. Leave the editor (in Vim, `:q`, or `:wq` to save) to return to Pi with the **latest** draft of your prompt, including changes made to it while the editor was open, and also when the editor fails.

Pi keeps working while the editor owns the terminal, so avoid saving a file that Pi is also modifying.

The editor is `$VISUAL`, then `$EDITOR`, then `vim`. It must name an executable, not a shell command. Inspector checks the path without blocking Pi and opens only existing regular files. An editor that exits with an error is reported by its name. No terminal, macOS, or editor configuration is modified.

Apply changes with `/reload`.

## Architecture and limits

[`mirage`](../mirage/README.md) draws the filenames and reports a click through `shared/protocol.ts`. Inspector owns only resolving the file, the editor process, and handing the terminal over and back.

`paths.ts` resolves a filename as Pi's own tools do, including their Unicode and macOS filename rules. Pi does not export those resolvers, so `paths.ts` loads `dist/core/tools/path-utils.js` from Pi's package directory by its path. `npm run pi-diff` watches that file for changes as it watches every Pi module the extensions import.

When a session is replaced or shut down, Inspector waits for the editor to exit and for its dialog to close. An editor still running at shutdown gets `SIGTERM`, and `SIGKILL` one second later.

Vim's TypeScript syntax highlighting has shown high CPU use by itself, apart from Pi. Vim's `redrawtime` option only limits the time spent highlighting; it does not prevent a stall. The terminal suite runs a clean Vim with syntax **on**, to test the handover apart from personal Vim plugins. It does not show that the highlighting stall is fixed.

See [development and tests](../README.md) for test instructions.
