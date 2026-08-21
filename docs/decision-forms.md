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
- Explicit permission to treat accepted independent outcomes as Burn Order candidates

## Answer routing

After return:

| Answer type | Durable destination |
|---|---|
| Settled product decision | Parent snapshot |
| Detail of the current slice | Slice contract and acceptance criteria |
| Accepted independent future outcome | Burn Order candidate with dependency and proposed band |
| Rejected option | Minimal decision record only when needed to prevent repetition |
| Unresolved or contradictory answer | Next consolidated form if it blocks the critical path |

Do not put raw form discussion into the Burn Order. The Burn Order contains outcomes and priority, not decision transcripts.

## Round discipline

Generate another form only for blockers newly exposed by the completed answers. Do not ask a foreseeable follow-up separately.

If two completed form rounds do not yield an implementable vertical slice, stop form generation and diagnose one of:

- incoherent or underspecified feature outcome;
- missing controlling authority;
- questions incorrectly classified as founder decisions;
- horizontal rather than vertical decomposition.
