# Stage 1 Codex Review Comment Guidance

## Purpose

Use this source when ChatGPT is asked to inspect or comment on a completed **Stage 1 Codex PR review** and provide direction for the implementation/correction worker.

This is a **reasoning aid**, not a deterministic response generator.

The objective is to turn reviewer findings into the smallest accurate, execution-useful correction direction without replacing repository authority, over-prescribing implementation, or creating unnecessary follow-up work.

Do not duplicate the project's existing issue-intake/source guidance. If inspection reveals a genuinely independent problem that should become separate durable work, route that through the existing issue-intake authority rather than expanding this source.

---

## Core role

After Stage 1, ChatGPT should act as a **semantic correction engineer** between reviewer output and implementation.

The useful transformation is:

```text
Codex finding(s)
→ verify against current authority and PR state
→ distinguish defect from suggestion / scope expansion / duplicate
→ identify the underlying invariant or failure class
→ consolidate related findings
→ produce one bounded correction direction
→ execute at the cheapest qualified layer or hand off only the unresolved delta
```

Do not merely restate Codex's comments.

Do not assume Codex's proposed mechanism is the correct fix.

Do not turn the correction into a line-by-line patch recipe when reversible implementation choices should remain with whichever qualified executor has the necessary live state and proof capability.

---

## Authority

Current repository authority controls.

When relevant, inspect the narrowest durable sources needed to understand the finding, such as:

- the PR and exact Stage 1 review;
- the controlling thin issue;
- the authoritative execution issue;
- acceptance criteria and verification authority;
- current repository governing instructions;
- relevant existing issue/PR state when duplication, provenance, or scope is material.

Do not reopen settled founder decisions or architecture merely because a reviewer suggested an alternative.

Do not treat historical conversation context as stronger than current repository state.

---

## Reasoning procedure

### 1. Establish what Codex actually found

For each substantive finding, determine:

- the exact claimed defect;
- the evidence Codex cited;
- the behavior or invariant allegedly violated;
- whether multiple comments describe the same root cause.

Ignore purely mechanical review chatter.

### 2. Verify before endorsing

Classify each finding using judgment, not keyword matching.

Useful dispositions include:

- **valid — correction required**;
- **valid — same root cause as another finding**;
- **already corrected / superseded**;
- **false positive / unsupported**;
- **scope expansion or preference, not a defect**;
- **upstream-owned or separately owned problem**;
- **founder decision required**.

Record the reason when rejecting, merging, or rerouting a finding.

A reviewer comment is evidence, not authority by itself.

### 3. Find the correction invariant

For accepted findings, ask:

> What must be true after the correction for this class of defect to be resolved?

Prefer an invariant or outcome over a literal patch recipe.

Examples of useful correction direction:

```text
All parser-sensitive lifecycle fields must be serialized in the one canonical form the next gate consumes.
```

```text
The corrected-head path must preserve reviewed-head provenance without authorizing unrelated post-review changes.
```

Less useful:

```text
Change line 184 to this exact conditional.
```

unless current evidence makes that implementation requirement genuinely authoritative.

### 4. Consolidate before commenting

Stage 1 correction is one bounded pass.

Combine findings that share a root cause or must be corrected together. Preserve distinct findings when their correction or verification genuinely differs.

Do not send the correction executor through reviewer comments one at a time.

### 5. Protect scope

State the relevant non-goals when there is a realistic risk of over-correction.

Watch especially for:

- redesigning adjacent machinery;
- broad parser/generalization work justified by one observed case;
- adding a new abstraction where an existing mechanism can be repaired;
- changing Stage 1 or Stage 2 policy to solve an implementation defect;
- folding unrelated defects into the current PR;
- weakening fail-closed behavior merely to make the reported reproduction pass.

### 6. Define proof of correction

Give the worker the observable evidence that should establish the finding is resolved.

Prefer:

- exact reproduction that must now pass;
- negative/control case that must remain blocked or unchanged;
- existing regression suites/checks that matter;
- cross-file or lifecycle interaction that must remain coherent.

Tests are evidence only when they prove the intended behavior.

### 7. Route correction by comparative efficiency

After semantic reconciliation, choose the cheapest qualified execution layer that can reach the next validated breakpoint without weakening proof or reviewer independence. Capability alone is not sufficient reason for ChatGPT to retain implementation.

Use the **One-Loop Rule**: ChatGPT may directly implement and persist the correction when the correction is already well-defined enough that one cohesive mutation plus one substantive verification cycle is a reasonable expectation, authoritative current repository/PR state and the required mutation surface are available, and no hidden local/runtime condition materially affects the change.

Prefer a live coding environment when Stage 1 findings require iterative source archaeology or repeated edit → test/gate → diagnose → edit work, active worktree/merge/process state, multiple tightly coupled executor/control-plane components, moving target-branch integration, or repository tests/builds/gates that are expected to determine the next code change. This remains true even when ChatGPT could technically make the repository mutations through connected tools.

If ChatGPT begins a correction and encounters the first material additional semantic execution loop—such as an unexpected test/CI failure requiring code diagnosis, a merge/worktree dependency, newly discovered cross-component/runtime scope, or a second substantive edit/verify cycle—preserve completed valid work and hand off the remaining delta instead of continuing from sunk cost. Trivial mechanical/syntax repairs may be completed directly when clearly cheaper.

Preserve mutation/proof separation. A successful edit, commit, or PR proves the mutation occurred; it does not prove runtime behavior that was not observed.

Codex remains the independent Stage 1 reviewer and must not implement its own findings. Any correction that changes the PR must continue through the repository-authorized Stage 1 completion/merge path rather than being treated as self-validated.

---

## Recommended comment shape

The headings below are a **menu, not a mandatory template**. Use only the sections that improve the correction handoff.

### Assessment

State which Codex findings are valid, merged by root cause, rejected, superseded, or out of scope.

### Correction direction

State the smallest complete invariant or outcome the correction should achieve.

When several accepted findings interact, explain the interaction and any necessary ordering.

### Constraints

State only material boundaries that prevent over-correction or preserve current authority.

### Verification

List the few highest-value observable checks that prove the correction rather than merely proving files changed.

### Execution note

When useful, close with a compact instruction equivalent to:

```text
Address all accepted Stage 1 findings in one consolidated correction pass on the current PR, preserve existing authority and non-goals, run the required verification, and stop for a genuine founder/safety/scope interrupt rather than inventing a broader fix.
```

Do not mechanically include this sentence when the context already makes it obvious.

---

## CLEAN Stage 1 reviews

If Stage 1 is genuinely clean, do not manufacture commentary merely because this source exists.

A useful response may simply confirm that there are no substantive findings requiring correction and point back to the repository's normal deterministic transition.

Do not use a clean review as an opportunity to introduce unrelated suggestions.

---

## What this source must not become

Do not turn this guidance into:

- a parser for reviewer prose;
- a rigid fill-in-the-blanks comment generator;
- a replacement for Codex review;
- a second Stage 1 reviewer;
- a requirement to create an issue for every finding;
- a mechanism for re-reviewing the corrected PR;
- a substitute for repository gates;
- a provider-specific LDL methodology rule.

The value of this layer is **judgment plus bounded structure**.

The structure should reduce omissions and implementation ambiguity while leaving ChatGPT free to reason about the actual defect.