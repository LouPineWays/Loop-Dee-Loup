// Tests for tools/orchestration/close-control.mjs — issue #542's deterministic, idempotent
// thin-control-Issue terminalization primitive, corrected per the Stage 1 review findings on
// PR #544 (three consolidated invariants: control/audit correspondence proven from durable
// evidence rather than trusted arguments; the canonical write-control-snapshot.mjs mutation
// path with real template-heading clearing; and safe idempotent retry across partial failure).
//
// Run with:
//   node --test tools/orchestration/close-control.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { checkCloseControl, buildTerminalControlBody, verifyControlCorrespondence } from "./close-control.mjs";

const OPEN_BODY = `- **Execution:** #486
- **Lifecycle:** AUDIT
- **Route:** implementation worker
- **PR:** #536
- **Stage 1:** satisfied at abc1234
- **Stage 2:** #538
- **Blocker:** none
- **Founder decision:** none
- **Terminal result:** none
`;

// Standard fixture: control Issue #487 (OPEN, OPEN_BODY, so its own Stage 2/Execution already
// correspond to audit #538 / work issue #486), audit Issue #538 (CLOSED). Individual tests
// override either issue's `state`/`body` via the optional overrides.
function makeGhIssueViewImpl({ controlIssue = 487, controlState = "OPEN", controlBody = OPEN_BODY, auditIssue = 538, auditState = "CLOSED" } = {}) {
  return async ({ number }) => {
    if (Number(number) === Number(auditIssue) && Number(auditIssue) !== Number(controlIssue)) {
      return { state: auditState, body: "" };
    }
    if (Number(number) === Number(controlIssue)) {
      return { state: controlState, body: controlBody };
    }
    throw new Error(`unexpected ghIssueViewImpl call for number ${number}`);
  };
}

// -- buildTerminalControlBody (pure) ----------------------------------------------------------

