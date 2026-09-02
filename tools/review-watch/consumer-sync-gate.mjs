#!/usr/bin/env node
// Composed automation entry point for docs/bounded-review-cycle.md's Stage 1 trigger
// bookkeeping and merge-ready gate on LDL's recurring, work-issue-less consumer-sync PRs
// (issue #274).
//
// Problem this closes: YouTubery PR #98 reached a clean genuine Codex review, but
// merge-ready-gate.mjs still reported NOT_REQUESTED because the founder's manually-typed
// `@codex review` comment lacked trigger.mjs's own head-scoped marker
// (`<!-- ldl-trigger-head:<sha> -->`) -- the exact provenance dedup/attribution logic
// trigger.mjs and stage1-gate.mjs require. The founder then had to hand-edit that comment to
// add the marker and re-run the gate by hand before it reported PRE_MERGE_READY_NO_WORK_ISSUE.
//
// This script automates that recovery, and only that recovery -- it deliberately does NOT
// attempt to post the `@codex review` trigger itself. Issue #274 asked for the cheapest
// GitHub-native automatic trigger path to be tried first and empirically verified before
// falling back; that trial was run for real (LDL PR #275, comment
// https://github.com/LouPineWays/Loop-Dee-Loup/pull/275#issuecomment-5505737648) and settled
// the question: Codex's connector does receive a Stage 1 trigger comment authored by the
// default GITHUB_TOKEN identity (github-actions[bot]), but that identity has no Codex account
// connected, so it replies with a fixed Codex Cloud connector-setup prompt ("To use Codex
// here, [create a Codex account and connect to github]...") instead of a review -- a
// structural limitation of a bot identity, not a flaky or improvable one. Auto-posting the
// trigger from this script would therefore only ever add a dead-end exchange to every
// consumer-sync PR, never a real review, so it does not. See
// docs/consumer-contract.md, "Automated Stage 1 and merge-ready bookkeeping" for the
// documented finding and the fallback this leads to. (That reply also exposed a genuine gap
// in tools/review-watch/genuine-response.mjs's isCodexCloudSetupPrompt, fixed alongside this
// script so it correctly classifies that reply as non-genuine rather than a false-positive
// RESPONSE_RECEIVED.)
//
// What this script actually automates:
//
//   1. derives the current head automatically when `--head` is omitted (`gh pr view`);
//   2. repairs a bare, markerless `@codex review` comment already on the thread -- the one
//      remaining founder action the required fallback allows (a fixed, zero-computation
//      comment, typed by a human so Codex actually reviews it) -- by appending the current
//      head's marker to it, so a genuine response that comment already drew becomes
//      attributable without anyone hand-editing anything. Repair only happens when the bare
//      comment is not older than the current head's own commit (Stage 1 review finding on
//      this PR): a trigger posted for an earlier head, before the PR advanced to a new head,
//      must never be relabeled onto that later head -- an unbound (no commit_id) genuine
//      response it already drew would then wrongly satisfy the new head's gate;
//   3. runs merge-ready-gate.mjs with the explicit no-work-issue sentinel every recurring
//      sync PR needs (issue #190), since this script is scoped to exactly that PR shape;
//   4. additionally requires the genuine Stage 1 response to be recognizably a *clean*
//      review (Stage 1 review finding on this PR): merge-ready-gate.mjs's exit 0 only proves
//      a genuine response arrived, never that it is finding-free -- that judgment normally
//      belongs to the controlling session under docs/bounded-review-cycle.md Stage 1 steps
//      4-6, which this fully unattended path has no session to perform. `isCleanStage1Response`
//      recognizes Codex's own fixed clean-pass phrasing ("Codex Review: Didn't find any major
//      issues.", observed live on this repository's own merged PRs, e.g. #257/#266) and
//      reports "blocked" instead of "ready" for anything else genuine, including a
//      finding-bearing review -- reproduced live on this very PR (#275, 7 findings).
//
// This does not reimplement trigger.mjs, stage1-gate.mjs, poll.mjs, or merge-ready-gate.mjs --
// it composes them (via findExistingTrigger/headMarker and merge-ready-gate.mjs's `run`),
// plus the two new primitives (bare-trigger repair, clean-response recognition) none of them
// provide.
//
// Usage:
//   node tools/review-watch/consumer-sync-gate.mjs --repo OWNER/REPO --pr 50 [--head <sha>]
//   node tools/review-watch/consumer-sync-gate.mjs --repo OWNER/REPO --pr 50 --set-status true
//
// Result `status` (also the composed exit code below):
//   "ready"          (exit 0) -- merge-ready-gate.mjs returned PRE_MERGE_READY_NO_WORK_ISSUE
//                                AND the genuine Stage 1 response is recognized as clean.
//                                Safe to surface a conspicuous "ready for manual merge" state.
//   "not_requested"  (exit 2) -- no Stage 1 trigger (marked or bare) exists yet at all. The
//                                founder's one remaining action: comment `@codex review` on
//                                this PR -- nothing to compute or copy.
//   "pending"        (exit 2) -- a trigger exists (repaired or already marked) but no genuine
//                                response yet. Not an error -- the normal in-flight state.
//   "blocked"        (exit 2) -- a closing-reference violation, a genuine response that is not
//                                recognized as clean (i.e. it may carry findings), or any other
//                                non-pending BLOCKED composed-gate state. Must never be
//                                reported as ready.
//   "error"          (exit 1) -- an operational failure (bad args, a `gh` failure, malformed
//                                gate output). Never treated as a pass.
//
// --set-status true additionally posts a GitHub commit status on `--head` under the context
// `ldl-sync/merge-ready`, mapping each status above to success/pending/pending/failure/error
// -- one deterministic, always-overwritten status per head, never an accumulating comment
// thread. Omitted (the default) so tests exercise the pure gate logic without a side effect.
//
// Tests: node --test tools/review-watch/consumer-sync-gate.test.mjs

