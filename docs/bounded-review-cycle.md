# Bounded review and acceptance-audit cycle

The target repository's stricter review rules control. When it has no stricter rule and a slice is review-worthy, use this bounded cycle. One inline round is a bound on reviewer invocations, not permission to merge a known defect.

## Entry check

Before review, verify the complete slice against its acceptance criteria and controlling authority. For code, check interacting requirements, existing invariants, generalize beyond the reported symptom, and use a fast local harness when repeated external verification would be expensive. For design or architecture, define a fixed rubric, list explicit deferrals and tensions, and self-review the entire current document rather than isolated edits.

Do not attach this cycle to trivial work merely because the mechanism exists. Preserve any target-repository rule that mandates review for a category of change.

Within Loop-Dee-Loup's own repository, a PR that touches a control-plane path — any root-level `*.md` file (currently `AGENTS.md`, `CLAUDE.md`, `README.md`), any `docs/*.md`, `.github/ISSUE_TEMPLATE/*`, `.github/workflows/*.yml`, anything under `.claude/**` (session skills, launch configuration, settings — the whole directory, not an enumerated subset), `tools/burn-order/**` including `docs/burn-order.json`, `tools/local-worker/**` (the executable substrate the `local-worker` operational skill dispatches through), `tools/review-watch/**` (the executable substrate this doc's Stage 1 and Stage 2 review-watching steps dispatch through), `tools/ldl-init/**` (the deterministic bootstrap mechanism that installs this repository's reusable machinery into a consumer repository, per `docs/consumer-contract.md`), or `tools/ldl-update/**` (the conflict-safe mechanism that moves an already-initialized consumer repository to a newer Loop-Dee-Loup revision, per `docs/consumer-contract.md`) — is never trivial for this test, regardless of diff size. These paths govern the Loop's own rules, CI gates, session skills, backlog state, and audit machinery; a one-line error in them (a stale `done.ref`, a disabled integrity check, a loosened rule) corrupts control state silently instead of failing loudly. Such a PR always gets the full cycle: Stage 1 inline review and, once merged, its own Stage 2 issue audit, matching the `audit-control-issue` template's one-PR, one-merge-commit fields — never both stages skipped, never merged clean-by-assumption without either, and never two merges sharing one Stage 2 issue.

`node tools/check-control-plane-paths.mjs` (wired into CI as the `control-plane-paths` workflow) deterministically verifies every path already listed above still resolves against the repository, guarding against the exact silent drift found by three consecutive Stage 2 audits (issues #37, #39, #41). It cannot decide whether a brand-new top-level location belongs on this list — that remains a judgment call for whoever adds it.

## Stage 1: one inline PR review round

1. Complete the slice and required local checks.
2. Freeze and record the PR head SHA.
3. Request exactly one independent inline review at that head by posting a PR comment containing `@codex review` — the same trigger mechanism as Stage 2. Check first whether it was already requested at this head. Use `node tools/review-watch/trigger.mjs --repo <owner/repo> --kind pr --number <pr> --head <head-sha>` to perform this check-then-post step deterministically rather than hand-running `gh` reads and dedup logic — it is idempotent (scoped to the given `--head`, so a stale trigger from an older head never suppresses a genuine one at the current head) and prints the trigger's bare ISO timestamp on stdout, ready to feed straight into the `poll.mjs --since` step below. If a prior trigger produced no genuine Codex response (no reply, or BLOCKED), pass `--force true` to post a fresh retry rather than treating the stale trigger as satisfied. Never use a different reviewer tool or mechanism (e.g. GitHub's own Copilot-review request) as a substitute or supplement — that is not the documented reviewer and its silence or delay does not license falling back to one. Duplicate `@codex review` invocations at the same head are parallel opinions in one round, not new rounds.
4. Require complete-change inspection, actionable defects only, and separation of defects from scope expansion, preference, deliberate deferral, or superseded material.
5. Verify every finding. Reject false positives with a recorded reason and deduplicate valid findings by root cause.
6. Batch all valid findings into one consolidated correction pass and rerun required checks.
7. Do not request a second inline review on that PR.
8. Merge only if every valid finding is fixed, required checks and CI pass, the reviewed scope, head, and target are reverified, and no Critical defect, founder decision, security/privacy issue, data-loss risk, migration uncertainty, or other blocker remains.

Multiple comments produced by one invocation are one round. Fix commits are not another round. A second invocation is another round and is prohibited by default.

Once Stage 1 has been requested, the PR body is the durable checkpoint. Make it self-sufficient, run `spend` first if the completed session is worth measuring, and clear or hand off rather than keeping an implementation-heavy session alive through review latency. Use PR event delivery when available; do not pair it with long fallback timers that merely preserve context. When no PR event delivery is available and a disposable worker must poll instead, use `node tools/review-watch/poll.mjs --repo <owner/repo> --kind pr --number <pr> --since <trigger-time>` rather than a hand-rolled loop, for the same early-exit-on-match reason given in Stage 2 step 6.

## Stage 2: one post-merge issue audit

1. Record the exact merge commit on the target branch, not merely the PR head.
2. Start the audit from a fresh independent context. Open one control issue containing the complete read-only audit specification, using the `audit-control-issue` issue template, filling in its verification-checklist field with a numbered, change-specific list of checks derived from the actual diff and acceptance criteria — not generic prose. Never reuse an existing non-audit issue — the original feature or slice issue, a decision form, or any other control issue, closed or open — as the Stage 2 control boundary. A prior invocation on the wrong issue is not a completed audit; open the fresh `audit-control-issue` regardless.
3. Verify the created issue body by direct read. It must survive transport intact and name the exact commit.
4. Check whether an invocation already exists, then post one separate issue comment containing `@codex review` to trigger the reviewer — never any other reviewer tool or mechanism. Use `node tools/review-watch/trigger.mjs --repo <owner/repo> --kind issue --number <issue>` to perform this check-then-post step deterministically, the same script used for the Stage 1 trigger above (omit `--head`; a fresh audit issue is opened per merge commit per step 2, so the whole thread already corresponds to one commit); it prints the trigger's bare ISO timestamp on stdout for the bounded follow-up in step 6. Per step 10 below, a prior trigger that produced no genuine response stays PENDING — pass `--force true` to post the retry rather than treating the stale trigger as satisfied. An invocation in the issue body is specification only and does not reliably start Codex. Never invoke from both places.
5. Treat posting the trigger and arranging its bounded follow-up as one atomic action. Issue audit responses are not covered by PR-only subscriptions.
6. Keep the controlling session lean. Delegate the trigger, wait, and response extraction to one disposable worker or successor context when available. That worker must wait with `node tools/review-watch/poll.mjs --repo <owner/repo> --kind issue --number <issue> --since <trigger-time>` (see the script's header comment for full usage) rather than a hand-rolled polling loop — the script exits the instant a genuine post-trigger Codex response appears, instead of only after a fixed timeout window, so a `run_in_background` invocation's completion notification fires at match time. This is a structural fix for the defect in issue #53, where a hand-rolled loop kept re-confirming an already-captured response for 11 minutes because it had no early-exit-on-match logic and nothing ever read its output. The worker reads the matched response in its own context and returns only the verdict, severity counts, and finding text required for action. Do not load the full audit transcript, verification-command list, or evidence prose into the orchestrator merely to learn whether Codex replied. The moment that worker extracts the verdict, it must call a push-notification tool with the terse CLEAN/NOT CLEAN line, independent of whether the controlling session is still live — issue-comment audit replies have no event/webhook delivery, and the controlling session is expected to have already cleared per `AGENTS.md`'s Context-cost boundaries, so a chat message alone is not a reliable notification path.
7. Audit the exact merged commit and complete current files, applicable instructions, source-of-truth hierarchy, merged PR, and its single inline review.
8. Verify every valid inline finding's disposition and search for cross-file contradictions, regressions, missing transitions, authority conflicts, unhandled boundaries, and traps exposed by the consolidated fix.
9. Deduplicate by root cause. Report in the template's required structure: a severity table, one entry per finding with exact evidence, consequence, and smallest correction, a verification-performed checklist working through every item in the control issue's verification checklist with its result, whether founder judgment is required, and an explicit CLEAN or NOT CLEAN verdict. Modify nothing.
10. Never record a CLEAN or NOT CLEAN verdict without an actual audit response comment behind it. If Codex does not respond, replies BLOCKED, or the trigger otherwise fails, the verdict stays PENDING — that is a blocker to retry, re-trigger, or escalate to the founder, not license for the controlling session or extracting worker to self-declare a verdict from its own read of the diff.

A report that nothing material remains is a successful audit. State anything the environment could not verify instead of implying it passed. PENDING is not a verdict: an audit issue with no genuine Codex response is an unfinished audit, not a clean one.

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
