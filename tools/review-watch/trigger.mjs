#!/usr/bin/env node
// Deterministic check-then-post step for the `@codex review` trigger shared by Stage 1
// (PR) and Stage 2 (post-merge audit issue) of docs/bounded-review-cycle.md. Replaces
// hand-run `gh` reads and dedup logic — and the need to remember the exact trigger
// timestamp for the later poll — with one idempotent script: check the thread for an
// existing trigger comment, and post exactly one `@codex review` comment only if none
// exists yet.
//
// Usage:
//   node tools/review-watch/trigger.mjs --repo OWNER/REPO --kind pr --number 50 --head <sha>
//   node tools/review-watch/trigger.mjs --repo OWNER/REPO --kind issue --number 53
//
// --kind pr and --kind issue both check the same GitHub "issue comments" thread
// (repos/OWNER/REPO/issues/NUMBER/comments) — GitHub models a PR as an issue, and the
// trigger comment described by docs/bounded-review-cycle.md Stage 1 step 3 and Stage 2
// step 4 is always a plain thread comment, never an inline review comment on a diff
// position. --kind only selects which `gh` subcommand posts the comment (`gh pr comment`
// vs `gh issue comment`), mirroring poll.mjs's existing --kind split rather than
// introducing a second flag convention.
//
// --head <sha> (Stage 1 only — pass the PR head SHA frozen per that stage's step 2) scopes
// both the dedup check and the posted comment to that exact head via a hidden HTML-comment
// marker. Without it, dedup matches any `@codex review` comment anywhere on the thread,
// which is correct for Stage 2 (a fresh audit issue is opened per merge commit, so the
// whole thread already corresponds to one commit) but wrong for Stage 1 if the PR ever
// legitimately needs a trigger at a second head — an unqualified match would report a stale
// older-head trigger as covering the new head and silently skip requesting review of it.
//
// --force true bypasses the dedup check and always posts a fresh trigger. Use it only after
// determining retry is warranted — e.g. per docs/bounded-review-cycle.md Stage 2 step 10, a
// prior trigger that produced no genuine Codex response (no reply, or a BLOCKED reply) stays
// PENDING and must be retried; without --force, this script's own idempotency would treat
// that prior trigger as already-satisfied and refuse to post the retry. --force only bypasses
// the *same-head* dedup check above — it never bypasses the cross-head block described next.
//
// Cross-head block (issue #165): per-head dedup alone does not stop a session from pushing a
// fix commit (a new head) and re-triggering `@codex review` at that new head, repeatedly,
// even after an *earlier* head on the same PR already drew a genuine Stage 1 response.
// docs/bounded-review-cycle.md Stage 1 step 7 ("Do not request a second inline review on that
// PR... A second invocation is another round and is prohibited by default") already prohibits
// this in prose, but nothing mechanical stopped it — observed directly on PR #164, which
// cycled trigger/fix-commit/re-trigger 8 times before a founder intervened. For --kind pr with
// --head given, `run` additionally checks every endpoint this PR could hold a Codex response
// on (pull-comments, pull-reviews, issue-comments) for a genuine response (reusing
// genuine-response.mjs's isGenuineResponse — never a second, competing classifier) already
// attributable to an *earlier* trigger round at a *different* head. If one is found, posting
// is refused (exit 2) unless `--ack-repeat-round "<reason>"` is given, which records the
// reason as a durable marker on the newly posted comment and proceeds. Reserve that override
// for a founder-authorized exception (per AGENTS.md's Founder interrupt conditions) — it exists
// so a genuinely legitimate second round is not permanently impossible, not so this check can
// be routinely worked around.
//
// Idempotent by default: if a comment containing `@codex review` already exists on the
// thread (scoped to --head when given), this exits 0 without posting a second one. Success
// prints the bare ISO timestamp of the (existing or newly posted) trigger to stdout — ready
// to feed straight into `poll.mjs --since` — with human-readable detail (posted/url) on
// stderr.
//
// Exit codes: 0 = success, 1 = operational error (bad/missing args, `gh` failure, or an
// unexpected response shape from the comments read), 2 = blocked — an earlier head on this
// PR already received a genuine response and no --ack-repeat-round override was given.
//
// Tests: node --test tools/review-watch/trigger.test.mjs

import { execFileSync } from "node:child_process";
import { endpointsFor, findAllMatches } from "./poll.mjs";
import { isGenuineResponse } from "./genuine-response.mjs";

const TRIGGER_TEXT = "@codex review";
const DEFAULT_BOT = "chatgpt-codex-connector[bot]";
const HEAD_MARKER_PATTERN = /<!-- ldl-trigger-head:(.+?) -->/;

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

export function headMarker(head) {
  return head ? `<!-- ldl-trigger-head:${head} -->` : null;
}

