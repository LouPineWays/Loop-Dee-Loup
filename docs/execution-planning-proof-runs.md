# Execution-planning proof runs (worker unit 294-D)

Durable record for worker unit 294-D under execution Issue #294 / control Issue #306:
exercising 294-A/B/C's shipped issue-local planning mechanism
(`tools/orchestration/parse-execution-plan.mjs`,
`tools/orchestration/prepare-dispatch-manifest.mjs`,
`tools/orchestration/format-unit-dispatch-prompt.mjs`, plus 294-A's documentation in
`docs/operating-model.md` and `docs/bounded-review-cycle.md`) against representative real
work, addressing every one of the 10 verification scenarios named in #294's own
"Verification" section.

This record follows the structural/honesty precedent set by
`docs/execution-boundary-experiment.md` and `docs/execution-boundary-probe-runs/*.json`: each
scenario below is either demonstrated with linked, reproducible evidence, or explicitly
marked not-exercised/inconclusive with a stated reason — never silently declared passing
without evidence.

## Representative real work used

Per this unit's own contract (comment 5550653317 on #294), `#294`/`#306` itself is used as
representative real work for every scenario that is naturally about parsing/routing/
dispatch-prompt mechanics: it is real, live, and already has a complete real plan on it (five
worker-unit contracts, a real Shared Contract, a real Plan Index, a real Dispatch Manifest).
Two scenarios additionally use other real, already-completed LDL issues:

- **Issue #368** ("[Bug] Stop blocked control invocations at the READY gate instead of
  falling through to execution reasoning", CLOSED) — a genuine single-bounded-vertical-slice
  execution issue, used as representative real work for scenario 1 (it never went through
  multi-unit planning machinery at all).
- No other issue in this repository's history has ever gone through 294-A/B/C's exact
  mechanism (it is newly shipped in this same plan), which is directly relevant to why
  scenarios 7 and 10 could not be exercised — see below.

## Scenario-by-scenario summary

