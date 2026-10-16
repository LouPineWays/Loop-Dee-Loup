# Loop-Dee-Loup Ideal-State Operating Principles

## Purpose

This document records the **ideal-state north star for Loop-Dee-Loup**: the end-state properties LDL should asymptotically approach as its methodology, control plane, deterministic tooling, agent boundaries, telemetry, and consumer portability improve.

It is a **reference document, not an execution specification**.

Do not treat every gap between current LDL and this ideal as authorization for new implementation work. Future design, methodology, telemetry, and optimization work may cite this document when evaluating whether a proposed change moves LDL toward or away from the intended end state.

Current founder instruction and repository-local authority remain stronger than this reference. Update this document only when the intended ideal materially changes.

---

## Ideal state

### 1. Minimal sufficient context, disposable execution contexts

Each worker/session receives **only the context needed for its bounded current outcome**.

Execution should proceed through iterative, independently bounded steps rather than accumulating one long conversational history.

Before a context is discarded, anything that later work genuinely needs must be compressed into durable repository/GitHub state. Future workers should consume current truth and direct authority rather than replaying the conversations that created it.

Target shape:

```text
minimal current authority/state
        ↓
bounded execution
        ↓
observable result/evidence
        ↓
durable new state
        ↓
discard execution context
        ↓
fresh next context when needed
```

Context retention is a cost. Historical context earns its place only when the current state is genuinely insufficient without it.

### 2. Founder at the beginning and end; autonomous middle

The user/founder should primarily own:

- broad vision and desired outcomes;
- product/business intent;
- meaningful tradeoffs;
- priorities / what is worth doing;
- legal, privacy, security, irreversible, or other genuinely founder-owned decisions;
- evaluation of completed results.

Once intent, authority, constraints, and acceptance conditions are sufficient, AI agents should autonomously carry the middle:

```text
founder selects objective / settles consequential choices
        ↓
LDL creates sufficient durable authority
        ↓
autonomous planning / execution / verification / correction
        ↓
validated bounded result
        ↓
founder evaluates outcome and chooses what matters next
```

Do not convert routine technical judgment into founder interruption merely because an agent can ask.

### 2.1 Semantic Engineering preserves founder/user values across execution

LDL's semantic layer exists to preserve the **Founder/user's values and intended outcomes** while lower layers plan, implement, verify, and automate the work. The strongest compact question is:

> **Given what the Founder wants, is this still the right thing to do?**

Technical correctness is necessary but not sufficient. A worker may faithfully execute its bounded contract, every deterministic check may pass, and each local artifact may be correct while the overall result is still wrong because the intermediate specification, decomposition, acceptance model, or objective failed to preserve the intended outcome.

Preferred distinction:

```text
Founder/user values + intended outcome
        ↓
Semantic Engineering / semantic supervision
        ↓
bounded objective, decomposition, acceptance, correction
        ↓
implementation + deterministic verification
```

This is the broader meaning of LDL's **letter-versus-spirit** boundary:

- the Manual / bounded execution contract protects the **letter** by constraining mechanically expressible authority, targets, evidence obligations, acceptance boundaries, and stop conditions;
- semantic supervision protects the **spirit** by judging whether literal compliance actually serves the Founder/user's intended outcome;
- neither layer substitutes for the other.

Semantic review should therefore be able to detect at least these failure shapes:

- several individually correct sub-results compose into the wrong overall outcome;
- a literal implementation satisfies written acceptance language while violating its intended purpose;
- deterministic proof establishes the stated mechanism but not the Founder-valued result;
- an intermediate objective or decomposition is itself the wrong translation of Founder intent.

When the mismatch can be resolved from existing Founder/repository authority, derive the missing or corrected higher-level invariant and route the correction downward through the normal bounded machinery. When the remaining uncertainty is genuinely a value, priority, preference, product/business intent, or consequential tradeoff not already settled by durable authority, stop and return to the Founder rather than inventing a value.

The spirit of the work is therefore grounded in **Founder/user values and intended outcomes**, not reviewer preference, implementation elegance, convenience, or whatever is easiest to measure.

### 3. Determinism for closed paths; reasoning for open paths

Use the cheapest reliable abstraction:

```text
deterministic script / state transition
→ reusable procedure / skill
→ specialized reasoning worker
→ orchestrator
→ founder
```

Predictable state transitions, bookkeeping, status detection, serialization, polling, reconciliation, exact checks, and other mechanically decidable operations should not consume reasoning merely because a model is available.

Reasoning should be reserved for genuine uncertainty: semantic reconciliation, architecture/design choices, root-cause analysis, open-ended implementation paths, ambiguous evidence, and other problems for which the correct continuation cannot already be derived mechanically from sufficient current state and authority.

The goal is not to maximize automation. It is to place each function at the **lowest-cost level that preserves correctness**.

Deterministically consumed durable state should also be **internally coherent at the moment it is authored**. When a lifecycle field and route jointly describe the next transition, producers should not emit combinations that are mechanically contradictory and rely on a later gate to discover the mismatch. If the next transition is already mechanically knowable, serialize the matching lifecycle/route pair directly; use reasoning only when the next transition itself remains genuinely unresolved.

