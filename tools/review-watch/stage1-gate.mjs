#!/usr/bin/env node
// Deterministic Stage 1 completion gate for docs/bounded-review-cycle.md. A review-worthy
// PR must not be reported as normally complete/merge-ready (AGENTS.md's `CLEAN` chat
// format, or any other "this slice is done" claim) unless durable GitHub evidence shows
// the mandatory Stage 1 `@codex review` actually happened and drew a genuine response.
//
// This closes a recurring omission, not a one-off: LDL issue #32 found a review-worthy PR
// (#31) that merged without Stage 1 despite the rule already being documented in prose, and
// YouTubery issue #12 reproduced the exact same omission independently — a session
// completed, committed, pushed, and reported a slice done without ever requesting the
// required inline review. Both times the rule existed in AGENTS.md; neither time did
// anything mechanically stop the session from treating the slice as complete anyway. This
// script is the mechanical stop: it reuses trigger.mjs's dedup read and poll.mjs's
// genuine-response matching (never a second, competing representation of "did Stage 1
// happen") to compute one of four states from repository evidence — never from
// conversation memory — and fails closed (a non-zero exit) unless that evidence shows
// Stage 1 either does not apply or already drew a genuine response.
//
// States (see docs/bounded-review-cycle.md's "Stage 1 completion gate" section):
//   EXEMPT           — the PR body records an explicit justified exemption. exit 0.
//   NOT_REQUESTED    — no `@codex review` trigger found at the given --head. exit 2.
//   PENDING          — a trigger exists but no genuine post-trigger bot response yet. exit 2.
//   RESPONSE_RECEIVED — a trigger and a genuine post-trigger bot response both exist. exit 0.
//
// Issue #616 (recurrence of #135; live #441/#442, merged PR #615): a claimed exemption
// never grants EXEMPT when the PR's own changed-file set touches a path
// tools/review-watch/control-plane-paths.mjs classifies as mandatory-review under
// docs/bounded-review-cycle.md's Entry check — PR #615 self-declared "Stage 1 exemption:
// evidence-only diagnostic trace" on a changed docs/diagnostic-traces/*.md file and merged
// without independent review, exactly the contradiction this closes. When that happens,
// `run` does not short-circuit to EXEMPT; it records the rejection in a `rejectedExemption`
// field (`{ reason, conflictingPaths }`) on whichever of NOT_REQUESTED/PENDING/
// RESPONSE_RECEIVED the ordinary trigger/response evaluation below produces, so a genuinely
// review-worthy PR still becomes reviewable/mergeable through an actual trigger + response
// — it just cannot shortcut through the self-declared marker. Establishing the changed-file
// set requires its own `gh` call, so this is only attempted when an exemption is actually
// claimed AND `--repo` is Loop-Dee-Loup's own repository (see below); if that lookup itself
// fails or returns something untrustworthy, this fails closed (exit 1) rather than letting
// the absence of evidence become exemption evidence.
//
// PR #622's own Stage 1 review (still issue #616) found and closed three further gaps in
// that first pass, all fixed below:
//   - The Entry check's control-plane policy is scoped to "Within Loop-Dee-Loup's own
//     repository", but this gate is distributed to every consumer repository via
//     tools/review-watch/**. Unconditionally applying Loop's own mandatory-review list would
//     force an installed consumer repository's legitimate, non-mandatory exemption through
//     Stage 1 anyway. The changed-file validation below therefore only runs at all when
//     `isLoopDeeLoupRepo(repo)` is true; any other `--repo` short-circuits to EXEMPT exactly
//     as this gate behaved before issue #616, with zero added `gh` calls.
//   - `gh pr view --json files` silently caps at the first 100 changed files (the installed
//     `gh` CLI's embedded `files(first: 100)` GraphQL query, with no pagination flag), so a
//     mandatory-review path beyond the first page could pass unnoticed. `defaultGhPrFiles`
//     below instead pages the REST pulls/files endpoint with the same `--paginate --slurp`
//     idiom `defaultGhApi` already uses.
//   - That REST endpoint's file objects expose `filename` and, for a rename, the source path
//     as `previous_filename` — the `gh pr view --json files` shape this replaced had no
//     equivalent, so a rename out of a mandatory-review path (e.g. `docs/policy.md` ->
//     `fixtures/policy.txt`) could grant EXEMPT looking only at the destination. `run` below
//     checks both `filename` and, when present, `previous_filename` against
//     isControlPlanePath. A malformed entry (not an object, or a non-string/empty
//     `filename`) fails closed (exit 1) exactly like a lookup error or a non-array response,
//     rather than silently dropping or ignoring it.
//
// RESPONSE_RECEIVED additionally requires the genuine response to be provably bound to the
// exact frozen --head being gated (poll.mjs's matchBelongsToHead), not merely timestamped
// after that head's trigger (issue #163): a delayed response for an older head on the same
// PR must never satisfy a newer head's gate just because it arrived later. A genuine response
// that exists but isn't reliably bound to --head leaves the gate at PENDING, reported via
// unboundGenuineMatches rather than folded into RESPONSE_RECEIVED.
//
// This gate does not evaluate whether a reported finding is valid or whether a correction
// actually fixes it — that is the controlling session's job under Stage 1 steps 4-9. Its
// only job is to prevent the mandatory trigger-and-response transition from being silently
// skipped or assumed.
//
// Usage:
//   node tools/review-watch/stage1-gate.mjs --repo OWNER/REPO --number 50 --head <sha>
//
// Exit codes: 0 = EXEMPT or RESPONSE_RECEIVED (safe to proceed), 2 = NOT_REQUESTED or
// PENDING (must not be reported complete/merge-ready yet), 1 = operational error.
//
// Tests: node --test tools/review-watch/stage1-gate.test.mjs

