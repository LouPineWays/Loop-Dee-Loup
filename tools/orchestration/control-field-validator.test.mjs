// Tests for tools/orchestration/control-field-validator.mjs — issue #510 (unit 510-A)'s
// deterministic pre-persistence guard for thin-control-state parser-sensitive fields.
//
// Run with:
//   node --test tools/orchestration/control-field-validator.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  extractUrlPointerKinds,
  validatePointerFieldValue,
  validateControlField,
  validateControlSnapshot,
  DEFAULT_CONTROL_FIELD_SPECS,
} from "./control-field-validator.mjs";

// Issue #499's own real (corrupted) snapshot shape — the live reproduction #510 exists to
// close. The canonical "Stage 2" field embeds a second parseable pointer (PR #509) inside its
// own explanatory prose, alongside a separately correct canonical "PR" field also naming #509.
const ISSUE_499_CORRUPT_BODY = `## Current state

- **Lifecycle:** REVIEW
- **Execution:** #497
- **Route:** implementation worker
- **PR:** https://github.com/LouPineWays/Loop-Dee-Loup/pull/509 (open; Stage 1 requested)
- **Stage 1:** requested — PR #509; awaiting response
- **Stage 2:** https://github.com/LouPineWays/Loop-Dee-Loup/issues/508 — Verdict: NOT CLEAN (correction dispatched as PR #509; a fresh Stage 2 audit is required once #509 merges)
- **Blocker:** none
- **Founder decision:** none
`;

// The corrected #499 shape (Verification case 2): same live state, but the Stage 2
// annotation no longer repeats #509 — it refers to it generically instead.
const ISSUE_499_CORRECTED_BODY = `## Current state

- **Lifecycle:** REVIEW
- **Execution:** #497
- **Route:** implementation worker
- **PR:** https://github.com/LouPineWays/Loop-Dee-Loup/pull/509 (open; Stage 1 requested)
- **Stage 1:** requested — PR #509; awaiting response
- **Stage 2:** https://github.com/LouPineWays/Loop-Dee-Loup/issues/508 — Verdict: NOT CLEAN (correction dispatched; fresh Stage 2 required after the current correction PR merges)
- **Blocker:** none
- **Founder decision:** none
`;

// -- extractUrlPointerKinds ---------------------------------------------------------------

test("extractUrlPointerKinds: reports pull vs issue kind for URL-shaped references, ignores bare #N", () => {
  assert.deepEqual(extractUrlPointerKinds("https://github.com/o/r/pull/509"), [{ kind: "pull", number: 509 }]);
  assert.deepEqual(extractUrlPointerKinds("https://github.com/o/r/issues/508"), [{ kind: "issue", number: 508 }]);
  assert.deepEqual(extractUrlPointerKinds("#509"), []);
  assert.deepEqual(extractUrlPointerKinds("none"), []);
});

// -- validatePointerFieldValue ------------------------------------------------------------

test("validatePointerFieldValue: field absent from the body is not itself a failure", () => {
  const result = validatePointerFieldValue(null, { label: "Stage 2" });
  assert.equal(result.ok, true);
  assert.equal(result.present, false);
});

test("validatePointerFieldValue: the 'none' sentinel is valid", () => {
  const result = validatePointerFieldValue("none", { label: "PR" });
  assert.equal(result.ok, true);
  assert.equal(result.sentinel, "none");
});

test("validatePointerFieldValue: exactly one recognized pointer is valid", () => {
  const result = validatePointerFieldValue("#509", { label: "PR" });
  assert.equal(result.ok, true);
  assert.equal(result.issue, 509);
});

