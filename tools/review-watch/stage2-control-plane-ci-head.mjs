#!/usr/bin/env node
// Resolves which exact pre-merge head a Stage 2 audit's control-plane-workflow CI-check
// checklist item must bind to — the correction for audit #508 (control issue #499)'s single
// P2 finding on PR #507.
//
// Root cause: docs/bounded-review-cycle.md's Stage 2 step 2 (and the audit-control-issue
// template's own permanently-rendered checklist instructions) previously told every
// checklist-authoring session, unconditionally, to check control-plane-workflow CI runs
// against "the PR's frozen reviewed head SHA (Stage 1 step 2)". That instruction is correct
// for an ordinary Stage 1 pass, but stale for docs/bounded-review-cycle.md's own
// "Correction-satisfied disposition" path: when Stage 1 reaches deterministic merge authority
// via a corrected head that is a verified descendant of the reviewed head
// (tools/review-watch/stage1-correction-gate.mjs), the corrected head — not the reviewed head
// — is the actual pre-merge state `merge-ready-gate.mjs` authorized, and it alone ever ran CI.
// Audit #508 (PR #507's own correction-satisfied case) reproduced exactly this: frozen
// reviewed head `05c70da1404ef89954c15be720222a81c01a230c` has zero Actions runs, while
// corrected/merge-authorized head `18f960088bb41704f2f970c72089640dc0c63bb9` has completed run
// `34456423959` — a genuine Codex response correctly followed the checklist's own (stale)
// instruction and correctly reported NOT CLEAN against unverifiable evidence. The defect was
// the checklist instruction, not the writer under audit.
//
// This module fixes the invariant at its source: the exact pre-merge head this checklist item
// must bind to is derived deterministically from the control issue's own "Stage 1" disposition
// bullet (the same raw string `tools/orchestration/ready-dispatch-gate.mjs`'s
// `parseControlBullet(body, "Stage 1")` already extracts) — never guessed, and never the merge
// commit itself (issue #98: control-plane workflows trigger only on `pull_request`, so their
// runs are keyed to a PR branch head, and the commit created on the target branch at merge time
// never appears as a `head_sha` even when CI ran and passed).
//
//   - an ordinary `satisfied at <sha>` / `exempt at <sha>` disposition -> that sha is the
//     frozen reviewed head, and the only head Stage 1 ever authorized; `source: "reviewed"`.
//   - a `correction-satisfied at <corrected-head-sha> (reviewed <reviewed-head-sha>)`
//     disposition (docs/bounded-review-cycle.md's "Correction-satisfied disposition" section)
//     -> the corrected head is the exact head the correction-satisfied machinery verified and
//     merge-ready-gate.mjs actually authorized merge at; `source: "corrected"`.
//   - anything else — an absent/empty bullet, one that looks like an attempted
//     correction-satisfied shape but is malformed, or unrecognized text — fails closed
//     (`ok: false`) rather than guessing which head to check.
//
// Usage: node tools/review-watch/stage2-control-plane-ci-head.mjs --control-issue <N>
//   [--repo <owner/repo>]
// `--repo` is derived deterministically from the checkout's own configured `origin` remote
// (tools/orchestration/ready-dispatch-gate.mjs's `resolveRepoIdentity`, issue #344) when
// omitted — never hand-typed by default, matching every other gate in this repository.
// Exit codes: 0 = resolved (prints `{ ok: true, head, source, ... }` as JSON on stdout),
// 2 = fails closed (prints `{ ok: false, reason }` as JSON on stdout — a real, recognized
// "cannot determine" outcome, not an operational error), 1 = operational error (missing
// argument, unreadable control issue, or unresolvable repo identity).
//
// Stage 1 correction on PR #509 (Codex finding): `resolveControlPlaneCiHead` below accepts the
// same 7-40 character hex-prefix disposition forms tools/review-watch/stage1-correction-gate.mjs
// already established (deliberately, for abbreviated disposition SHAs), but GitHub's
// `actions/runs?head_sha=<sha>` filter requires an exact full-length match and does not resolve
// a prefix — a legitimately short disposition like `correction-satisfied at 18f9600 (...)` would
// otherwise make a real, successful CI run look absent, producing another false NOT CLEAN audit.
// `run()` below resolves a non-40-character `head` to its canonical full commit SHA (reusing
// stage1-correction-gate.mjs's own `defaultResolveCommit`, the established precedent for this
// exact prefix-resolution problem) before returning success, and fails closed (exit 2) rather
// than guessing when the prefix does not resolve to a real commit. `resolveControlPlaneCiHead`
// itself stays a pure, repo-agnostic disposition parser — the resolution step needs network/repo
// access, so it belongs in `run()`, the only place both are available.
//
// Tests: node --test tools/review-watch/stage2-control-plane-ci-head.test.mjs

