# Bounded review and acceptance-audit cycle

The target repository's stricter review rules control. When it has no stricter rule and a slice is review-worthy, use this bounded cycle. One inline round is a bound on reviewer invocations, not permission to merge a known defect.

## Entry check

Before review, verify the complete slice against its acceptance criteria and controlling authority. For code, check interacting requirements, existing invariants, generalize beyond the reported symptom, and use a fast local harness when repeated external verification would be expensive. For design or architecture, define a fixed rubric, list explicit deferrals and tensions, and self-review the entire current document rather than isolated edits.

Do not attach this cycle to trivial work merely because the mechanism exists. Preserve any target-repository rule that mandates review for a category of change.

## Stage 1: one inline PR review round

1. Complete the slice and required local checks.
2. Freeze and record the PR head SHA.
3. Request exactly one independent inline review at that head by posting a PR comment containing `@codex review` — the same trigger mechanism as Stage 2. Check first whether it was already requested at this head. Never use a different reviewer tool or mechanism (e.g. GitHub's own Copilot-review request) as a substitute or supplement — that is not the documented reviewer and its silence or delay does not license falling back to one. Duplicate `@codex review` invocations at the same head are parallel opinions in one round, not new rounds.
4. Require complete-change inspection, actionable defects only, and separation of defects from scope expansion, preference, deliberate deferral, or superseded material.
5. Verify every finding. Reject false positives with a recorded reason and deduplicate valid findings by root cause.
6. Batch all valid findings into one consolidated correction pass and rerun required checks.
7. Do not request a second inline review on that PR.
8. Merge only if every valid finding is fixed, required checks and CI pass, the reviewed scope, head, and target are reverified, and no Critical defect, founder decision, security/privacy issue, data-loss risk, migration uncertainty, or other blocker remains.

Multiple comments produced by one invocation are one round. Fix commits are not another round. A second invocation is another round and is prohibited by default.

Once Stage 1 has been requested, the PR body is the durable checkpoint. Make it self-sufficient, run `spend` first if the completed session is worth measuring, and clear or hand off rather than keeping an implementation-heavy session alive through review latency. Use PR event delivery when available; do not pair it with long fallback timers that merely preserve context.

## Stage 2: one post-merge issue audit

1. Record the exact merge commit on the target branch, not merely the PR head.
2. Start the audit from a fresh independent context. Open one control issue containing the complete read-only audit specification, using the `audit-control-issue` issue template.
3. Verify the created issue body by direct read. It must survive transport intact and name the exact commit.
4. Check whether an invocation already exists, then post one separate issue comment containing `@codex review` to trigger the reviewer — never any other reviewer tool or mechanism. An invocation in the issue body is specification only and does not reliably start Codex. Never invoke from both places.
5. Treat posting the trigger and arranging its bounded follow-up as one atomic action. Issue audit responses are not covered by PR-only subscriptions.
6. Keep the controlling session lean. Delegate the trigger, wait, and response extraction to one disposable worker or successor context when available. It reads the issue response in its own context and returns only the verdict, severity counts, and finding text required for action. Do not load the full audit transcript, verification-command list, or evidence prose into the orchestrator merely to learn whether Codex replied.
7. Audit the exact merged commit and complete current files, applicable instructions, source-of-truth hierarchy, merged PR, and its single inline review.
8. Verify every valid inline finding's disposition and search for cross-file contradictions, regressions, missing transitions, authority conflicts, unhandled boundaries, and traps exposed by the consolidated fix.
9. Deduplicate by root cause. Report severity counts, exact evidence, consequence, smallest correction, whether founder judgment is required, and end with CLEAN or NOT CLEAN. Modify nothing.

A report that nothing material remains is a successful audit. State anything the environment could not verify instead of implying it passed.

## Verdict handling

CLEAN closes the review cycle. Close the audit issue and implemented work issue where target-repository policy requires it, record the exact merge and audit evidence in the parent snapshot, and stop at this natural fresh-session boundary.

NOT CLEAN starts one consolidated correction outcome:

1. verify each finding against the audited merge commit;
2. reject false positives and duplicates with reasons;
3. stop only for a genuine founder decision or safety blocker;
4. batch accepted findings into one correction PR;
5. run that correction through the same one-inline-round, one-audit cycle.

Do not ask routine permission between those mechanically authorized steps and do not answer findings one at a time. A correction cycle may repeat after a genuine NOT CLEAN verdict, but each cycle remains bounded and evidence-driven.

The audit advances the parent snapshot only from evidence. A reviewer's summary is not evidence by itself; verify the exact commit, files, checks, and disposition.
