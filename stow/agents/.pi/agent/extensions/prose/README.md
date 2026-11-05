# Prose

Prose makes Pi's Markdown, its plain text, and its text selection behave like Amp's. Code blocks are drawn without their fence lines, indented, and still highlighted for their language. Inline code already shows without backticks. Wrapped lines keep their indent, in Markdown and in plain text such as tool output, and Markdown lines end where their text ends rather than being padded with spaces to the right edge.

## Selection

In fullscreen mode, Pi draws its own mouse selection and copies it. With prose, a selection is bounded to text everywhere in the transcript:

- Every row's selection ends at its last character, whatever padding or background the row has, in messages, tool rows and anything else.
- A row starts at its content, after margins and indents, where the row marks it. Markdown and plain-text rows do, and so do [`mirage`](../mirage/README.md)'s tool rows. A code line starts after the block's indent but keeps the code's own indentation, and a wrapped row starts after its hanging indent. A selection that starts in the indent begins at the content, and one that ends there selects nothing on that row. Rows nobody marks start where Pi starts them.
- A copy joins wrapped rows back into the lines they came from, with the space the wrap dropped, or with none where it broke inside a word. Separate lines and paragraphs stay separate, including soft and hard line breaks inside a paragraph.
- A triple-click selects a whole wrapped line, not just the row clicked.

## Wrapping

Prose wraps Markdown and plain text itself, before Pi would. Each continuation row hangs under its line's indent, as list items already do in Pi, and a long code line wraps under the code's own indentation. Each row records where its content starts and, if it continues the line above, whether the wrap dropped a space. Pi's own wrapping drops that space, so a copy could not otherwise tell a wrapped line from two lines.

## Markers

The records are zero-width markers in each rendered row, defined in `shared/selection.ts` so other extensions can mark their rows too. They are private APC sequences, which pi-tui counts as zero width and strips from copies, and which terminals ignore. Pi's selection finds them on the rendered row, so the right column is found whatever padding, margins or wrapping a component adds.

## Setting

The code indent is Pi's `markdown.codeBlockIndent` setting, four spaces here. With `""`, code is flush and there is no indent to skip. Lines with a background, such as user messages, are still padded to the edge so the background fills the row, but selecting them stops at the text.

## How it works

Prose patches six pi-tui methods: `Markdown`'s `renderToken`, for code blocks and wrapping, and `render`, to end lines at their text, `Text`'s `render`, for plain-text wrapping, and `TuiAltScreen`'s `getSelectionColumns`, `getActiveSelectionText` and `getLineSelection`. The classes are imported by name, so `npm run pi-diff` watches their modules on upgrades. Before patching, it probes each group with Pi's own code: a code block, a wrapped and cached text, and a selection, copy and triple-click. A part whose Pi code no longer looks as expected is left alone, with a warning. After patching, it checks each group again through the patched code, since Pi could pass a probe yet stop calling what prose replaced, and puts Pi's own methods back for a group that fails, also with a warning. Sessions share one installation, and the last to close restores Pi's methods, unless another extension has since replaced them.

Apply changes with `/reload`.
