// Tests for tools/review-watch/poll.mjs. All GitHub access is faked via the injected
// `ghApiImpl` option — never touch the real network or `gh` CLI here. Run with:
//   node --test tools/review-watch/poll.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { findAllMatches, endpointsFor, parseArgs, run, parsePaginatedOutput, extractCommitId, matchBelongsToHead } from "./poll.mjs";

const BOT = "chatgpt-codex-connector[bot]";
const SINCE = "2026-08-23T14:00:00Z";
const SINCE_MS = new Date(SINCE).getTime();

test("findAllMatches: matches a genuine post-trigger bot comment", () => {
  const matches = findAllMatches(
    [{ id: 1, user: { login: BOT }, created_at: "2026-08-23T14:05:00Z", body: "Stage 1 review complete." }],
    { bot: BOT, sinceMs: SINCE_MS, endpointName: "issue-comments" },
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, 1);
  assert.equal(matches[0].endpoint, "issue-comments");
});

test("findAllMatches: ignores a bot comment from before the trigger time", () => {
  const matches = findAllMatches([{ id: 2, user: { login: BOT }, created_at: "2026-08-23T13:00:00Z" }], {
    bot: BOT,
    sinceMs: SINCE_MS,
    endpointName: "issue-comments",
  });
  assert.deepEqual(matches, []);
});

test("findAllMatches: ignores a fresh comment from a non-bot author", () => {
  const matches = findAllMatches([{ id: 3, user: { login: "someone-else" }, created_at: "2026-08-23T14:05:00Z" }], {
    bot: BOT,
    sinceMs: SINCE_MS,
    endpointName: "issue-comments",
  });
  assert.deepEqual(matches, []);
});

test("findAllMatches: reviews match via submitted_at instead of created_at", () => {
  const matches = findAllMatches([{ id: 4, user: { login: BOT }, submitted_at: "2026-08-23T14:10:00Z" }], {
    bot: BOT,
    sinceMs: SINCE_MS,
    endpointName: "pull-reviews",
  });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, 4);
});

test("findAllMatches: returns every genuine match, not just the first — one invocation can post several comments", () => {
  const matches = findAllMatches(
    [
      { id: 5, user: { login: "someone-else" }, created_at: "2026-08-23T14:01:00Z" },
      { id: 6, user: { login: BOT }, created_at: "2026-08-23T14:02:00Z" },
      { id: 7, user: { login: BOT }, created_at: "2026-08-23T14:03:00Z" },
    ],
    { bot: BOT, sinceMs: SINCE_MS, endpointName: "issue-comments" },
  );
  assert.deepEqual(
    matches.map((m) => m.id),
    [6, 7],
  );
});

test("extractCommitId: reads commit_id when present", () => {
  assert.equal(extractCommitId({ commit_id: "sha-a" }), "sha-a");
});

test("extractCommitId: falls back to original_commit_id when commit_id is absent", () => {
  assert.equal(extractCommitId({ original_commit_id: "sha-b" }), "sha-b");
});

test("extractCommitId: returns null when neither field is present (e.g. a plain issue comment)", () => {
  assert.equal(extractCommitId({ id: 1, body: "no commit fields here" }), null);
});

test("extractCommitId: prefers original_commit_id over a drifted commit_id (verified against PR #175's own review comments, issue #163)", () => {
  // GitHub re-anchors an inline review comment's commit_id forward to a later commit once
  // its diff position survives an intervening push — original_commit_id stays fixed to the
  // commit the comment was actually authored against. Preferring commit_id here would let a
  // stale review comment for an older head silently appear bound to a newer one.
  assert.equal(
    extractCommitId({ commit_id: "sha-newer-after-push", original_commit_id: "sha-actually-reviewed" }),
    "sha-actually-reviewed",
  );
});

test("findAllMatches: carries commit_id through onto the returned match (issue #163)", () => {
  const matches = findAllMatches(
    [{ id: 1, user: { login: BOT }, created_at: "2026-08-23T14:05:00Z", commit_id: "sha-a" }],
    { bot: BOT, sinceMs: SINCE_MS, endpointName: "pull-comments" },
  );
  assert.equal(matches[0].commit_id, "sha-a");
});

test("findAllMatches: commit_id is null when the source item carries no commit identity", () => {
  const matches = findAllMatches([{ id: 1, user: { login: BOT }, created_at: "2026-08-23T14:05:00Z" }], {
    bot: BOT,
    sinceMs: SINCE_MS,
    endpointName: "issue-comments",
  });
  assert.equal(matches[0].commit_id, null);
});

test("matchBelongsToHead: a match with a matching commit_id is bound to that head regardless of round count", () => {
  const rounds = [{ head: "sha-a", timestamp: "2026-08-23T13:00:00Z" }, { head: "sha-b", timestamp: "2026-08-23T14:00:00Z" }];
  assert.equal(matchBelongsToHead({ commit_id: "sha-b" }, { head: "sha-b", rounds }), true);
});