### 4. Recursive improvement under telemetry and user supervision

LDL should eventually observe its own significant functions well enough to identify recurring avoidable cost, quality loss, founder intervention, rework, context waste, or inappropriate use of reasoning.

Recursive improvement should itself follow LDL discipline:

```text
observe bounded evidence
→ identify recurring loss / opportunity
→ form a falsifiable improvement hypothesis
→ choose the cheapest candidate mechanism
→ run a bounded experiment
→ verify outcome
→ supervised promotion into normal authority
→ observe again
```

Do not permit unconstrained self-modification, optimization from weak evidence, or automatic creation of new mechanisms merely because telemetry exists.

Improvement remains under founder supervision and normal repository authority.

### 5. GitHub-native operation; no mandatory third-party control plane

A normal LDL installation should require only:

- GitHub / the repository as durable shared state;
- the user's chosen qualified AI agents / coding environments;
- ordinary local or cloud execution capabilities those agents already possess.

Do not make core LDL operation depend on a separately hosted LDL service, daemon, proprietary orchestration platform, database, vector store, dashboard, message bus, or third-party workflow product.

Optional integrations may improve convenience, but they must not become hidden mandatory infrastructure for the methodology.

GitHub/repository state remains the durable interchange surface between disposable workers and environments.

### 6. Device and execution-location independence

LDL should be usable from as broad a range of environments as practical, including local machines, laptops, mobile-accessible workflows, remote/cloud coding sessions, and future agent surfaces.

The stronger invariant is:

> **Execution location should be disposable.**

A worker/session crashing, losing context, exhausting a context window, moving to another machine, or resuming in a remote cloud environment should not require reconstructing the workflow from conversation history.

Environment-specific assumptions should be minimized or represented explicitly where unavoidable.

### 7. Minimal sufficient durable state / path-independent continuation

This is the Bellman-inspired state principle underlying much of the ideal.

For any bounded step whose future continuation is determined by current authority and durable state:

> **A future worker should not need to know how LDL got here. It should need only where the work is now, what remains true, what it is authorized to do, and what constitutes a valid next state.**

Conceptually:

```text
current durable state
+ current authority
+ necessary provenance
+ objective / acceptance boundary
→ correct next continuation
```

Different histories that produce the same **sufficient** current state should not require historical reconstruction merely to choose the same next action.

If omitted history can legitimately change the correct action, the state representation is not yet sufficient and LDL must either preserve the missing fact or continue using bounded reasoning.

This is a design lens, not a mandate to build a generalized dynamic-programming, MDP, policy-database, or graph-planning system.

### 8. Every autonomous transition should be independently verifiable

Autonomous action should leave observable evidence that the intended state transition occurred correctly.

Preferred shape:

```text
known state
→ authorized bounded action
→ observable evidence
→ validated new state
→ next transition becomes available
```

Where verification is mechanical, use deterministic checks. Where semantic assurance is genuinely required, use bounded independent reasoning/review.

Do not substitute "the agent said it finished" for evidence of the outcome.

### 9. Failure should be local, resumable, and non-destructive

An ordinary agent/model/tool/environment failure should stop at the smallest safe durable boundary.

A fresh worker should be able to determine:

- what completed;
- what did not complete;
- what evidence exists;
- whether retry/resume is authorized;
- what next step is valid.

Failed execution should not corrupt lifecycle truth, silently authorize later stages, or require broad historical reconstruction.

Prefer fail-closed ambiguity over invented progress, while avoiding unnecessary founder interruption when deterministic recovery is possible.

A failed deterministic transition check is evidence about current durable state, not permission to pretend the rejected transition occurred. Recovery should distinguish an explicit blocking state from a merely malformed, stale, or non-applicable state and then use the repository-authorized deterministic or reasoning path appropriate to that verdict.

### 10. Explicit bounded authority

Founder/repository authority should define the autonomous region in which an agent may act.

Agents should not infer consequential authority from conversational momentum, historical implication, or the fact that a technically possible action is available.

Machine-enforceable constraints are preferable where practical. Prose remains appropriate for semantic boundaries that cannot be encoded mechanically without unacceptable brittleness.

The desired delegation model is:

```text
founder / repository settles objective + consequential boundaries
→ LDL exposes a bounded authority envelope
→ agents optimize within that envelope
→ independent evidence verifies the result
→ founder intervenes only at a genuine boundary
```

### 11. Provider independence

LDL must remain conceptually independent of Claude, Codex, Copilot, ChatGPT, or any other specific model/provider/agent product.

Providers are execution capabilities with different cost, context, reasoning, tooling, permission, and assurance characteristics. LDL may route work according to those capabilities, but the methodology should survive replacement of every currently used provider.

Do not encode a temporary founder workflow preference as a permanent provider-specific methodology dependency.

### 12. Optimize validated progress, not proxy metrics

LDL's economic objective is not minimum tokens, maximum automation, maximum agent count, shortest wall-clock time, or minimum founder messages in isolation.

Optimize **validated useful progress per scarce resource**, considering at least:

