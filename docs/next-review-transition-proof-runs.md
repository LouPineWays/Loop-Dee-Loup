# Next-review-transition proof runs (worker unit 397-C)

Durable record for worker unit 397-C under execution Issue #397 / control Issue #398:
exercising 397-A/397-B/397-E's shipped mechanism (`tools/orchestration/ready-dispatch-gate.mjs`'s
new `READY_FOR_PLAN`/`PLAN_READY`/`ROUTED`/`EXECUTION_COMPLETE` pre-PR states,
`tools/orchestration/next-review-transition-gate.mjs`'s new post-PR verdict set, and
`tools/orchestration/format-dispatch-prompt.mjs`'s new planning/integration templates, plus
397-A's documentation in `docs/operating-model.md` and `docs/bounded-review-cycle.md`) against
representative real work, addressing every one of the 7 verification scenarios named in #397's
own "Verification" section.

This record follows the structural/honesty precedent set by `docs/execution-planning-proof-runs.md`
(itself following `docs/execution-boundary-experiment.md`): each scenario below is either
demonstrated with linked, reproducible evidence, or explicitly marked constructed-exercise or
not-exercised/inconclusive with a stated reason -- never silently declared passing without
evidence.

## Representative real work used

Per this unit's own contract (Worker Unit 397-C on #397), the following real, live, or real-
historical repository state was used:

- **Control Issue #408 / execution Issue #407** ("[Control]/[Bug] Terminalize orphaned Stage 2
  audit issues") -- read live on 2026-09-06. #408 is the exact live reproduction #397's own
  bug-report comment was written against (`Lifecycle: READY_FOR_PLAN`, `Route: planning worker`,
  `Blocker: none`, `Founder decision: none`); it had not moved on by the time this unit ran, so
  no synthetic substitute was needed, per this unit's own contract's explicit instruction to
  check first.
- **Control Issue #375 / PR #376 / Audit Issue #380** (#374's own implementation and proving
  lifecycle, 2026-09-04) -- used as the representative broad "Next authorized transition"
  source text (per this unit's contract, #375's real mid-cycle comment is the required negative-
  control source) and as real historical evidence of an actual Stage 1 -> merge -> Stage 2
  breakpoint sequence.
- **Audit Issues #384, #406** -- real, closed Stage 2 audits from unrelated completed corrections
  (#381/#382 and #306's own terminal correction respectively), used to exercise the post-audit
  observation path against real durable state.
- **This unit's own dispatch** (397-C's worker-unit dispatch message, received to start this
  session) -- a live, real, independent instance of terse implementation-unit dispatch.

No currently-open real PR or Audit Issue in this repository's live state was found in the exact
shape needed for two sub-cases (a closing-reference violation pre-merge, and a still-open-work-
issue CLEAN audit or a NOT CLEAN audit post-merge); those two shapes were exercised via clearly-
labeled constructed exercises calling the shipped, unmodified pure verdict functions directly,
following exactly the same technique 294-D's own scenario-4/5 exercises used for their own no-
real-occurrence cases.

## Scenario-by-scenario summary

| # | Scenario | Status | Artifact |
| - | -------- | ------ | -------- |
| 1 | Terse implementation-unit dispatch | Demonstrated (real, live) | `docs/next-review-transition-proof-runs/397-scenario-01-terse-implementation-dispatch.json` |
| 2 | Terse correction dispatch | Demonstrated via constructed exercise (not a real occurrence) for the closing-reference variant; findings-bearing Stage 1 responses are now also correction-triggering | `docs/next-review-transition-proof-runs/397-scenario-02-terse-correction-dispatch.json` (+ `-exercise.mjs`) |
| 3 | Stage 1 breakpoint | Demonstrated (real, historical) | `docs/next-review-transition-proof-runs/397-scenario-03-stage1-breakpoint.json` |
| 4 | Merge -> Stage 2 breakpoint | Demonstrated (real, historical replay at the exact recorded durable reference) | `docs/next-review-transition-proof-runs/397-scenario-04-merge-stage2-breakpoint.json` |
| 5 | Fresh Stage 2 observation | Demonstrated -- partly real (NO_ACTION_YET/AMBIGUOUS), partly constructed exercise (STAGE2_CLOSE_READY/STAGE2_CORRECTION_REQUIRED; no real currently-open case exists for either) | `docs/next-review-transition-proof-runs/397-scenario-05-fresh-stage2-observation.json` (+ `-exercise.mjs`) |
| 6 | Negative control | Demonstrated (real) | `docs/next-review-transition-proof-runs/397-scenario-06-negative-control.json` |
| 7 | Context/economic evidence | Demonstrated (real character-count comparisons); explicitly not treated as the sole success criterion per #397's own constraint | `docs/next-review-transition-proof-runs/397-scenario-07-context-economic-evidence.json` |

4 of 7 scenarios (1, 3, 4, 6) are demonstrated with real, reproducible, linked evidence (live
current state for 1, real historical state for 3/4/6). 2 more (2, 5) are demonstrated partly or
wholly via clearly-labeled constructed exercises -- no real occurrence currently exists in this
repository's live state for the specific verdict shapes they require -- and are called out as
such rather than counted alongside the scenarios with unqualified real evidence. Scenario 7 uses
real character counts from real artifacts, per #397's own instruction not to make token
reduction the sole criterion. None silently omitted, none declared passing without evidence.

## Exact commands run (reproducible)