test("matchBelongsToHead: a match whose commit_id names a different head is excluded even after that head's own trigger (issue #163's delayed-response race)", () => {
  const rounds = [{ head: "sha-a", timestamp: "2026-08-23T13:00:00Z" }, { head: "sha-b", timestamp: "2026-08-23T14:00:00Z" }];
  assert.equal(matchBelongsToHead({ commit_id: "sha-a" }, { head: "sha-b", rounds }), false);
});

test("matchBelongsToHead: an unbound match (no commit_id) is trusted only when exactly one trigger round exists", () => {
  const rounds = [{ head: "sha-a", timestamp: "2026-08-23T13:00:00Z" }];
  assert.equal(matchBelongsToHead({ commit_id: null }, { head: "sha-a", rounds }), true);
});

test("matchBelongsToHead: an unbound match fails closed once more than one trigger round exists, even for the latest head", () => {
  const rounds = [{ head: "sha-a", timestamp: "2026-08-23T13:00:00Z" }, { head: "sha-b", timestamp: "2026-08-23T14:00:00Z" }];
  assert.equal(matchBelongsToHead({ commit_id: null }, { head: "sha-b", rounds }), false);
});

test("matchBelongsToHead: a same-head retry (two trigger comments, one head) is not treated as cross-head ambiguity (Stage 1 review finding on issue #163's own PR)", () => {
  const rounds = [{ head: "sha-a", timestamp: "2026-08-23T13:00:00Z" }, { head: "sha-a", timestamp: "2026-08-23T13:30:00Z" }];
  assert.equal(
    matchBelongsToHead({ commit_id: null }, { head: "sha-a", rounds }),
    true,
    "a --force retry at the same frozen head posts a second trigger comment (a second round) but not a second distinct head, so an unbound genuine retry response must still bind",
  );
});

test("parsePaginatedOutput: flattens multiple `gh api --paginate --slurp` pages into one flat array", () => {
  // --slurp wraps each page's own JSON array into one outer array, so 3 items spread across
  // 2 pages arrive as [[{id:1},{id:2}],[{id:3}]] on stdout, not as one flat 3-item array.
  const raw = JSON.stringify([
    [{ id: 1 }, { id: 2 }],
    [{ id: 3 }],
  ]);
  const result = parsePaginatedOutput(raw);
  assert.deepEqual(result.map((i) => i.id), [1, 2, 3]);
});

test("parsePaginatedOutput: a single page still arrives wrapped in --slurp's outer array", () => {
  const raw = JSON.stringify([[{ id: 1 }]]);
  const result = parsePaginatedOutput(raw);
  assert.deepEqual(result.map((i) => i.id), [1]);
});

test("parsePaginatedOutput: an endpoint with no items yields an empty flat array", () => {
  const raw = JSON.stringify([[]]);
  assert.deepEqual(parsePaginatedOutput(raw), []);
});

test("endpointsFor: pr kind checks the three endpoints from issue #53's incident", () => {
  const endpoints = endpointsFor("pr", "owner/repo", 50);
  assert.deepEqual(
    endpoints.map((e) => e.path),
    ["repos/owner/repo/pulls/50/comments", "repos/owner/repo/pulls/50/reviews", "repos/owner/repo/issues/50/comments"],
  );
});

test("endpointsFor: issue kind checks issue comments only", () => {
  const endpoints = endpointsFor("issue", "owner/repo", 53);
  assert.deepEqual(
    endpoints.map((e) => e.path),
    ["repos/owner/repo/issues/53/comments"],
  );
});

test("endpointsFor: rejects an unknown kind", () => {
  assert.throws(() => endpointsFor("pull", "owner/repo", 1), /--kind must be "pr" or "issue"/);
});

test("parseArgs: applies defaults and reads flags", () => {
  const args = parseArgs(["--repo", "owner/repo", "--kind", "pr", "--number", "50", "--since", SINCE]);
  assert.equal(args.repo, "owner/repo");
  assert.equal(args.interval, 150);
  assert.equal(args.timeout, 1800);
  assert.equal(args.bot, BOT);
});

test("run: exits 1 when required args are missing", async () => {
  const result = await run({});
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /Missing required args/);
});

test("run: exits 1 on a non-numeric --interval instead of hot-polling", async () => {
  let ghApiCalls = 0;
  const result = await run(
    { repo: "owner/repo", kind: "issue", number: 53, since: SINCE, interval: "soon", timeout: 1800 },
    { ghApiImpl: async () => { ghApiCalls += 1; return []; } },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /--interval must be a positive number/);
  assert.equal(ghApiCalls, 0, "must reject before ever polling");
});

test("run: exits 1 on a zero or negative --interval", async () => {
  const result = await run({ repo: "owner/repo", kind: "issue", number: 53, since: SINCE, interval: 0, timeout: 1800 });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /--interval must be a positive number/);
});