test("validatePointerFieldValue: zero recognized pointers is rejected (Verification case 5)", () => {
  const result = validatePointerFieldValue("awaiting founder review", { label: "Stage 2" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /names no #N issue reference/);
});

test("validatePointerFieldValue: the exact #499 corrupted Stage 2 value is rejected for multiple pointers (Verification case 1)", () => {
  const result = validatePointerFieldValue(
    "#508 — NOT CLEAN (correction dispatched as PR #509; a fresh Stage 2 audit is required once #509 merges)",
    { label: "Stage 2" },
  );
  assert.equal(result.ok, false);
  assert.match(result.reason, /more than one execution pointer/);
});

test("validatePointerFieldValue: the corrected #499 Stage 2 value (no second numbered pointer) is accepted (Verification case 2)", () => {
  const result = validatePointerFieldValue(
    "#508 — NOT CLEAN (correction dispatched; fresh Stage 2 required after the current correction PR merges)",
    { label: "Stage 2" },
  );
  assert.equal(result.ok, true);
  assert.equal(result.issue, 508);
});

test("validatePointerFieldValue: a bare #N reference never fails a kind check — no kind information exists to check it against", () => {
  const result = validatePointerFieldValue("#509", { label: "Stage 2", expectedKind: "issue" });
  assert.equal(result.ok, true);
});

test("validatePointerFieldValue: a pull-kind URL in a field that expects an issue-kind reference is rejected (wrong pointer kind, Verification case 5)", () => {
  const result = validatePointerFieldValue("https://github.com/o/r/pull/509", { label: "Stage 2", expectedKind: "issue" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /requires a issue-kind reference/);
});

test("validatePointerFieldValue: an issue-kind URL in a field that expects a pull-kind reference is rejected (wrong pointer kind, Verification case 5)", () => {
  const result = validatePointerFieldValue("https://github.com/o/r/issues/509", { label: "PR", expectedKind: "pull" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /requires a pull-kind reference/);
});

test("validatePointerFieldValue: a matching-kind URL is accepted", () => {
  const pr = validatePointerFieldValue("https://github.com/o/r/pull/509", { label: "PR", expectedKind: "pull" });
  assert.equal(pr.ok, true);
  const stage2 = validatePointerFieldValue("https://github.com/o/r/issues/508", { label: "Stage 2", expectedKind: "issue" });
  assert.equal(stage2.ok, true);
});

// -- validateControlField (Execution alias/near-duplicate handling) -----------------------

test("validateControlField: Execution field reuses readExecutionBulletField's own alias handling", () => {
  const body = "- **Execution issue:** #310\n";
  const result = validateControlField(body, { label: "Execution", isExecutionField: true, expectedKind: "issue" });
  assert.equal(result.ok, true);
  assert.equal(result.issue, 310);
});

test("validateControlField: Execution field alias conflict (legacy vs live spelling naming different issues) fails closed", () => {
  const body = "- **Execution:** #310\n- **Execution issue:** #320\n";
  const result = validateControlField(body, { label: "Execution", isExecutionField: true, expectedKind: "issue" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /ambiguous/);
});

// -- Near-duplicate label preservation (Verification case 6 — #493/#495) ------------------

test("validateControlField: a near-duplicate 'Stage 2 (current)' label alongside canonical 'Stage 2' fails closed (Verification case 6)", () => {
  const body = "- **Stage 2:** #480\n- **Stage 2 (current):** #492\n";
  const result = validateControlField(body, { label: "Stage 2", expectedKind: "issue" });
  assert.equal(result.ok, false);
  assert.match(result.reason, /near-duplicate/);
});

test("validateControlField: no near-duplicate label present behaves exactly like an ordinary field read", () => {
  const body = "- **Stage 2:** #508\n";
  const result = validateControlField(body, { label: "Stage 2", expectedKind: "issue" });
  assert.equal(result.ok, true);
  assert.equal(result.issue, 508);
});

// -- validateControlSnapshot (whole-body, field-local) -------------------------------------

test("validateControlSnapshot: rejects the exact #499 corrupted snapshot, naming Stage 2 specifically (Verification case 1)", () => {
  const result = validateControlSnapshot(ISSUE_499_CORRUPT_BODY);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 1, "only the Stage 2 field should fail — PR/Execution are each single-pointer and valid on their own");
  assert.match(result.errors[0], /"Stage 2"/);
  assert.match(result.errors[0], /more than one execution pointer/);
});

test("validateControlSnapshot: accepts the corrected #499 snapshot (Verification case 2)", () => {
  const result = validateControlSnapshot(ISSUE_499_CORRECTED_BODY);
  assert.equal(result.ok, true);
});

test("validateControlSnapshot: a separate canonical PR field and canonical Stage 2 field pointing at different issues both validate together — field-local, not a whole-body ban on multiple references (Verification case 3)", () => {
  const body = "- **PR:** #509\n- **Stage 2:** #508\n";
  const result = validateControlSnapshot(body);
  assert.equal(result.ok, true);
});

test("validateControlSnapshot: historical relationship prose elsewhere in the body naming several issues does not contaminate the canonical fields' own parse result (Verification case 4)", () => {
  const body = `## Relationships

- #505/#506/#507/#508/#509 are all part of the same correction chain.

## Current state

- **PR:** #509
- **Stage 2:** #508
`;
  const result = validateControlSnapshot(body);
  assert.equal(result.ok, true);
});

test("validateControlSnapshot: a field entirely absent from the body contributes no error (field presence is a read-time gate concern, not this validator's)", () => {
  const result = validateControlSnapshot("## Current state\n\n- **Lifecycle:** READY\n");
  assert.equal(result.ok, true);
});

test("validateControlSnapshot: multiple simultaneously-invalid fields are all reported, not just the first", () => {
  const body = "- **PR:** #509 (also #510)\n- **Stage 2:** #508 (also #512)\n";
  const result = validateControlSnapshot(body);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 2);
});

test("validateControlSnapshot: default field specs are Execution/PR/Stage 2 — the fields ready-dispatch-gate.mjs / next-review-transition-gate.mjs already structurally trust", () => {
  assert.deepEqual(
    DEFAULT_CONTROL_FIELD_SPECS.map((s) => s.label),
    ["Execution", "PR", "Stage 2"],
  );
});
