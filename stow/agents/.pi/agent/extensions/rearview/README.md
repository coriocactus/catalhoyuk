# Rearview

Rearview starts the fullscreen transcript with only its most recent entries, and adds older pages above them as you scroll to the top.

## Usage

Run `/reload` in fullscreen mode. The transcript starts with about **50 saved entries** plus the current compaction summary. Scroll up with the mouse wheel, `Page Up`, or `Ctrl+Home`: each time the viewport reaches the top of the transcript, Rearview adds one older page above it and keeps the rows you were reading in place. Reach the new top to load the next page. Loading stops at the beginning of the active branch. Press `Ctrl+End` to return to the latest output (plain `Home` and `End` move the cursor in the prompt editor).

To change the page size, change `PAGE_SIZE` in `model.ts` and run `/reload`. A page can hold more than `PAGE_SIZE` entries, because a tool call always stays with its result.

## Behaviour

- Loaded pages stay in the transcript through compaction and through new output.
- `/reload`, `/resume`, and navigating the session tree reset the transcript to its most recent entries. Run `/reload` after changing the TUI mode.
- Model context, the active branch, session files, prompt history, and unsent drafts are unchanged, and tools are **never run again**.
- With [`mirage`](../mirage/README.md), a group that a page boundary split becomes one group again when the older page loads. The anchor, the line at the top of the viewport, stays in place: if it was the first line of the split group, the whole group's header takes its place. Filename clicks, image previews, and expanding and collapsing keep working.
- Rearview builds **older rows** only when asked for them; it does not clip rows that were already built. Pi itself still reads the whole session file into memory, so this is not paging from disk or a memory cap, and rows that have been shown are kept.

## Architecture

`model.ts` selects the entries of each page along parent links. `scroll.ts` notices scrolling at the top and holds the anchor while a page is added, including scroll input that arrives before the next layout pass. `anchors.ts` finds the anchor again after regrouping, expanding, and transcript rebuilds. With `mirage`, the groups of a page are worked out before its rows are built and kept only once they are, so a page that fails to build changes nothing on screen.

`native.ts` is the adapter: it replaces Pi's private `InteractiveMode.renderSessionEntries` through `shared/patch.ts`. If that method is missing when the extension loads, or another extension has replaced Rearview's, Rearview does not load. The rest of what the adapter reads is checked when Pi first builds a transcript; if that check fails, Rearview warns once and leaves the native transcript in place. Each session lets go of the patch when it shuts down, and no installed Pi file is changed.

See [development and tests](../README.md) for test instructions.