All commands below were run from the repository root on branch `feature/397-transition-gates`
at commit `e3fa6fc` (397-A/397-B/397-E's shipped tip) before this unit's own commit.

```
node tools/orchestration/ready-dispatch-gate.mjs --control-issue 408
node tools/orchestration/ready-dispatch-gate.mjs --control-issue 408 | node tools/orchestration/format-dispatch-prompt.mjs
node tools/orchestration/next-review-transition-gate.mjs --pr 376 --head fd1baa68eefd9dabec69784fa1c5390e9fa31ae5 --issue 375
node tools/orchestration/next-review-transition-gate.mjs --audit-issue 384
node tools/orchestration/next-review-transition-gate.mjs --audit-issue 380
node tools/orchestration/next-review-transition-gate.mjs --audit-issue 406
node docs/next-review-transition-proof-runs/397-scenario-02-terse-correction-dispatch-exercise.mjs
node docs/next-review-transition-proof-runs/397-scenario-05-fresh-stage2-observation-exercise.mjs
gh issue view 408 --repo LouPineWays/Loop-Dee-Loup --json body
gh issue view 407 --repo LouPineWays/Loop-Dee-Loup --json body
gh issue view 375 --repo LouPineWays/Loop-Dee-Loup --json body,createdAt,updatedAt,closedAt
gh api repos/LouPineWays/Loop-Dee-Loup/issues/comments/5553518120 --jq '.body'
gh api repos/LouPineWays/Loop-Dee-Loup/issues/comments/5553510493 --jq '.body'
gh api repos/LouPineWays/Loop-Dee-Loup/issues/comments/5541631991 --jq '.body'
gh pr list --repo LouPineWays/Loop-Dee-Loup --state all --limit 30 --json number,title,state,mergedAt,createdAt
gh issue view 380 --repo LouPineWays/Loop-Dee-Loup --json number,state,title
gh issue view 406 --repo LouPineWays/Loop-Dee-Loup --json number,state,title
```

Full outputs are recorded in each scenario's own JSON artifact above.

## Test suite verification

Per this unit's contract, 397-A/397-B/397-E's own scripts were exercised, never modified. Before
this unit added any files:

```
node --test tools/orchestration/*.test.mjs
```

**238/238 passing.**

```
node --test tools/review-watch/*.test.mjs
```

**410/410 passing.**

After this unit's own work (documentation and two standalone exercise scripts under `docs/`, not
test files), the same suites were re-run and remain **238/238** and **410/410** passing --
unaffected by this unit's changes, confirming no shipped script's behavior was modified.

## Bugs / gaps found while exercising the shipped scripts

Per this unit's own honesty convention (and 294-D's precedent that its own original "Bugs found:
None" claim was later found wrong), one real, unexpected finding surfaced while gathering real
evidence for scenario 5, reported honestly rather than omitted:

1. **Audit #406's real completed Stage 2 report is not recognized as backing its own real CLEAN
   verdict.** Running `next-review-transition-gate.mjs --audit-issue 406` against the real,
   closed audit for #306's own terminal correction returns `AMBIGUOUS`/`PREMATURE_CLOSURE`
   rather than `STAGE2_CLOSE_READY`, because `lifecycle-gate.mjs`'s checklist-walk-through check
   counts the real completed report's checklist at 8 numbered items against a requested 9 --
   `reportEvidence.backed: false`. The gate's own fail-closed behavior here is correct and by
   design (it does not fabricate a passing result on unverified evidence -- exactly what
   scenario 6's negative control and #397's requirement 6 call for), but the underlying checklist-
   count mismatch on this specific real report is itself a candidate defect worth a future,
   separate look. Fixing it is out of this unit's own scope (397-C exercises 397-A/397-B/397-E's
   shipped scripts; it does not change their behavior, per this unit's own Worker Unit Contract's
   "Verification required" field). See
   `docs/next-review-transition-proof-runs/397-scenario-05-fresh-stage2-observation.json` for the
   full real output.
2. **Audit Issue #380 remains open on GitHub despite a real, backed CLEAN verdict and a closed
   work issue (#374).** This is not a defect in 397-A/397-B/397-E's shipped mechanism -- it is
   the exact live orphaned-audit-issue defect execution Issue #407 / control Issue #408 (the very
   representative real work used for scenario 1 above) already exists to fix, and is explicitly
   out of #397's own scope. Noted here only because it surfaced naturally while gathering real
   evidence for scenario 5, not as a new finding requiring action from this unit.

Neither finding required or received a code change in this unit's own work, per its contract.

## Verdict

**PASS for all 7 named scenarios, on real, reproducible evidence for 4 of them (1, 3, 4, 6) and
on clearly-labeled constructed exercises (using the shipped, unmodified pure verdict functions
directly) for the remaining 2 (2, 5) plus part of scenario 7's comparison basis.** No scenario
was silently omitted or declared passing without evidence. Per the same precedent this record
follows (`docs/execution-planning-proof-runs.md`), the constructed-exercise scenarios (2 and part
of 5) do not by themselves claim a real historical occurrence -- they establish that 397-A/397-B/
397-E's shipped mechanism, exercised as shipped, resolves every one of #397's own named verification
scenarios to exactly one bounded verdict or breakpoint, using real repository state wherever real
state in the required shape currently exists, and an honestly-labeled synthetic substitute
otherwise -- consistent with #397's own root-cause finding and its Shared Contract's explicit
Verification-required instruction that "this unit exercises the shipped scripts, it does not
change their behavior."
