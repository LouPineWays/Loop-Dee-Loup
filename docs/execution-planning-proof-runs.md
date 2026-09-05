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
| 4 | Deterministic route | **Not exercised** — the original real-world example was found in Stage 2 audit #396 to be the wrong example (it depended on a routing bug fixed in PR #393); two rounds of constructed synthetic substitutes were then found invalid in Stage 2 audit #400 against a schema that cannot truthfully express this case — see the artifact for the full history and the noted schema gap | `docs/execution-planning-proof-runs/294-scenario-04-deterministic-route.json` |
| 5 | Escalation/recombination | **Not exercised with a real occurrence** (none happened in #294's real history); supplementary constructed exercise of the real mechanism recorded instead | `docs/execution-planning-proof-runs/294-scenario-05-escalation-recombination.json` (+ `294-scenario-05-escalation-recombination-exercise.mjs`) |
| 6 | No message bus | Demonstrated | `docs/execution-planning-proof-runs/294-scenario-06-no-message-bus.json` |
| 7 | Integration/PR | **Not exercised** — 294-E (the actual Integration/PR worker for this plan) is still PLANNED/blocked on this unit; opening a PR is explicitly out of this unit's scope | `docs/execution-planning-proof-runs/294-scenario-07-integration-pr.json` |
| 8 | Parallel negative control | Demonstrated | `docs/execution-planning-proof-runs/294-scenario-08-parallel-negative-control.json` |
| 9 | Backlog integrity | Demonstrated | `docs/execution-planning-proof-runs/294-scenario-09-backlog-integrity.json` |
| 10 | Economic evidence | **Not exercised** — no telemetry/comparable control exists yet for this newly-shipped mechanism's first real use | `docs/execution-planning-proof-runs/294-scenario-10-economic-evidence.json` |

5 of 10 scenarios are demonstrated with real, reproducible, linked evidence. 5 are explicitly
marked not-exercised, each with a concrete, non-speculative reason (no real occurrence
existed to observe, the dependent worker hasn't run yet, no comparable telemetry/control
exists, or — scenario 4, downgraded twice across the #396 and #400 correction rounds — the
original real-world example depended on a routing bug since fixed in PR #393, and two rounds
of constructed synthetic substitutes were themselves found invalid against a Worker Unit
Contract schema that has no field able to truthfully express this scenario's case) — none
silently omitted, none declared passing without evidence.

## Exact commands run (reproducible)

All commands below were run from the repository root on branch `feature/294-execution-planning`
at commit `d9990aa` (294-A/B/C's shipped tip) before this unit's own commit, except the
`prepare-dispatch-manifest.mjs --execution-issue 294` re-run, re-run against the fixed
mechanism on `main` as part of the Stage 2 audit #396/#400 correction rounds (see
`294-scenario-04-deterministic-route.json`'s `refreshed_live_rerun` section for that round's
exact output). The scenario 4 constructed exercise script that previously appeared in this
list was deleted in the #400 correction round — see that JSON artifact's
`constructed_exercise_history_abandoned` section for why.

```
node tools/orchestration/parse-execution-plan.mjs --execution-issue 368
node tools/orchestration/parse-execution-plan.mjs --execution-issue 294
node tools/orchestration/prepare-dispatch-manifest.mjs --execution-issue 294
node tools/orchestration/format-unit-dispatch-prompt.mjs --execution-issue 294 --unit 294-D
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
   fixed in PR #399): `extractCapabilityClassLabel` truncated a capability field at the
   *first* em/en-dash found anywhere in the whole field, not just a dash separating the class
   label from trailing detail. Fixing bug 1 above stopped a unit's own deterministic-script
   route from masking this second, pre-existing bug for real unit 294-C, whose real
   "Applicable role/capability" field text carries an unrelated dash in its own explanatory
   prose — exposing a REPLAN_REQUIRED misroute that this proof-run's own original "None"
   claim had never actually exercised. Fixed by truncating at the field's first sentence
   boundary before applying the dash-truncation logic.
3. **Abbreviation-unsafe sentence truncation** (found in PR #399's own Stage 1 review, fixed
   in the same PR): bug 2's fix above applied its new sentence-boundary truncation
   unconditionally, so a field with an abbreviation ("e.g.") preceding its real dash separator
   would be cut short at the abbreviation's internal period. Fixed by gating the
   sentence-boundary step on the `"(see Shared Contract)"` marker's presence.
4. **Two invalid scenario-4 constructed-exercise attempts** (found across PR #399's own Stage
   1 review and Stage 2 audit #400): not a code bug in `resolveUnitRoute` itself, but a proof
   methodology defect — the first synthetic worker-unit contract required an outcome the
   routed script couldn't produce; the second named the routed script in "Files/surfaces
   expected to change" while separately asserting it was "not modified," an internally
   contradictory contract the current 13-field Worker Unit Contract schema cannot avoid for
   this case (no field distinguishes "invokes an existing mechanism unmodified" from "files
   this unit's own work changes"). Resolved by retracting the exercise and marking scenario 4
   honestly not-exercised rather than attempting a third contrivance — see
   `294-scenario-04-deterministic-route.json`'s `schema_gap_noted_for_future_work`.
5. **Stale durable #294 state** (found in Stage 2 audit #400): after bug 1 was fixed in PR
   #393, worker unit 294-C's own Worker Unit Contract comment on #294 (and the durable
   Dispatch Manifest comment) still recorded the pre-fix `deterministic script:
   prepare-dispatch-manifest.mjs` routing as current, contradicting the actually-merged code.
   Refreshed as part of this correction round — see the comments' own edit history on #294 for
   the correction note and refreshed Dispatch Manifest.

See issues #396 and #400 for the full evidence trail on all five findings.
`format-unit-dispatch-prompt.mjs` and `parse-execution-plan.mjs` are not implicated in any of
them.

## Verdict

**PASS for 5 of 10 named scenarios on real, reproducible evidence, with 5 honestly marked
not-exercised, for stated, structural reasons** (no real occurrence to observe for
escalation/recombination; the dependent Integration/PR worker has not run yet; no comparable
telemetry/control exists for this mechanism's first real use; and — scenario 4, downgraded
twice across the #396 and #400 correction rounds — the original real-world example turned out
to depend on the own-deliverable routing bug above, and two rounds of constructed synthetic
substitutes were themselves found invalid against a schema gap this record now names rather
than papers over). Per the same precedent this record follows
(`docs/execution-boundary-experiment.md`), this result does not by itself claim scenarios 4,
5, 7, and 10 as validated by real historical occurrence — it establishes that the shipped
mechanism, as corrected through the #396 and #400 correction rounds, behaves correctly on
every scenario that could actually be observed with real, live repository state, supplemented
by a clearly-labeled constructed exercise for scenario 5 (the one case where a valid synthetic
substitute was achievable), and records the remaining three (4, 7, and 10) honestly rather
than fabricating evidence for them. This proof-run record's own original "Bugs found: None"
claim was itself found wrong by the process it was meant to support, twice over — a reminder
that this document, like the mechanism it documents, is not self-verifying and depends on the
same independent review discipline (`docs/bounded-review-cycle.md`) applied to any other
shipped change.
