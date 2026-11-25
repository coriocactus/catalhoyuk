# Inspector

Inspector opens the filename of a call in your editor, in the same terminal, when you click it, and so a Markdown link to a text file. Pi keeps working while the editor is open.

## Usage

Click an underlined filename in a call's row. The editor opens that file in the same terminal. Leave the editor (in Vim, `:q`, or `:wq` to save) to return to Pi with the **latest** draft of your prompt, including changes made to it while the editor was open, and also when the editor fails.

Pi keeps working while the editor owns the terminal, so avoid saving a file that Pi is also modifying.

## Links

In fullscreen mode, Pi opens a link you click in a message itself, with the system's opener: on macOS, `open`, which gives a Markdown file to TextEdit. Inspector opens a `file://` link to a text file in the editor instead, as it opens a filename, at the line its fragment names: `#L120`, `#120`, or the first line of `#L120-L130`, passed to the editor as `+120`. A text file has no NUL byte in its first 8,000 bytes, and those bytes are valid UTF-8, as git tells text from binary. An empty file is text.

Every other link goes to Pi's opener, as before: a web page, a link to an image, a PDF, or another file that is not text, a directory, and a file that is gone. In regular mode the terminal opens links itself, and Pi never sees the click.

Pi sets its opener on the screen from its options, so no method of its class can be replaced to reach it. Inspector replaces the screen's mouse handling for selection, `TuiAltScreen.handleSelectionMouseEvent`, which wraps the screen's opener once before Pi handles the event. If Pi's screen has no opener there, Inspector warns once and links open as Pi opens them.

The editor is `$VISUAL`, then `$EDITOR`, then `vim`. It must name an executable, not a shell command. Inspector checks the path without blocking Pi and opens only existing regular files. An editor that exits with an error is reported by its name. No terminal, macOS, or editor configuration is modified.

Apply changes with `/reload`.

## Architecture and limits

[`mirage`](../mirage/README.md) draws the filenames and reports a click through `shared/protocol.ts`. Inspector owns only resolving the file, the editor process, and handing the terminal over and back. `links.ts` reads a clicked link and tells a text file from binary.

`paths.ts` resolves a filename as Pi's own tools do, including their Unicode and macOS filename rules. Pi does not export those resolvers, so `paths.ts` loads `dist/core/tools/path-utils.js` from Pi's package directory by its path. `npm run pi-diff` watches that file for changes as it watches every Pi module the extensions import.

When a session is replaced or shut down, Inspector waits for the editor to exit and for its dialog to close. An editor still running at shutdown gets `SIGTERM`, and `SIGKILL` one second later.

Vim's TypeScript syntax highlighting has shown high CPU use by itself, apart from Pi. Vim's `redrawtime` option only limits the time spent highlighting; it does not prevent a stall. The terminal suite runs a clean Vim with syntax **on**, to test the handover apart from personal Vim plugins. It does not show that the highlighting stall is fixed.

See [development and tests](../README.md) for test instructions.
