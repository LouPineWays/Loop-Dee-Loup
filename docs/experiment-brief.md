# Initial experiment brief

## Hypothesis

Replacing persistent agent conversations with compact GitHub state snapshots and bounded work packets will reduce message/context token consumption without reducing correctness or increasing human coordination.

The optimization target is **validated Burn Order progress per token**, not minimum tokens in isolation.

## First trial

Run Covenant's active `wolfscairn-list-and-privacy` Burn Order item through the full control-plane loop.

### Entry gate

Covenant PR #94 must first close its one bounded inline-review round. Its two current P1 findings are documentation corrections:

1. Reconcile published source-label claims with Buttondown tags being unavailable and unset.
2. Update the decision checklist so steps 1–7 are complete and step 8 is the sole outstanding item.

Those corrections belong to PR #94's existing consolidated correction pass, not to the Loop-Dee-Loup pilot.

### Pilot scope after PR #94

The remaining product work is:

1. Build the Buttondown signup form into the Covenant publication site at `covenant.wolfscairn.com`, using the settled Story 3.3 integration contract.
2. Emit the documented CSP through `site/build.py` as a `<meta http-equiv>` policy compatible with GitHub Pages.
3. Preserve the no-JavaScript rule, graceful failure behavior, CTA hierarchy, brand-wide list positioning, and privacy-policy link.
4. Publish through Covenant's existing branch, test, PR, bounded inline-review, merge, and acceptance-audit rules.
5. Once live, perform the human end-to-end test: submit, receive confirmation, confirm, receive a test broadcast, and unsubscribe.
6. Close `wolfscairn-list-and-privacy` only when that live evidence proves FR-24.

### Control-plane loop

1. Link the Covenant Burn Order item to one durable parent execution issue in Loop-Dee-Loup.
2. Maintain current truth in the parent body.
3. Create only the bounded work packets required by meaningful context boundaries.
4. Execute each packet in a fresh Claude Code session.
5. Preserve Covenant's own source-of-truth hierarchy, IP boundary, checks, and review gates.
6. Close the parent only after the merged result passes its stopping review and the live test passes.
7. Advance Covenant's Burn Order separately.

Loop-Dee-Loup does not replace Covenant's source of truth or safety rules.

## State model

A parent may be in one of these states:

- PROPOSED
- READY
- IN_PROGRESS
- BLOCKED_DECISION
- BLOCKED_FAILURE
- REVIEW
- AUDIT
- CORRECTION
- DONE

Every state transition must be supported by recorded evidence. Only one work packet may be designated NEXT.

## Measurements

Record for the experimental item and a comparable recent baseline where available:

- total input and output tokens;
- message/conversation tokens;
- repository/context rereading tokens;
- number of fresh agent sessions;
- number of user interventions;
- work packets created;
- rework and correction packets;
- elapsed time to validated completion;
- acceptance-audit outcome.

## Success criteria

The experiment succeeds only if:

- message/context tokens decline materially;
- total tokens per validated item do not increase materially;
- no correctness or acceptance gate is weakened;
- user intervention does not increase;
- the issue structure remains faster to maintain than the context it replaces;
- a fresh executor can start from the parent snapshot and active packet without reconstructing history.

No target percentage is fixed before the baseline is measured.

## Failure signals

Stop or redesign the experiment if:

- executors routinely need comments or prior child issues;
- the parent snapshot grows as an append-only transcript;
- packet creation becomes clerical overhead;
- state is duplicated between Covenant's Burn Order and parent issues;
- failures arise from missing compressed context;
- agents proceed across packet boundaries without explicit authorization.

## Explicit non-goals

The first trial will not:

- build a general autonomous orchestrator;
- automatically modify Covenant's Burn Order;
- trigger or merge production changes without existing approvals;
- treat GitHub comments as an execution database;
- create one child issue per conversational step;
- optimize token count at the expense of verified progress.

## Decision after trial

After the stopping audit and live signup test, compare the experiment with the baseline and choose one:

- ADOPT: use for additional medium or large items;
- REVISE: change the packet/state contract and repeat once;
- REJECT: return to the existing workflow and retain only proven components.