import { execFileSync } from "node:child_process";
import { findExistingTrigger, headMarker } from "./trigger.mjs";
import { run as runMergeReadyGate } from "./merge-ready-gate.mjs";

const TRIGGER_TEXT = "@codex review";

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const value = argv[++i];
    args[key] = value;
  }
  return args;
}

// Pure. The earliest comment on the thread whose trimmed body is *exactly* the trigger
// phrase and that carries no head marker anywhere in it -- i.e. a plain human-typed
// `@codex review` trigger, the zero-computation founder action this issue's Required
// fallback section describes. Deliberately an exact match on the trimmed body, not a
// substring: trigger.mjs's own findTriggerRounds comment explains why a loose substring
// match is unsafe -- a thread discussing this exact mechanism (this file's own review
// thread included) can easily mention the phrase in ordinary prose without it being a
// deliberate trigger.
export function findBareTrigger(comments) {
  const matches = (comments ?? []).filter((c) => (c.body ?? "").trim() === TRIGGER_TEXT);
  if (matches.length === 0) return null;
  matches.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  return matches[0];
}

function statusForGateBlock(gate) {
  const blockedBy = gate.blockedBy ?? [];
  if (blockedBy.length === 1 && blockedBy[0].component === "stage1") {
    if (blockedBy[0].state === "NOT_REQUESTED") return "not_requested";
    if (blockedBy[0].state === "PENDING") return "pending";
  }
  return "blocked";
}

// Codex's own fixed clean-pass phrasing, observed live and unchanged across this
// repository's own merged PRs (e.g. #257, #266): "Codex Review: Didn't find any major
// issues." followed by a varying second sentence. A finding-bearing review instead opens
// "### 💡 Codex Review\n\nHere are some automated review suggestions..." (reproduced live on
// this very PR, #275) -- a structurally different message, never this fixed prefix.
const CLEAN_REVIEW_PATTERN = /^Codex Review: Didn't find any major issues\./;

