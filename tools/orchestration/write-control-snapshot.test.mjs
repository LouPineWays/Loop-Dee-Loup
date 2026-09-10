// Tests for tools/orchestration/write-control-snapshot.mjs — issue #510 (unit 510-A)'s
// write-before-validate helper for the normal LDL-authored thin-control-body edit path.
//
// Run with:
//   node --test tools/orchestration/write-control-snapshot.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { checkWriteControlSnapshot } from "./write-control-snapshot.mjs";

const CORRUPT_BODY = `- **PR:** #509
- **Stage 2:** #508 — NOT CLEAN (correction dispatched as PR #509; a fresh Stage 2 audit is required once #509 merges)
`;

const VALID_BODY = `- **PR:** #509
- **Stage 2:** #508 — NOT CLEAN (correction dispatched; fresh Stage 2 required after the current correction PR merges)
`;

test("checkWriteControlSnapshot: exits 1 when --control-issue is missing", () => {
  const result = checkWriteControlSnapshot({ repo: "owner/repo", proposedBody: VALID_BODY });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /control-issue is required/);
});

test("checkWriteControlSnapshot: exits 1 when no proposed body was supplied", () => {
  const result = checkWriteControlSnapshot({ repo: "owner/repo", controlIssue: 499 });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /proposed body/);
});

test("checkWriteControlSnapshot: REJECTED — refuses the exact #499 corrupted shape before ever calling the write implementation (write-before-validate ordering, Verification case 7)", () => {
  let editCalled = false;
  const result = checkWriteControlSnapshot(
    { repo: "owner/repo", controlIssue: 499, proposedBody: CORRUPT_BODY },
    { ghEditImpl: () => { editCalled = true; } },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "REJECTED");
  assert.equal(editCalled, false, "an invalid proposed body must never reach the write implementation — the prior durable body is left unchanged");
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /"Stage 2"/);
});

test("checkWriteControlSnapshot: WRITTEN — a valid proposed body is persisted verbatim via the injected write implementation", () => {
  const editCalls = [];
  const result = checkWriteControlSnapshot(
    { repo: "owner/repo", controlIssue: 499, proposedBody: VALID_BODY },
    { ghEditImpl: (args) => editCalls.push(args) },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "WRITTEN");
  assert.equal(editCalls.length, 1);
  assert.equal(editCalls[0].repo, "owner/repo");
  assert.equal(editCalls[0].controlIssue, 499);
  assert.equal(editCalls[0].body, VALID_BODY);
});

test("checkWriteControlSnapshot: an operational failure from the write implementation itself is reported as exit 1, distinct from a REJECTED validation failure", () => {
  const result = checkWriteControlSnapshot(
    { repo: "owner/repo", controlIssue: 499, proposedBody: VALID_BODY },
    {
      ghEditImpl: () => {
        throw new Error("gh: network error");
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /gh issue edit failed/);
});

test("checkWriteControlSnapshot: cross-field coexistence (PR + Stage 2 pointing at distinct issues) is accepted and written (Verification case 3)", () => {
  const editCalls = [];
  const result = checkWriteControlSnapshot(
    { repo: "owner/repo", controlIssue: 499, proposedBody: "- **PR:** #509\n- **Stage 2:** #508\n" },
    { ghEditImpl: (args) => editCalls.push(args) },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(editCalls.length, 1);
});
