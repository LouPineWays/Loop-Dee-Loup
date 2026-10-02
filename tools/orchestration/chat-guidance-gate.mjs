// Chat guidance boundary for issue #73 (unit 73-C). Pure functions only.
//
// A Stage 1 finding set or a Stage 2 NOT CLEAN verdict needs semantic guidance before a fresh
// correction worker is dispatched. That guidance is one fixed-heading durable comment,
// `## Chat Guidance (v1)`, authored by an actor with repository write/admin permission and bound
// to the exact target: `Target kind`, `Target ref`, `Target evidence id` (Stage 1: the reviewed
// head SHA; Stage 2: the report comment id). A comment bound to older evidence is STALE and never
// reused. Without matching guidance the launcher stops with a fixed handoff string; that stop is
// never a founder decision and never permission for the supervisor to author the correction.
//
// Tests: node --test tools/orchestration/chat-guidance-gate.test.mjs

import { parseBoldBullets, hasWritePermission } from "./launch-authorization.mjs";

export const CHAT_GUIDANCE_HEADING = "## Chat Guidance (v1)";

export function chatGuidanceHandoff(target) {
  if (target?.kind === "stage1") return `Chat guidance required on PR #${target.ref}`;
  if (target?.kind === "stage2") return `Chat guidance required on Stage 2 Audit #${target.ref}`;
  return null;
}

function firstNonBlankLine(body) {
  return String(body ?? "").split(/\r?\n/).find((l) => l.trim() !== "")?.trim();
}

function guidanceText(body, fields) {
  const bullet = fields.get("Guidance");
  if (bullet) return bullet;
  return String(body ?? "")
    .split(/\r?\n/)
    .filter((l, i) => i > 0 && !/^\s*[-*]\s+\*\*[^*:]+:\*\*/.test(l))
    .join("\n")
    .trim();
}

// comments: [{ id, body, authorPermission }] (permission read back from GitHub, never self-declared).
// target: { kind: 'stage1'|'stage2', ref: <PR or Audit number>, evidenceId: <head SHA | report comment id> }.
// Returns { status: 'VALID'|'REQUIRED'|'STALE'|'AMBIGUOUS', handoff?, guidance?, reason }.
// Only VALID permits a correction dispatch; every other status carries the fixed handoff string.
export function verifyChatGuidance(comments, target) {
  const bad =
    !target ||
    !["stage1", "stage2"].includes(target.kind) ||
    target.ref == null ||
    target.evidenceId == null ||
    String(target.evidenceId) === "";
  if (bad) return { status: "AMBIGUOUS", reason: "malformed target", handoff: chatGuidanceHandoff(target) };
  const handoff = chatGuidanceHandoff(target);
  const ref = String(target.ref).replace(/^#/, "");
  const evidenceId = String(target.evidenceId);
  const current = [];
  let sawStale = false;
  for (const c of Array.isArray(comments) ? comments : []) {
    if (firstNonBlankLine(c?.body) !== CHAT_GUIDANCE_HEADING) continue;
    if (!hasWritePermission(c.authorPermission)) continue; // untrusted author: not guidance
    const f = parseBoldBullets(c.body);
    if (f.get("Target kind") !== target.kind) continue;
    if (String(f.get("Target ref") ?? "").replace(/^#/, "") !== ref) continue;
    const text = guidanceText(c.body, f);
    if (!text) continue;
    if (f.get("Target evidence id") !== evidenceId) {
      sawStale = true;
      continue;
    }
    current.push({ commentId: c.id, text });
  }
  if (current.length === 0) {
    return sawStale
      ? { status: "STALE", handoff, reason: "guidance is bound to superseded evidence" }
      : { status: "REQUIRED", handoff, reason: "no exact-target Chat Guidance comment" };
  }
  if (new Set(current.map((g) => g.text)).size > 1) {
    return { status: "AMBIGUOUS", handoff, reason: "conflicting guidance for the current evidence" };
  }
  return { status: "VALID", guidance: current[current.length - 1], reason: "exact-target guidance bound to current evidence" };
}

// Maps an open-path verdict to the guidance target. `evidenceId` is read back by the caller
// (Stage 1: verdict head; Stage 2: current report comment id) -- never taken from guidance text.
export function guidanceTargetForVerdict(verdict, { reportCommentId } = {}) {
  if (verdict?.state === "STAGE1_CORRECTION_REQUIRED") {
    return { kind: "stage1", ref: verdict.pr, evidenceId: verdict.head };
  }
  if (verdict?.state === "STAGE2_CORRECTION_REQUIRED") {
    return { kind: "stage2", ref: verdict.auditIssue, evidenceId: reportCommentId };
  }
  return null;
}
