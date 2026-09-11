// Tests for tools/orchestration/close-control.mjs — issue #542's deterministic, idempotent
// thin-control-Issue terminalization primitive.
//
// Run with:
//   node --test tools/orchestration/close-control.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { checkCloseControl, buildTerminalControlBody } from "./close-control.mjs";

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

// -- checkCloseControl --------------------------------------------------------------------------

test("checkCloseControl: exits 1 when required args are missing", async () => {
  const result = await checkCloseControl({ repo: "owner/repo", "control-issue": 487 });
  assert.equal(result.exitCode, 1);
});

test("checkCloseControl: exits 1 when gh issue view fails", async () => {
  const result = await checkCloseControl(
    { repo: "owner/repo", "control-issue": 487, "audit-issue": 538 },
    { ghIssueViewImpl: async () => { throw new Error("not found"); } },
  );
  assert.equal(result.exitCode, 1);
});

test("checkCloseControl: ALREADY_TERMINAL — a safe no-op on a control Issue already closed, no edit/close/comment attempted (idempotent rerun)", async () => {
  const result = await checkCloseControl(
    { repo: "owner/repo", "control-issue": 487, "audit-issue": 538, "work-issue": 486 },
    {
      ghIssueViewImpl: async () => ({ state: "CLOSED", body: OPEN_BODY }),
      ghEditImpl: async () => assert.fail("must not re-edit an already-closed control Issue"),
      ghCloseImpl: async () => assert.fail("must not re-close an already-closed control Issue"),
      ghCommentImpl: async () => assert.fail("must not re-comment on an already-closed control Issue"),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "ALREADY_TERMINAL");
  assert.equal(result.controlIssue, 487);
});

test("checkCloseControl: CLOSED — an open control Issue is rewritten to a terminal body, closed, and commented on, in that order", async () => {
  const calls = [];
  const result = await checkCloseControl(
    { repo: "owner/repo", "control-issue": 487, "audit-issue": 538, "work-issue": 486 },
    {
      ghIssueViewImpl: async ({ number }) => {
        assert.equal(number, 487);
        return { state: "OPEN", body: OPEN_BODY };
      },
      ghEditImpl: async (a) => calls.push({ step: "edit", ...a }),
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

test("checkCloseControl: REJECTED — a pre-existing corrupted parser-sensitive field (e.g. a two-pointer PR bullet) is refused before any mutation is attempted", async () => {
  const corruptBody = OPEN_BODY.replace("- **PR:** #536", "- **PR:** #536 (see also predecessor #535)");
  const result = await checkCloseControl(
    { repo: "owner/repo", "control-issue": 487, "audit-issue": 538, "work-issue": 486 },
    {
      ghIssueViewImpl: async () => ({ state: "OPEN", body: corruptBody }),
      ghEditImpl: async () => assert.fail("an invalid composed body must never reach the write implementation"),
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
    { repo: "owner/repo", "control-issue": 487, "audit-issue": 538 },
    {
      ghIssueViewImpl: async () => ({ state: "OPEN", body: OPEN_BODY }),
      ghEditImpl: async () => { throw new Error("gh: network error"); },
      ghCloseImpl: async () => assert.fail("must not close before the body write succeeded"),
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /gh issue edit failed/);
});

test("checkCloseControl: a gh issue close failure after a successful body write is an operational error naming the already-terminal body", async () => {
  const result = await checkCloseControl(
    { repo: "owner/repo", "control-issue": 487, "audit-issue": 538 },
    {
      ghIssueViewImpl: async () => ({ state: "OPEN", body: OPEN_BODY }),
      ghEditImpl: async () => {},
      ghCloseImpl: async () => { throw new Error("gh: transient error"); },
      ghCommentImpl: async () => assert.fail("must not comment before the close succeeded"),
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /gh issue close failed/);
});

test("checkCloseControl: a comment-post failure after a successful close still reports CLOSED (never a failed exit), naming the comment failure", async () => {
  const result = await checkCloseControl(
    { repo: "owner/repo", "control-issue": 487, "audit-issue": 538, "work-issue": 486 },
    {
      ghIssueViewImpl: async () => ({ state: "OPEN", body: OPEN_BODY }),
      ghEditImpl: async () => {},
      ghCloseImpl: async () => {},
      ghCommentImpl: async () => { throw new Error("transient network error"); },
    },
  );
  assert.equal(result.exitCode, 0, "the Issue is genuinely terminalized and closed; this must not be reported as a blocked failure");
  assert.equal(result.state, "CLOSED");
  assert.equal(result.commentPosted, false);
  assert.match(result.message, /could not post the durable explanation comment/);
});

test("checkCloseControl: ACCEPTED_NO_WORK_ISSUE shape (no --work-issue) still terminalizes and closes correctly", async () => {
  const calls = [];
  const result = await checkCloseControl(
    { repo: "owner/repo", "control-issue": 487, "audit-issue": 538 },
    {
      ghIssueViewImpl: async () => ({ state: "OPEN", body: OPEN_BODY }),
      ghEditImpl: async (a) => calls.push(a),
      ghCloseImpl: async () => {},
      ghCommentImpl: async () => {},
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.workIssue, null);
  assert.doesNotMatch(calls[0].body, /work issue #/);
});
