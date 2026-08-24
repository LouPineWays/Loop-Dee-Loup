#!/usr/bin/env node
// Deterministic check-then-post step for the `@codex review` trigger shared by Stage 1
// (PR) and Stage 2 (post-merge audit issue) of docs/bounded-review-cycle.md. Replaces
// hand-run `gh` reads and dedup logic — and the need to remember the exact trigger
// timestamp for the later poll — with one idempotent script: check the thread for an
// existing trigger comment, and post exactly one `@codex review` comment only if none
// exists yet. Prints the trigger's ISO timestamp on success, ready to feed straight into
// `tools/review-watch/poll.mjs --since`.
//
// Usage:
//   node tools/review-watch/trigger.mjs --repo OWNER/REPO --kind pr --number 50
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
// Idempotent: if a comment containing `@codex review` already exists on the thread, this
// exits 0 without posting a second one and reports the existing trigger's timestamp
// instead. Otherwise it posts exactly one such comment and reports its timestamp.
//
// Exit codes: 0 = success (existing or newly posted trigger; JSON on stdout with
// `posted`, `timestamp`, `url`), 1 = operational error (bad/missing args, `gh` failure,
// or an unexpected response shape from the comments read).
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

// Pure — no I/O — so tests can exercise it without a network call or `gh`. Returns the
// earliest comment containing the trigger text, or null if none exists. Earliest, not
// latest, so a re-run always reports the same canonical trigger timestamp even if the
// thread somehow already holds more than one (this script itself never posts a second).
export function findExistingTrigger(comments) {
  const matches = comments.filter((c) => (c.body ?? "").includes(TRIGGER_TEXT));
  if (matches.length === 0) return null;
  matches.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  return matches[0];
}

// `ghApiImpl` and `ghPostImpl` are injected so tests can drive `run` end-to-end without
// touching the real network or `gh` CLI.
export async function run(args, { ghApiImpl = defaultGhApi, ghPostImpl = defaultGhPost } = {}) {
  const { repo, kind, number } = args;

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

  const existing = findExistingTrigger(comments);
  if (existing) {
    return {
      exitCode: 0,
      message: JSON.stringify({ posted: false, timestamp: existing.created_at, url: existing.html_url ?? null }),
    };
  }

  let posted;
  try {
    posted = await ghPostImpl({ repo, kind, number });
  } catch (err) {
    return { exitCode: 1, message: `gh comment post failed: ${err.message}` };
  }

  return {
    exitCode: 0,
    message: JSON.stringify({ posted: true, timestamp: posted.created_at, url: posted.html_url ?? null }),
  };
}

function defaultGhApi(path) {
  // --paginate --slurp: same convention as poll.mjs, so a busy thread's trigger comment
  // is never missed just because it landed past the first page.
  const raw = execFileSync("gh", ["api", path, "--paginate", "--slurp"], { encoding: "utf8" });
  return JSON.parse(raw).flat();
}

// Posts the trigger via `gh pr comment` / `gh issue comment` (not a raw POST to the
// comments endpoint) so it is authored as the authenticated `gh` user, then reads the
// thread back to obtain the freshly created comment's authoritative timestamp/url rather
// than scraping the CLI's plain-text URL output.
function defaultGhPost({ repo, kind, number }) {
  const sub = kind === "pr" ? "pr" : "issue";
  execFileSync("gh", [sub, "comment", String(number), "--repo", repo, "--body", TRIGGER_TEXT], { encoding: "utf8" });
  const path = endpointsFor(kind, repo, number).find((e) => e.name === "issue-comments").path;
  const raw = execFileSync("gh", ["api", path, "--paginate", "--slurp"], { encoding: "utf8" });
  const comments = JSON.parse(raw).flat();
  const posted = findExistingTrigger(comments);
  if (!posted) throw new Error("posted comment not found on re-read");
  return posted;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await run(args);
  if (result.exitCode === 0) {
    console.log(result.message);
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