- founder attention/intervention;
- model/reasoning expenditure;
- context loading and retrieval;
- retries and rework;
- escaped defects / assurance quality;
- latency where it matters;
- maintenance burden;
- coordination overhead;
- unnecessary external infrastructure.

A change that lowers raw token consumption while increasing correction churn or escaped defects is not an optimization.

A change that costs the same but materially raises validated quality or autonomous capacity may be a successful optimization.

### 13. Persistent complexity must amortize

Every durable abstraction—gate, field, lifecycle transition, worker role, skill, script, telemetry stream, artifact type, or additional process boundary—creates maintenance and comprehension cost.

Persistent complexity must eventually earn its place by doing one or more of the following repeatedly:

- reducing marginal reasoning/model cost;
- reducing founder intervention;
- reducing context/retrieval overhead;
- preventing meaningful defects/rework;
- increasing validated autonomy;
- increasing assurance at comparable cost;
- enabling work that could not otherwise be handled safely/reliably.

If an abstraction no longer earns that cost, LDL should simplify, consolidate, or remove it through normal supervised improvement.

Recursive improvement must not become recursive bureaucracy.

---

## Bellman-inspired north-star invariant

The strongest compact formulation is:

> **No future worker should need to know how we got here—only where we are, what remains true, what it is authorized to do, and what constitutes a valid next state.**

This applies only when the recorded state is genuinely sufficient. It does not justify suppressing history/provenance that materially affects correctness.

---

## Architectural summary

The intended mature LDL is:

> **A GitHub-native, provider-independent software-development control methodology in which the founder selects objectives and consequential tradeoffs and evaluates validated outcomes, while disposable AI workers autonomously traverse bounded, verifiable subproblems using only minimal sufficient durable state; deterministic machinery handles every predictably mechanical operation; reasoning is reserved for genuine uncertainty; failures are locally resumable; and telemetry drives supervised improvement in validated progress per scarce resource.**

---

## How to use this document

When evaluating a proposed LDL mechanism, optimization, or architecture change, ask:

1. Does it reduce or increase the context a fresh worker must reconstruct?
2. Does it improve the sufficiency and clarity of durable current state?
3. Does it move a mechanically decidable function below model reasoning?
4. Does it preserve reasoning where semantic judgment is genuinely required?
5. Does it reduce unnecessary founder intervention while preserving founder authority?
6. Can execution fail/resume locally without historical archaeology?
7. Is the resulting state/transition independently verifiable?
8. Does it remain GitHub-native and portable across execution environments?
9. Does it remain provider-independent at the methodology level?
10. Does telemetry provide evidence that the change improves validated progress rather than a vanity metric?
11. Does the added complexity have a plausible recurring amortization path?
12. If every current provider/session/environment disappeared, would durable repository state still make the work intelligible and resumable by a qualified replacement?

A proposal does not need to improve every dimension simultaneously. Tradeoffs are allowed. Material regressions against this north star should be explicit and justified rather than accidental.

---

## Relationship to existing work

### #464 / #465 — Bellman-style reusable state continuations

#464/#465 are a **bounded design/research execution outcome** asking which recurring LDL control-plane reasoning paths actually satisfy sufficient-state/path-independence conditions and can safely move below model reasoning.

This North Star document is broader and non-executable. #464 may use these principles as design criteria, but this document must not absorb #464's investigation or become a generalized Bellman implementation program.

### #391 / #392 — recursive-improvement telemetry capstone

The capstone is a concrete proving path for the telemetry/recursive-improvement portion of this ideal. This document does not alter its dependencies or authorize self-modifying methodology.

### #138 — full software-development lifecycle

#138 concerns the substantive lifecycle from Concept through Maintenance. This document concerns the desired operating properties of LDL across that lifecycle.

### Existing thin-control / fresh-session / deterministic-gate work

Current thin-control, thick-execution, fresh-worker, lifecycle-gate, review/audit, deterministic reconciliation, and launcher work are concrete mechanisms that may advance portions of this ideal. Their current repository authority controls their implementation; this document should not be used to reopen settled details casually.

---

## Non-goals

This document does **not** authorize:

- immediate implementation work;
- treating every current shortfall as a backlog item;
- building a generalized dynamic-programming / Bellman engine;
- an MDP, reinforcement-learning planner, policy database, or workflow graph merely to formalize the analogy;
- unconstrained self-modification;
- optimizing raw token count at the expense of correctness;
- removing semantic reasoning merely because determinism is cheaper;
- eliminating historical provenance that current state cannot safely replace;
- a hosted LDL control plane, daemon, database, message bus, or third-party workflow dependency;
- provider-specific core methodology;
- prematurely rewriting current working mechanisms to fit a cleaner abstract model;
- turning this reference into a roadmap, Burn Order, or acceptance checklist for LDL as a whole.

---

## Maintenance rule

Keep this document as a durable reference unless repository authority later establishes a better canonical north-star artifact.

Update it when the **intended ideal** changes materially, not whenever implementation status changes.

Implementation progress, priorities, dependencies, telemetry results, and specific gaps belong in their owning Issues/artifacts rather than being tracked here.