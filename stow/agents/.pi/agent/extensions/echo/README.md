# Echo

Load `~/.pi/agent/echo/*.md` into Pi's editor without sending a message.

```sh
mkdir -p ~/.pi/agent/echo
printf 'Review the changes for correctness and simplicity.\n' > ~/.pi/agent/echo/review.md
```

Run `/reload` once to load the extension. Type `@@` at the start of a line or
after whitespace, then part of a snippet name. Choose with Tab or Enter to replace
just `@@name` with its contents. The surrounding draft stays intact, and the cursor
lands after the inserted text. Repeat to combine snippets with your own text.
Escape dismisses completion; normal `@file` completion is unchanged.

- Names are filenames without `.md`; spaces in names work without quotes.
- Only direct, non-hidden `.md` entries are offered; symlinked snippets work.
- Contents are literal: no frontmatter parsing, argument substitution, or trimming.
- Adding, editing, or removing snippets needs no reload.
- Uses Pi's agent directory (`PI_CODING_AGENT_DIR` when set).
- Missing files and read errors notify without changing the editor.

The implementation uses Node's filesystem APIs and Pi's public `getAgentDir` and
`addAutocompleteProvider`. Completion is terminal-only and uses Pi's normal
editor/undo handling. No runtime dependencies, editor replacement, private APIs,
watchers, or cached state.
