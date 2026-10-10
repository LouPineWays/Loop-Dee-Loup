// Tests for the pre-first-Stage-1 compatibility witness (issue #1029) and its trigger.mjs wiring.
// All GitHub access is injected; nothing touches the network. Run:
//   node --test tools/review-watch/first-review-compat.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { checkFirstReviewCompat } from "./first-review-compat.mjs";
import { run, triggerCommentBody } from "./trigger.mjs";

// PR #1021 reproduction: head 5dd2da1 vs target a1726d3 (import insertion conflict).
const HEAD = "5dd2da1c128155c44973cf4f9c38ff2ce759eec4";
const TARGET = "a1726d3a18112169321e68ea9fffba77e68dbebd";
const MOVED = "b".repeat(40);

const pr = (over = {}) => ({ state: "OPEN", headRefOid: HEAD, baseRefName: "main", mergeable: "MERGEABLE", ...over });
const base = { repo: "o/r", number: 1021, head: HEAD, sleep: async () => {} };

test("#1021 fixture: CONFLICTING against a stable target is a CONFLICT carrying exact head and target", async () => {
  const r = await checkFirstReviewCompat({
    ...base,
    readPr: async () => pr({ mergeable: "CONFLICTING" }),
    readTarget: async () => TARGET,
  });
  assert.equal(r.verdict, "CONFLICT");
  assert.equal(r.head, HEAD);
  assert.deepEqual(r.target, { ref: "main", sha: TARGET });
});

test("MERGEABLE proceeds (a branch merely behind main needs no successor)", async () => {
  const r = await checkFirstReviewCompat({ ...base, readPr: async () => pr(), readTarget: async () => TARGET });
  assert.equal(r.verdict, "COMPATIBLE");
  assert.equal(r.target.sha, TARGET);
});

test("target moving between reads invalidates the witness and re-evaluates against the new tip", async () => {
  const tips = [TARGET, MOVED, MOVED, MOVED];
  let prReads = 0;
  const r = await checkFirstReviewCompat({
    ...base,
    readPr: async () => (prReads++ < 2 ? pr({ mergeable: "MERGEABLE" }) : pr({ mergeable: "CONFLICTING" })),
    readTarget: async () => tips.shift(),
  });
  assert.equal(r.verdict, "CONFLICT", "must judge against the post-move tip, not the cached compatible claim");
  assert.equal(r.target.sha, MOVED);
});

test("a target that never stabilizes fails closed", async () => {
  let n = 0;
  const r = await checkFirstReviewCompat({
    ...base,
    readPr: async () => pr(),
    readTarget: async () => String(++n).padStart(40, "0"),
  });
  assert.equal(r.verdict, "UNPROVEN");
  assert.match(r.reason, /TARGET_MOVED/);
});

test("UNKNOWN is re-read a bounded number of times, then unproven (never a conflict or compatible verdict)", async () => {
  let reads = 0;
  let sleeps = 0;
  const r = await checkFirstReviewCompat({
    ...base,
    maxAttempts: 3,
    sleep: async () => void sleeps++,
    readPr: async () => (reads++, pr({ mergeable: "UNKNOWN" })),
    readTarget: async () => TARGET,
  });
  assert.equal(r.verdict, "UNPROVEN");
  assert.match(r.reason, /UNKNOWN/);
  assert.equal(sleeps, 2);
  assert.equal(reads, 6);
});

test("UNKNOWN that resolves on a later read is honored", async () => {
  let n = 0;
  const r = await checkFirstReviewCompat({
    ...base,
    readPr: async () => pr({ mergeable: ++n <= 2 ? "UNKNOWN" : "MERGEABLE" }),
    readTarget: async () => TARGET,
  });
  assert.equal(r.verdict, "COMPATIBLE");
});

test("read errors, stale head, and non-open PRs fail closed", async () => {
  const err = await checkFirstReviewCompat({
    ...base,
    readPr: async () => {
      throw new Error("HTTP 502");
    },
    readTarget: async () => TARGET,
  });
  assert.equal(err.verdict, "UNPROVEN");
  assert.match(err.reason, /READ_ERROR/);
  const stale = await checkFirstReviewCompat({
    ...base,
    readPr: async () => pr({ headRefOid: MOVED }),
    readTarget: async () => TARGET,
  });
  assert.match(stale.reason, /STALE_HEAD/);
  const closed = await checkFirstReviewCompat({ ...base, readPr: async () => pr({ state: "MERGED" }), readTarget: async () => TARGET });
  assert.equal(closed.verdict, "UNPROVEN");
  const badTip = await checkFirstReviewCompat({ ...base, readPr: async () => pr(), readTarget: async () => "nope" });
  assert.equal(badTip.verdict, "UNPROVEN");
});

