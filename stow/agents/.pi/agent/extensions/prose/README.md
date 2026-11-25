# Prose

Prose changes how Pi draws Markdown and plain text, and bounds its text selection to the text. Code blocks lose their fence lines, are indented, and keep their language's highlighting. Inline code, which already shows without backticks, is bold and in the terminal's yellow, headings are in its cyan, and list markers, bulleted and numbered, are in the text's colour. Wrapped lines keep their indent, in Markdown and in plain text such as tool output. Markdown lines end where their text ends instead of being padded with spaces to the right edge. A user message is a green bar beside green italic text, with no background.

## Colours

Inline code is `yellow`, headings `sky`, and user messages `moss`, in **`shared/colours.ts`**, which mirage's and comrade's rows use too. Each is a palette entry of the terminal (3, 6, and 2), so it follows the terminal's theme, as `ls` and `jj` colours do. A six-digit RGB value works there too. Edit the file and run `/reload`.

## User messages

A user message keeps Pi's Markdown, and draws it without the background and its padding: a green `┃` beside every line of the text, blank lines between paragraphs included, and the blank lines Pi puts around every message. Its list markers are green, as its text is. Pi's output padding comes before the bar. The bar is layout: a selection starts after it.

## Selection

In fullscreen mode, Pi draws its own mouse selection and copies it. With Prose, a selection is bounded to text everywhere in the transcript:

- Every line's selection ends at its last character, whatever padding or background the line has: in messages, calls, and everything else. A line that marks where its content ends ends there instead, before the caret that expands or collapses it: [`mirage`](../mirage/README.md)'s and [`comrade`](../comrade/README.md)'s rows do.
- A line's selection starts at its content, after margins and indents, where the line marks it. Markdown and plain-text lines do, and so do [`mirage`](../mirage/README.md)'s rows. A code line starts after the block's indent but keeps the code's own indentation, and a continuation line starts after its hanging indent. A selection that starts in the indent begins at the content, and one that ends there selects nothing on that line. Lines that nobody marks start where Pi starts them.
- A copy joins continuation lines back into the lines they came from, with the space the wrap dropped, or with none where the wrap broke inside a word. Separate lines and paragraphs stay separate, including soft and hard line breaks inside a paragraph.
- A triple-click selects a wrapped line with its continuation lines, not just the line clicked.

## Wrapping

Prose wraps Markdown and plain text itself, before Pi does. Each continuation line hangs under its line's indent, as list items already do in Pi, and a long code line wraps under the code's own indentation. Each line records where its content starts and, if it is a continuation line, whether the wrap dropped a space. A line can also record where its content ends, before a caret. Pi's own wrapping drops that space, so a copy could not otherwise tell a wrapped line from two lines. Pi then lays out the wrapped text as it always does, which carries a style across line breaks.

## Markers

The records are markers: zero-width sequences in each line, defined in `shared/selection.ts` so that other extensions can mark their lines too. They are private APC sequences, which pi-tui counts as zero width and strips from copies, and which terminals ignore. Pi's selection finds them in the line as drawn, so the right column is found whatever padding, margins, or wrapping a component adds.

## Setting

The code indent is Pi's `markdown.codeBlockIndent` setting, two spaces unless you set it. With `""`, code is flush and there is no indent to skip. Lines with a background are still padded to the edge so the background fills the line, but selecting them stops at the text.

## How it works

Prose is an adapter. It installs four patches through `shared/patch.ts`, which replace six pi-tui methods and one of Pi's:

- `Markdown`: `renderToken`, for code blocks and wrapping, and `render`, so lines end at their text, with inline code and headings in their colours.
- `Text`: `render`, for plain-text wrapping.
- `TuiAltScreen`: `getSelectionColumns`, `getActiveSelectionText`, and `getLineSelection`.
- `UserMessageComponent`: `rebuild`, for user messages.

The classes are imported by name, so `npm run pi-diff` watches their modules on upgrades.

Before each patch, Prose probes Pi's own code: a code block, a wrapped and cached text, a selection, copy, and triple-click, and a user message built as one padded Markdown with a background. A patch whose Pi code no longer looks as expected is not installed, with one warning. After each patch, Prose checks again through the patched code, since Pi could pass a probe and yet stop calling what Prose replaced. It removes a patch that fails this check, with one warning. When Pi starts, such a warning waits for your first key: Pi draws the session's transcript after Prose loads, and the warning would otherwise sit above it. Sessions share the patches, and the last to shut down restores Pi's methods. If another extension has replaced one of Prose's methods, Prose does not load.

Apply changes with `/reload`.

See [development and tests](../README.md) for test instructions.
