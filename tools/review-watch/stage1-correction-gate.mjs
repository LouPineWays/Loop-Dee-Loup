#!/usr/bin/env node
// Deterministic gate for the "correction-satisfied" Stage 1 disposition — worker unit 454-B
// under control Issue #454's own Shared Contract (`## Shared Contract (v1)` comment,
// section 2).
//
// #454's root cause: the one-round Stage 1 policy (docs/bounded-review-cycle.md, "Do not
// request a second inline review on that PR") never gave `next-review-transition-gate.mjs`
// a way to authorize a merge once a corrected head existed, once the reviewed head's own
// genuine, findings-bearing Codex response had already been consumed. Control Issue #408
// reproduced this live: PR #435's corrected head reported `NO_ACTION_YET` forever, because
// `stage1.state` at that new head was `NOT_REQUESTED` and nothing else authorized progress
// without a second (policy-violating) review round.
//
// This module recognizes a new, distinct control-Issue disposition shape naming both heads
// explicitly, so no gate ever has to guess which head was actually reviewed:
//
//   - **Stage 1:** correction-satisfied at <corrected-head-sha> (reviewed <reviewed-head-sha>)
//
// Writing that bullet does not itself grant merge authority. `checkCorrectionDelta` always
// re-derives the evidence mechanically, exactly like the two pre-existing disposition shapes
// (`satisfied at <sha>` / `exempt at <sha>`) already do via stage1-gate.mjs — never trusting
// the bullet's prose. Three checks run in this fixed order, the first two of which need no
// network access at all when they already resolve the outcome:
//
//   1. HEAD_MISMATCH — the disposition's `correctedHead` does not match the head currently
//      being gated (`gatedHead`). A stale disposition for an older head, or one since
//      superseded by further commits, must never authorize a different head's merge. Checked
//      first, before any `gh` call, using the same case-insensitive prefix comparison
//      `next-review-transition-gate.mjs` already uses for its own two disposition shapes
//      (`stage1DispositionMatchesHead`, exported from that module and reused here rather than
//      re-implemented a second way).
//   2. NOT_SATISFIED (findings-provenance) — `reviewedHead`'s own Stage 1 result
//      (stage1-gate.mjs's `run`) must be `RESPONSE_RECEIVED` and carry a genuine,
//      findings-bearing match. A clean-pass or unreviewed `reviewedHead` can never back a
//      "correction" disposition — there would be nothing to have corrected.
//   3. NOT_SATISFIED (ancestry) — `correctedHead` must be a strict, non-diverged descendant of
//      `reviewedHead` with at least one real intervening commit (GitHub compare API status
//      `"ahead"`; see `defaultCompare`). This is the cheapest reliable mechanical evidence that
//      the corrected head genuinely followed the reviewed one — not a content-level guarantee
//      that only findings-authorized lines changed (#454 explicitly excludes semantic diff
//      review from this mechanism).
//
// All three pass -> CORRECTION_SATISFIED. This module never adjudicates finding content and
// never requests a second Codex round — see #454's own "Non-goals this plan preserves".
//
// Usage (standalone diagnosis/testing — the normal path is composition from
// next-review-transition-gate.mjs, unit 454-C, not direct invocation):
//   node tools/review-watch/stage1-correction-gate.mjs --repo OWNER/REPO --pr 50 \
//     --reviewed-head <sha> --corrected-head <sha> [--gated-head <sha>]
// `--gated-head` defaults to `--corrected-head` when omitted (a standalone/manual invocation
// is normally "check whether this exact corrected head would satisfy itself").
//
// Exit codes mirror stage1-gate.mjs: 0 = CORRECTION_SATISFIED, 2 = HEAD_MISMATCH or
// NOT_SATISFIED, 1 = operational error. `checkCorrectionDelta` never throws for a merely-
// unsatisfied case — only a genuine I/O failure (a thrown `stage1RunImpl`/`compareImpl`, or
// either returning output without a trustworthy shape) produces `exitCode: 1`.
//
// Tests: node --test tools/review-watch/stage1-correction-gate.test.mjs

import { execFileSync } from "node:child_process";
import { run as stage1Run } from "./stage1-gate.mjs";
import { stage1DispositionMatchesHead } from "../orchestration/next-review-transition-gate.mjs";