import { execFileSync } from "node:child_process";
import { endpointsFor, findAllMatches, matchBelongsToHead } from "./poll.mjs";
import { findExistingTrigger, findTriggerRounds } from "./trigger.mjs";
import { isGenuineResponse } from "./genuine-response.mjs";
import { isControlPlanePath, isLoopDeeLoupRepo } from "./control-plane-paths.mjs";

// Re-exported so existing callers/tests that import isGenuineResponse from this module
// (its original home) keep working unchanged now that the classifier itself lives in
// genuine-response.mjs — moved there so trigger.mjs can reuse it without a circular import
// (this module already imports findExistingTrigger from trigger.mjs). See issue #165.
export { isGenuineResponse };

// A PR body records an exemption with a line of the exact form:
//   Stage 1 exemption: <reason>
// e.g. "Stage 1 exemption: docs typo fix, not review-worthy per Entry check." Matched
// against the durable PR body (not a comment, not conversation memory) so a fresh session
// re-running this gate sees the same judgment without reconstructing it.
// [ \t]*, not \s*, after the label: \s matches newlines too, so \s* would let an empty
// "Stage 1 exemption:" line swallow the following line of ordinary description text as
// the "reason", accepting a malformed marker as a justified exemption. Restricting to
// horizontal whitespace forces the reason onto the marker's own line.
const EXEMPTION_PATTERN = /^Stage 1 exemption:[ \t]*(.+)$/im;

// A fence delimiter line per CommonMark's fenced-code-block rule (simplified): up to 3
// leading spaces, then a run of 3+ backticks or 3+ tildes, then anything else (an info
// string on an opening fence; nothing but trailing whitespace on a closing one).
const FENCE_LINE_PATTERN = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;

// Blanks out every line inside a fenced Markdown code/example block (both the fence
// delimiters and their content) so `findExemption` cannot match a `Stage 1 exemption:`
// line that only appears as documentation of the syntax rather than an actual
// declaration (issue #162: a PR body documenting this exemption mechanism in a fenced
// example was misread by EXEMPTION_PATTERN as a real declaration). This is a minimal
// line-oriented fence-state parser, not a general CommonMark implementation: a fence
// opens on a line of 3+ identical backticks/tildes and closes on the next line that is
// nothing but the same character repeated at least as many times, matching ordinary
// GitHub PR body fences (including tilde fences) without handling every CommonMark edge
// case such as nested nonequal-length nonclosing fences beyond that one comparison.
function blankFencedBlocks(body) {
  const lines = body.split("\n");
  let fenceChar = null;
  let fenceLen = 0;
  return lines
    .map((line) => {
      const match = FENCE_LINE_PATTERN.exec(line);
      if (fenceChar) {
        if (match && match[1][0] === fenceChar && match[1].length >= fenceLen && match[2].trim() === "") {
          fenceChar = null;
          fenceLen = 0;
        }
        return "";
      }
      if (match) {
        fenceChar = match[1][0];
        fenceLen = match[1].length;
        return "";
      }
      return line;
    })
    .join("\n");
}

