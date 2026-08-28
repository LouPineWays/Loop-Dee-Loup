# Founder decision forms

## Purpose

A decision form replaces slow one-question-at-a-time dialogue. It gives the founder every currently knowable critical-path question, recommendations, and room to override assumptions in one asynchronous response.

## Generation procedure

Before creating a form:

1. Read the parent snapshot and minimum target-repository authority.
2. Define the accepted feature outcome.
3. Trace the currently visible critical path to an implementable vertical slice.
4. Remove technical questions already answerable from authority.
5. Include every founder-level decision that blocks or materially changes that path.
6. Exclude speculative downstream questions with no effect on a currently visible slice.

## Required form structure

### Header

- Parent loop
- Accepted outcome
- Current verified state
- Why founder input is required
- What becomes implementable after completion

### Each question

- Stable ID
- Decision required
- Critical-path consequence
- Two or three mutually exclusive options where appropriate
- Recommendation
- Tradeoffs
- Suggested answer
- Founder answer
- Founder comments

### Final section

- General comments or constraints
- New outcome proposals
- Explicit permission to treat accepted independent outcomes as backlog candidates

## Answer routing

After return:

| Answer type | Durable destination |
|---|---|
| Settled product decision | Parent snapshot |
| Detail of the current slice | Slice contract and acceptance criteria |
| Accepted independent future outcome | Backlog candidate: a target repository's own Burn Order entry, or a `priority:*`-labeled Loop-Dee-Loup Issue, with dependencies noted |
| Rejected option | Minimal decision record only when needed to prevent repetition |
| Unresolved or contradictory answer | Next consolidated form if it blocks the critical path |

Do not put raw form discussion into the backlog. A target repository's Burn Order (e.g. Covenant's) is that repository's own prioritized backlog, not a Loop-Dee-Loup artifact, and it contains outcomes and priority, not decision transcripts. An accepted outcome about Loop-Dee-Loup itself instead becomes a `priority:*`-labeled GitHub Issue on Loop-Dee-Loup's own repository — see `docs/priority-horizons.md` — never a target repository's Burn Order.

## Round discipline

Generate another form only for blockers newly exposed by the completed answers. Do not ask a foreseeable follow-up separately.

If two completed form rounds do not yield an implementable vertical slice, diagnose before generating the next form:

- incoherent or underspecified feature outcome;
- missing controlling authority;
- questions incorrectly classified as founder decisions;
- horizontal rather than vertical decomposition.
