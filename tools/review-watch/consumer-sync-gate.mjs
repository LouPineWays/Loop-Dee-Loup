#!/usr/bin/env node
// Composed automation entry point for docs/bounded-review-cycle.md's Stage 1 trigger and
// merge-ready bookkeeping on LDL's recurring, work-issue-less consumer-sync PRs (issue #274).
//
// Problem this closes: YouTubery PR #98 reached a clean genuine Codex review, but
// merge-ready-gate.mjs still reported NOT_REQUESTED because the founder's manually-typed
// `@codex review` comment lacked trigger.mjs's own head-scoped marker
// (`<!-- ldl-trigger-head:<sha> -->`) -- the exact provenance dedup/attribution logic
// trigger.mjs and stage1-gate.mjs require. The founder then had to hand-edit that comment to
// add the marker and re-run the gate by hand before it reported PRE_MERGE_READY_NO_WORK_ISSUE.
// This script automates that whole recovery mechanically:
//
//   1. derives the current head automatically when `--head` is omitted (`gh pr view`);
//   2. repairs a bare, markerless `@codex review` comment already on the thread by appending
//      the current head's marker to it -- so a genuine response a plain human-typed trigger
//      already drew becomes attributable without anyone hand-editing anything;
//   3. posts a fresh, correctly-marked trigger via trigger.mjs when no trigger (marked or
//      bare) exists at all yet, attempting the fully-automatic native path this issue prefers;
//   4. runs merge-ready-gate.mjs with the explicit no-work-issue sentinel every recurring sync
//      PR needs (issue #190), since this script is scoped to exactly that PR shape.
//
// This does not reimplement trigger.mjs, stage1-gate.mjs, poll.mjs, or merge-ready-gate.mjs --
// it composes them, plus one new primitive (bare-trigger repair) none of them provide. Every
// one-round / cross-head / genuine-response protection those scripts already enforce (see
// trigger.mjs's own header comment) propagates untouched through the `runTriggerImpl` call
// below -- this script adds no override and cannot bypass them.
//
// Usage:
//   node tools/review-watch/consumer-sync-gate.mjs --repo OWNER/REPO --pr 50 [--head <sha>]
//   node tools/review-watch/consumer-sync-gate.mjs --repo OWNER/REPO --pr 50 --set-status true
//
// Result `status` (also the composed exit code below):
//   "ready"   (exit 0) -- merge-ready-gate.mjs returned PRE_MERGE_READY_NO_WORK_ISSUE. Safe to
//                         surface a conspicuous "ready for manual merge" GitHub state.
//   "pending" (exit 2) -- a Stage 1 trigger exists (bot-posted or repaired) but no genuine
//                         response yet. Not an error -- the normal in-flight state between
//                         trigger and response.
//   "blocked" (exit 2) -- a founder-interrupt trigger block (cross-head or repeat-round), a
//                         closing-reference violation, or any other non-pending BLOCKED
//                         composed-gate state. Must never be reported as ready.
//   "error"   (exit 1) -- an operational failure (bad args, a `gh` failure, malformed gate
//                         output). Never treated as a pass.
//
// --set-status true additionally posts a GitHub commit status on `--head` under the context
// `ldl-sync/merge-ready`, mapping ready/pending/blocked/error to success/pending/failure/error
// -- one deterministic, always-overwritten status per head, never an accumulating comment
// thread. Omitted (the default) so tests exercise the pure gate logic without a side effect.
//
// Tests: node --test tools/review-watch/consumer-sync-gate.test.mjs

import { execFileSync } from "node:child_process";
import { run as runTrigger, findExistingTrigger, headMarker } from "./trigger.mjs";
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
  const pendingOnly =
    blockedBy.length === 1 &&
    blockedBy[0].component === "stage1" &&
    ["NOT_REQUESTED", "PENDING"].includes(blockedBy[0].state);
  return pendingOnly ? "pending" : "blocked";
}

// `ghApiImpl`/`ghPatchImpl`/`ghPrViewImpl`/`runTriggerImpl`/`runMergeReadyGateImpl`/
// `setStatusImpl` are all injected so tests can drive `run` end-to-end against fakes,
// never the real network or `gh` CLI.
export async function run(
  args,
  {
    ghApiImpl = defaultGhApi,
    ghPatchImpl = defaultGhPatch,
    ghPrViewImpl = defaultGhPrView,
    runTriggerImpl = runTrigger,
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
  // (bot-posted or already repaired) already satisfies trigger.mjs/stage1-gate.mjs
  // unchanged, and repairing it again would be a pointless mutation.
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
      // Reflect the edit locally instead of re-reading, so the trigger.mjs call below sees
      // the repaired body immediately without racing a second live read.
      comments = comments.map((c) => (c.id === bare.id ? { ...c, body: newBody } : c));
    }
  }

  let trigger;
  try {
    trigger = await runTriggerImpl(
      { repo, kind: "pr", number: pr, head },
      { ghApiImpl: (path) => (path === commentsPath ? comments : ghApiImpl(path)) },
    );
  } catch (err) {
    return { exitCode: 1, status: "error", message: `trigger.mjs threw: ${err.message}`, repaired };
  }
  if (trigger.exitCode === 1) {
    return { exitCode: 1, status: "error", message: `trigger.mjs: ${trigger.message}`, repaired };
  }
  if (trigger.exitCode === 2) {
    // A founder-interrupt block (cross-head repeat-round, or Stage 2's genuine-issue-response
    // guard) -- never something this automation may resolve on its own. Surface it as
    // blocked, never as pending or ready.
    return { exitCode: 2, status: "blocked", message: trigger.message, repaired, trigger };
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

const STATUS_STATE = { ready: "success", pending: "pending", blocked: "failure", error: "error" };
const STATUS_DESCRIPTION = {
  ready: "Clean genuine Codex review + composed gate pass -- ready for manual merge.",
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
