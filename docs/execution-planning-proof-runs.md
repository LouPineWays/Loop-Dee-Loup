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
| 4 | Deterministic route | Demonstrated via constructed exercise (not a real occurrence) — the original real-world example and two subsequent synthetic substitutes were each found invalid across audits #396/#400 and PR #401's own Stage 1 review, which also found and fixed a live safety gap in the routing mechanism itself; see the artifact for the full four-round history | `docs/execution-planning-proof-runs/294-scenario-04-deterministic-route.json` (+ `294-scenario-04-deterministic-route-exercise.mjs`) |
| 5 | Escalation/recombination | Demonstrated via constructed exercise (not a real occurrence) — none happened in #294's real history | `docs/execution-planning-proof-runs/294-scenario-05-escalation-recombination.json` (+ `294-scenario-05-escalation-recombination-exercise.mjs`) |
| 6 | No message bus | Demonstrated | `docs/execution-planning-proof-runs/294-scenario-06-no-message-bus.json` |
| 7 | Integration/PR | **Not exercised** — 294-E (the actual Integration/PR worker for this plan) is still PLANNED/blocked on this unit; opening a PR is explicitly out of this unit's scope | `docs/execution-planning-proof-runs/294-scenario-07-integration-pr.json` |
| 8 | Parallel negative control | Demonstrated | `docs/execution-planning-proof-runs/294-scenario-08-parallel-negative-control.json` |
| 9 | Backlog integrity | Demonstrated | `docs/execution-planning-proof-runs/294-scenario-09-backlog-integrity.json` |
| 10 | Economic evidence | **Not exercised** — no telemetry/comparable control exists yet for this newly-shipped mechanism's first real use | `docs/execution-planning-proof-runs/294-scenario-10-economic-evidence.json` |

6 of 10 scenarios (1, 2, 3, 6, 8, 9) are demonstrated with real, reproducible, linked
evidence. 2 more (4, 5) are demonstrated only via a clearly-labeled constructed exercise —
no real occurrence exists for either in #294's actual history — and are called out as such
rather than counted alongside the 6 with unqualified real evidence. The remaining 2 (7, 10)
are explicitly marked not-exercised, each with a concrete, non-speculative reason (the
dependent worker hasn't run yet; no comparable telemetry/control exists). None silently
omitted, none declared passing without evidence, and none of the three categories above is
conflated with another in this count (a Stage 1 review finding on PR #401 caught an earlier
version of this document doing exactly that).

## Exact commands run (reproducible)

All commands below were run from the repository root on branch `feature/294-execution-planning`
at commit `d9990aa` (294-A/B/C's shipped tip) before this unit's own commit, except the
`prepare-dispatch-manifest.mjs --execution-issue 294` re-run and both scenario exercise
scripts, re-run against the fixed mechanism on `main` as part of the Stage 2 audit
#396/#400/#401 correction rounds (see `294-scenario-04-deterministic-route.json`'s
`refreshed_live_rerun`/`constructed_exercise` sections and
`294-scenario-05-escalation-recombination.json`'s `constructed_exercise` section for the
current exact output). The scenario 4 exercise script was deleted in the #400 correction
round and recreated in the #401 correction round with a corrected, non-contradictory
synthetic contract — see that JSON artifact's `history` section for the full four-round
record.

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
   contradictory contract given that field's own name. Resolved for good in bug 6 below.
5. **Stale durable #294 state** (found in Stage 2 audit #400): after bug 1 was fixed in PR
   #393, worker unit 294-C's own Worker Unit Contract comment on #294 (and the durable
   Dispatch Manifest comment) still recorded the pre-fix `deterministic script:
   prepare-dispatch-manifest.mjs` routing as current, contradicting the actually-merged code.
   Refreshed in the #400 correction round — see the comments' own edit history on #294 for the
   correction note and refreshed Dispatch Manifest.
6. **Live, unguarded truthfulness gap in the deterministic-script route** (found in PR #401's
   own Stage 1 review, correcting Stage 2 audit #400's initial "future work" framing of bug
   4 above): even after bug 1's fix, `resolveUnitRoute` still inferred "genuine pre-existing
   mechanism, not the unit's own deliverable" merely from a script's existence-on-disk plus
   textual absence from "Required bounded outcome" — unsound whenever a valid contract's
   outcome describes the same file without literally repeating its exact backtick path (a
   paraphrase). Such a unit would be silently short-circuited to "just run the pre-change
   file" when its real job is to modify it. This did not affect any of #294's 5 real units
   (none use this route post-bug-1), but was a live latent defect for any future unit — not
   merely a documentation/schema-gap concern as bug 4's initial disposition assumed. Fixed by
   requiring an explicit, fixed annotation — `(invoked, not modified)` — immediately after a
   script's own path in "Files/surfaces expected to change" before that entry is eligible for
   the route at all (`hasInvokedNotModifiedAnnotation`), on top of the pre-existing
   `isUnitsOwnDeliverable` check kept as defense in depth. This also resolved bug 4: with a
   truthful, non-contradictory way for a contract to assert non-modification now available,
   the scenario-4 constructed exercise was rebuilt validly instead of remaining retracted —
   see `294-scenario-04-deterministic-route.json`'s `history` section.
7. **Incomplete synthetic contract in the scenario-5 exercise** (found in PR #401's own Stage
   1 review): `294-scenario-05-escalation-recombination-exercise.mjs`'s synthetic unit
   populated only 5 of the 13 fixed Worker Unit Contract fields — a shape
   `parse-execution-plan.mjs`'s own required-field validation (bug/finding from Stage 1 review
   on PR #393) would reject if ever posted as a real comment, so the exercise only proved
   `buildManifestEntries` handles an internally injected malformed object, not that a valid
   planned unit can reach the claimed escalation path. Fixed by populating all 13 fields with
   a plausible, complete contract.

See issues #396 and #400, and PR #401's own Stage 1 review, for the full evidence trail on
all seven findings. `format-unit-dispatch-prompt.mjs` is not implicated in any of them.

## Verdict

**PASS for 6 of 10 named scenarios on real, reproducible evidence (1, 2, 3, 6, 8, 9), with 2
more (4, 5) demonstrated only via a clearly-labeled constructed exercise, and the remaining 2
(7, 10) honestly marked not-exercised for stated, structural reasons** (the dependent
Integration/PR worker has not run yet; no comparable telemetry/control exists for this
mechanism's first real use). Per the same precedent this record follows
(`docs/execution-boundary-experiment.md`), this result does not by itself claim scenarios 4,
5, 7, and 10 as validated by real historical occurrence — it establishes that the shipped
mechanism, as corrected through the #396, #400, and #401 correction rounds, behaves correctly
on every scenario that could actually be observed with real, live repository state,
supplemented by clearly-labeled constructed exercises for scenarios 4 and 5 (both now valid,
non-contradictory synthetic substitutes), and records the remaining two (7 and 10) honestly
rather than fabricating evidence for them. Scenario 4's own history across three correction
rounds is itself part of this record's evidence: not just a documentation fix each time, but
successively deeper findings culminating in a real, previously-live safety gap in the shipped
routing mechanism (bug 6 above) — a gap none of the 5 real #294 units happened to trigger, but
that a future unit plausibly could have. This proof-run record's own original "Bugs found:
None" claim was itself found wrong by the process it was meant to support, across three
separate correction rounds — a reminder that this document, like the mechanism it documents,
is not self-verifying and depends on the same independent review discipline
(`docs/bounded-review-cycle.md`) applied to any other shipped change, and that a finding's
first-pass disposition ("future work," "proof methodology only") is itself subject to that
same scrutiny rather than being the last word.