import { execFileSync } from "node:child_process";
import { parseControlBullet, resolveRepoIdentity } from "../orchestration/ready-dispatch-gate.mjs";
import { defaultResolveCommit } from "./stage1-correction-gate.mjs";

// Matches docs/bounded-review-cycle.md's "Correction-satisfied disposition" bullet shape — an
// independent copy of tools/review-watch/stage1-correction-gate.mjs's own
// CORRECTION_SATISFIED_PATTERN, per this repository's established convention of
// independently-maintained per-consumer copies of this exact pattern (see that module's own
// header comment, and tools/orchestration/next-review-transition-gate.mjs's
// FINDINGS_PREAMBLE_PATTERN comment for the same convention) rather than a forced
// cross-directory import for a two-line regex.
// Deliberately not `$`-anchored at the end (unlike stage1-correction-gate.mjs's own copy,
// which is): a real live bullet (control issue #499, the audit #508 reproduction itself) reads
// `correction-satisfied at <sha> (reviewed <sha>) — merge authorized via the composed
// \`merge-ready-gate.mjs\` (...)`, an evidence annotation appended after the canonical shape
// once merge-ready-gate.mjs actually granted merge authority. That annotation documents an
// already-settled fact for human readers and is not itself a competing disposition, so it must
// not make this resolver fail closed on the exact issue it exists to serve. Only the required
// leading shape is validated; trailing prose is ignored.
const CORRECTION_SATISFIED_PATTERN =
  /^correction-satisfied\s+at\s+([0-9a-f]{7,40})\s+\(reviewed\s+([0-9a-f]{7,40})\)/i;

// Matches docs/bounded-review-cycle.md's two pre-existing ordinary Stage 1 disposition shapes
// — an independent copy of tools/orchestration/next-review-transition-gate.mjs's own private
// parseAffirmativeStage1Disposition regex (not exported by that module), same convention as
// above. Also not `$`-anchored, for the same trailing-annotation tolerance as above; `\b` still
// stops the sha capture at the same hex boundary a `$`-anchored match would.
const AFFIRMATIVE_DISPOSITION_PATTERN = /^(?:satisfied|exempt)\s+at\s+([0-9a-f]{7,40})\b/i;

