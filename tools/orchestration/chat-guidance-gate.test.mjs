import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyChatGuidance, guidanceTargetForVerdict, chatGuidanceHandoff } from "./chat-guidance-gate.mjs";

const t1 = { kind: "stage1", ref: 7, evidenceId: "abc123" };
const t2 = { kind: "stage2", ref: 9, evidenceId: "555" };
const gc = (kind, ref, ev, o = {}) => ({
  id: o.id ?? 1,
  authorPermission: o.perm ?? "write",
  body: `## Chat Guidance (v1)\n\n- **Target kind:** ${kind}\n- **Target ref:** #${ref}\n- **Target evidence id:** ${ev}\n- **Guidance:** ${o.text ?? "fix the null check"}`,
});

test("handoff strings are exact", () => {
  assert.equal(chatGuidanceHandoff(t1), "Chat guidance required on PR #7");
  assert.equal(chatGuidanceHandoff(t2), "Chat guidance required on Stage 2 Audit #9");
});

test("no guidance requires Chat with fixed handoff", () => {
  const r = verifyChatGuidance([], t1);
  assert.equal(r.status, "REQUIRED");
  assert.equal(r.handoff, "Chat guidance required on PR #7");
  assert.equal(verifyChatGuidance([], t2).handoff, "Chat guidance required on Stage 2 Audit #9");
});

test("exact-target guidance is valid for both stages", () => {
  assert.equal(verifyChatGuidance([gc("stage1", 7, "abc123")], t1).status, "VALID");
  assert.equal(verifyChatGuidance([gc("stage2", 9, "555")], t2).status, "VALID");
});

test("changed head or report invalidates guidance", () => {
  assert.equal(verifyChatGuidance([gc("stage1", 7, "old")], t1).status, "STALE");
  assert.equal(verifyChatGuidance([gc("stage2", 9, "444")], t2).status, "STALE");
});

test("wrong kind/ref, untrusted author, empty guidance, prose do not count", () => {
  assert.equal(verifyChatGuidance([gc("stage2", 7, "abc123")], t1).status, "REQUIRED");
  assert.equal(verifyChatGuidance([gc("stage1", 8, "abc123")], t1).status, "REQUIRED");
  assert.equal(verifyChatGuidance([gc("stage1", 7, "abc123", { perm: "read" })], t1).status, "REQUIRED");
  assert.equal(verifyChatGuidance([gc("stage1", 7, "abc123", { text: "" })], t1).status, "REQUIRED");
  assert.equal(verifyChatGuidance([{ id: 2, authorPermission: "admin", body: "please fix it" }], t1).status, "REQUIRED");
});

test("conflicting current guidance is ambiguous; malformed target fails closed", () => {
  const r = verifyChatGuidance(
    [gc("stage1", 7, "abc123", { text: "a" }), gc("stage1", 7, "abc123", { text: "b", id: 2 })],
    t1,
  );
  assert.equal(r.status, "AMBIGUOUS");
  assert.equal(verifyChatGuidance([], { kind: "stage1", ref: 7 }).status, "AMBIGUOUS");
});

test("guidanceTargetForVerdict", () => {
  assert.deepEqual(guidanceTargetForVerdict({ state: "STAGE1_CORRECTION_REQUIRED", pr: 7, head: "h" }), {
    kind: "stage1",
    ref: 7,
    evidenceId: "h",
  });
  assert.deepEqual(guidanceTargetForVerdict({ state: "STAGE2_CORRECTION_REQUIRED", auditIssue: 9 }, { reportCommentId: 5 }), {
    kind: "stage2",
    ref: 9,
    evidenceId: 5,
  });
  assert.equal(guidanceTargetForVerdict({ state: "NO_ACTION_YET" }), null);
});