// Matches the disposition shape from this module's own header comment. Case-insensitive on
// hex digits (lower-cased on capture, matching the two pre-existing disposition shapes'
// convention in next-review-transition-gate.mjs's own `parseAffirmativeStage1Disposition`).
// Deliberately does NOT match either pre-existing shape ("satisfied at <sha>" / "exempt at
// <sha>") — those lack the required "correction-satisfied" keyword and the "(reviewed ...)"
// clause entirely, so `parseCorrectionSatisfiedDisposition` returns `null` for them rather
// than conflating the three shapes.
const CORRECTION_SATISFIED_PATTERN =
  /^correction-satisfied\s+at\s+([0-9a-f]{7,40})\s+\(reviewed\s+([0-9a-f]{7,40})\)$/i;

// Pure. Parses the raw `- **Stage 1:**` bullet value (the same string
// `parseControlBullet(body, "Stage 1")` already extracts) for this module's own disposition
// shape. Returns `{ correctedHead, reviewedHead }` (both lower-cased) on a match, `null`
// otherwise — an absent/empty bullet, one of the two pre-existing shapes, or anything
// malformed. Never throws.
export function parseCorrectionSatisfiedDisposition(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  const match = CORRECTION_SATISFIED_PATTERN.exec(text);
  if (!match) return null;
  return { correctedHead: match[1].toLowerCase(), reviewedHead: match[2].toLowerCase() };
}

// Lenient sibling of parseCorrectionSatisfiedDisposition, only ever consulted when that strict
// parse already failed. Stage 1 review finding on PR #459: a "Stage 1" bullet that is clearly
// attempting this disposition shape (opens with the "correction-satisfied" keyword) but is
// malformed in some other way -- a missing parenthesis, a non-hex sha, a typo -- must not be
// treated identically to no disposition being present at all; docs/bounded-review-cycle.md
// promises it fails closed to AMBIGUOUS instead. This intentionally only checks the leading
// keyword, not the full shape -- it exists purely to distinguish "absent" (this returns false,
// same as before) from "present but corrupted" (this returns true), never to itself validate
// or partially accept a malformed disposition.
const CORRECTION_SATISFIED_KEYWORD_PATTERN = /^correction-satisfied\b/i;

export function looksLikeCorrectionSatisfiedDisposition(raw) {
  if (typeof raw !== "string") return false;
  const text = raw.trim();
  if (!text) return false;
  return CORRECTION_SATISFIED_KEYWORD_PATTERN.test(text) && !CORRECTION_SATISFIED_PATTERN.test(text);
}

// Third independent copy of Codex's own fixed findings-bearing Stage 1 preamble pattern (see
// `tools/orchestration/next-review-transition-gate.mjs`'s `FINDINGS_PREAMBLE_PATTERN` and
// `tools/review-watch/consumer-sync-gate.mjs`'s own copy for the same fixed string, plus their
// module comments for the full rationale/history). This repository's established convention
// for this exact pattern is an independently-maintained copy per consumer rather than a forced
// cross-module import (both of those files' own comments say so explicitly for the same
// pattern); the Shared Contract for #454 directs this module to follow that same convention
// rather than introduce a new `tools/review-watch` -> `tools/orchestration` import for it
// (unlike `stage1DispositionMatchesHead` above, which the Shared Contract explicitly directs
// this module to import and reuse instead of duplicating the more complex head-comparison
// logic a third time).
const FINDINGS_PREAMBLE_PATTERN =
  /^### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request\./;

// Pure. Both known fixed Stage 1 preambles are anchored with `^`; PR #435's own live
// regression showed a genuine review can open with an insignificant leading newline before
// the heading, which an unforgiving anchor then fails to match. Trimming only insignificant
// outer whitespace before testing tolerates that formatting noise without inspecting or
// adjudicating any actual finding content — mirrors the other two copies' own
// `stripOuterWhitespace` fix for the identical issue.
function stripOuterWhitespace(text) {
  return (text ?? "").trim();
}

