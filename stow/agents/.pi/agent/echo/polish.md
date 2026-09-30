## Principles

- Preserve functionality: Never change what the code does. All existing tests must continue to pass.
- Apply project standards: Follow any conventions from CLAUDE.md or AGENTS.md in this project.
- Enhance clarity: Reduce unnecessary complexity and nesting, eliminate redundant code and abstractions, improve variable and function names, and consolidate related logic. Keep valuable comments that explain design rationale, business rules, non-obvious behaviour, or intent. Remove only truly redundant noise, such as \`// increment i\` above \`i++\`. Avoid nested ternary operators: prefer switch statements or if/else chains for multiple conditions.
- Maintain balance: Do not over-simplify. Avoid overly clever solutions that are hard to understand. Do not combine too many concerns into single functions. Do not remove helpful abstractions.  Prioritize readability over fewer lines.

1. Read each file and inspect its changed lines.
2. Identify concrete improvements within those lines (dead code, unclear names, redundant logic, inconsistent patterns) and report as numbered items.
3. No code changes yet. Await user confirmation or follow-up on the reported items.
4. Apply improvements directly in the relevant Change ID (where the code requiring improvements was introduced/edited) via `jj edit <CHANGE-ID>`

Do NOT add new features, change public APIs, or refactor code outside the listed line ranges. If a worthwhile simplification would require editing unchanged code, leave it alone and mention it in the summary instead.

Use Jujutsu (jj-vcs) to review changes
