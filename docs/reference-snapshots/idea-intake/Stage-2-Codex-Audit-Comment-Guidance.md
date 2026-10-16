# Stage 2 Codex Audit Comment Guidance

## Purpose

Use this source when ChatGPT is asked to inspect or comment on a completed **Stage 2 Codex Audit** and provide correction direction or terminal interpretation.

This is a **reasoning aid**, not a deterministic response generator.

Stage 2 differs from Stage 1: the audit evaluates an exact merged state after the implementation PR has already completed its Stage 1 cycle. A NOT CLEAN audit may therefore expose a deeper invariant, a cross-file contradiction, a repeated failure class, or a defect that escaped the inline review.

The objective is to turn the completed audit into one bounded, source-linked correction contract without blindly forwarding findings to an implementor.

Do not duplicate the project's existing issue-intake/source guidance. If the audit reveals an independently owned outcome that should become separate durable work, route that decision through the existing intake authority.

---

## Core role

For a NOT CLEAN Stage 2 audit, ChatGPT should act as a **semantic correction-engineering layer**.

The useful transformation is:

```text
completed Stage 2 audit
→ verify exact audit target and finding provenance
→ reconcile findings with the relevant PR / prior audit / control chain
→ distinguish new defect from recurrence, duplicate, superseded evidence, or scope expansion
→ identify the smallest complete correction invariant
→ produce one bounded correction contract
→ execute at the cheapest qualified layer or hand off only the unresolved delta
```

Do not merely tell the correction executor to "fix the audit comments."

Do not treat every audit finding as independent simply because Codex listed it separately.

---

## Authority

Current repository authority and the completed Stage 2 audit control.

Inspect only the durable sources needed to establish correction scope and provenance, typically:

- the Audit Issue and completed Codex report;
- the exact merge commit under audit;
- the merged PR;
- relevant Stage 1 findings and their disposition;
- the controlling thin issue;
- the authoritative execution/correction issue;
- directly relevant prior Audit/PR chain when recurrence or supersession is material;
- repository governing instructions.

Do not perform broad historical archaeology by default.

Read backward only as far as needed to answer a concrete question such as:

- Is this the same unresolved invariant seen before?
- Was this finding already corrected or superseded?
- Does another issue already own the underlying defect?
- Did Stage 1 address the symptom while missing the complete boundary?

The Audit Issue remains canonical audit evidence. Do not rewrite its verdict to make the correction easier to describe.

---

## First decision: CLEAN or NOT CLEAN

### CLEAN

Do not invent additional corrective work.

Confirm that no substantive audit finding requires semantic correction engineering and return to the repository-authorized terminalization path.

If a mechanical lifecycle defect prevents a backed CLEAN verdict from closing normally, diagnose that separate control-plane defect through the existing issue-intake authority rather than pretending the audit is NOT CLEAN.

### NOT CLEAN

Perform the reconciliation below before correction execution is dispatched or performed.

---

## NOT CLEAN reasoning procedure

### 1. Confirm the audit evidence

Establish:

- exact merged commit audited;
- genuine completed Codex verdict;
- each substantive finding;
- severity/evidence supplied;
- requested verification coverage.

Do not self-declare a different audit verdict.

### 2. Classify each finding by provenance

Useful dispositions include:

- **new independent defect**;
- **same unresolved root cause as an earlier finding**;
- **supplementary evidence for an existing correction invariant**;
- **valid but already owned by active correction work**;
- **false positive / unsupported**;
- **superseded by current authoritative state**;
- **separate owner / separate issue-intake candidate**;
- **founder decision required**.

Do not count repeated wording as independent evidence when several comments describe one underlying defect.

### 3. Compare against the relevant correction chain

Stage 2 is especially valuable when it shows that a prior correction was too narrow.

Ask:

- What did the prior PR believe it fixed?
- What did Stage 1 verify or correct?
- What survived into the exact merged state?
- Is the audit exposing a missed edge case, an incomplete invariant, a wrong abstraction boundary, or a genuinely new defect?
- Would fixing the literal symptom leave another known path violating the same invariant?

This is where ChatGPT should add reasoning value rather than forwarding Codex prose unchanged.

### 4. State one correction invariant

For the accepted in-scope findings, derive the smallest complete post-correction truth.

Prefer:

```text
All terminal Stage 2 paths must leave both the work issue and audit issue in lifecycle-consistent terminal state, including interrupted/restarted execution.
```

over:

```text
Add another close call in function X.
```

The qualified correction executor may choose the cheapest correct mechanism after inspecting the authoritative live state.

### 5. Decide whether one bounded correction slice is sufficient

Keep the findings together when they:

- share one root cause;
- require one coherent state transition;
- must be verified together to prove the outcome.

Separate/reroute only when outcome, authority, dependency, risk, lifecycle, or required context genuinely changes.

Do not split by file, technical layer, or reviewer bullet count.

### 6. Protect against repeated narrow fixes

