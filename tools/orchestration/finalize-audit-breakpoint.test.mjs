// Tests for tools/orchestration/finalize-audit-breakpoint.mjs — issue #561's deterministic
// AUDIT breakpoint finalize step, closing the live #559/#445/PR #558 reviewer-trigger race.
//
// Run with:
//   node --test tools/orchestration/finalize-audit-breakpoint.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  run,
  verifyExecutionMatchesAudit,
  verifyControlPrMatches,
  verifyPrMerged,
  verifyAuditIssueMatches,
  composeAuditFinalizedControlBody,
  verifyAuditFinalizedBody,
} from "./finalize-audit-breakpoint.mjs";

const REVIEW_BODY = `## Current state

- **Lifecycle:** REVIEW
- **Execution:** #440
- **Route:** implementation worker
- **PR:** #558
- **Stage 1:** satisfied at abc1234
- **Stage 2:** none
- **Blocker:** none
- **Founder decision:** none
`;

const REVIEW_BODY_NO_WORK_ISSUE = `## Current state

- **Lifecycle:** REVIEW
- **Execution:** none
- **Route:** implementation worker
- **PR:** #558
- **Stage 1:** satisfied at abc1234
- **Stage 2:** none
- **Blocker:** none
- **Founder decision:** none
`;

const ALREADY_AUDIT_BODY = `## Current state

- **Lifecycle:** AUDIT
- **Execution:** #440
- **Route:** implementation worker
- **PR:** #558
- **Stage 1:** satisfied at abc1234
- **Stage 2:** #559
- **Blocker:** none
- **Founder decision:** none
`;

// Issue #585 (live blocker hit finalizing control #582): a template-shaped body
// (`.github/ISSUE_TEMPLATE/parent-execution.yml`) carries no ad hoc "- **Lifecycle:**" bullet
// at all — its lifecycle lives only in the canonical "### State" heading. PR #583's own
// updated field guidance now actively tells new intake not to add a redundant Lifecycle
// bullet, so this shape is the expected one going forward, not a rare edge case.
const REVIEW_BODY_TEMPLATE_STATE_HEADING = `### State

REVIEW

### Current state

- **Execution:** #440
- **Route:** implementation worker
- **PR:** #558
- **Stage 1:** requested
- **Stage 2:** none
`;

const MERGED_PR_VIEW = { state: "MERGED", mergeCommit: { oid: "d34db33fd34db33fd34db33fd34db33fd34db33f" } };

const MATCHING_AUDIT_VIEW = {
  state: "OPEN",
  body: [
    "### Work issue",
    "",
    "#440",
    "",
    "### Exact merge commit",
    "",
    "`d34db33fd34db33fd34db33fd34db33fd34db33f`",
    "",
  ].join("\n"),
};

const MATCHING_AUDIT_VIEW_NO_WORK_ISSUE = {
  state: "OPEN",
  body: [
    "### Work issue",
    "",
    "none",
    "",
    "### Exact merge commit",
    "",
    "`d34db33fd34db33fd34db33fd34db33fd34db33f`",
    "",
  ].join("\n"),
};

function fixedGhIssueView(body) {
  return async () => body;
}

// -- Pure helpers --------------------------------------------------------------------------

test("verifyExecutionMatchesAudit: accepts a matching Execution pointer", () => {
  assert.equal(verifyExecutionMatchesAudit(REVIEW_BODY, 440).ok, true);
});