// --- trigger.mjs wiring ---
const thread = (rounds = []) => async () => rounds;

test("trigger: a CONFLICTING first review posts nothing, exits 3, names the successor preflight with exact head", async () => {
  let posts = 0;
  const result = await run(
    { repo: "o/r", kind: "pr", number: 1021, head: HEAD },
    {
      ghApiImpl: thread(),
      ghPostImpl: async () => (posts++, { created_at: "x" }),
      compatImpl: async () => ({ verdict: "CONFLICT", head: HEAD, target: { ref: "main", sha: TARGET } }),
    },
  );
  assert.equal(result.exitCode, 3);
  assert.equal(posts, 0);
  assert.match(result.message, new RegExp(`--expect-predecessor-head ${HEAD}`));
  assert.match(result.message, new RegExp(TARGET));
});

test("trigger: an unproven first review fails closed with exit 1 and posts nothing", async () => {
  let posts = 0;
  const result = await run(
    { repo: "o/r", kind: "pr", number: 1021, head: HEAD },
    {
      ghApiImpl: thread(),
      ghPostImpl: async () => (posts++, { created_at: "x" }),
      compatImpl: async () => ({ verdict: "UNPROVEN", reason: "UNKNOWN: mergeability" }),
    },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(posts, 0);
});

test("trigger: a MERGEABLE first review posts exactly once", async () => {
  let posts = 0;
  const result = await run(
    { repo: "o/r", kind: "pr", number: 1, head: HEAD },
    {
      ghApiImpl: thread(),
      ghPostImpl: async () => (posts++, { created_at: "2026-10-09T00:00:00Z" }),
      compatImpl: async () => ({ verdict: "COMPATIBLE", head: HEAD, target: { ref: "main", sha: TARGET } }),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(posts, 1);
});

test("trigger: repeat after an existing trigger at this head is idempotent and never re-checks or double-posts", async () => {
  let compatCalls = 0;
  let posts = 0;
  const result = await run(
    { repo: "o/r", kind: "pr", number: 1, head: HEAD },
    {
      ghApiImpl: thread([{ body: triggerCommentBody(HEAD), created_at: "2026-10-09T00:00:00Z" }]),
      ghPostImpl: async () => (posts++, { created_at: "x" }),
      compatImpl: async () => (compatCalls++, { verdict: "CONFLICT", target: { ref: "main", sha: TARGET } }),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.posted, false);
  assert.equal(compatCalls, 0);
  assert.equal(posts, 0);
});

test("trigger: a later round at a new head (existing earlier round, no genuine response) is not a first review", async () => {
  let compatCalls = 0;
  const result = await run(
    { repo: "o/r", kind: "pr", number: 1, head: HEAD },
    {
      ghApiImpl: thread([{ body: triggerCommentBody("a".repeat(40)), created_at: "2026-10-09T00:00:00Z" }]),
      ghPostImpl: async () => ({ created_at: "2026-10-09T01:00:00Z" }),
      compatImpl: async () => (compatCalls++, { verdict: "CONFLICT", target: { ref: "main", sha: TARGET } }),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(compatCalls, 0);
});

test("trigger: Stage 2 (--kind issue) never runs the first-review check", async () => {
  let compatCalls = 0;
  const result = await run(
    { repo: "o/r", kind: "issue", number: 53 },
    {
      ghApiImpl: thread(),
      ghPostImpl: async () => ({ created_at: "2026-10-09T01:00:00Z" }),
      compatImpl: async () => (compatCalls++, { verdict: "CONFLICT" }),
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(compatCalls, 0);
});

test("trigger: a non-trigger comment merely quoting a head marker is not a prior round -- the first real trigger is still compat-gated", async () => {
  let compatCalls = 0;
  let posts = 0;
  const result = await run(
    { repo: "o/r", kind: "pr", number: 1, head: HEAD },
    {
      ghApiImpl: thread([
        { body: `discussion quoting the marker <!-- ldl-trigger-head:${"a".repeat(40)} -->`, created_at: "2026-10-09T00:00:00Z" },
      ]),
      ghPostImpl: async () => (posts++, { created_at: "x" }),
      compatImpl: async () => (compatCalls++, { verdict: "CONFLICT", target: { ref: "main", sha: TARGET } }),
    },
  );
  assert.equal(result.exitCode, 3);
  assert.equal(compatCalls, 1);
  assert.equal(posts, 0);
});
