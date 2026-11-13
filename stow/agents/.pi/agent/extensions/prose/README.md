# Prose

Prose changes how Pi draws Markdown and plain text, and bounds its text selection to the text, as Amp does. Code blocks lose their fence lines, are indented, and keep their language's highlighting. Inline code already shows without backticks. Wrapped lines keep their indent, in Markdown and in plain text such as tool output. Markdown lines end where their text ends instead of being padded with spaces to the right edge.

## Selection

In fullscreen mode, Pi draws its own mouse selection and copies it. With Prose, a selection is bounded to text everywhere in the transcript:

- Every line's selection ends at its last character, whatever padding or background the line has: in messages, tool rows, and everything else.
- A line's selection starts at its content, after margins and indents, where the line marks it. Markdown and plain-text lines do, and so do [`mirage`](../mirage/README.md)'s tool rows. A code line starts after the block's indent but keeps the code's own indentation, and a continuation line starts after its hanging indent. A selection that starts in the indent begins at the content, and one that ends there selects nothing on that line. Lines that nobody marks start where Pi starts them.
- A copy joins continuation lines back into the lines they came from, with the space the wrap dropped, or with none where the wrap broke inside a word. Separate lines and paragraphs stay separate, including soft and hard line breaks inside a paragraph.
- A triple-click selects a wrapped line with its continuation lines, not just the line clicked.

## Wrapping

Prose wraps Markdown and plain text itself, before Pi does. Each continuation line hangs under its line's indent, as list items already do in Pi, and a long code line wraps under the code's own indentation. Each line records where its content starts and, if it is a continuation line, whether the wrap dropped a space. Pi's own wrapping drops that space, so a copy could not otherwise tell a wrapped line from two lines. Pi then lays out the wrapped text as it always does, which carries a style across line breaks.

## Markers

The records are markers: zero-width sequences in each line, defined in `shared/selection.ts` so that other extensions can mark their lines too. They are private APC sequences, which pi-tui counts as zero width and strips from copies, and which terminals ignore. Pi's selection finds them in the line as drawn, so the right column is found whatever padding, margins, or wrapping a component adds.

## Setting

The code indent is Pi's `markdown.codeBlockIndent` setting, two spaces unless you set it. With `""`, code is flush and there is no indent to skip. Lines with a background, such as user messages, are still padded to the edge so the background fills the line, but selecting them stops at the text.

## How it works

Prose is an adapter. It installs three patches through `shared/patch.ts`, which replace six pi-tui methods:

- `Markdown`: `renderToken`, for code blocks and wrapping, and `render`, so lines end at their text.
- `Text`: `render`, for plain-text wrapping.
- `TuiAltScreen`: `getSelectionColumns`, `getActiveSelectionText`, and `getLineSelection`.

The classes are imported by name, so `npm run pi-diff` watches their modules on upgrades.

Before each patch, Prose probes Pi's own code: a code block, a wrapped and cached text, and a selection, copy, and triple-click. A patch whose Pi code no longer looks as expected is not installed, with one warning. After each patch, Prose checks again through the patched code, since Pi could pass a probe and yet stop calling what Prose replaced. It removes a patch that fails this check, with one warning. Sessions share the patches, and the last to shut down restores Pi's methods. If another extension has replaced one of Prose's methods, Prose does not load.

Apply changes with `/reload`.

See [development and tests](../README.md) for test instructions.