test("buildTerminalControlBody: rewrites every required field to a truthful terminal state, including a real work issue", () => {
  const next = buildTerminalControlBody(OPEN_BODY, { auditIssue: 538, workIssue: 486 });
  assert.match(next, /- \*\*Lifecycle:\*\* DONE/);
  assert.match(next, /- \*\*Route:\*\* none/);
  assert.match(next, /- \*\*Stage 2:\*\* #538 — CLEAN, closed/);
  assert.match(next, /- \*\*Blocker:\*\* none/);
  assert.match(next, /- \*\*Founder decision:\*\* none/);
  assert.match(next, /- \*\*Terminal result:\*\* Backed CLEAN Stage 2 audit #538 closed; work issue #486 closed;/);
  // The gated work Issue reference itself is left untouched — this primitive terminalizes the
  // thin control Issue, never the work issue's own already-recorded pointer.
  assert.match(next, /- \*\*Execution:\*\* #486/);
});

test("buildTerminalControlBody: with no work issue (ACCEPTED_NO_WORK_ISSUE shape), the Terminal result names only the audit", () => {
  const next = buildTerminalControlBody(OPEN_BODY, { auditIssue: 538, workIssue: null });
  assert.match(next, /- \*\*Terminal result:\*\* Backed CLEAN Stage 2 audit #538 closed; control terminalized/);
  assert.doesNotMatch(next, /work issue #/);
});

test("buildTerminalControlBody: the composed Stage 2 value carries exactly one parseable pointer (issue #510's #499 corruption shape must never recur)", () => {
  const next = buildTerminalControlBody(OPEN_BODY, { auditIssue: 538, workIssue: 486 });
  const stage2Line = next.split("\n").find((l) => /^- \*\*Stage 2:\*\*/.test(l));
  const refs = [...stage2Line.matchAll(/#(\d+)/g)];
  assert.equal(refs.length, 1, `expected exactly one "#N" reference in the Stage 2 bullet, got: ${stage2Line}`);
});

test("buildTerminalControlBody: also handles the shipped parent-execution template's '### State' heading shape (no ad hoc Lifecycle bullet)", () => {
  const templateBody = "### State\n\nAUDIT\n\n### Current state\n\n- **Blocker:** none\n";
  const next = buildTerminalControlBody(templateBody, { auditIssue: 538, workIssue: 486 });
  assert.match(next, /### State\n\nDONE/);
});

test("buildTerminalControlBody: also clears the template's dedicated '### Current blocker' / '### Founder interrupt' heading fields, not just an ad hoc bullet under '### Current state'", () => {
  const templateBody = [
    "### State",
    "",
    "AUDIT",
    "",
    "### Current state",
    "",
    "- **Execution:** #486",
    "",
    "### Current blocker",
    "",
    "Waiting on founder input.",
    "",
    "### Founder interrupt",
    "",
    "Pricing model TBD.",
    "",
  ].join("\n");
  const next = buildTerminalControlBody(templateBody, { auditIssue: 538, workIssue: 486 });
  const lines = next.split("\n");
  assert.equal(lines[lines.indexOf("### Current blocker") + 2], "none");
  assert.equal(lines[lines.indexOf("### Founder interrupt") + 2], "none");
  // No stray ad hoc bullets duplicating those same fields were introduced either.
  assert.ok(!lines.some((l) => /^-\s*\*\*(Blocker|Founder decision):\*\*/i.test(l)));
});

// -- verifyControlCorrespondence (pure) --------------------------------------------------------

test("verifyControlCorrespondence: ok when Stage 2 and Execution already name the exact audit/work issue supplied", () => {
  const result = verifyControlCorrespondence(OPEN_BODY, { auditIssueNumber: 538, workIssueNumber: 486 });
  assert.deepEqual(result, { ok: true });
});

test("verifyControlCorrespondence: ok with no work issue supplied at all (ACCEPTED_NO_WORK_ISSUE), regardless of the Execution field's own value", () => {
  const result = verifyControlCorrespondence(OPEN_BODY, { auditIssueNumber: 538, workIssueNumber: null });
  assert.deepEqual(result, { ok: true });
});

test("verifyControlCorrespondence: REJECTED when the control's own Stage 2 reference names a different (stale/mistyped) audit issue", () => {
  const staleBody = OPEN_BODY.replace("- **Stage 2:** #538", "- **Stage 2:** #999");
  const result = verifyControlCorrespondence(staleBody, { auditIssueNumber: 538, workIssueNumber: 486 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("#999") && e.includes("not audit #538")));
});

test("verifyControlCorrespondence: REJECTED when the control's own Stage 2 reference is missing or 'none'", () => {
  const noStage2 = OPEN_BODY.replace("- **Stage 2:** #538\n", "");
  const missing = verifyControlCorrespondence(noStage2, { auditIssueNumber: 538, workIssueNumber: 486 });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => e.includes("no")));

  const noneBody = OPEN_BODY.replace("- **Stage 2:** #538", "- **Stage 2:** none");
  const none = verifyControlCorrespondence(noneBody, { auditIssueNumber: 538, workIssueNumber: 486 });
  assert.equal(none.ok, false);
  assert.ok(none.errors.some((e) => e.includes('"none"')));
});

test("verifyControlCorrespondence: REJECTED when a real work issue is supplied but the control's Execution reference names a different work issue", () => {
  const staleExecution = OPEN_BODY.replace("- **Execution:** #486", "- **Execution:** #111");
  const result = verifyControlCorrespondence(staleExecution, { auditIssueNumber: 538, workIssueNumber: 486 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes("#111") && e.includes("not work issue #486")));
});

// -- checkCloseControl --------------------------------------------------------------------------

test("checkCloseControl: exits 1 when required args are missing", async () => {
  const result = await checkCloseControl({ repo: "owner/repo", "control-issue": 487 });
  assert.equal(result.exitCode, 1);
});

test("checkCloseControl: exits 1 when gh issue view fails for the control issue", async () => {
  const result = await checkCloseControl(
    { repo: "owner/repo", "control-issue": 487, "audit-issue": 538 },
    { ghIssueViewImpl: async () => { throw new Error("not found"); } },
  );
  assert.equal(result.exitCode, 1);
});

test("checkCloseControl: ALREADY_TERMINAL — a safe no-op on a control Issue already closed, no correspondence/audit/edit/close/comment check attempted (idempotent rerun)", async () => {
  const result = await checkCloseControl(
    { repo: "owner/repo", "control-issue": 487, "audit-issue": 538, "work-issue": 486 },
    {
      ghIssueViewImpl: async () => ({ state: "CLOSED", body: OPEN_BODY }),
      ghEditImpl: () => assert.fail("must not re-edit an already-closed control Issue"),
      ghCloseImpl: async () => assert.fail("must not re-close an already-closed control Issue"),
      ghCommentImpl: async () => assert.fail("must not re-comment on an already-closed control Issue"),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "ALREADY_TERMINAL");
  assert.equal(result.controlIssue, 487);
});

test("checkCloseControl: CLOSED — an open control Issue whose own Stage 2/Execution already correspond, and whose named audit is closed, is rewritten to a terminal body, closed, and commented on, in that order", async () => {
  const calls = [];
  const result = await checkCloseControl(
    { repo: "owner/repo", "control-issue": 487, "audit-issue": 538, "work-issue": 486 },
    {
      ghIssueViewImpl: makeGhIssueViewImpl(),
      ghEditImpl: (a) => calls.push({ step: "edit", ...a }),
      ghCloseImpl: async (a) => calls.push({ step: "close", ...a }),
      ghCommentImpl: async (a) => calls.push({ step: "comment", ...a }),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "CLOSED");
  assert.equal(result.controlIssue, 487);
  assert.equal(result.auditIssue, 538);
  assert.equal(result.workIssue, 486);
  assert.deepEqual(calls.map((c) => c.step), ["edit", "close", "comment"], "body must be written before the Issue is closed (requirement 5: never one without the other)");
  assert.match(calls[0].body, /- \*\*Lifecycle:\*\* DONE/);
  assert.equal(calls[1].controlIssue, 487);
  assert.match(calls[2].body, /Terminalized by `tools\/orchestration\/close-control\.mjs`/);
  assert.match(calls[2].body, /issue #542/);
});

test("checkCloseControl: REJECTED — a control body whose Stage 2 reference names a different (unrelated) audit issue than --audit-issue is refused before any mutation, even though that unrelated audit is genuinely closed with CLEAN evidence", async () => {
  const staleBody = OPEN_BODY.replace("- **Stage 2:** #538", "- **Stage 2:** #999");
  let editAttempted = false;
  const result = await checkCloseControl(
    { repo: "owner/repo", "control-issue": 487, "audit-issue": 538, "work-issue": 486 },
    {
      ghIssueViewImpl: makeGhIssueViewImpl({ controlBody: staleBody }),
      ghEditImpl: () => { editAttempted = true; },
      ghCloseImpl: async () => assert.fail("must not close on a rejected correspondence check"),
      ghCommentImpl: async () => assert.fail("must not comment on a rejected correspondence check"),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "REJECTED");
  assert.ok(result.errors.some((e) => e.includes("#999")));
  assert.equal(editAttempted, false, "an unrelated audit's evidence must never reach the write implementation");
});

test("checkCloseControl: REJECTED — close-audit's own nonterminal (still-open) result must never authorize control mutation, even though the control's own Stage 2/Execution already correspond", async () => {
  let editAttempted = false;
  const result = await checkCloseControl(
    { repo: "owner/repo", "control-issue": 487, "audit-issue": 538, "work-issue": 486 },
    {
      ghIssueViewImpl: makeGhIssueViewImpl({ auditState: "OPEN" }),
      ghEditImpl: () => { editAttempted = true; },
      ghCloseImpl: async () => assert.fail("must not close the control while the audit itself is still open"),
      ghCommentImpl: async () => assert.fail("must not comment while the audit itself is still open"),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "REJECTED");
  assert.ok(result.errors.some((e) => e.includes("538") && e.includes("not closed")));
  assert.equal(editAttempted, false);
});

test("checkCloseControl: REJECTED — a pre-existing corrupted parser-sensitive field (e.g. a two-pointer PR bullet) is refused before any mutation is attempted, once correspondence and audit-closed checks already pass", async () => {
  const corruptBody = OPEN_BODY.replace("- **PR:** #536", "- **PR:** #536 (see also predecessor #535)");
  const result = await checkCloseControl(
    { repo: "owner/repo", "control-issue": 487, "audit-issue": 538, "work-issue": 486 },
    {
      ghIssueViewImpl: makeGhIssueViewImpl({ controlBody: corruptBody }),
      ghEditImpl: () => assert.fail("an invalid composed body must never reach the write implementation"),
      ghCloseImpl: async () => assert.fail("must not close on a rejected write"),
      ghCommentImpl: async () => assert.fail("must not comment on a rejected write"),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "REJECTED");
  assert.ok(result.errors.length > 0);
});

test("checkCloseControl: a gh issue edit failure is an operational error; the Issue is never closed on an unwritten body", async () => {
  const result = await checkCloseControl(
    { repo: "owner/repo", "control-issue": 487, "audit-issue": 538, "work-issue": 486 },
    {
      ghIssueViewImpl: makeGhIssueViewImpl(),
      ghEditImpl: () => { throw new Error("gh: network error"); },
      ghCloseImpl: async () => assert.fail("must not close before the body write succeeded"),
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /gh issue edit failed/);
});

test("checkCloseControl: a gh issue close failure after a successful body write is an operational error naming the already-terminal body", async () => {
  const result = await checkCloseControl(
    { repo: "owner/repo", "control-issue": 487, "audit-issue": 538, "work-issue": 486 },
    {
      ghIssueViewImpl: makeGhIssueViewImpl(),
      ghEditImpl: () => {},
      ghCloseImpl: async () => { throw new Error("gh: transient error"); },
      ghCommentImpl: async () => assert.fail("must not comment before the close succeeded"),
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /gh issue close failed/);
});

test("checkCloseControl: idempotent recovery — retrying the exact same command after a close failure converges to CLOSED with the comment posted exactly once, never a stranded OPEN + DONE control", async () => {
  const editCalls = [];
  let terminalBody = null;
  let closeAttempts = 0;
  const commentCalls = [];

  const ghEditImpl = (a) => {
    editCalls.push(a);
    terminalBody = a.body;
  };
  const ghCloseImpl = async () => {
    closeAttempts += 1;
    if (closeAttempts === 1) throw new Error("gh: transient network error");
    // second attempt succeeds
  };
  const ghCommentImpl = async (a) => commentCalls.push(a);

  const args = { repo: "owner/repo", "control-issue": 487, "audit-issue": 538, "work-issue": 486 };

  // First attempt: body write succeeds, close fails -- reads the pre-terminal OPEN_BODY.
  const first = await checkCloseControl(args, {
    ghIssueViewImpl: makeGhIssueViewImpl(),
    ghEditImpl,
    ghCloseImpl,
    ghCommentImpl,
  });
  assert.equal(first.exitCode, 1);
  assert.match(first.message, /gh issue close failed/);
  assert.ok(terminalBody, "the body must have been rewritten to terminal shape before the close attempt");

  // Simulate the durable state after the partial failure: the control Issue is still OPEN on
  // GitHub, but its body already reads the terminal shape written by the first attempt.
  const retry = await checkCloseControl(args, {
    ghIssueViewImpl: makeGhIssueViewImpl({ controlBody: terminalBody }),
    ghEditImpl,
    ghCloseImpl,
    ghCommentImpl,
  });

  assert.equal(retry.exitCode, 0);
  assert.equal(retry.state, "CLOSED");
  assert.equal(closeAttempts, 2, "the close step must actually be retried, not silently skipped");
  assert.equal(commentCalls.length, 1, "the explanation comment must be posted exactly once across both attempts, never duplicated");
  assert.equal(editCalls.length, 2, "re-composing an already-terminal body on retry is a safe idempotent no-op write");
  // The re-composed body on retry is unchanged in its terminal fields (idempotent).
  assert.match(editCalls[1].body, /- \*\*Lifecycle:\*\* DONE/);
  assert.match(editCalls[1].body, /- \*\*Stage 2:\*\* #538 — CLEAN, closed/);
});

test("checkCloseControl: a comment-post failure after a successful close still reports CLOSED (never a failed exit), naming the comment failure", async () => {
  const result = await checkCloseControl(
    { repo: "owner/repo", "control-issue": 487, "audit-issue": 538, "work-issue": 486 },
    {
      ghIssueViewImpl: makeGhIssueViewImpl(),
      ghEditImpl: () => {},
      ghCloseImpl: async () => {},
      ghCommentImpl: async () => { throw new Error("transient network error"); },
    },
  );
  assert.equal(result.exitCode, 0, "the Issue is genuinely terminalized and closed; this must not be reported as a blocked failure");
  assert.equal(result.state, "CLOSED");
  assert.equal(result.commentPosted, false);
  assert.match(result.message, /could not post the durable explanation comment/);
});

test("checkCloseControl: ACCEPTED_NO_WORK_ISSUE shape (no --work-issue) still terminalizes and closes correctly, regardless of the control's own pre-existing Execution reference", async () => {
  const calls = [];
  const result = await checkCloseControl(
    { repo: "owner/repo", "control-issue": 487, "audit-issue": 538 },
    {
      ghIssueViewImpl: makeGhIssueViewImpl(),
      ghEditImpl: (a) => calls.push(a),
      ghCloseImpl: async () => {},
      ghCommentImpl: async () => {},
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.workIssue, null);
  assert.doesNotMatch(calls[0].body, /work issue #/);
});