export function findExemption(body) {
  const match = EXEMPTION_PATTERN.exec(blankFencedBlocks(body ?? ""));
  return match ? match[1].trim() : null;
}

export function parseArgs(argv) {
  const args = { bot: "chatgpt-codex-connector[bot]" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const value = argv[++i];
    args[key] = value;
  }
  return args;
}

// `ghApiImpl`, `ghPrViewImpl`, and `ghPrFilesImpl` are injected so tests can drive `run`
// end-to-end without touching the real network or `gh` CLI.
export async function run(
  args,
  { ghApiImpl = defaultGhApi, ghPrViewImpl = defaultGhPrView, ghPrFilesImpl = defaultGhPrFiles } = {},
) {
  const { repo, number, head } = args;
  const bot = args.bot ?? "chatgpt-codex-connector[bot]";

  if (!repo || !number || !head) {
    return { exitCode: 1, message: "Missing required args: --repo, --number, --head are all required." };
  }

  let body;
  try {
    body = await ghPrViewImpl({ repo, number });
  } catch (err) {
    return { exitCode: 1, message: `gh pr view failed for ${repo}#${number}: ${err.message}` };
  }

  const exemption = findExemption(body);
  // Set only when a claimed exemption is rejected for conflicting with a mandatory-review
  // control-plane path (issue #616) — attached to whatever terminal state the ordinary
  // trigger/response evaluation below produces, so the rejection is visible without ever
  // itself granting EXEMPT.
  let rejectedExemption = null;
  // Loop-Dee-Loup's own mandatory-review control-plane policy only applies within
  // Loop-Dee-Loup's own repository (see module comment) — a consumer repository's exemption
  // claim is unaffected and short-circuits exactly as this gate behaved before issue #616,
  // with no changed-file lookup at all.
  if (exemption && !isLoopDeeLoupRepo(repo)) {
    return { exitCode: 0, state: "EXEMPT", reason: exemption };
  }
  if (exemption) {
    let changedFiles;
    try {
      changedFiles = await ghPrFilesImpl({ repo, number });
    } catch (err) {
      return { exitCode: 1, message: `gh api pulls/files failed for ${repo}#${number}: ${err.message}` };
    }
    if (!Array.isArray(changedFiles)) {
      return {
        exitCode: 1,
        message: `Ambiguous changed-file read: expected an array of file entries for ${repo}#${number}.`,
      };
    }
    // Each entry is a REST pulls/files object (`{ filename, previous_filename?, ... }`, see
    // defaultGhPrFiles below). A malformed entry fails closed rather than being silently
    // dropped or coerced — the absence of evidence must never become exemption evidence.
    // Both the current `filename` and, for a rename, the source `previous_filename` are
    // checked: a rename out of a mandatory-review path is still a mandatory-review change
    // (issue #616 Stage 1 review finding).
    const paths = [];
    for (const entry of changedFiles) {
      if (!entry || typeof entry !== "object" || typeof entry.filename !== "string" || entry.filename.length === 0) {
        return {
          exitCode: 1,
          message: `Ambiguous changed-file read: malformed file entry for ${repo}#${number}: ${JSON.stringify(entry)}.`,
        };
      }
      paths.push(entry.filename);
      if (typeof entry.previous_filename === "string" && entry.previous_filename.length > 0) {
        paths.push(entry.previous_filename);
      }
    }
    const conflictingPaths = [...new Set(paths.filter((path) => isControlPlanePath(path)))];
    if (conflictingPaths.length === 0) {
      return { exitCode: 0, state: "EXEMPT", reason: exemption };
    }
    rejectedExemption = { reason: exemption, conflictingPaths };
  }

  const endpoints = endpointsFor("pr", repo, number);
  const commentsEndpoint = endpoints.find((e) => e.name === "issue-comments");

  let comments;
  try {
    comments = await ghApiImpl(commentsEndpoint.path);
  } catch (err) {
    return { exitCode: 1, message: `gh api call failed for ${commentsEndpoint.path}: ${err.message}` };
  }
  if (!Array.isArray(comments)) {
    return {
      exitCode: 1,
      message: `Ambiguous trigger read: expected an array of comments from ${commentsEndpoint.path}.`,
    };
  }

  const trigger = findExistingTrigger(comments, { head });
  if (!trigger) {
    return { exitCode: 2, state: "NOT_REQUESTED", ...(rejectedExemption ? { rejectedExemption } : {}) };
  }

  const sinceMs = new Date(trigger.created_at).getTime();
  const matches = [];
  for (const endpoint of endpoints) {
    // The issue-comments thread was already fetched above for the trigger dedup check;
    // reuse it instead of reading it twice.
    let items = endpoint.name === "issue-comments" ? comments : null;
    if (items === null) {
      try {
        items = await ghApiImpl(endpoint.path);
      } catch (err) {
        return { exitCode: 1, message: `gh api call failed for ${endpoint.path}: ${err.message}` };
      }
    }
    matches.push(...findAllMatches(items, { bot, sinceMs, endpointName: endpoint.name }));
  }

  const nonGenuineMatches = matches.filter((m) => !isGenuineResponse(m.body_excerpt));
  const genuineMatches = matches.filter((m) => isGenuineResponse(m.body_excerpt));

  // Head correlation (issue #163): a genuine response may only satisfy this gate when
  // durable evidence ties it to the exact frozen `head` being evaluated, never merely to
  // "arrived after this head's trigger" — see matchBelongsToHead's own comment in poll.mjs
  // for the delayed-response race this closes. `rounds` is every head-marked trigger round
  // on the whole thread (not just this head's own trigger), since an unbound (no commit_id)
  // match can only be trusted when the thread is unambiguous — exactly one round total.
  const rounds = findTriggerRounds(comments);
  const boundGenuineMatches = genuineMatches.filter((m) => matchBelongsToHead(m, { head, rounds }));
  // Present (possibly empty) in both outcomes below, not only PENDING: a genuine finding
  // that fails head-binding (e.g. an unbound issue comment on a multi-head thread) is still
  // a real post-trigger response the controller must see and verify under Stage 1 steps 4-9
  // — dropping it silently just because a *different*, commit-bound match already satisfied
  // the gate would hide a genuine finding from review (Stage 1 review finding on this PR).
  const unboundGenuineMatches = genuineMatches.filter((m) => !matchBelongsToHead(m, { head, rounds }));

  if (boundGenuineMatches.length === 0) {
    return {
      exitCode: 2,
      state: "PENDING",
      triggerTimestamp: trigger.created_at,
      nonGenuineMatches,
      unboundGenuineMatches,
      ...(rejectedExemption ? { rejectedExemption } : {}),
    };
  }

  return {
    exitCode: 0,
    state: "RESPONSE_RECEIVED",
    triggerTimestamp: trigger.created_at,
    matches: boundGenuineMatches,
    unboundGenuineMatches,
    ...(rejectedExemption ? { rejectedExemption } : {}),
  };
}

