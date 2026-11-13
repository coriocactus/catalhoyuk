Refine existing code for clarity without changing how it behaves:
* Behavior: preserve exact outputs and side effects, and keep all existing tests green
* Standards: follow the project conventions defined in AGENTS.md and CLAUDE.md
* Structure: flatten nesting, cut redundancy, group related logic, and sharpen names
* Branches: prefer if/else chains or switch statements over nested ternary expressions
* Comments: keep rationale, business rules, and non-obvious intent; cut code restatements
* Boundaries: preserve helpful abstractions; never cram distinct concerns into one place
* Restraint: optimize for plain readability, never for cleverness or fewer lines of code