// Pure. `raw` is the control issue's own "Stage 1" bullet value (the same string
// parseControlBullet(body, "Stage 1") extracts). See module comment for the full contract.
// Never throws.
export function resolveControlPlaneCiHead(raw) {
  if (typeof raw !== "string") {
    return { ok: false, reason: "no Stage 1 disposition bullet found on the control issue (not a string)" };
  }
  const text = raw.trim();
  if (!text) {
    return { ok: false, reason: "no Stage 1 disposition bullet found on the control issue (empty)" };
  }

  const correction = CORRECTION_SATISFIED_PATTERN.exec(text);
  if (correction) {
    const correctedHead = correction[1].toLowerCase();
    const reviewedHead = correction[2].toLowerCase();
    return { ok: true, head: correctedHead, source: "corrected", reviewedHead, correctedHead };
  }

  // Present but malformed: distinguishes "attempted this shape and got it wrong" from "absent
  // entirely" — mirrors stage1-correction-gate.mjs's own looksLikeCorrectionSatisfiedDisposition
  // fail-closed distinction (that module's own Stage 1 review finding: a bullet clearly
  // attempting this shape must never be silently treated the same as no disposition at all).
  if (/^correction-satisfied\b/i.test(text)) {
    return {
      ok: false,
      reason:
        "Stage 1 bullet looks like a correction-satisfied disposition but does not match the required " +
        `"correction-satisfied at <sha> (reviewed <sha>)" shape: ${JSON.stringify(text)}`,
    };
  }

  const affirmative = AFFIRMATIVE_DISPOSITION_PATTERN.exec(text);
  if (affirmative) {
    const head = affirmative[1].toLowerCase();
    return { ok: true, head, source: "reviewed", reviewedHead: head, correctedHead: null };
  }

  return {
    ok: false,
    reason:
      'Stage 1 bullet does not match any recognized disposition shape (expected "satisfied at <sha>", ' +
      `"exempt at <sha>", or "correction-satisfied at <sha> (reviewed <sha>)"): ${JSON.stringify(text)}`,
  };
}

function defaultGhIssueView({ repo, number }) {
  const raw = execFileSync("gh", ["issue", "view", String(number), "--repo", repo, "--json", "body"], {
    encoding: "utf8",
  });
  return JSON.parse(raw);
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    args[key === "control-issue" ? "controlIssue" : key] = argv[++i];
  }
  return args;
}

// Async. `ghIssueViewImpl`/`resolveRepoIdentityImpl`/`resolveCommitImpl` are injected so tests
// can drive this end-to-end without touching the real network, `gh` CLI, or `git` binary.
export async function run(
  args,
  {
    ghIssueViewImpl = defaultGhIssueView,
    resolveRepoIdentityImpl = resolveRepoIdentity,
    resolveCommitImpl = defaultResolveCommit,
  } = {},
) {
  const { controlIssue } = args;
  if (!controlIssue) {
    return { exitCode: 1, message: "Missing required arg: --control-issue." };
  }

  let repo = args.repo;
  if (!repo) {
    const identity = resolveRepoIdentityImpl();
    if (!identity.ok) {
      return { exitCode: 1, message: `Could not resolve repository identity: ${identity.reason}` };
    }
    repo = identity.repo;
  }

  let issueData;
  try {
    issueData = await ghIssueViewImpl({ repo, number: controlIssue });
  } catch (err) {
    return { exitCode: 1, message: `gh issue view failed for ${repo}#${controlIssue}: ${err.message}` };
  }

  const bullet = parseControlBullet(issueData.body ?? "", "Stage 1");
  const resolved = resolveControlPlaneCiHead(bullet);
  if (!resolved.ok) {
    return { exitCode: 2, ...resolved };
  }

  // Full-length heads need no lookup (the common case, and the exact optimization
  // stage1-correction-gate.mjs's own resolver already applies for the same reason). A shorter
  // hex prefix must resolve to a real commit before it is ever forwarded as a successful `head`
  // — see module header comment.
  if (resolved.head.length !== 40) {
    let fullHead;
    try {
      fullHead = await resolveCommitImpl({ repo, sha: resolved.head });
    } catch (err) {
      return {
        exitCode: 1,
        message: `commit resolution threw for ${resolved.source} head ${resolved.head}: ${err.message}`,
      };
    }
    if (!fullHead) {
      return {
        exitCode: 2,
        ok: false,
        reason:
          `${resolved.source} head ${resolved.head} (from the control issue's Stage 1 disposition) ` +
          `does not resolve to a real commit in ${repo}.`,
      };
    }
    resolved.head = fullHead.toLowerCase();
  }

  return { exitCode: 0, ...resolved };
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
if (process.argv[1] && process.argv[1].endsWith("stage2-control-plane-ci-head.mjs")) {
  main();
}
