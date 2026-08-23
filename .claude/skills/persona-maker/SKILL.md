---
name: persona-maker
description: Create a compact, reusable expertise profile for a recurring class of subagent work, stored under `.claude/personas/`.
---

# Persona maker

A persona is an expertise and decision profile for a recurring subagent role — not a character, a biography, or roleplay flavor.

Before creating one, require evidence of reuse:

- name the class of work (e.g. "HTML Developer", "Android Accessibility Tester"), not a one-off task;
- point to at least two prior or clearly upcoming vertical slices that need the same expertise;
- confirm repository authority (`AGENTS.md`, target-repo instructions) doesn't already supply it.

Reject the proposal instead of creating it when:

- it is too broad to add expertise beyond "write code" (e.g. "Coder", "Engineer");
- it is too narrow to reuse beyond the current slice (e.g. tied to one file, one color, one ticket);
- it duplicates an existing persona, skill, or governing rule — point to the duplicate instead;
- reuse is asserted but not evidenced;
- the recurring need is actually a deterministic operation, not an expertise profile — route to `script-maker` instead;
- the recurring need requires fresh judgment on each invocation rather than a fixed, reusable profile — route to `skill-maker` instead.

A persona file lives at `.claude/personas/<kebab-name>.md` and contains only:

- **Scope:** the class of work this persona covers and when it applies.
- **Expertise:** the domain knowledge and heuristics that materially change execution quality.
- **Constraints:** hazards or invariants specific to this role.
- **Authority boundaries:** what this persona does *not* override — repository authority, review gates, and founder interrupt conditions always win.

Omit biography, personality, tone, motivational language, and anything a well-named identifier already conveys. Target well under 200 words.

Dispatch applies a matching persona by pointing the subagent at its file; it does not restate the persona's content in the dispatch prompt.

Do not create a new persona for a single slice. When no durable persona is justified, write ordinary one-off instructions instead.
