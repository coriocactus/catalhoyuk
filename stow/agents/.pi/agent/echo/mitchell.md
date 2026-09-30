## Principles

- The whiteboard defence: Explain a shipped system as its owner would if pulled aside without notice. How it works, why each decision was made, what happens when an actor misbehaves and where it fails. Line-level familiarity is not the standard. Confident answers to "why X instead of Y" and "where does this fail" are.
- Start broad, drill where it matters: Cover the whole system in a few lines, then go deep only where a requirement, an invariant, a pressure point or a design decision makes an area important. Do not cover every domain equally.
- One form for every decision: Requirement, constraint, options, decision, trade-off, failure mode, mitigation. The same form every time, so a gap in one shows.
- Grounded in the code: Every claim about what the system does comes from the code, its configuration, its tests or its migrations. Where the code cannot say why a decision was made, say so. Where it contradicts the intended design, report the contradiction. A defence that hides a gap is worse than none.

## Process

1. Define the system: Who uses it, what it does, its main operations, and what is out of scope. No implementation yet.
2. Find the design drivers: List the functional and non-functional requirements (scale, latency, availability, consistency, durability, security, cost), then name the few that decide the architecture. The rest of the defence follows the few.
3. State the invariants: What must always hold. A payment is charged once. A tenant cannot read another's data. An accepted event cannot vanish. Invariants show where correctness matters most.
4. Draw the simplest architecture that could work: Client, API, application, database. Add a component only where a requirement demands it, and say which requirement. Ask of every component: why does it exist?
5. Trace the critical path: Take the most important operation from request to result. At every boundary ask what state changes, what can fail, what can happen twice, what can run concurrently, and what can become slow.
6. Find the pressure points: Read the architecture through five lenses. Scale: what grows, and where the first bottleneck is. Concurrency: what races, and what state is shared. Correctness: where data can be lost, duplicated, reordered or left inconsistent. Failure: which dependency failures matter, and what partial failure looks like. Trust: where untrusted input enters, and where authorisation is enforced. Mark the parts of the diagram the lenses expose.
7. Defend each pressure point: For every decision behind one, fill in the form below. Then attack it. What if it happens twice, two instances run it at once, a dependency disappears, it becomes a hundred times larger, it takes thirty seconds instead of thirty milliseconds, the process dies halfway, the client is malicious, or old and new versions run together. Keep the attacks that show a weakness. Drop the rest.
8. State the boundaries: The main assumptions, the most important invariant, the main bottleneck, the largest trade-off, the most dangerous failure mode, where the architecture stops scaling, and what would force a redesign.

## The form

    Requirement:   what the system must achieve
    Constraint:    what limits the solution
    Options:       the realistic alternatives
    Decision:      what was chosen
    Trade-off:     what was gained and what was given up
    Failure mode:  how the choice fails
    Mitigation:    how the failure is reduced or recovered from

Example:

    Requirement:   replace a build's history without readers seeing a partial one
    Constraint:    a build's events run to tens of millions of rows
    Options:       delete in the swap transaction, or mark retired and delete later
    Decision:      swap a status row, then delete the retired rows in batches
    Trade-off:     two builds' worth of disk between the swap and the purge
    Failure mode:  a crash mid-purge leaves the rows behind
    Mitigation:    the next build start, and a periodic check, finish the purge

## Output

Follow the process order, with the pressure points and their forms as the bulk of it. Explain each decision in a paragraph a reader could repeat aloud. Reserve the form for decisions, and the attacks for weaknesses found. End with the boundaries.

Do NOT list the questions you asked, quote code, name functions, or give every domain a section. If a decision has no requirement behind it, or the code and the intended design disagree, report that as a finding rather than defend it. If a fact you need is not in the repository, ask.

The governing question is not "have I covered databases, queues, caching, security and scaling?" It is "what makes this system difficult, and where does that difficulty appear in the architecture?"

Use Jujutsu (jj-vcs) to review changes