When the audit repeats a previously addressed failure class, explicitly say so.

The correction direction should then operate at the higher proven invariant/boundary, not reproduce another same-level symptom patch.

If evidence shows the current abstraction itself is wrong and the correction would materially change architecture, product intent, security/privacy, or scope, stop for the appropriate founder/issue-engineering boundary.

### 7. Define closure evidence

Specify the smallest set of checks that would prove the correction outcome.

Include, where relevant:

- the exact Stage 2 reproduction;
- previously failing sibling/edge paths;
- negative controls that must remain fail-closed;
- the earlier Stage 1 case that must not regress;
- cross-file/state consistency;
- deterministic gates that must now select the correct transition;
- normal Stage 1 and fresh exact-merge Stage 2 after the correction PR.

Avoid enormous verification lists. Group checks by independent behavior/invariant.

### 8. Route correction by comparative efficiency

After producing the complete correction contract, choose the cheapest qualified execution layer that preserves Stage 2 independence and the required proof threshold. Capability alone is not sufficient reason for ChatGPT to retain implementation.

Use the **One-Loop Rule**: ChatGPT may directly implement and persist the bounded correction when its correct shape is substantially settled before mutation and one cohesive mutation plus one substantive verification cycle is a reasonable expectation. Authoritative current repository state, the required mutation surface, and sufficient observable proof must be available through its current tools.

Prefer a live coding environment when the NOT CLEAN finding requires iterative repository/runtime discovery, active worktree/merge/process state, multiple tightly coupled components, repository-wide correction, moving target-branch integration, or repeated tests/builds/gates that are expected to determine subsequent edits. Source edits, branches, commits, and PRs are not automatic escalation boundaries; repeated repository/runtime interaction cost is.

If ChatGPT begins the correction and encounters the first material additional semantic execution loop—unexpected test/CI failure requiring diagnosis, merge/worktree dependency, newly discovered cross-component/runtime scope, or a second substantive edit/verify cycle—preserve completed valid work and hand off the remaining delta. Trivial mechanical repairs may still be completed directly when clearly cheaper.

Preserve mutation/proof separation: creating a change proves the mutation occurred, not runtime behavior that was not observed.

The Stage 2 auditor remains assurance-only and must never implement its own findings. Any correction that changes source or runtime behavior must go through the normal correction PR, Stage 1, merge, and fresh exact-merge Stage 2 audit before CLEAN can be established. Do not self-declare the corrected result clean.

---

## Recommended correction comment shape

The headings below are a **menu, not a mandatory template**. Use only what makes the next worker materially more likely to solve the complete problem.

### Audit assessment

State the accepted findings and any rejected, duplicate, superseded, or separately owned items.

### Root-cause synthesis

Explain whether the findings represent:

- one root cause;
- recurrence of an earlier invariant;
- an incomplete prior correction;
- or genuinely independent defects.

### Correction contract

State the smallest complete invariant/outcome the next correction must achieve.

Describe required interactions or boundaries, but leave reversible implementation choices to the qualified correction executor unless current authority makes a choice mandatory.

### Verification

List the highest-value observable checks and negative controls.

### Constraints / non-goals

Include only boundaries needed to prevent scope expansion or repetition of an already-failed mechanism.

### Next execution route

State the current durable execution target/route when repository authority makes it clear.

The correction executor should be able to begin from durable state without needing a long conversational handoff; when ChatGPT is itself the qualified executor, persist the same durable correction authority and observed proof rather than relying on conversation memory.

---

## Relationship to new Issue creation

This source does not define Issue-creation policy.

When Stage 2 exposes an independent problem that is not part of the active correction outcome:

1. establish that it is genuinely separate rather than another manifestation of the same invariant;
2. check current repository state for an existing owner;
3. route through the project's existing issue-intake/source authority.

Do not create another Issue merely because Stage 2 used another bullet.

Do not absorb an independent systemic defect into the current correction PR merely to avoid creating durable state.

---

## Re-audit boundary

A NOT CLEAN audit starts a correction cycle; it does not authorize ChatGPT to declare the corrected result clean.

The correction PR must pass the repository's normal Stage 1 path and then receive a fresh Stage 2 audit of the new exact merged state.

Do not coach Codex toward a desired verdict or response shape.

---

## What this source must not become

Do not turn this guidance into:

- a rigid comment template;
- deterministic semantic parsing of audit prose;
- an automatic finding-to-issue converter;
- a second auditor;
- a substitute for Stage 2 evidence;
- a requirement to create new work after every NOT CLEAN;
- a reason to reload the full historical issue/PR corpus;
- an instruction to implement reviewer-proposed mechanisms literally;
- a provider-specific LDL methodology dependency.

The value of this layer is **semantic reconciliation**:

```text
finding text
→ provenance
→ root cause
→ complete bounded invariant
→ execution-ready correction authority
```

The structure exists to improve consistency and reduce avoidable correction churn, not to remove reasoning.