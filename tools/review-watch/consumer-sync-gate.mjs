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
//      attributable without anyone hand-editing anything;
//   3. runs merge-ready-gate.mjs with the explicit no-work-issue sentinel every recurring
//      sync PR needs (issue #190), since this script is scoped to exactly that PR shape.
//
// This does not reimplement trigger.mjs, stage1-gate.mjs, poll.mjs, or merge-ready-gate.mjs --
// it composes them (via findExistingTrigger/headMarker and merge-ready-gate.mjs's `run`),
// plus the one new primitive (bare-trigger repair) none of them provide.
//
// Usage:
//   node tools/review-watch/consumer-sync-gate.mjs --repo OWNER/REPO --pr 50 [--head <sha>]
//   node tools/review-watch/consumer-sync-gate.mjs --repo OWNER/REPO --pr 50 --set-status true
//
// Result `status` (also the composed exit code below):
//   "ready"          (exit 0) -- merge-ready-gate.mjs returned PRE_MERGE_READY_NO_WORK_ISSUE.
//                                Safe to surface a conspicuous "ready for manual merge" state.
//   "not_requested"  (exit 2) -- no Stage 1 trigger (marked or bare) exists yet at all. The
//                                founder's one remaining action: comment `@codex review` on
//                                this PR -- nothing to compute or copy.
//   "pending"        (exit 2) -- a trigger exists (repaired or already marked) but no genuine
//                                response yet. Not an error -- the normal in-flight state.
//   "blocked"        (exit 2) -- a closing-reference violation or any other non-pending
//                                BLOCKED composed-gate state. Must never be reported as ready.
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

// `ghApiImpl`/`ghPatchImpl`/`ghPrViewImpl`/`runMergeReadyGateImpl`/`setStatusImpl` are all
// injected so tests can drive `run` end-to-end against fakes, never the real network or
// `gh` CLI.
export async function run(
  args,
  {
    ghApiImpl = defaultGhApi,
    ghPatchImpl = defaultGhPatch,
    ghPrViewImpl = defaultGhPrView,
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

  const commentsPath = `repos/${repo}/issues/${pr}/comments`;
  let comments;
  try {
    comments = await ghApiImpl(commentsPath);
  } catch (err) {
    return { exitCode: 1, status: "error", message: `gh api call failed for ${commentsPath}: ${err.message}` };
  }
  if (!Array.isArray(comments)) {
    return {
      exitCode: 1,
      status: "error",
      message: `Ambiguous comments read: expected an array from ${commentsPath}.`,
    };
  }

  // Repair only when no marked trigger for this exact head exists yet -- a marked trigger
  // (already repaired, or one a founder happened to post with the marker themselves) already
  // satisfies trigger.mjs/stage1-gate.mjs unchanged, and repairing it again would be a
  // pointless mutation.
  let repaired = false;
  if (!findExistingTrigger(comments, { head })) {
    const bare = findBareTrigger(comments);
    if (bare) {
      const newBody = `${bare.body}\n${headMarker(head)}`;
      try {
        await ghPatchImpl({ repo, commentId: bare.id, body: newBody });
      } catch (err) {
        return {
          exitCode: 1,
          status: "error",
          message: `gh comment edit failed for comment ${bare.id}: ${err.message}`,
        };
      }
      repaired = true;
      // Reflect the edit locally instead of re-reading, so merge-ready-gate.mjs's own reads
      // (a fresh `gh api` call inside stage1-gate.mjs) still land after this PATCH is durable.
      comments = comments.map((c) => (c.id === bare.id ? { ...c, body: newBody } : c));
    }
  }

  let gate;
  try {
    gate = await runMergeReadyGateImpl({ repo, pr, head, issue: "none" });
  } catch (err) {
    return { exitCode: 1, status: "error", message: `merge-ready-gate threw: ${err.message}`, repaired };
  }

  let result;
  if (gate.exitCode === 1) {
    result = { exitCode: 1, status: "error", message: gate.message, repaired, gate };
  } else if (gate.exitCode === 2) {
    result = { exitCode: 2, status: statusForGateBlock(gate), repaired, gate };
  } else {
    result = { exitCode: 0, status: "ready", repaired, gate };
  }

  if (setStatus) {
    try {
      await setStatusImpl({ repo, head, result });
    } catch (err) {
      return { exitCode: 1, status: "error", message: `setting commit status failed: ${err.message}`, repaired };
    }
  }

  return result;
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
