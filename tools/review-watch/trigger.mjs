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
// that prior trigger as already-satisfied and refuse to post the retry.
//
// Idempotent by default: if a comment containing `@codex review` already exists on the
// thread (scoped to --head when given), this exits 0 without posting a second one. Success
// prints the bare ISO timestamp of the (existing or newly posted) trigger to stdout — ready
// to feed straight into `poll.mjs --since` — with human-readable detail (posted/url) on
// stderr.
//
// Exit codes: 0 = success, 1 = operational error (bad/missing args, `gh` failure, or an
// unexpected response shape from the comments read).
//
// Tests: node --test tools/review-watch/trigger.test.mjs

import { execFileSync } from "node:child_process";
import { endpointsFor } from "./poll.mjs";

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

export function headMarker(head) {
  return head ? `<!-- ldl-trigger-head:${head} -->` : null;
}

export function triggerCommentBody(head) {
  const marker = headMarker(head);
  return marker ? `${TRIGGER_TEXT}\n${marker}` : TRIGGER_TEXT;
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

  if (!force) {
    let comments;
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

    const existing = findExistingTrigger(comments, { head });
    if (existing) {
      return { exitCode: 0, timestamp: existing.created_at, posted: false, url: existing.html_url ?? null };
    }
  }

  let posted;
  try {
    posted = await ghPostImpl({ repo, kind, number, head });
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
function defaultGhPost({ repo, kind, number, head }) {
  const sub = kind === "pr" ? "pr" : "issue";
  const body = triggerCommentBody(head);
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
