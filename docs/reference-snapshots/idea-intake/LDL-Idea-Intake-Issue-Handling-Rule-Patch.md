# Loop-Dee-Loup Idea Intake — Issue Handling Rule Patch

## Purpose

Add this rule to the ChatGPT-side Loop-Dee-Loup Idea Intake authority. It corrects the handling of new incidents that occur after an execution Issue has already completed a PR/review/audit lifecycle.

## Post-completion evidence vs. execution lifecycle

Treat **outcome ownership**, **incident provenance**, **evidence disposition**, and **execution lifecycle** as separate questions.

### Incident provenance is not issue ownership

An incident may occur while LDL is advancing an Issue/PR whose substantive purpose is unrelated to the defect exposed by the incident.

Example shape:

```text
work on #A
→ cross-cutting LDL control-plane defect occurs
→ #A remains the reproduction context
→ existing Issue #B may own the defect
```

Do not reject valid evidence merely because `#A` is not itself “about” the defect. When ambiguity is possible, describe `#A` as **live reproduction context** rather than as the defect owner or source-of-authority Issue.

### Existing outcome owner does not imply reusing a completed execution packet

When new material evidence maps to an existing Issue that already completed a PR / Stage 1 / Stage 2 cycle:

- preserve that completed packet and its historical PR/audit evidence;
- do not reset its PR, Stage 1, Stage 2, lifecycle, or terminal fields to a fictitious pre-execution state;
- do not weaken deterministic gates so they ignore the completed packet;
- do not create a duplicate independent outcome merely because fresh implementation is required.

If the evidence requires another implementation/review/audit cycle, create a **fresh execution slice/correction packet** under the same governing outcome/control authority. Repoint the current thin control to that fresh execution packet.

Preferred shape:

```text
existing governing outcome / thin control
        ↓
completed execution packet
        → PR / Stage 1 / Stage 2 remain historical evidence
        ↓ new material recurrence/regression evidence
fresh bounded execution packet
        ↓
current PR / review / audit lifecycle
```

This is not duplicate work. It is a new execution lifecycle for the same governing outcome.

### Single-current execution packet invariant

A thin control may retain links to multiple historical execution packets, but it must have **at most one current nonterminal execution packet**. The control's current `Execution` pointer identifies that sole current packet; predecessor packets remain historical evidence and must not compete for current execution authority.

Before creating or promoting a fresh execution packet under an existing thin control:

- inspect the control's existing execution packets and their live lifecycle state;
- if another packet is still nonterminal, determine whether it remains genuinely active, should be completed/terminalized, or should be explicitly superseded/reconciled;
- do not create or point the control at a second simultaneously active packet merely because the prior packet is stale, inconvenient, blocked, or has accumulated later evidence;
- preserve any still-relevant incident/provenance evidence while making current-vs-historical execution authority unambiguous.

If two nonterminal thick packets are found competing under one thin control, treat that as malformed durable state requiring reconciliation before new dispatch or packet creation. Do not choose between them from conversational recency or issue number alone.

### In-flight migration linkage invariant

When legacy unsplit work is deliberately migrated into thin control + thick execution form **after a PR already exists**, preserving the PR is not sufficient by itself. Intake must also verify that the existing PR is linked to the new thick execution Issue using the repository's current **parser-recognized PR-to-execution linkage convention**.

- Inspect the live linkage authority before editing metadata; do not assume a prose label such as `Execution: #N` is equivalent to the canonical linkage consumed by deterministic gates.
- When the PR and new thick execution Issue unquestionably represent the same already-authorized in-flight packet, normalize the PR metadata to the smallest canonical linkage form recognized by current repository tooling (for example a recognized closing/addressing marker when that is the repository convention).
- Do not fabricate a new ownership relationship, rewrite historical commits, rename an already-used branch solely for cosmetic consistency, or broaden linkage rules merely to rescue one migrated packet.
- Preserve the pre-migration reviewed head, correction provenance, merge state, and review/audit history; the linkage normalization exists only so current deterministic machinery can prove the relationship already established by durable authority.
- After migration, verify that control `Execution`, PR linkage, lifecycle/review state, and the repository's recovery/finalization gates agree before treating the packet as resumable. A rejection caused by noncanonical linkage means the migration is incomplete; repair the durable representation rather than bypassing the gate.

### Thin-control reconciliation

When a thin control remains the founder-facing entry point after post-completion evidence:

- keep the control if the accepted outcome is still the same;
- record the incident as reproduction evidence;
- move the control's current `Execution` pointer to the fresh packet;
- set lifecycle/route according to the fresh packet's actual next transition;
- preserve the old packet under completed/historical evidence;
- ensure `Execution`, `Route`, blocker/founder-interrupt state, and current PR/review/audit fields are mutually coherent before dispatch.

A deterministic gate rejection caused by historical PR linkage is evidence that current durable state is malformed for the intended new cycle. Repair the state representation; do not bypass the gate.

### Duplicate-work decision

For a new incident:

1. Determine which outcome/invariant owns the defect.
2. Decide whether the incident adds material evidence.
3. Enumerate the governing control's execution packets and determine whether any nonterminal packet already owns current execution.
4. If one packet is active, update that packet/control with the new evidence when it fits the same bounded slice; do not create a competing active packet.
5. If an existing nonterminal packet is stale, superseded, or otherwise no longer valid as current authority, reconcile/terminalize its current-vs-historical status before promoting a fresh packet.
6. If the owning packet is terminal and no new implementation is required, add the evidence only.
7. If terminal and new implementation/review/audit is required, preserve the completed packet and create a fresh bounded execution packet under the same governing outcome/control.
8. Create a new independent owner only when outcome, authority, dependency, risk, or scope genuinely differs.

## Compact invariant

> **Same defect owner does not mean same execution packet. Preserve completed packets; attach new evidence to the existing outcome; create a fresh execution lifecycle only when new implementation work is actually required; and keep exactly one current nonterminal execution packet per thin control.**