function defaultGhApi(path) {
  const raw = execFileSync("gh", ["api", path, "--paginate", "--slurp"], { encoding: "utf8" });
  return JSON.parse(raw).flat();
}

// Returns the PR's changed-file entries (`{ filename, previous_filename?, ... }`, per
// GitHub's REST pulls/files response) — only invoked when a `Stage 1 exemption:` marker is
// actually present AND `--repo` is Loop-Dee-Loup's own repository (see module comment), so
// the common no-exemption/consumer-repository path never pays for this extra `gh` call.
//
// This uses the paginated REST endpoint, not `gh pr view --json files`: that command's
// underlying GraphQL query is `files(first: 100)` with no pagination flag exposed by `gh pr
// view --help`, so it silently drops any changed file beyond the first 100 — a PR with more
// than 100 changed files and a mandatory-review path past that boundary could otherwise
// pass exemption validation unnoticed (issue #616 Stage 1 review finding). `--paginate
// --slurp` is the same idiom defaultGhApi above already uses for issue-comments pages: each
// page's own JSON array arrives wrapped in --slurp's outer array, so `.flat()` merges every
// page into one flat array of file entries regardless of how many pages existed.
function defaultGhPrFiles({ repo, number }) {
  const raw = execFileSync("gh", ["api", `repos/${repo}/pulls/${number}/files`, "--paginate", "--slurp"], {
    encoding: "utf8",
  });
  return JSON.parse(raw).flat();
}

function defaultGhPrView({ repo, number }) {
  const raw = execFileSync("gh", ["pr", "view", String(number), "--repo", repo, "--json", "body"], {
    encoding: "utf8",
  });
  return JSON.parse(raw).body ?? "";
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
if (process.argv[1] && process.argv[1].endsWith("stage1-gate.mjs")) {
  main();
}