test("run: exits 1 on a non-numeric --timeout instead of falsely reporting timeout with zero polling", async () => {
  let ghApiCalls = 0;
  const result = await run(
    { repo: "owner/repo", kind: "issue", number: 53, since: SINCE, interval: 150, timeout: "forever" },
    { ghApiImpl: async () => { ghApiCalls += 1; return []; } },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /--timeout must be a positive number/);
  assert.equal(ghApiCalls, 0);
});

test("run: exits 1 on an invalid --since timestamp", async () => {
  const result = await run({
    repo: "owner/repo",
    kind: "issue",
    number: 53,
    since: "not-a-date",
    interval: 150,
    timeout: 1800,
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /not a valid timestamp/);
});

test("run: exits 0 with all matches from the round the moment they appear on the first sweep — no sleep call", async () => {
  let sleepCalls = 0;
  const ghApiImpl = async () => [{ id: 9, user: { login: BOT }, created_at: "2026-08-23T14:05:00Z" }];
  const result = await run(
    { repo: "owner/repo", kind: "issue", number: 53, since: SINCE, bot: BOT, interval: 150, timeout: 1800 },
    { ghApiImpl, sleepImpl: async () => { sleepCalls += 1; } },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(sleepCalls, 0, "must not sleep once a match is already found — this is the early-exit fix for issue #53");
  const parsed = JSON.parse(result.message);
  assert.equal(parsed.matched, true);
  assert.equal(parsed.count, 1);
  assert.equal(parsed.matches[0].id, 9);
});

test("run: a match on the pr-kind pull-comments endpoint doesn't stop it from also collecting a same-sweep match on pull-reviews", async () => {
  const ghApiImpl = async (path) => {
    if (path.endsWith("/comments") && path.includes("/pulls/")) {
      return [{ id: 20, user: { login: BOT }, created_at: "2026-08-23T14:05:00Z" }];
    }
    if (path.includes("/pulls/") && path.endsWith("/reviews")) {
      return [{ id: 21, user: { login: BOT }, submitted_at: "2026-08-23T14:06:00Z" }];
    }
    return [];
  };
  const result = await run(
    { repo: "owner/repo", kind: "pr", number: 59, since: SINCE, bot: BOT, interval: 150, timeout: 1800 },
    { ghApiImpl },
  );
  const parsed = JSON.parse(result.message);
  assert.equal(parsed.count, 2);
  assert.deepEqual(
    parsed.matches.map((m) => m.id).sort(),
    [20, 21],
  );
});

test("run: finds a match only on a later sweep, after sleeping in between", async () => {
  let call = 0;
  const ghApiImpl = async () => {
    call += 1;
    if (call < 3) return []; // no match yet on the first two sweeps
    return [{ id: 10, user: { login: BOT }, created_at: "2026-08-23T14:05:00Z" }];
  };
  let sleepCalls = 0;
  const result = await run(
    { repo: "owner/repo", kind: "issue", number: 53, since: SINCE, bot: BOT, interval: 150, timeout: 1800 },
    { ghApiImpl, sleepImpl: async () => { sleepCalls += 1; } },
  );
  assert.equal(result.exitCode, 0);
  assert.ok(sleepCalls >= 1, "should have slept between sweeps before finding the match");
  assert.equal(JSON.parse(result.message).matches[0].id, 10);
});

test("run: caps the sleep to the time remaining before the deadline instead of always sleeping a full interval", async () => {
  const sleepDurations = [];
  const ghApiImpl = async () => [];
  await run(
    { repo: "owner/repo", kind: "issue", number: 53, since: SINCE, bot: BOT, interval: 150, timeout: 1 },
    { ghApiImpl, sleepImpl: async (ms) => { sleepDurations.push(ms); } },
  );
  // A 1-second budget must never queue a 150-second (interval) sleep.
  for (const ms of sleepDurations) {
    assert.ok(ms <= 1000, `sleep of ${ms}ms exceeds the 1s --timeout budget`);
  }
});

test("run: times out with exit 2 and no match when the deadline has already passed", async () => {
  const ghApiImpl = async () => [];
  const result = await run(
    { repo: "owner/repo", kind: "issue", number: 53, since: SINCE, bot: BOT, interval: 150, timeout: 0.001 },
    { ghApiImpl, sleepImpl: async () => {} },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(JSON.parse(result.message).matched, false);
});

test("run: surfaces a gh api failure as exit 1 rather than treating it as no-match", async () => {
  const ghApiImpl = async () => {
    throw new Error("gh: authentication required");
  };
  const result = await run(
    { repo: "owner/repo", kind: "issue", number: 53, since: SINCE, bot: BOT, interval: 150, timeout: 1800 },
    { ghApiImpl },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /gh api call failed/);
});
