#!/usr/bin/env node
// Polls GitHub for a genuine Codex review response and exits the moment one appears,
// instead of running for a fixed timeout window regardless of whether the answer already
// arrived. Fixes the defect in issue #53: a review-watching worker's background loop had
// no early-exit-on-match logic, so it kept re-confirming an already-captured response for
// 11 minutes with nothing — worker or coordinator — ever surfacing it.
//
// Structural fix, not a prompt reminder: when this script is run with
// `run_in_background: true`, the *process itself* terminates as soon as it finds a match,
// so the caller's background-job-done notification fires at match time, not at the end of
// a fixed wait window. There is nothing for a worker to "remember" to check.
//
// Usage:
//   node tools/review-watch/poll.mjs --repo OWNER/REPO --kind pr --number 50 \
//     --since 2026-08-23T14:00:00Z [--interval 150] [--timeout 1800] \
//     [--bot chatgpt-codex-connector[bot]]
//   node tools/review-watch/poll.mjs --repo OWNER/REPO --kind issue --number 53 \
//     --since 2026-08-23T14:00:00Z
//
// --kind pr checks the same three endpoints described in issue #53 (PR review comments,
// PR reviews, and the PR's issue-comments thread). --kind issue checks issue comments only
// (Stage 2 audit responses have no reviews/review-comments endpoints).
//
// --since must be the trigger time (when `@codex review` was posted), so a stale prior
// comment from an earlier round can never be mistaken for the new response.
//
// A match reports every post-trigger bot item found across all checked endpoints in the
// sweep that found one, not just the first — one invocation can post a review body plus
// several inline comments, or (per docs/bounded-review-cycle.md, "multiple comments
// produced by one invocation are one round") several standalone comments, and a caller
// that only saw the first would under-verify the rest of the round.
//
// Exit codes: 0 = matched (match JSON on stdout), 2 = timed out with no match,
// 1 = operational error (bad args, `gh` failure).
//
// Tests: node --test tools/review-watch/poll.test.mjs

import { execFileSync } from "node:child_process";

export function parseArgs(argv) {
  const args = { interval: 150, timeout: 1800, bot: "chatgpt-codex-connector[bot]" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const value = argv[++i];
    args[key] = value;
  }
  return args;
}

export function endpointsFor(kind, repo, number) {
  if (kind === "pr") {
    return [
      { name: "pull-comments", path: `repos/${repo}/pulls/${number}/comments` },
      { name: "pull-reviews", path: `repos/${repo}/pulls/${number}/reviews` },
      { name: "issue-comments", path: `repos/${repo}/issues/${number}/comments` },
    ];
  }
  if (kind === "issue") {
    return [{ name: "issue-comments", path: `repos/${repo}/issues/${number}/comments` }];
  }
  throw new Error(`--kind must be "pr" or "issue", got: ${kind}`);
}

// Pure — no I/O — so tests can exercise it without a network call or `gh`. Returns every
// post-`sinceMs` item authored by `bot` in `items`, not just the first, so one invocation's
// full round of comments/reviews is captured in a single sweep.
export function findAllMatches(items, { bot, sinceMs, endpointName }) {
  const matches = [];
  for (const item of items) {
    const login = item?.user?.login;
    if (login !== bot) continue;
    const timestamp = item.submitted_at || item.created_at;
    if (!timestamp) continue;
    if (new Date(timestamp).getTime() < sinceMs) continue; // stale response from an earlier round
    matches.push({
      endpoint: endpointName,
      id: item.id,
      login,
      created_at: timestamp,
      url: item.html_url ?? null,
      body_excerpt: (item.body ?? "").slice(0, 200),
    });
  }
  return matches;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `ghApiImpl` and `sleepImpl` are injected so tests can drive `run` end-to-end without
// touching the real network or waiting on real timers.
export async function run(args, { ghApiImpl = defaultGhApi, sleepImpl = sleep } = {}) {
  const { repo, kind, number, since, bot } = args;

  if (!repo || !kind || !number || !since) {
    return { exitCode: 1, message: "Missing required args: --repo, --kind, --number, --since are all required." };
  }

  const interval = Number(args.interval);
  if (!Number.isFinite(interval) || interval <= 0) {
    return { exitCode: 1, message: `--interval must be a positive number, got: ${args.interval}` };
  }

  const timeout = Number(args.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return { exitCode: 1, message: `--timeout must be a positive number, got: ${args.timeout}` };
  }

  const sinceMs = new Date(since).getTime();
  if (Number.isNaN(sinceMs)) {
    return { exitCode: 1, message: `--since is not a valid timestamp: ${since}` };
  }

  let endpoints;
  try {
    endpoints = endpointsFor(kind, repo, number);
  } catch (err) {
    return { exitCode: 1, message: err.message };
  }

  const deadline = Date.now() + timeout * 1000;

  while (Date.now() <= deadline) {
    const matches = [];
    for (const endpoint of endpoints) {
      let items;
      try {
        items = await ghApiImpl(endpoint.path);
      } catch (err) {
        return { exitCode: 1, message: `gh api call failed for ${endpoint.path}: ${err.message}` };
      }
      matches.push(...findAllMatches(items, { bot, sinceMs, endpointName: endpoint.name }));
    }
    if (matches.length > 0) {
      return { exitCode: 0, message: JSON.stringify({ matched: true, count: matches.length, matches }) };
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await sleepImpl(Math.min(interval * 1000, remainingMs));
  }

  return {
    exitCode: 2,
    message: JSON.stringify({ matched: false, reason: "timeout", timeoutSeconds: timeout }),
  };
}

// `gh api --paginate` prints each page as its own separate JSON document, not one combined
// document — `gh api --help` states this explicitly ("Each page is a separate JSON array or
// object. Pass --slurp to wrap all pages ... into an outer JSON array"). A single JSON.parse
// on raw multi-page --paginate output throws on a busy thread. --slurp gives one JSON array
// of per-page arrays, which this flattens into one flat array of items.
export function parsePaginatedOutput(raw) {
  return JSON.parse(raw).flat();
}

function defaultGhApi(path) {
  // --paginate: a busy PR/issue thread can push the post-trigger response past the
  // default single-page result, which would otherwise be silently missed on every sweep
  // until the whole poll times out.
  const raw = execFileSync("gh", ["api", path, "--paginate", "--slurp"], { encoding: "utf8" });
  return parsePaginatedOutput(raw);
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

// Only run as a CLI when invoked directly (`node tools/review-watch/poll.mjs ...`), not
// when the test file imports these functions.
if (process.argv[1] && process.argv[1].endsWith("poll.mjs")) {
  main();
}
