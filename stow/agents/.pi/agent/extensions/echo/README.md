# Echo

Load `~/.pi/agent/echo/*.md` into Pi's editor without sending a message.

```sh
mkdir -p ~/.pi/agent/echo
printf 'Review the changes for correctness and simplicity.\n' > ~/.pi/agent/echo/review.md
```

Run `/reload` once to load the extension. Type `/echo re`, use Pi's normal
completion to choose `review`, then submit `/echo review`. The snippet replaces
the editor contents; edit it and send when ready. `/echo` alone shows usage.

- Names are filenames without `.md`; spaces in names work without quotes.
- Only direct, non-hidden `.md` entries are offered; symlinked snippets work.
- Contents are literal: no frontmatter parsing, argument substitution, or trimming.
- Adding, editing, or removing snippets needs no reload.
- Uses Pi's agent directory (`PI_CODING_AGENT_DIR` when set).
- Missing files and read errors notify without changing the editor.

The implementation uses Node's filesystem APIs and Pi's public `getAgentDir`,
`registerCommand`, argument completions, and `ctx.ui.setEditorText`. No runtime
dependencies, editor replacement, private APIs, watchers, or cached state.
