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
   contradictory contract given that field's own name. Resolved across bugs 6, 8, and 9 below.
5. **Stale durable #294 state** (found in Stage 2 audit #400): after bug 1 was fixed in PR
   #393, worker unit 294-C's own Worker Unit Contract comment on #294 (and the durable
   Dispatch Manifest comment) still recorded the pre-fix `deterministic script:
   prepare-dispatch-manifest.mjs` routing as current, contradicting the actually-merged code.
   Refreshed in the #400 correction round — see the comments' own edit history on #294 for the
   correction note and refreshed Dispatch Manifest.
6. **Live, unguarded truthfulness gap in the deterministic-script route, part 1: unproven
   non-modification** (found in PR #401's first Stage 1 review round, correcting Stage 2
   audit #400's initial "future work" framing of bug 4 above): even after bug 1's fix,
   `resolveUnitRoute` still inferred "genuine pre-existing mechanism, not the unit's own
   deliverable" merely from a script's existence-on-disk plus textual absence from "Required
   bounded outcome" — unsound whenever a valid contract's outcome describes the same file
   without literally repeating its exact backtick path (a paraphrase). Such a unit would be
   silently short-circuited to "just run the pre-change file" when its real job is to modify
   it. This did not affect any of #294's 5 real units (none use this route post-bug-1), but
   was a live latent defect for any future unit — not merely a documentation/schema-gap
   concern as bug 4's initial disposition assumed. Fixed by requiring an explicit, fixed
   annotation — `(invoked, not modified)` — immediately after a script's own path in
   "Files/surfaces expected to change" before that entry is eligible for the route at all
   (`hasInvokedNotModifiedAnnotation`), on top of the pre-existing `isUnitsOwnDeliverable`
   check kept as defense in depth.
7. **Incomplete synthetic contract in the scenario-5 exercise** (found in PR #401's first
   Stage 1 review round): `294-scenario-05-escalation-recombination-exercise.mjs`'s synthetic
   unit populated only 5 of the 13 fixed Worker Unit Contract fields — a shape
   `parse-execution-plan.mjs`'s own required-field validation (bug/finding from Stage 1 review
   on PR #393) would reject if ever posted as a real comment, so the exercise only proved
   `buildManifestEntries` handles an internally injected malformed object, not that a valid
   planned unit can reach the claimed escalation path. Fixed by populating all 13 fields with
   a plausible, complete contract.
8. **Live, unguarded truthfulness gap in the deterministic-script route, part 2: unproven
   outcome completeness** (found in Stage 2 audit #402, on the PR #401 merge that shipped bug
   6's fix): bug 6's annotation fix protected only the ONE annotated entry — it never checked
   whether the unit's Files/surfaces field named anything ELSE. A unit whose Files/surfaces
   listed an annotated, genuinely pre-existing script ALONGSIDE a separate, real deliverable
   (e.g. `` `gate.mjs` (invoked, not modified), `new-feature.mjs` (new) `` with an outcome
   like "create a new feature module") was still wrongly routed to "just run the gate
   script," silently leaving the real deliverable unimplemented — reproducing the same
   unsatisfied-outcome defect bugs 1 and 4 already fixed, via a different field shape. This
   triggered correction PR #403.
9. **Two more gaps in the same route, found on PR #403's own Stage 1 review, both fixed in
   the same PR without a second Codex invocation**: PR #403's first commit fixed bug 8 by
   requiring the annotated script to be the ONLY *backtick code span* named in the field
   (`isOnlySurfaceNamed`). Codex's review of that commit found this incomplete in two
   directions: (a) the parser does not require backtick-quoting for "Files/surfaces expected
   to change", so a second surface named in PLAIN, unquoted text (e.g. `docs/new-guide.md
   (new)`, no backticks) was invisible to a code-span count — bug 8's own defect,
   reintroduced via unquoted text; (b) counting every code span also OVERcounted a genuinely
   single-surface field that mentioned the same path twice, or contained an unrelated inline
   code span (e.g. a CLI flag name) in its own explanatory prose, needlessly declining a safe
   deterministic route. The same review round also found this document's own scenario-4
   history section had misattributed which PR introduced `isOnlySurfaceNamed` (as PR #401
   rather than PR #403), and found the scenario-4 exercise's three synthetic units
   under-populated (6 of 13 required fields, the same class of defect as bug 7). Fixed by
   replacing both `hasInvokedNotModifiedAnnotation` and `isOnlySurfaceNamed` with a single
   whole-field anchor, `extractSoleInvokedNotModifiedPath`: the entire Files/surfaces field
   must consist of exactly one backtick-quoted path immediately followed by the fixed
   annotation and nothing else — closing both (a) and (b) at once by admitting no per-token
   heuristic to get wrong, at the deliberate cost of declining some genuinely-safe fields
   wrapped in extra prose (documented as a trade-off in that function's own comment). See
   `294-scenario-04-deterministic-route.json`'s `history` section for the full, precisely-
   attributed six-round record of this scenario's own evidence.

10. **Deterministic-script route verifies field structure, not outcome completeness — a
   documented trust boundary, not a bug fixed in code** (found in Stage 2 audit #404, on PR
   #403's merge): even after bug 9's whole-field anchor, `resolveUnitRoute` still cannot
   verify that a unit's full "Required bounded outcome" is completely satisfied by running
   its sole annotated script — a structurally valid unit whose outcome genuinely requires
   follow-up judgment beyond the script call (e.g. "run this checker and close the linked
   issue based on its verdict") still takes the route, even though the follow-up action is
   real, unfinished work. This scenario's own `valid_invocation` exercise fixture originally
   claimed an outcome of "...and acting on its verdict," exposing exactly this gap. Closing it
   in code would require semantically parsing outcome prose — the per-unit judgment #294's own
   founder clarification says deterministic routing must never become ("routing itself turns
   into a second planning pass"). The founder reviewed this specific finding directly and
   chose to document it as an explicit trust boundary in `resolveUnitRoute`'s own module
   comment — this route verifies field structure only, and a contract whose outcome isn't
   actually complete once its annotated script runs is a contract-authoring error this tool
   is not designed to catch, the same trust already extended to a unit's "State" or
   "Verification required" fields not lying — rather than attempting an eighth structural fix.
   The exercise's outcome text was corrected to genuinely match what the route verifies.

See issues #396, #400, #402, and #404 for the full evidence trail on all ten findings.
`format-unit-dispatch-prompt.mjs` is not implicated in any of them.

## Verdict

**PASS for 6 of 10 named scenarios on real, reproducible evidence (1, 2, 3, 6, 8, 9), with 2
more (4, 5) demonstrated only via a clearly-labeled constructed exercise, and the remaining 2
(7, 10) honestly marked not-exercised for stated, structural reasons** (the dependent
Integration/PR worker has not run yet; no comparable telemetry/control exists for this
mechanism's first real use). Per the same precedent this record follows
(`docs/execution-boundary-experiment.md`), this result does not by itself claim scenarios 4,
5, 7, and 10 as validated by real historical occurrence — it establishes that the shipped
mechanism, as corrected through Stage 2 audits #396, #400, #402, and #404 and the Stage 1
review rounds on PRs #399, #401, and #403, behaves correctly (within the documented
structural-eligibility scope described below) on every scenario that could actually be
observed with real, live repository state, supplemented by clearly-labeled constructed
exercises for scenarios 4 and 5 (both now valid, non-contradictory synthetic substitutes),
and records the remaining two (7 and 10) honestly rather than fabricating evidence for them.
Scenario 4's own history across seven rounds is itself part of this record's evidence: not
just a documentation fix each time, but successively deeper findings culminating in three
real, previously-live safety gaps in the shipped routing mechanism (bugs 6, 8, and 9 above) —
gaps none of the 5 real #294 units happened to trigger, but that a future unit plausibly could
have, and where each attempted fix (PR #401's annotation, then PR #403's own first-commit span
count) was itself found incomplete on the very next review round rather than accepted at face
value — including this record's own history section, twice caught misstating which PR fixed
which defect. The seventh round (bug 10) found something qualitatively different from the
first six: not a fixable structural gap, but an inherent limit of what field-structure
checking can ever verify about outcome completeness without semantic judgment — resolved by a
founder-reviewed decision to document that limit explicitly rather than keep iterating in
code, since closing it for real would itself require the "second planning pass" deterministic
routing is designed never to become. This proof-run record's own original "Bugs found: None"
claim was itself found wrong by the process it was meant to support, repeatedly — a reminder
that this document, like the mechanism it documents, is not self-verifying and depends on the
same independent review discipline (`docs/bounded-review-cycle.md`) applied to any other
shipped change, that a finding's first-pass disposition ("future work," "proof methodology
only," even a just-shipped fix, even this record's own provenance claims) is itself subject to
that same scrutiny rather than being the last word, and that not every finding demands another
code change — some demand an honest, durable statement of what the mechanism does and does not
promise.
