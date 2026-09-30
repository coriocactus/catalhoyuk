## Principles

- Write for a reader, not for the writer: Every sentence should be clear to someone who does not already know what it says. McCloskey calls clarity the one golden rule (Economical Writing, third edition, University of Chicago Press, 2019). The rest are ways to keep it.
- Writing is thinking: A sentence that will not come clear comes from a thought that is not clear yet. Say what is unclear rather than smoothing the words over it.
- Preserve meaning: Change how a thing is said, never what it says. When a rewrite would change the meaning, report it rather than apply it.
- Apply project standards: The project's conventions, such as AGENTS.md, come first. Use the project's dialect, British English here, and keep the exact names the code uses.

## Checks, in order of importance

1. Check the facts before the words: A sentence can be clear and wrong. Read the code, tests and workflows a sentence describes before you rewrite it, and report a stale claim rather than tidy it. A review finds more stale claims than unclear sentences.
2. Each sentence hits its target in the middle: Use active verbs. "You should use active verbs", not "active verbs should be used". Cut adjectives and adverbs first, then anything else that does not change the meaning.
3. One word means one thing: Do not vary a name for elegance. If it is the build, call it the build every time. Express parallel ideas in parallel form.
4. Query every this, these, that and those: Each one points the reader backwards, and looking back is looking away. Replace with "the" or with the noun itself.
5. A paragraph has one point: Cut a paragraph that has none. Split one that has two. A run of one-sentence paragraphs is breathless, and a wall of text is skipped.
6. No boilerplate and no anticipation: Cut "It is important to note that", "As we will see", "In this section we", and any sentence that announces a later sentence. Say the thing.
7. Cut the words bad writers love: via, the process of, respectively, hypothesise, utilise, in order to, in terms of, with respect to, the fact that, and their kind.
8. Be concrete and plain: A number over "significant", a noun over a category, "big" over "of substantial magnitude". Use plain words, and use the same technical term the code uses rather than a synonym.
9. Write in complete sentences: Short ones are fine. Fragments used as headings, and labels standing where a sentence should go, are not.
10. Watch the tricks that replace punctuation: No emphasis by italics, bold or scare quotes. If a sentence needs them to make its point, rewrite it. A bold lead-in that names a paragraph's subject is a heading, not emphasis.
11. Read it out loud: A sentence you would stumble over, or would not say to a colleague, needs rewriting.

## Claudisms

Check every sentence against https://claudisms.ai/claudisms.md, the banlist of words and constructions that give machine-written text away. Search for the listed words. The ones that keep coming up in technical prose are shape, lives, carries, holds, settled, real, worth and surface as a verb. Catch by eye the constructions no search can find: the cleft ("what I keep coming back to is"), the crowned superlative ("the one that matters most"), the negative parallelism ("not X, but Y"), the metaphor of placement or weight and the announcement of value ("worth noting", "this matters").

## Punctuation

- No semicolons in prose. Split the sentence, or use a comma. A semicolon inside a quoted log message or a CLI message stays, because the quote must match its source.
- No em dashes. Use a comma, a full stop or brackets.
- Code, SQL and quoted output are not prose. Leave them alone.

## Process

1. Read each file and inspect its changed lines. Prose includes comments, docstrings, log messages, commit descriptions and Markdown.
2. For each sentence that fails a check, report the sentence, the check it fails and the rewrite, as numbered items. Group them by file.
3. No changes yet. Await confirmation or follow-up on the reported items.
4. Apply the rewrites in the Change ID that last touched each line, via `jj edit <CHANGE-ID>`. Leave the working copy on a fresh empty change at the tip.

Do NOT change what a sentence says, rename a symbol, or rewrite prose outside the listed range. A fix that belongs outside the range goes in its own change after confirmation. If a rewrite needs a fact you do not have, ask.

Use Jujutsu (jj-vcs) to review changes
