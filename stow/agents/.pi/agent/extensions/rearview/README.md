# Rearview

Run `/reload` in fullscreen mode. The transcript starts with roughly **50 saved
entries**, plus the current compaction summary. Scroll upward with the wheel,
Page Up, or Ctrl+Home: reaching the top prepends one older batch and keeps the existing
messages in place. Reach the new top to load again; loading stops at the active
branch's beginning. Ctrl+End returns to live output. (Plain Home/End move the editor
cursor.)

- Loaded history stays available, including through compaction and live updates.
- Reload/resume and tree navigation start a fresh recent view. Reload after changing TUI mode.
- Model context, branch selection, session files, prompt history, and unsent drafts
  are unchanged. Tools are **never re-executed**.
- With `mirage`, a tool run split by a page boundary joins into one group when the
  older page loads. The top row stays in place; if it was a group's first line, the
  merged group's header takes its place. Filename clicks, images, and toggles still work.
- Change `PAGE_SIZE` in `model.ts`, then `/reload`, to adjust the batch size. A batch
  can be larger to keep tool calls with their results.

This lazily constructs **older UI rows**, not merely clipped pre-rendered history.
Pi itself still reads the session JSONL into memory; this is not disk-level paging
or a memory cap. Already displayed rows are retained.

`model.ts` selects entries along parent links; `scroll.ts` observes upward input
and anchors prepends, including input arriving before the next layout. `anchors.ts`
keeps the top visible chat row in place through regrouping, expansion, and rebuilds.
Grouping sees each page before its rows are built and commits it only after the page
is built, so a failed page leaves the display unchanged. `native.ts`
isolates the private renderer adapter, checks the required APIs, and falls back to
the native transcript with a warning if setup is incompatible. Each outgoing
session disposes its adapter. No installed files are patched.

See [development and tests](../README.md).