// Pure. `stage1` is stage1-gate.mjs's own result. True only when at least one *head-bound*
// genuine match (stage1.matches — provably tied to the exact reviewedHead being checked,
// per stage1-gate.mjs's own matchBelongsToHead) opens with the known findings-bearing
// preamble. Stage 1 review finding on this PR: `stage1.unboundGenuineMatches` are, by
// stage1-gate.mjs's own contract, responses that could NOT be attributed to the requested
// head — on a PR with triggers for multiple heads, an unbound findings-bearing response
// belonging to a *different* round must never be borrowed to prove that reviewedHead itself
// received findings. Positive correction provenance must come only from stage1.matches;
// an unbound match is never counted here (unlike next-review-transition-gate.mjs's own copy
// of this helper, which deliberately does include unbound matches for its own PENDING-state
// ambiguity check — a different question: "should this gate merely pause and let a human
// look," not "does this prove the named head was reviewed").
function hasFindingsStage1Response(stage1) {
  return (stage1.matches ?? []).some((m) => FINDINGS_PREAMBLE_PATTERN.test(stripOuterWhitespace(m.body_excerpt)));
}

// Async. The default `compareImpl`: runs `gh api repos/<repo>/compare/<base>...<head>` and
// returns the parsed JSON as-is (`checkCorrectionDelta` reads only its `status` field).
// GitHub's compare API: `ahead` = head contains base plus 1+ new commits, `identical` = no
// new commits, `diverged`/`behind` = base is not an ancestor of head.
export function defaultCompare({ repo, base, head }) {
  const raw = execFileSync("gh", ["api", `repos/${repo}/compare/${base}...${head}`], { encoding: "utf8" });
  return JSON.parse(raw);
}

// Async. The default `resolveCommitImpl`: resolves any hex prefix (7-40 chars) to the full
// 40-character commit SHA via GitHub's own commit-lookup API, which already accepts an
// abbreviated ref. Returns `null` (never throws) when the ref does not resolve to a real
// commit — an invalid/typo'd SHA is evidence for NOT_SATISFIED, not an operational error.
export function defaultResolveCommit({ repo, sha }) {
  try {
    const raw = execFileSync("gh", ["api", `repos/${repo}/commits/${sha}`, "--jq", ".sha"], { encoding: "utf8" });
    const resolved = raw.trim();
    return resolved || null;
  } catch {
    return null;
  }
}

