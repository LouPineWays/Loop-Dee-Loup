// Pre-first-Stage-1 current-target compatibility witness -- issue #1029 (control #1028; live
// reproduction PR #1021 / #963/#964: a new PR was already `CONFLICTING` with its live target when
// its FIRST `@codex review` was requested, so the reviewed head could never merge and a founder had
// to intervene after review).
//
// Called by trigger.mjs immediately before it posts the FIRST Stage 1 trigger on a PR (no earlier
// trigger round at any head). It consumes GitHub's own live mergeability for the exact PR head and
// witnesses the target tip around that read; it is not a merge oracle and reads nothing locally.
//
//   MERGEABLE  -> ok. A PR that is merely behind its target still proceeds: GitHub merges
//                 non-conflicting diverged branches normally, so there is no zero-behind rule.
//   CONFLICTING -> CONFLICT (positively confirmed against a stable target tip). The first trigger
//                 must not be consumed; a bounded current-target continuation is routed instead
//                 (successor-integration-preflight.mjs; docs/bounded-review-cycle.md
//                 § Pre-first-review current-target compatibility).
//   UNKNOWN    -> bounded re-read (maxAttempts, no infinite poll); still UNKNOWN => UNPROVEN.
//   Any read error, non-open PR, head different from the frozen --head, or a target tip that keeps
//   moving across the witness reads => UNPROVEN / STALE_HEAD: fail closed, never a fictitious
//   conflict verdict and never a cached "compatible" claim.
//
// Every attempt re-reads the target tip before and after the PR read; a differing pair
// invalidates that attempt's result (target movement re-evaluates, it is never accepted as-is).

export const COMPAT_OK = "COMPATIBLE";
export const COMPAT_CONFLICT = "CONFLICT";
export const COMPAT_UNPROVEN = "UNPROVEN";

const SHA = /^[0-9a-f]{40}$/i;

export async function checkFirstReviewCompat({
  repo,
  number,
  head,
  readPr,
  readTarget,
  sleep = async () => {},
  maxAttempts = 4,
  delayMs = 5000,
}) {
  if (typeof readPr !== "function" || typeof readTarget !== "function") {
    return { verdict: COMPAT_UNPROVEN, reason: "compat readers are not configured" };
  }
  let last = "no attempt completed";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let before, pr, after;
    try {
      pr = await readPr({ repo, number });
      if (pr.state !== "OPEN") {
        return { verdict: COMPAT_UNPROVEN, reason: `PR #${number} is ${pr.state}, not OPEN`, terminal: true };
      }
      if (String(pr.headRefOid).toLowerCase() !== String(head).toLowerCase()) {
        return {
          verdict: COMPAT_UNPROVEN,
          reason: `STALE_HEAD: PR #${number} head is ${pr.headRefOid}, trigger requested for ${head}`,
          terminal: true,
        };
      }
      before = await readTarget({ repo, ref: pr.baseRefName });
      // Re-read the PR after the target read so mergeability is never judged from a read taken
      // before a target move we have already observed.
      pr = await readPr({ repo, number });
      if (String(pr.headRefOid).toLowerCase() !== String(head).toLowerCase() || pr.state !== "OPEN") {
        return { verdict: COMPAT_UNPROVEN, reason: `STALE_HEAD: PR #${number} changed during the compat read`, terminal: true };
      }
      after = await readTarget({ repo, ref: pr.baseRefName });
    } catch (err) {
      return { verdict: COMPAT_UNPROVEN, reason: `READ_ERROR: ${err.message}`, terminal: true };
    }
    if (!SHA.test(before) || !SHA.test(after)) {
      return { verdict: COMPAT_UNPROVEN, reason: "malformed target tip read", terminal: true };
    }
    if (before.toLowerCase() !== after.toLowerCase()) {
      last = `TARGET_MOVED: ${pr.baseRefName} moved ${before} -> ${after} during the witness`;
      continue; // re-evaluate against the new tip; never accept the old compatibility claim
    }
    const witness = { head, target: { ref: pr.baseRefName, sha: after } };
    if (pr.mergeable === "MERGEABLE") return { verdict: COMPAT_OK, ...witness };
    if (pr.mergeable === "CONFLICTING") return { verdict: COMPAT_CONFLICT, ...witness };
    last = `UNKNOWN: GitHub has not computed mergeability for ${head} against ${pr.baseRefName}`;
    if (attempt < maxAttempts) await sleep(delayMs);
  }
  return { verdict: COMPAT_UNPROVEN, reason: `${last} after ${maxAttempts} bounded attempts` };
}
