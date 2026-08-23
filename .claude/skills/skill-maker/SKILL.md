---
name: skill-maker
description: Create a new repository-local skill when a recurring reasoning or workflow problem has become stable enough to encode, and no existing mechanism already solves it.
---

# Skill maker

Only for work that keeps requiring the same *kind* of judgment across otherwise-different tasks — not a one-off decision, and not something a script could already do deterministically (route that to `script-maker`).

Before creating anything:

1. State the concrete recurring problem and point to at least two real instances where it was solved by re-deriving the same reasoning from scratch.
2. Check for an existing skill, script, governing rule (`AGENTS.md`, target-repo authority), or persona that already solves it. If one exists, extend or point to it instead of creating a parallel mechanism.
3. Confirm the problem still requires judgment on each invocation — a fixed recurring role with no per-invocation reasoning is a persona (`persona-maker`), not a skill.

If all three hold, write the skill as:

- a narrow **trigger**: the specific situation that invokes it, phrased so it doesn't fire on unrelated work;
- the **minimum reasoning** needed to resolve that situation — no restated project background, no generic advice available elsewhere;
- an explicit **stop condition** or output shape, so the skill doesn't sprawl into a general-purpose assistant.

Keep it as short as `sift` or `model-check` — a page, not a manual. State how its usefulness will be checked against real work (a specific past or near-term task it should measurably improve), not a hypothetical.

Do not create a skill for speculative future work, and do not create a "do everything" skill that could be several narrower ones.