// Pure. `stage1` is stage1-gate.mjs's own result (nested under merge-ready-gate.mjs's
// composed `gate.stage1`). A genuine response existing (RESPONSE_RECEIVED) only proves Stage
// 1 happened -- stage1-gate.mjs's own header comment is explicit that it "does not evaluate
// whether a reported finding is valid" -- so this script must not treat every
// RESPONSE_RECEIVED as clean. Requires every bound genuine match to carry the known
// clean-pass phrasing; anything else (including a real finding-bearing review) is not
// recognized as clean. EXEMPT is trusted as-is -- a human already declared Stage 1 doesn't
// apply, per docs/bounded-review-cycle.md's own EXEMPT semantics.
export function isCleanStage1Response(stage1) {
  if (!stage1) return false;
  if (stage1.state === "EXEMPT") return true;
  if (stage1.state !== "RESPONSE_RECEIVED") return false;
  const matches = stage1.matches ?? [];
  return matches.length > 0 && matches.every((m) => CLEAN_REVIEW_PATTERN.test(m.body_excerpt ?? ""));
}

// `ghApiImpl`/`ghPatchImpl`/`ghPrViewImpl`/`ghCommitDateImpl`/`runMergeReadyGateImpl`/
// `setStatusImpl` are all injected so tests can drive `run` end-to-end against fakes, never
// the real network or `gh` CLI.
export async function run(
  args,
  {
    ghApiImpl = defaultGhApi,
    ghPatchImpl = defaultGhPatch,
    ghPrViewImpl = defaultGhPrView,
    ghCommitDateImpl = defaultGhCommitDate,
    runMergeReadyGateImpl = runMergeReadyGate,
    setStatusImpl = defaultSetStatus,
  } = {},
) {
  const { repo, pr } = args;
  if (!repo || !pr) {
    return { exitCode: 1, status: "error", message: "Missing required args: --repo and --pr are both required." };
  }
  const setStatus = args["set-status"] === "true" || args["set-status"] === "1";

  let head = args.head;
  if (!head) {
    try {
      head = await ghPrViewImpl({ repo, number: pr });
    } catch (err) {
      return { exitCode: 1, status: "error", message: `gh pr view failed for ${repo}#${pr}: ${err.message}` };
    }
    if (!head) {
      return { exitCode: 1, status: "error", message: `Could not derive a head SHA for ${repo}#${pr}.` };
    }
  }

  // From here on `head` is known, so every remaining early return routes through `finalize`
  // instead of returning directly (Stage 1 review finding on this PR): otherwise, when
  // --set-status is requested and an operational failure happens after this point, a prior
  // run's "success" status posted on this same SHA would be left standing, silently
  // misrepresenting a run that could not actually verify anything as still ready.
  const finalize = async (result) => {
    if (setStatus) {
      try {
        await setStatusImpl({ repo, head, result });
      } catch (err) {
        return {
          exitCode: 1,
          status: "error",
          message: `setting commit status failed: ${err.message}`,
          repaired: result.repaired ?? false,
        };
      }
    }
    return result;
  };

  const commentsPath = `repos/${repo}/issues/${pr}/comments`;
  let comments;
  try {
    comments = await ghApiImpl(commentsPath);
  } catch (err) {
    return finalize({
      exitCode: 1,
      status: "error",
      message: `gh api call failed for ${commentsPath}: ${err.message}`,
      repaired: false,
    });
  }
  if (!Array.isArray(comments)) {
    return finalize({
      exitCode: 1,
      status: "error",
      message: `Ambiguous comments read: expected an array from ${commentsPath}.`,
      repaired: false,
    });
  }

  // Repair only when no marked trigger for this exact head exists yet -- a marked trigger
  // (already repaired, or one a founder happened to post with the marker themselves) already
  // satisfies trigger.mjs/stage1-gate.mjs unchanged, and repairing it again would be a
  // pointless mutation.
  let repaired = false;
  if (!findExistingTrigger(comments, { head })) {
    const bare = findBareTrigger(comments);
    if (bare) {
      let headCommitDate;
      try {
        headCommitDate = await ghCommitDateImpl({ repo, head });
      } catch (err) {
        return finalize({
          exitCode: 1,
          status: "error",
          message: `gh commit lookup failed for ${head}: ${err.message}`,
          repaired: false,
        });
      }
      // Stage 1 review finding on this PR: a bare trigger posted *before* this head's own
      // commit existed cannot be durably associated with this head -- the PR may have moved
      // on since, and an unbound genuine response it already drew would then wrongly satisfy
      // a head it never actually reviewed. Left unrepaired, the current head simply has no
      // trigger yet, which merge-ready-gate.mjs correctly reports as NOT_REQUESTED.
      if (new Date(bare.created_at).getTime() >= new Date(headCommitDate).getTime()) {
        const newBody = `${bare.body}\n${headMarker(head)}`;
        try {
          await ghPatchImpl({ repo, commentId: bare.id, body: newBody });
        } catch (err) {
          return finalize({
            exitCode: 1,
            status: "error",
            message: `gh comment edit failed for comment ${bare.id}: ${err.message}`,
            repaired: false,
          });
        }
        repaired = true;
        // Reflect the edit locally instead of re-reading, so merge-ready-gate.mjs's own reads
        // (a fresh `gh api` call inside stage1-gate.mjs) still land after this PATCH is
        // durable.
        comments = comments.map((c) => (c.id === bare.id ? { ...c, body: newBody } : c));
      }
    }
  }

  let gate;
  try {
    gate = await runMergeReadyGateImpl({ repo, pr, head, issue: "none" });
  } catch (err) {
    return finalize({ exitCode: 1, status: "error", message: `merge-ready-gate threw: ${err.message}`, repaired });
  }

  let result;
  if (gate.exitCode === 1) {
    result = { exitCode: 1, status: "error", message: gate.message, repaired, gate };
  } else if (gate.exitCode === 2) {
    result = { exitCode: 2, status: statusForGateBlock(gate), repaired, gate };
  } else if (isCleanStage1Response(gate.stage1)) {
    result = { exitCode: 0, status: "ready", repaired, gate };
  } else {
    result = {
      exitCode: 2,
      status: "blocked",
      repaired,
      gate,
      message:
        "A genuine Codex response was received but is not recognized as a clean, finding-free review -- " +
        "needs founder/session review before merge.",
    };
  }

  return finalize(result);
}