| # | Scenario | Status | Artifact |
| - | -------- | ------ | -------- |
| 1 | Single-worker plan | Demonstrated (indirect — mechanism correctly does not impose multi-unit structure on a real single-worker issue) | `docs/execution-planning-proof-runs/294-scenario-01-single-worker-plan.json` |
| 2 | Need-to-know decomposition | Demonstrated | `docs/execution-planning-proof-runs/294-scenario-02-need-to-know-decomposition.json` |
| 3 | Shared-contract case | Demonstrated | `docs/execution-planning-proof-runs/294-scenario-03-shared-contract-case.json` |
| 4 | Deterministic route | **Not demonstrated by a real #294 occurrence** (the original real-world example was found in Stage 2 audit #396 to be the wrong example — it depended on a routing bug fixed in PR #393); supplementary constructed exercise of the real fixed mechanism recorded instead | `docs/execution-planning-proof-runs/294-scenario-04-deterministic-route.json` (+ `294-scenario-04-deterministic-route-exercise.mjs`) |
| 5 | Escalation/recombination | **Not exercised with a real occurrence** (none happened in #294's real history); supplementary constructed exercise of the real mechanism recorded instead | `docs/execution-planning-proof-runs/294-scenario-05-escalation-recombination.json` (+ `294-scenario-05-escalation-recombination-exercise.mjs`) |
| 6 | No message bus | Demonstrated | `docs/execution-planning-proof-runs/294-scenario-06-no-message-bus.json` |
| 7 | Integration/PR | **Not exercised** — 294-E (the actual Integration/PR worker for this plan) is still PLANNED/blocked on this unit; opening a PR is explicitly out of this unit's scope | `docs/execution-planning-proof-runs/294-scenario-07-integration-pr.json` |
| 8 | Parallel negative control | Demonstrated | `docs/execution-planning-proof-runs/294-scenario-08-parallel-negative-control.json` |
| 9 | Backlog integrity | Demonstrated | `docs/execution-planning-proof-runs/294-scenario-09-backlog-integrity.json` |
| 10 | Economic evidence | **Not exercised** — no telemetry/comparable control exists yet for this newly-shipped mechanism's first real use | `docs/execution-planning-proof-runs/294-scenario-10-economic-evidence.json` |

6 of 10 scenarios are demonstrated with real, reproducible, linked evidence. 4 are explicitly
marked not-exercised or not-demonstrated by a real occurrence, each with a concrete,
non-speculative reason (no real occurrence existed to observe, the dependent worker hasn't
run yet, no comparable telemetry/control exists, or — scenario 4, downgraded in this
correction round per Stage 2 audit #396 — the original real-world example depended on a
routing bug since fixed in PR #393 and no other real #294 unit demonstrates the scenario) —
none silently omitted, none declared passing without evidence.

## Exact commands run (reproducible)

All commands below were run from the repository root on branch `feature/294-execution-planning`
at commit `d9990aa` (294-A/B/C's shipped tip) before this unit's own commit, except the
`prepare-dispatch-manifest.mjs --execution-issue 294` re-run and the
`294-scenario-04-deterministic-route-exercise.mjs` run, both re-run against the fixed
mechanism on `main` as part of the Stage 2 audit #396 correction round (see
`294-scenario-04-deterministic-route.json`'s `refreshed_live_rerun` and
`constructed_exercise` sections for that round's exact output).

```
node tools/orchestration/parse-execution-plan.mjs --execution-issue 368
node tools/orchestration/parse-execution-plan.mjs --execution-issue 294
node tools/orchestration/prepare-dispatch-manifest.mjs --execution-issue 294
node tools/orchestration/format-unit-dispatch-prompt.mjs --execution-issue 294 --unit 294-D
node docs/execution-planning-proof-runs/294-scenario-04-deterministic-route-exercise.mjs
node docs/execution-planning-proof-runs/294-scenario-05-escalation-recombination-exercise.mjs
gh issue list --repo LouPineWays/Loop-Dee-Loup --state all --search "294-A OR 294-B OR 294-C OR 294-D OR 294-E in:title" --json number,title
gh issue list --repo LouPineWays/Loop-Dee-Loup --state all --limit 500 --json number
```

Full outputs are recorded in each scenario's own JSON artifact above.

## Test suite verification

Per this unit's contract, 294-A/B/C's own scripts were exercised, never modified. Before and
after this unit's work:

```
node --test tools/orchestration/*.test.mjs
```

**138/138 passing**, both before this unit added any files (baseline, matching 294-C's own
recorded 136-test count plus the two `ready-dispatch-gate.test.mjs` tests already present)
and after (this unit's own added files are documentation and one standalone exercise script
under `docs/`, not test files, so the suite's own test count is unaffected by this unit's
changes).

## Bugs found in the shipped scripts

This claimed "None" at the time this unit (294-D) first shipped, but that claim did not
survive independent scrutiny. The post-merge Stage 2 audit on PR #393 (issue #396, NOT CLEAN)
found two real bugs in `prepare-dispatch-manifest.mjs`, both since fixed in correction rounds:

1. **Own-deliverable routing bug** (fixed in PR #393's Stage 1 correction, commit `6de7f0a`):
   `resolveUnitRoute`'s deterministic-script step routed a unit to a script named in its own
   "Files/surfaces expected to change" field even when that same script was also that unit's
   own deliverable per its "Required bounded outcome" field — i.e. "run the file's pre-change
   contents" was treated as satisfying a unit whose job was to change that file. This is
   exactly what the original scenario-4 proof-run (294-B/294-C routing to their own scripts)
   was unknowingly exercising, rather than the genuine pre-existing-mechanism case the
   scenario describes. Fixed by adding `isUnitsOwnDeliverable`.
2. **Capability-class-label sentence/dash truncation bug** (found in Stage 2 audit #396 itself,
   fixed in this same correction round): `extractCapabilityClassLabel` truncated a capability
   field at the *first* em/en-dash found anywhere in the whole field, not just a dash
   separating the class label from trailing detail. Fixing bug 1 above stopped a unit's own
   deterministic-script route from masking this second, pre-existing bug for real unit 294-C,
   whose real "Applicable role/capability" field text carries an unrelated dash in its own
   explanatory prose — exposing a REPLAN_REQUIRED misroute that this proof-run's own original
   "None" claim had never actually exercised. Fixed by truncating at the field's first
   sentence boundary before applying the dash-truncation logic.

See issue #396 for the full evidence trail on both bugs. `format-unit-dispatch-prompt.mjs`
and `parse-execution-plan.mjs` are not implicated in either bug.

## Verdict

**PASS for 6 of 10 named scenarios on real, reproducible evidence, with 4 honestly marked
not-exercised or not-demonstrated by a real occurrence, for stated, structural reasons** (no
real occurrence to observe for escalation/recombination; the dependent Integration/PR worker
has not run yet; no comparable telemetry/control exists for this mechanism's first real use;
and — scenario 4, downgraded in the Stage 2 audit #396 correction round — the original
real-world example turned out to depend on the own-deliverable routing bug above, and no real
#294 unit demonstrates a genuine pre-existing-mechanism route once that bug was fixed). Per
the same precedent this record follows (`docs/execution-boundary-experiment.md`), this result
does not by itself claim scenarios 4, 5, 7, and 10 as validated by real historical occurrence
— it establishes that the shipped mechanism, as corrected through the #396 correction round,
behaves correctly on every scenario that could actually be observed with real, live
repository state, supplemented by clearly-labeled constructed exercises for scenarios 4 and 5
where no real occurrence exists, and records the remaining two (7 and 10) honestly rather
than fabricating evidence for them. This proof-run record's own original "Bugs found: None"
claim was itself found wrong by the process it was meant to support — a reminder that this
document, like the mechanism it documents, is not self-verifying and depends on the same
independent review discipline (`docs/bounded-review-cycle.md`) applied to any other shipped
change.
