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
| 4 | Deterministic route | Demonstrated | `docs/execution-planning-proof-runs/294-scenario-04-deterministic-route.json` |
| 5 | Escalation/recombination | **Not exercised with a real occurrence** (none happened in #294's real history); supplementary constructed exercise of the real mechanism recorded instead | `docs/execution-planning-proof-runs/294-scenario-05-escalation-recombination.json` (+ `294-scenario-05-escalation-recombination-exercise.mjs`) |
| 6 | No message bus | Demonstrated | `docs/execution-planning-proof-runs/294-scenario-06-no-message-bus.json` |
| 7 | Integration/PR | **Not exercised** — 294-E (the actual Integration/PR worker for this plan) is still PLANNED/blocked on this unit; opening a PR is explicitly out of this unit's scope | `docs/execution-planning-proof-runs/294-scenario-07-integration-pr.json` |
| 8 | Parallel negative control | Demonstrated | `docs/execution-planning-proof-runs/294-scenario-08-parallel-negative-control.json` |
| 9 | Backlog integrity | Demonstrated | `docs/execution-planning-proof-runs/294-scenario-09-backlog-integrity.json` |
| 10 | Economic evidence | **Not exercised** — no telemetry/comparable control exists yet for this newly-shipped mechanism's first real use | `docs/execution-planning-proof-runs/294-scenario-10-economic-evidence.json` |

7 of 10 scenarios are demonstrated with real, reproducible, linked evidence. 3 are explicitly
marked not-exercised, each with a concrete, non-speculative reason (no real occurrence
existed to observe, the dependent worker hasn't run yet, or no comparable telemetry/control
exists) — none silently omitted, none declared passing without evidence.

## Exact commands run (reproducible)

All commands below were run from the repository root on branch `feature/294-execution-planning`
at commit `d9990aa` (294-A/B/C's shipped tip) before this unit's own commit.

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

None. All three scripts (`parse-execution-plan.mjs`, `prepare-dispatch-manifest.mjs`,
`format-unit-dispatch-prompt.mjs`) behaved exactly as documented across every live and
constructed run in this proof-run record, including the deliberately-adversarial scenario 5
exercise (an unresolvable synthetic unit correctly triggered `REPLAN_REQUIRED` with a
specific, actionable reason, and did not disturb any other unit's routing or
dispatch-readiness in the same run).

## Verdict

**PASS for 7 of 10 named scenarios, with 3 honestly marked not-exercised for stated,
structural reasons** (no real occurrence to observe for escalation/recombination; the
dependent Integration/PR worker has not run yet; no comparable telemetry/control exists for
this mechanism's first real use). Per the same precedent this record follows
(`docs/execution-boundary-experiment.md`), this result does not by itself claim scenarios 5,
7, and 10 as validated — it establishes that the shipped mechanism behaves correctly on every
scenario that could actually be observed with real, live repository state at this unit's
dispatch time, and records the remaining three honestly rather than fabricating evidence for
them.