const STATUS_STATE = {
  ready: "success",
  not_requested: "pending",
  pending: "pending",
  blocked: "failure",
  error: "error",
};
const STATUS_DESCRIPTION = {
  ready: "Clean genuine Codex review + composed gate pass -- ready for manual merge.",
  not_requested: 'No Stage 1 trigger yet -- comment "@codex review" on this PR to request review.',
  pending: "Stage 1 trigger posted; waiting for a genuine Codex response.",
  blocked: "Blocked -- see PR comments / Actions log for the finding or violation.",
  error: "Automation failed to determine merge readiness -- see Actions log.",
};

function defaultSetStatus({ repo, head, result }) {
  execFileSync(
    "gh",
    [
      "api",
      `repos/${repo}/statuses/${head}`,
      "-f",
      `state=${STATUS_STATE[result.status]}`,
      "-f",
      `context=ldl-sync/merge-ready`,
      "-f",
      `description=${STATUS_DESCRIPTION[result.status]}`,
    ],
    { encoding: "utf8" },
  );
}

function defaultGhApi(path) {
  const raw = execFileSync("gh", ["api", path, "--paginate", "--slurp"], { encoding: "utf8" });
  return JSON.parse(raw).flat();
}

function defaultGhPatch({ repo, commentId, body }) {
  execFileSync("gh", ["api", "-X", "PATCH", `repos/${repo}/issues/comments/${commentId}`, "-f", `body=${body}`], {
    encoding: "utf8",
  });
}

function defaultGhPrView({ repo, number }) {
  const raw = execFileSync("gh", ["pr", "view", String(number), "--repo", repo, "--json", "headRefOid"], {
    encoding: "utf8",
  });
  return JSON.parse(raw).headRefOid ?? null;
}

function defaultGhCommitDate({ repo, head }) {
  const raw = execFileSync("gh", ["api", `repos/${repo}/commits/${head}`], { encoding: "utf8" });
  return JSON.parse(raw).commit.committer.date;
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
if (process.argv[1] && process.argv[1].endsWith("consumer-sync-gate.mjs")) {
  main();
}