// Async. The core decision function. `stage1RunImpl`/`compareImpl` are injected so tests can
// drive this end-to-end without touching the real network or `gh` CLI. See this module's
// header comment for the full three-check design and ordering.
export async function checkCorrectionDelta(
  { repo, pr, reviewedHead, correctedHead, gatedHead },
  { stage1RunImpl = stage1Run, compareImpl = defaultCompare, resolveCommitImpl = defaultResolveCommit } = {},
) {
  if (!repo || !pr || !reviewedHead || !correctedHead || !gatedHead) {
    return {
      exitCode: 1,
      message:
        "Missing required args: repo, pr, reviewedHead, correctedHead, and gatedHead are all required.",
    };
  }

  // Check 1: HEAD_MISMATCH, before any network call. `stage1DispositionMatchesHead` expects
  // a `{ sha }`-shaped disposition object and a candidate head string; it is otherwise
  // agnostic to which disposition shape produced the sha, so a minimal `{ sha: correctedHead
  // }` object reuses it exactly as next-review-transition-gate.mjs's own two disposition
  // shapes already do, rather than re-implementing the case-insensitive prefix comparison a
  // second way.
  if (!stage1DispositionMatchesHead({ sha: correctedHead.toLowerCase() }, gatedHead)) {
    return { exitCode: 2, state: "HEAD_MISMATCH", reviewedHead, correctedHead, gatedHead };
  }

  // Check 2: findings-provenance at the reviewed head. The documented disposition shape
  // (parseCorrectionSatisfiedDisposition) accepts a 7-40 character hex prefix for
  // reviewedHead, but stage1-gate.mjs's own trigger-marker and response-binding logic
  // (trigger.mjs's headMarker, poll.mjs's matchBelongsToHead) compare against the *exact*
  // full head SHA the real `@codex review` trigger recorded — never a prefix. Stage 1 review
  // finding on this PR: an abbreviated reviewedHead therefore always reported NOT_REQUESTED,
  // permanently rejecting the advertised short form. Resolve any non-full-length prefix to
  // the full commit SHA first (no extra call for the already-full-length common case).
  let resolvedReviewedHead = reviewedHead;
  if (reviewedHead.length !== 40) {
    let resolved;
    try {
      resolved = await resolveCommitImpl({ repo, sha: reviewedHead });
    } catch (err) {
      return { exitCode: 1, message: `commit resolution threw for reviewed head ${reviewedHead}: ${err.message}` };
    }
    if (!resolved) {
      return {
        exitCode: 2,
        state: "NOT_SATISFIED",
        reviewedHead,
        correctedHead,
        reason: `reviewedHead ${reviewedHead} does not resolve to a real commit in ${repo} — a correction-satisfied disposition requires a real, reviewable commit.`,
      };
    }
    resolvedReviewedHead = resolved.toLowerCase();
  }

  let stage1;
  try {
    stage1 = await stage1RunImpl({ repo, number: pr, head: resolvedReviewedHead });
  } catch (err) {
    return { exitCode: 1, message: `stage1-gate threw for reviewed head ${resolvedReviewedHead}: ${err.message}` };
  }
  if (!stage1 || typeof stage1.exitCode !== "number") {
    return {
      exitCode: 1,
      message: "stage1-gate returned output without a trustworthy exitCode for the reviewed head.",
    };
  }
  if (stage1.exitCode === 1) {
    return { exitCode: 1, message: `stage1-gate operational error at reviewed head ${reviewedHead}: ${stage1.message}` };
  }
  if (stage1.state !== "RESPONSE_RECEIVED" || !hasFindingsStage1Response(stage1)) {
    return {
      exitCode: 2,
      state: "NOT_SATISFIED",
      reviewedHead,
      correctedHead,
      reason:
        stage1.state === "RESPONSE_RECEIVED"
          ? `reviewed head ${reviewedHead} has a genuine Stage 1 response, but it carries no findings-bearing ` +
            "match (a clean-pass response can never back a correction-satisfied disposition — there would be " +
            "nothing to have corrected)."
          : `reviewed head ${reviewedHead}'s Stage 1 result is ${JSON.stringify(stage1.state)}, not ` +
            "RESPONSE_RECEIVED — a correction-satisfied disposition requires a genuine, findings-bearing Stage 1 " +
            "response to already exist at the reviewed head.",
    };
  }

  // Check 3: ancestry between reviewed and corrected heads.
  let compare;
  try {
    compare = await compareImpl({ repo, base: reviewedHead, head: correctedHead });
  } catch (err) {
    return { exitCode: 1, message: `compare failed for ${reviewedHead}...${correctedHead}: ${err.message}` };
  }
  if (!compare || typeof compare.status !== "string") {
    return { exitCode: 1, message: "compare returned output without a trustworthy status field." };
  }
  if (compare.status !== "ahead") {
    return {
      exitCode: 2,
      state: "NOT_SATISFIED",
      reviewedHead,
      correctedHead,
      reason:
        `compare(${reviewedHead}...${correctedHead}) reported status ${JSON.stringify(compare.status)}, not ` +
        '"ahead" — a correction-satisfied disposition requires the corrected head to be a strict, non-diverged ' +
        "descendant of the reviewed head with at least one real intervening commit.",
    };
  }

  return { exitCode: 0, state: "CORRECTION_SATISFIED", reviewedHead, correctedHead };
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const value = argv[++i];
    switch (key) {
      case "reviewed-head":
        args.reviewedHead = value;
        break;
      case "corrected-head":
        args.correctedHead = value;
        break;
      case "gated-head":
        args.gatedHead = value;
        break;
      default:
        args[key] = value;
    }
  }
  return args;
}

// Async. Standalone CLI wrapper. `checkCorrectionDeltaImpl` is injected so tests can drive
// `run` end-to-end without touching the real network or `gh` CLI.
export async function run(args, { checkCorrectionDeltaImpl = checkCorrectionDelta } = {}) {
  const { repo, pr, reviewedHead, correctedHead } = args;
  const gatedHead = args.gatedHead ?? correctedHead;

  if (!repo || !pr || !reviewedHead || !correctedHead) {
    return {
      exitCode: 1,
      message: "Missing required args: --repo, --pr, --reviewed-head, and --corrected-head are all required.",
    };
  }

  return checkCorrectionDeltaImpl({ repo, pr, reviewedHead, correctedHead, gatedHead });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await run(args);
  if (result.exitCode === 1) {
    console.error(result.message);
  } else {
    console.log(JSON.stringify(result));
  }
  process.exit(result.exitCode);
}

// Only run as a CLI when invoked directly, not when the test file imports these functions.
if (process.argv[1] && process.argv[1].endsWith("stage1-correction-gate.mjs")) {
  main();
}
