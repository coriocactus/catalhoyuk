# Fullscreen history

Run `/reload` in fullscreen mode. The transcript starts with roughly **50 saved
entries**, plus the current compaction summary. Scroll upward with the wheel,
Page Up, or Home: reaching the top prepends one older batch and keeps the existing
messages in place. Reach the new top to load again; loading stops at the active
branch's beginning. End returns to live output.

- Loaded history stays available, including through compaction and live updates.
- Reload/resume and tree navigation start a fresh recent view. Reload after changing TUI mode.
- Model context, branch selection, session files, prompt history, and unsent drafts
  are unchanged. Tools are **never re-executed**.
- `tool-display` groups each historical page independently. Its filename-to-Vim
  clicks, hidden images, local toggles, and Ctrl+O still work.
- Change `PAGE_SIZE` in `model.ts`, then `/reload`, to adjust the batch size. A batch
  can be larger to keep tool calls with their results.

This lazily constructs **older UI rows**, not merely clipped pre-rendered history.
Pi itself still reads the session JSONL into memory; this is not disk-level paging
or a memory cap. Already displayed rows are retained.

`model.ts` selects entries along parent links; `scroll.ts` observes upward input
and anchors prepends. `native.ts` isolates the private renderer adapter, pinned to
**Pi 0.85.1**. It reuses native renderers with separate pending-tool state, never
patches installed files, and requires revalidation for Pi upgrades.

See [development and tests](../README.md).
