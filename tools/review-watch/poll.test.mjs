// Tests for tools/review-watch/poll.mjs. All GitHub access is faked via the injected
// `ghApiImpl` option — never touch the real network or `gh` CLI here. Run with:
//   node --test tools/review-watch/poll.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { findAllMatches, endpointsFor, parseArgs, run } from "./poll.mjs";

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