// Records an --ack-repeat-round override as a durable marker on the posted comment, so a
// second (or later) Stage 1 round at a new head carries visible, recorded justification
// rather than merely bypassing the check silently. "-->" is escaped so an adversarial or
// careless reason string can't prematurely close the HTML comment.
export function ackMarker(reason) {
  if (!reason) return null;
  const escaped = reason.replace(/-->/g, "--&gt;");
  return `<!-- ldl-repeat-round-ack:${escaped} -->`;
}

export function triggerCommentBody(head, ackReason) {
  const lines = [TRIGGER_TEXT, headMarker(head), ackMarker(ackReason)].filter(Boolean);
  return lines.join("\n");
}

// Pure. Extracts the head SHA a trigger comment was scoped to via headMarker's own format, or
// null when the comment carries no head marker (e.g. a Stage 2 issue trigger, which is never
// scoped to a head).
export function extractHeadFromTrigger(body) {
  const match = HEAD_MARKER_PATTERN.exec(body ?? "");
  return match ? match[1] : null;
}

// Pure. Every trigger comment on the thread (any head, not just the one dedup is scoped to),
// each tagged with the head it was posted for and sorted oldest first — the basis for
// attributing a later genuine bot response to the trigger round that requested it.
export function findTriggerRounds(comments) {
  return comments
    .filter((c) => (c.body ?? "").includes(TRIGGER_TEXT))
    .map((c) => ({ head: extractHeadFromTrigger(c.body), timestamp: c.created_at }))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

// Pure. Given trigger rounds sorted oldest first, returns the round a response at
// `responseTimestamp` belongs to: the latest round whose trigger was posted at or before that
// response. This is how one genuine response gets attributed to "the round for head X" without
// needing an explicit upper-bound window per round.
export function attributeRound(rounds, responseTimestamp) {
  const responseMs = new Date(responseTimestamp).getTime();
  let owner = null;
  for (const round of rounds) {
    if (new Date(round.timestamp).getTime() <= responseMs) owner = round;
    else break;
  }
  return owner;
}

// Pure — no I/O. Returns the head of the earliest prior trigger round on this PR that already
// drew a genuine Codex response, as long as that round's head differs from `currentHead` — or
// null if no such round exists. `comments` is the issue-comments thread (source of every
// trigger comment's own head marker); `otherItems` is every other endpoint's items (pull
// review comments, pull reviews) that could also carry a genuine response. Both are combined
// for genuine-response scanning since a Codex reply can land on any of them.
export function findPriorGenuineHead({ comments, otherItems = [], currentHead, bot = DEFAULT_BOT }) {
  const rounds = findTriggerRounds(comments);
  if (rounds.length === 0) return null;

  const sinceMs = new Date(rounds[0].timestamp).getTime();
  const allItems = [...comments, ...otherItems];
  const matches = findAllMatches(allItems, { bot, sinceMs, endpointName: "combined" });

  for (const match of matches) {
    if (!isGenuineResponse(match.body_excerpt)) continue;
    const owner = attributeRound(rounds, match.created_at);
    if (owner && owner.head && owner.head !== currentHead) {
      return owner.head;
    }
  }
  return null;
}

// Pure — no I/O — so tests can exercise it without a network call or `gh`. Returns the
// earliest comment containing the trigger text (and, when `head` is given, that head's
// marker), or null if none exists. Earliest, not latest, so a re-run always reports the
// same canonical trigger timestamp even if the thread somehow already holds more than one
// matching comment.
export function findExistingTrigger(comments, { head } = {}) {
  const marker = headMarker(head);
  const matches = comments.filter((c) => {
    const body = c.body ?? "";
    if (!body.includes(TRIGGER_TEXT)) return false;
    if (marker && !body.includes(marker)) return false;
    return true;
  });
  if (matches.length === 0) return null;
  matches.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  return matches[0];
}

// `ghApiImpl` and `ghPostImpl` are injected so tests can drive `run` end-to-end without
// touching the real network or `gh` CLI.
export async function run(args, { ghApiImpl = defaultGhApi, ghPostImpl = defaultGhPost } = {}) {
  const { repo, kind, number, head } = args;
  const force = args.force === "true" || args.force === "1";
  const ackReason = args["ack-repeat-round"];

  if (!repo || !kind || !number) {
    return { exitCode: 1, message: "Missing required args: --repo, --kind, --number are all required." };
  }

  let endpoints;
  try {
    endpoints = endpointsFor(kind, repo, number);
  } catch (err) {
    return { exitCode: 1, message: err.message };
  }
  const commentsEndpoint = endpoints.find((e) => e.name === "issue-comments");
  if (!commentsEndpoint) {
    return { exitCode: 1, message: `No issue-comments endpoint resolved for --kind ${kind}.` };
  }

  // The cross-head block below needs the full issue-comments thread even under --force,
  // since --force only bypasses the same-head repost dedup, never the cross-head check.
  const needsCommentsRead = !force || (kind === "pr" && head);
  let comments = null;
  if (needsCommentsRead) {
    try {
      comments = await ghApiImpl(commentsEndpoint.path);
    } catch (err) {
      return { exitCode: 1, message: `gh api call failed for ${commentsEndpoint.path}: ${err.message}` };
    }

    if (!Array.isArray(comments)) {
      return {
        exitCode: 1,
        message: `Ambiguous existing-trigger read: expected an array of comments from ${commentsEndpoint.path}.`,
      };
    }
  }

  if (!force) {
    const existing = findExistingTrigger(comments, { head });
    if (existing) {
      return { exitCode: 0, timestamp: existing.created_at, posted: false, url: existing.html_url ?? null };
    }
  }

  if (kind === "pr" && head) {
    const otherItems = [];
    for (const endpoint of endpoints) {
      if (endpoint.name === "issue-comments") continue;
      let items;
      try {
        items = await ghApiImpl(endpoint.path);
      } catch (err) {
        return { exitCode: 1, message: `gh api call failed for ${endpoint.path}: ${err.message}` };
      }
      if (!Array.isArray(items)) {
        return {
          exitCode: 1,
          message: `Ambiguous cross-head response read: expected an array of items from ${endpoint.path}.`,
        };
      }
      otherItems.push(...items);
    }

    const priorHead = findPriorGenuineHead({ comments, otherItems, currentHead: head });
    if (priorHead && !ackReason) {
      return {
        exitCode: 2,
        message:
          `Refusing to post a second Stage 1 trigger on ${repo}#${number}: head ${priorHead} on this PR ` +
          `already received a genuine Codex response. Per docs/bounded-review-cycle.md Stage 1 step 7, a ` +
          `second invocation is another round and is prohibited by default. Pass ` +
          `--ack-repeat-round "<reason>" to record an explicit, founder-authorized override and proceed.`,
        priorGenuineHead: priorHead,
      };
    }
  }

  let posted;
  try {
    posted = await ghPostImpl({ repo, kind, number, head, ackReason });
  } catch (err) {
    return { exitCode: 1, message: `gh comment post failed: ${err.message}` };
  }

  return { exitCode: 0, timestamp: posted.created_at, posted: true, url: posted.html_url ?? null };
}

function defaultGhApi(path) {
  // --paginate --slurp: same convention as poll.mjs, so a busy thread's trigger comment
  // is never missed just because it landed past the first page.
  const raw = execFileSync("gh", ["api", path, "--paginate", "--slurp"], { encoding: "utf8" });
  return JSON.parse(raw).flat();
}

// `gh pr comment` / `gh issue comment` print the URL of the just-created comment
// (".../issuecomment-NNNN") to stdout on success. Parsing that id is how the freshly
// posted comment is identified after the re-read below — `findExistingTrigger`'s
// earliest-match semantics are for dedup, not for locating a comment just posted, and
// would return a pre-existing older trigger instead of this one on a `--force` retry.
export function extractCommentId(ghCommentOutput) {
  const match = String(ghCommentOutput).match(/#issuecomment-(\d+)/);
  if (!match) throw new Error(`could not parse comment id from gh output: ${ghCommentOutput}`);
  return match[1];
}

// Pure — no I/O. Finds the comment with the given id, or null. Used instead of
// `findExistingTrigger` to identify a just-posted comment by its own identity rather
// than by trigger-text dedup semantics.
export function findCommentById(comments, id) {
  return comments.find((c) => String(c.id) === String(id)) ?? null;
}

// Posts the trigger via `gh pr comment` / `gh issue comment` (not a raw POST to the
// comments endpoint) so it is authored as the authenticated `gh` user, then reads the
// thread back and picks out that exact comment by id to obtain its authoritative
// timestamp/url — never re-derived via trigger-text dedup, which would return a stale
// pre-existing trigger instead of the one just posted.
function defaultGhPost({ repo, kind, number, head, ackReason }) {
  const sub = kind === "pr" ? "pr" : "issue";
  const body = triggerCommentBody(head, ackReason);
  const output = execFileSync("gh", [sub, "comment", String(number), "--repo", repo, "--body", body], {
    encoding: "utf8",
  });
  const commentId = extractCommentId(output);
  const path = endpointsFor(kind, repo, number).find((e) => e.name === "issue-comments").path;
  const raw = execFileSync("gh", ["api", path, "--paginate", "--slurp"], { encoding: "utf8" });
  const comments = JSON.parse(raw).flat();
  const posted = findCommentById(comments, commentId);
  if (!posted) throw new Error(`posted comment id ${commentId} not found on re-read`);
  return posted;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await run(args);
  if (result.exitCode === 0) {
    console.error(JSON.stringify({ posted: result.posted, url: result.url }));
    console.log(result.timestamp);
  } else {
    console.error(result.message);
  }
  process.exit(result.exitCode);
}

// Only run as a CLI when invoked directly (`node tools/review-watch/trigger.mjs ...`), not
// when the test file imports these functions.
if (process.argv[1] && process.argv[1].endsWith("trigger.mjs")) {
  main();
}
