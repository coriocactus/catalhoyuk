# Rearview

Rearview is a Pi extension that starts the fullscreen transcript with only recent messages and lazily prepends older batches as you scroll upward.

## Usage

Run `/reload` in fullscreen mode. The transcript starts with roughly **50 saved entries** plus the current compaction summary. Scroll upward with the mouse wheel, `Page Up`, or `Ctrl+Home`: each time the viewport reaches the top of the transcript, Rearview prepends one older batch of entries while keeping the existing messages anchored in place. Reach the new top to load the next batch. Loading stops at the beginning of the active branch. Press `Ctrl+End` to return to live output (plain `Home` and `End` move the prompt editor cursor).

To adjust the batch size, change `PAGE_SIZE` in `model.ts` and run `/reload`. An individual batch can exceed `PAGE_SIZE` so that tool calls are always kept together with their results.

## Behaviour

- Loaded history stays in the transcript through compaction and live message updates.
- Running `/reload` or `/resume`, or navigating the session tree, resets the transcript to a fresh recent view. Run `/reload` after changing the TUI mode.
- Model context, active branch selection, session files, prompt history, and unsent editor drafts are unchanged, and tools are **never re-executed**.
- When used alongside [`mirage`](../mirage/README.md), a tool run split across a page boundary merges into a single group when the older page loads. The top visible row stays anchored in place (if it was the first line of the partial group, the merged group's header takes its place), and filename clicks, image previews, and expand/collapse toggles continue to work.
- Rearview lazily constructs **older UI rows** on demand rather than merely clipping pre-rendered history. However, Pi itself still reads the full session JSONL into memory, so this is not disk-level paging or a memory cap, and rows that have already been displayed are retained.

## Architecture

`model.ts` selects historical entry batches along parent links. `scroll.ts` observes upward terminal input and anchors prepends, including scroll input that arrives before the next layout pass completes. `anchors.ts` keeps the top visible chat row fixed in place across regrouping, row expansion, and transcript rebuilds. When `mirage` is active, grouping inspects each page before its UI rows are constructed and commits the batch only after the page is built, so a failed page build leaves the display unchanged. `native.ts` isolates the private transcript renderer adapter, checks the required Pi APIs on load, and falls back to the native transcript with a warning if the runtime setup is incompatible. Each outgoing session disposes of its adapter on shutdown, and no installed Pi files are patched.

See [development and tests](../README.md) for test instructions.
