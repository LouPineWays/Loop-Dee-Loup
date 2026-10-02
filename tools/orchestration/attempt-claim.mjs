// Attempt claims and liveness classification for issue #73 (unit 73-A). Pure.
//
// A claim is one fixed-heading comment `## Launch Attempt (v1)` on the control issue.
// Liveness is NEVER read from the claim text: callers pass the GitHub Actions run status
// read back through `gh api`, keyed by attempt id. Claims by authors without write
// permission (and not the Actions bot) are ignored, so they can neither block nor
// satisfy a launch.
//
// Tests: node --test tools/orchestration/attempt-claim.test.mjs

import { parseBoldBullets, hasWritePermission } from "./launch-authorization.mjs";

export const LAUNCH_ATTEMPT_HEADING = "## Launch Attempt (v1)";
const LIVE_STATUSES = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);
export const SETTLED_PHASES = new Set(["DONE", "SETTLED"]);

export function formatAttemptId(runId, runAttempt) {
  return `${runId}-${runAttempt}`;
}

// Attempt ids are `<run_id>-<run_attempt>`. A GitHub rerun keeps run_id and bumps run_attempt, so
// liveness must be looked up for the exact attempt, never for the run id alone.
export function parseAttemptId(attemptId) {
  const m = /^(\d+)-(\d+)$/.exec(String(attemptId ?? ""));
  return m ? { runId: m[1], runAttempt: m[2] } : null;
}

export function parseAttemptClaims(comments) {
  const claims = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    const first = String(c?.body ?? "").split(/\r?\n/).find((l) => l.trim() !== "")?.trim();
    if (first !== LAUNCH_ATTEMPT_HEADING) continue;
    const trusted = hasWritePermission(c.authorPermission) || c.author === "github-actions[bot]";
    if (!trusted) continue;
    const f = parseBoldBullets(c.body);
    const attemptId = f.get("Attempt id");
    const nonce = f.get("Authorization nonce");
    if (!attemptId || !nonce) continue;
    claims.push({
      commentId: c.id,
      attemptId,
      nonce,
      claimedAt: f.get("Claimed at") ?? null,
      runner: f.get("Runner") ?? null,
      phase: (f.get("Phase") ?? "").toUpperCase(),
    });
  }
  // One attempt id may carry several claim comments (CLAIMED, then DONE); the latest comment for
  // an attempt id is its current phase.
  const latest = new Map();
  for (const c of claims) latest.set(c.attemptId, c);
  return [...latest.values()];
}

export function renderClaimBody({ attemptId, nonce, claimedAt, runner, phase = "CLAIMED", outcome = null }) {
  return [
    LAUNCH_ATTEMPT_HEADING,
    "",
    `- **Attempt id:** ${attemptId}`,
    `- **Authorization nonce:** ${nonce}`,
    `- **Claimed at:** ${claimedAt}`,
    `- **Runner:** ${runner}`,
    `- **Phase:** ${phase}`,
    ...(outcome ? [`- **Outcome:** ${outcome}`] : []),
    "",
  ].join("\n");
}

// claims: output of parseAttemptClaims. liveness: { [attemptId]: { status, conclusion } }
// as read back from the Actions run API; a missing/malformed entry is unknown.
// Returns exactly one of NO_CLAIM | LIVE | ORPHANED | AMBIGUOUS. LIVE and AMBIGUOUS
// both forbid launch; ORPHANED permits reconcile-then-claim.
export function classifyAttempt(claims, liveness = {}) {
  const open = (Array.isArray(claims) ? claims : []).filter((c) => !SETTLED_PHASES.has(c.phase));
  if (open.length === 0) return "NO_CLAIM";
  let anyUnknown = false;
  for (const c of open) {
    const l = liveness?.[c.attemptId];
    const status = typeof l?.status === "string" ? l.status.toLowerCase() : null;
    if (status && LIVE_STATUSES.has(status)) return "LIVE";
    if (status !== "completed") anyUnknown = true;
  }
  return anyUnknown ? "AMBIGUOUS" : "ORPHANED";
}

// Idempotent claim decision for one incoming trigger. Duplicate or replayed events for
// the same attempt id or an already-settled nonce never produce a second active claim.
// Returns { action: "CLAIM" | "RECONCILE_THEN_CLAIM" | "ALREADY_CLAIMED" | "REPLAY" | "BLOCK", reason }.
export function planClaim(claims, liveness, { attemptId, nonce }) {
  const all = Array.isArray(claims) ? claims : [];
  if (all.some((c) => c.nonce === nonce && SETTLED_PHASES.has(c.phase))) {
    return { action: "REPLAY", reason: "authorization nonce already consumed by a settled attempt" };
  }
  if (all.some((c) => c.attemptId === attemptId)) {
    return { action: "ALREADY_CLAIMED", reason: "this attempt id already holds a claim" };
  }
  const state = classifyAttempt(all, liveness);
  if (state === "LIVE") return { action: "BLOCK", reason: "a live attempt holds the claim" };
  if (state === "AMBIGUOUS") return { action: "BLOCK", reason: "liveness ambiguous; failing closed" };
  if (state === "ORPHANED") return { action: "RECONCILE_THEN_CLAIM", reason: "prior attempt terminated without settling" };
  return { action: "CLAIM", reason: "no prior claim" };
}
