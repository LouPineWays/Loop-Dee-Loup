# Bounded review and acceptance-audit cycle

The target repository's stricter review rules control. When it has no stricter rule and a slice is review-worthy, use this bounded cycle. One inline round is a bound on reviewer invocations, not permission to merge a known defect.

## Entry check

Before review, verify the complete slice against its acceptance criteria and controlling authority. For code, check interacting requirements, existing invariants, generalize beyond the reported symptom, and use a fast local harness when repeated external verification would be expensive. For design or architecture, define a fixed rubric, list explicit deferrals and tensions, and self-review the entire current document rather than isolated edits.

## Stage 1: one inline PR review round

1. Complete the slice and required local checks.
2. Freeze and record the PR head SHA.
3. Request exactly one independent inline review at that head.
4. Require complete-change inspection, actionable defects only, and separation of defects from scope expansion, preference, deliberate deferral, or superseded material.
5. Verify every finding. Reject false positives with a recorded reason and deduplicate valid findings by root cause.
6. Batch all valid findings into one consolidated correction pass and rerun required checks.
7. Do not request a second inline review on that PR.
8. Merge only if every valid finding is fixed, required checks pass, the reviewed scope and target are reverified, and no Critical defect, founder decision, security/privacy issue, data-loss risk, migration uncertainty, or other blocker remains.

Multiple comments produced by one invocation are one round. Fix commits are not another round. A second invocation is another round and is prohibited by default.

## Stage 2: one post-merge issue audit

1. Record the exact merge commit.
2. Open one control issue containing the complete read-only audit specification.
3. Post a separate issue comment to trigger the reviewer. An invocation in the issue body is specification only and does not reliably start Codex.
4. Audit the exact merged commit and complete current files, applicable instructions, source-of-truth hierarchy, merged PR, and its single inline review.
5. Verify every valid inline finding's disposition and search for cross-file contradictions, regressions, missing transitions, authority conflicts, unhandled boundaries, and traps exposed by the consolidated fix.
6. Deduplicate by root cause. Report severity counts, exact evidence, consequence, smallest correction, whether founder judgment is required, and end with CLEAN or NOT CLEAN.

CLEAN closes the review cycle. NOT CLEAN creates one consolidated correction outcome. If independently valuable, it may be its own correction slice and follows the same bounded cycle. Do not resume piecemeal review tennis.

The audit advances the parent snapshot only from evidence. A reviewer's summary is not evidence by itself; verify the exact commit, files, checks, and disposition.
