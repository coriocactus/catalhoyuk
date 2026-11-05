# Echo

Echo is a Pi extension that inserts Markdown snippets from `~/.pi/agent/echo/*.md` into Pi's prompt editor via `@@` autocomplete, without submitting the message.

## Usage

Create the snippet directory and add one or more `.md` files:

```sh
mkdir -p ~/.pi/agent/echo
printf 'Review the changes for correctness and simplicity.\n' > ~/.pi/agent/echo/review.md
```

Run `/reload` once to load the extension. In the editor, type `@@` at the start of a line or after whitespace, followed by part of a snippet name. Press `Tab` or `Enter` to replace just the `@@name` token with the file's contents. Any surrounding draft text stays intact, and the cursor lands at the end of the inserted text so you can repeat the gesture to combine multiple snippets with your own prompt. Press `Escape` to dismiss the completion menu. Normal `@file` completion is unchanged.

## Snippet files

- Snippet names are the filenames without the `.md` extension, and spaces in names work without quotes.
- Only direct, non-hidden `.md` entries in the directory are offered, and symlinked snippet files are supported.
- File contents are inserted literally, with no frontmatter parsing, argument substitution, or whitespace trimming.
- Adding, editing, or removing snippet files takes effect immediately without running `/reload`.
- The snippet directory is resolved inside Pi's agent directory, respecting `PI_CODING_AGENT_DIR` when set.
- If a snippet file is missing or cannot be read when selected, Echo shows an error notification without changing the editor contents.

## Implementation

Echo is built on Node's filesystem APIs and Pi's public `getAgentDir` and `addAutocompleteProvider` APIs. Completion runs only in the interactive terminal UI and uses Pi's standard editor and undo handling. The extension uses no runtime dependencies, editor replacement, private APIs, filesystem watchers, or cached state.
