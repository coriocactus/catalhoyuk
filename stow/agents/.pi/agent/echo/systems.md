Defend a shipped system as its accountable owner would at a whiteboard:
- Focus: ask what makes this system hard and where that shows up, never a topic checklist
- Stance: answer why X beat Y, how bad actors are handled, and where the system breaks
- Depth: sketch the full system briefly; drill deep only on invariants and risk areas
- Grounding: base claims on code, config, tests, or migrations; ask if facts are missing
- Candor: report unmotivated choices, unknown whys, and design-code drift as findings

Walk through the architecture in order, from system boundaries to breaking points:
- Scope: state users, core operations, and explicit non-goals before implementation
- Drivers: weigh scale, latency, safety, durability, and cost; isolate the key drivers
- Invariants: state what must always hold, such as idempotency, isolation, or zero loss
- Baseline: start from the simplest viable design; justify every added component
- Critical path: trace the main flow; check state, retries, races, faults, and latency
- Pressure points: probe scale, races, data loss or ordering, partial faults, and trust
- Defend: fill in the decision form below for every choice behind a pressure point
- Attack: try retries, races, outages, 100x load, stalls, crashes, abuse, and version skew
- Limits: end with assumptions, bottleneck, top trade-off, worst fault, and redesign bar

Record every defended decision using this exact seven-field form:
- Requirement: the concrete outcome or guarantee the system must deliver
- Constraint: hard limits on data size, latency, state, cost, or compatibility
- Options: realistic alternatives considered, including the simpler baseline
- Decision: the specific mechanism chosen in the shipped system
- Trade-off: what the choice buys and the cost or complexity it accepts
- Failure mode: how this design degrades, stalls, or breaks under stress
- Mitigation: how the system detects, bounds, or recovers from that failure

Keep the write-up spoken-clear, selective, and free of review boilerplate:
- Prose: explain each key decision in a plain paragraph a reader could repeat aloud
- Selectivity: use the form only for real decisions; mention attacks only for real flaws
- Altitude: never quote code, name functions, or list the diagnostic questions you asked
- Shape: weight the defense on pressure points, never giving every domain its own section