test("verifyExecutionMatchesAudit: rejects a mismatched Execution pointer", () => {
  const result = verifyExecutionMatchesAudit(REVIEW_BODY, 999);
  assert.equal(result.ok, false);
  assert.match(result.reason, /names #440, not the given --execution-issue #999/);
});

test('verifyExecutionMatchesAudit: accepts "none" execution-issue against a body with no Execution pointer', () => {
  assert.equal(verifyExecutionMatchesAudit(REVIEW_BODY_NO_WORK_ISSUE, "none").ok, true);
});

test('verifyExecutionMatchesAudit: rejects "none" execution-issue against a body naming a real Execution pointer', () => {
  const result = verifyExecutionMatchesAudit(REVIEW_BODY, "none");
  assert.equal(result.ok, false);
  assert.match(result.reason, /--execution-issue was given as "none"/);
});

test("verifyControlPrMatches: accepts a matching PR pointer, rejects a mismatch", () => {
  assert.equal(verifyControlPrMatches(REVIEW_BODY, 558).ok, true);
  const result = verifyControlPrMatches(REVIEW_BODY, 999);
  assert.equal(result.ok, false);
  assert.match(result.reason, /names #558, not the given --pr #999/);
});

test("verifyPrMerged: accepts a genuinely MERGED PR with a merge commit", () => {
  const result = verifyPrMerged(MERGED_PR_VIEW);
  assert.equal(result.ok, true);
  assert.equal(result.mergeCommitOid, MERGED_PR_VIEW.mergeCommit.oid);
});

test("verifyPrMerged: rejects an OPEN PR — the #559 race's own ordering invariant 1", () => {
  const result = verifyPrMerged({ state: "OPEN" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /is "OPEN", not "MERGED"/);
});

test("verifyPrMerged: rejects a MERGED PR carrying no mergeCommit.oid", () => {
  const result = verifyPrMerged({ state: "MERGED" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /carries no mergeCommit\.oid/);
});

test("verifyAuditIssueMatches: accepts a matching, OPEN audit issue", () => {
  const result = verifyAuditIssueMatches(MATCHING_AUDIT_VIEW, {
    mergeCommitOid: MERGED_PR_VIEW.mergeCommit.oid,
    executionIssue: 440,
  });
  assert.equal(result.ok, true);
});

test("verifyAuditIssueMatches: accepts the explicit no-work-issue shape", () => {
  const result = verifyAuditIssueMatches(MATCHING_AUDIT_VIEW_NO_WORK_ISSUE, {
    mergeCommitOid: MERGED_PR_VIEW.mergeCommit.oid,
    executionIssue: "none",
  });
  assert.equal(result.ok, true);
});

test("verifyAuditIssueMatches: rejects a closed audit issue", () => {
  const result = verifyAuditIssueMatches(
    { ...MATCHING_AUDIT_VIEW, state: "CLOSED" },
    { mergeCommitOid: MERGED_PR_VIEW.mergeCommit.oid, executionIssue: 440 },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /is "CLOSED", not "OPEN"/);
});

test("verifyAuditIssueMatches: rejects a merge-commit mismatch — never project onto the wrong audit issue's evidence", () => {
  const result = verifyAuditIssueMatches(MATCHING_AUDIT_VIEW, { mergeCommitOid: "cafef00dcafef00dcafef00dcafef00dcafef00d", executionIssue: 440 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /"Exact merge commit" field/);
});

test("verifyAuditIssueMatches: rejects a work-issue mismatch", () => {
  const result = verifyAuditIssueMatches(MATCHING_AUDIT_VIEW, { mergeCommitOid: MERGED_PR_VIEW.mergeCommit.oid, executionIssue: 999 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /"Work issue" field/);
});

test("composeAuditFinalizedControlBody / verifyAuditFinalizedBody round-trip", () => {
  const composed = composeAuditFinalizedControlBody(REVIEW_BODY, { auditIssue: 559, executionIssue: 440, pr: 558 });
  assert.equal(composed.ok, true);
  assert.match(composed.body, /- \*\*Stage 2:\*\* #559/);
  assert.match(composed.body, /- \*\*Lifecycle:\*\* AUDIT/);
  assert.equal(verifyAuditFinalizedBody(composed.body, { auditIssue: 559 }).ok, true);
  assert.equal(verifyAuditFinalizedBody(REVIEW_BODY, { auditIssue: 559 }).ok, false);
});

test("composeAuditFinalizedControlBody: issue #585 — resolves Lifecycle via the canonical '### State' heading fallback when no ad hoc Lifecycle bullet exists", () => {
  const composed = composeAuditFinalizedControlBody(REVIEW_BODY_TEMPLATE_STATE_HEADING, {
    auditIssue: 559,
    executionIssue: 440,
    pr: 558,
  });
  assert.equal(composed.ok, true);
  assert.match(composed.body, /- \*\*Stage 2:\*\* #559/);
  assert.match(composed.body, /### State\s*\n\s*AUDIT/);
  assert.equal(verifyAuditFinalizedBody(composed.body, { auditIssue: 559 }).ok, true);
});

test("composeAuditFinalizedControlBody: re-checks Lifecycle against the given body, not just its caller's earlier check — rejects a concurrently BLOCKED control Issue", () => {
  const blockedBody = REVIEW_BODY.replace("Lifecycle:** REVIEW", "Lifecycle:** BLOCKED");
  const result = composeAuditFinalizedControlBody(blockedBody, { auditIssue: 559, executionIssue: 440, pr: 558 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /pre-write re-check:.*not one of the recognized/);
});

test("composeAuditFinalizedControlBody: re-checks the Execution pointer against the given body — rejects a concurrently changed pointer", () => {
  const changedBody = REVIEW_BODY.replace("Execution:** #440", "Execution:** #999");
  const result = composeAuditFinalizedControlBody(changedBody, { auditIssue: 559, executionIssue: 440, pr: 558 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /pre-write re-check:.*names #999, not the given --execution-issue #440/);
});

test("composeAuditFinalizedControlBody: re-checks the PR pointer against the given body — rejects a concurrently changed pointer", () => {
  const changedBody = REVIEW_BODY.replace("PR:** #558", "PR:** #777");
  const result = composeAuditFinalizedControlBody(changedBody, { auditIssue: 559, executionIssue: 440, pr: 558 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /pre-write re-check:.*names #777, not the given --pr #558/);
});

test("composeAuditFinalizedControlBody: already-AUDIT body with a different recorded Stage 2 pointer is refused, not overwritten", () => {
  const differentAuditBody = ALREADY_AUDIT_BODY.replace("Stage 2:** #559", "Stage 2:** #12345");
  const result = composeAuditFinalizedControlBody(differentAuditBody, { auditIssue: 559, executionIssue: 440, pr: 558 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /already Lifecycle: AUDIT but its Stage 2 pointer is "#12345"/);
});

test("composeAuditFinalizedControlBody: already-AUDIT body with the matching Stage 2 pointer is accepted (idempotent rerun)", () => {
  const result = composeAuditFinalizedControlBody(ALREADY_AUDIT_BODY, { auditIssue: 559, executionIssue: 440, pr: 558 });
  assert.equal(result.ok, true);
  assert.match(result.body, /- \*\*Stage 2:\*\* #559/);
});

// -- run(): end-to-end -----------------------------------------------------------------

test("run(): the happy path — merged PR, matching audit issue, write verified -> FINALIZED", async () => {
  let bodies = [REVIEW_BODY, REVIEW_BODY]; // pre-write read, pre-write re-read
  let writtenBody = null;
  const result = await run(
    { repo: "o/r", controlIssue: 445, executionIssue: 440, pr: 558, auditIssue: 559 },
    {
      ghIssueViewImpl: async () => {
        if (writtenBody !== null) return writtenBody; // post-write read-back
        return bodies.length > 1 ? bodies.shift() : bodies[0];
      },
      ghPrViewImpl: async ({ pr }) => {
        assert.equal(pr, 558);
        return MERGED_PR_VIEW;
      },
      ghAuditIssueViewImpl: async ({ auditIssue }) => {
        assert.equal(auditIssue, 559);
        return MATCHING_AUDIT_VIEW;
      },
      writeControlSnapshotImpl: async ({ controlIssue, proposedBody }) => {
        assert.equal(controlIssue, 445);
        writtenBody = proposedBody;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "FINALIZED");
  assert.equal(result.message, "FINALIZED 445 558 559");
});

test("run(): issue #585 — a template State-heading-only control body (no ad hoc Lifecycle bullet at all) still finalizes to AUDIT, not AUDIT_BREAKPOINT_UNVERIFIED", async () => {
  let controlBody = REVIEW_BODY_TEMPLATE_STATE_HEADING;
  const result = await run(
    { repo: "o/r", controlIssue: 445, executionIssue: 440, pr: 558, auditIssue: 559 },
    {
      ghIssueViewImpl: async () => controlBody,
      ghPrViewImpl: async () => MERGED_PR_VIEW,
      ghAuditIssueViewImpl: async () => MATCHING_AUDIT_VIEW,
      writeControlSnapshotImpl: async ({ proposedBody }) => {
        controlBody = proposedBody;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "FINALIZED");
  // upsertControlBullet's own hybrid-write convergence (PR #583) writes AUDIT onto the
  // canonical "### State" heading here, since no ad hoc bullet exists to update instead.
  assert.match(controlBody, /### State\s*\n\s*AUDIT/);
  assert.match(controlBody, /- \*\*Stage 2:\*\* #559/);
});

test("run(): the #559/#445/PR #558 race shape — Audit Issue created but control still REVIEW, then a fresh session finalizes before any trigger is authorized", async () => {
  // Reproduces the live incident precondition: PR merged, Audit Issue #559 already exists,
  // control Issue #445 still durably reads Lifecycle: REVIEW / Stage 2: none. This script
  // must accept exactly that starting state and converge it to AUDIT — proving a controller
  // that runs this *before* trigger.mjs never lets an auditor observe stale REVIEW state.
  let controlBody = REVIEW_BODY;
  const result = await run(
    { repo: "o/r", controlIssue: 445, executionIssue: 440, pr: 558, auditIssue: 559 },
    {
      ghIssueViewImpl: async () => controlBody,
      ghPrViewImpl: async () => MERGED_PR_VIEW,
      ghAuditIssueViewImpl: async () => MATCHING_AUDIT_VIEW,
      writeControlSnapshotImpl: async ({ proposedBody }) => {
        controlBody = proposedBody;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.state, "FINALIZED");
  assert.match(controlBody, /- \*\*Lifecycle:\*\* AUDIT/);
  assert.match(controlBody, /- \*\*Stage 2:\*\* #559/);
});

test("run(): PR not yet merged -> AUDIT_BREAKPOINT_UNVERIFIED, never reaches write-control-snapshot", async () => {
  let writeAttempted = false;
  const result = await run(
    { repo: "o/r", controlIssue: 445, executionIssue: 440, pr: 558, auditIssue: 559 },
    {
      ghIssueViewImpl: async () => REVIEW_BODY,
      ghPrViewImpl: async () => ({ state: "OPEN" }),
      ghAuditIssueViewImpl: async () => MATCHING_AUDIT_VIEW,
      writeControlSnapshotImpl: async () => {
        writeAttempted = true;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "AUDIT_BREAKPOINT_UNVERIFIED");
  assert.equal(writeAttempted, false, "must never write the control snapshot before the PR is confirmed merged");
});

test("run(): audit issue evidence mismatch -> AUDIT_BREAKPOINT_UNVERIFIED, never reaches write-control-snapshot", async () => {
  let writeAttempted = false;
  const result = await run(
    { repo: "o/r", controlIssue: 445, executionIssue: 440, pr: 558, auditIssue: 559 },
    {
      ghIssueViewImpl: async () => REVIEW_BODY,
      ghPrViewImpl: async () => MERGED_PR_VIEW,
      ghAuditIssueViewImpl: async () => ({ state: "OPEN", body: "### Work issue\n\n#999\n" }),
      writeControlSnapshotImpl: async () => {
        writeAttempted = true;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.state, "AUDIT_BREAKPOINT_UNVERIFIED");
  assert.equal(writeAttempted, false);
});

test("run(): write-control-snapshot.mjs rejection -> AUDIT_BREAKPOINT_UNVERIFIED", async () => {
  const result = await run(
    { repo: "o/r", controlIssue: 445, executionIssue: 440, pr: 558, auditIssue: 559 },
    {
      ghIssueViewImpl: async () => REVIEW_BODY,
      ghPrViewImpl: async () => MERGED_PR_VIEW,
      ghAuditIssueViewImpl: async () => MATCHING_AUDIT_VIEW,
      writeControlSnapshotImpl: async () => ({ exitCode: 2, state: "REJECTED", errors: ["boom"] }),
    },
  );
  assert.equal(result.state, "AUDIT_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /did not report WRITTEN/);
});

test("run(): write succeeds but read-back does not show the expected bullets -> AUDIT_BREAKPOINT_UNVERIFIED (the actual verification, not the write call's own return value)", async () => {
  const result = await run(
    { repo: "o/r", controlIssue: 445, executionIssue: 440, pr: 558, auditIssue: 559 },
    {
      ghIssueViewImpl: fixedGhIssueView(REVIEW_BODY), // read-back never reflects the write
      ghPrViewImpl: async () => MERGED_PR_VIEW,
      ghAuditIssueViewImpl: async () => MATCHING_AUDIT_VIEW,
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.state, "AUDIT_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /read-back's/);
});

test("run(): a control Issue whose current Lifecycle is neither REVIEW nor AUDIT fails closed", async () => {
  const result = await run(
    { repo: "o/r", controlIssue: 445, executionIssue: 440, pr: 558, auditIssue: 559 },
    {
      ghIssueViewImpl: async () => REVIEW_BODY.replace("Lifecycle:** REVIEW", "Lifecycle:** CORRECTION"),
      ghPrViewImpl: async () => MERGED_PR_VIEW,
      ghAuditIssueViewImpl: async () => MATCHING_AUDIT_VIEW,
      writeControlSnapshotImpl: async () => ({ exitCode: 0, state: "WRITTEN" }),
    },
  );
  assert.equal(result.state, "AUDIT_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /not one of the recognized/);
});

test("run(): a concurrent Lifecycle change landing between the initial read and the pre-write re-read is refused, not clobbered — Stage 1 review finding (P1) on PR #562", async () => {
  // The initial `ghIssueViewImpl` call (used for the up-front authority checks) still returns
  // REVIEW; the second call — the pre-write re-read — returns a body a concurrent controller
  // has since moved to BLOCKED. Without re-validating against the fresher body, `run()` would
  // otherwise still write Lifecycle: AUDIT over top of that newer BLOCKED state.
  let calls = 0;
  let writeAttempted = false;
  const result = await run(
    { repo: "o/r", controlIssue: 445, executionIssue: 440, pr: 558, auditIssue: 559 },
    {
      ghIssueViewImpl: async () => {
        calls += 1;
        return calls === 1 ? REVIEW_BODY : REVIEW_BODY.replace("Lifecycle:** REVIEW", "Lifecycle:** BLOCKED");
      },
      ghPrViewImpl: async () => MERGED_PR_VIEW,
      ghAuditIssueViewImpl: async () => MATCHING_AUDIT_VIEW,
      writeControlSnapshotImpl: async () => {
        writeAttempted = true;
        return { exitCode: 0, state: "WRITTEN" };
      },
    },
  );
  assert.equal(result.state, "AUDIT_BREAKPOINT_UNVERIFIED");
  assert.match(result.reason, /pre-write re-check:.*not one of the recognized/);
  assert.equal(writeAttempted, false, "must never write once the pre-write re-check finds a concurrently changed Lifecycle");
});

test("run(): already-AUDIT control Issue with a matching Stage 2 bullet is a safe idempotent no-op success", async () => {
  const result = await run(
    { repo: "o/r", controlIssue: 445, executionIssue: 440, pr: 558, auditIssue: 559 },
    {
      ghIssueViewImpl: async () => ALREADY_AUDIT_BODY,
      ghPrViewImpl: async () => MERGED_PR_VIEW,
      ghAuditIssueViewImpl: async () => MATCHING_AUDIT_VIEW,
      writeControlSnapshotImpl: async ({ proposedBody }) => ({ exitCode: 0, state: "WRITTEN", proposedBody }),
    },
  );
  assert.equal(result.state, "FINALIZED");
});

test("run(): rejects missing/invalid required args without ever calling gh", async () => {
  const result = await run(
    { repo: "o/r", controlIssue: null, executionIssue: 440, pr: 558, auditIssue: 559 },
    {
      ghIssueViewImpl: async () => {
        throw new Error("must not be called");
      },
    },
  );
  assert.equal(result.exitCode, 1);
});

test('run(): rejects an --execution-issue that is neither a positive integer nor "none"', async () => {
  const result = await run(
    { repo: "o/r", controlIssue: 445, executionIssue: "bogus", pr: 558, auditIssue: 559 },
    {
      ghIssueViewImpl: async () => {
        throw new Error("must not be called");
      },
    },
  );
  assert.equal(result.exitCode, 1);
});
