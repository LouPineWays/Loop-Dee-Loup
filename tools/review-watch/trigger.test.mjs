// Tests for tools/review-watch/trigger.mjs. All `gh` access is faked via the injected
// `ghApiImpl`/`ghPostImpl` options — never touch the real network or `gh` CLI here. Run
// with: node --test tools/review-watch/trigger.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, headMarker, triggerCommentBody, findExistingTrigger, run } from "./trigger.mjs";

test("parseArgs: reads flags", () => {
  const args = parseArgs(["--repo", "owner/repo", "--kind", "pr", "--number", "50", "--head", "abc123"]);
  assert.equal(args.repo, "owner/repo");
  assert.equal(args.kind, "pr");
  assert.equal(args.number, "50");
  assert.equal(args.head, "abc123");
});

test("headMarker: null when no head is given", () => {
  assert.equal(headMarker(undefined), null);
});

test("triggerCommentBody: plain trigger text when no head is given", () => {
  assert.equal(triggerCommentBody(undefined), "@codex review");
});

test("triggerCommentBody: embeds the head marker when a head is given", () => {
  const body = triggerCommentBody("abc123");
  assert.match(body, /^@codex review\n/);
  assert.equal(body, `@codex review\n${headMarker("abc123")}`);
});

test("findExistingTrigger: matches a comment containing the trigger text", () => {
  const match = findExistingTrigger([{ id: 1, body: "please @codex review this", created_at: "2026-08-23T14:00:00Z" }]);
  assert.equal(match.id, 1);
});

test("findExistingTrigger: ignores comments that don't contain the trigger text", () => {
  const match = findExistingTrigger([{ id: 1, body: "looks good to me", created_at: "2026-08-23T14:00:00Z" }]);
  assert.equal(match, null);
});

test("findExistingTrigger: returns null for an empty thread", () => {
  assert.equal(findExistingTrigger([]), null);
});

test("findExistingTrigger: returns the earliest match when more than one exists", () => {
  const match = findExistingTrigger([
    { id: 1, body: "@codex review", created_at: "2026-08-23T15:00:00Z" },
    { id: 2, body: "@codex review", created_at: "2026-08-23T14:00:00Z" },
  ]);
  assert.equal(match.id, 2);
});

test("findExistingTrigger: with a head, ignores a trigger comment scoped to a different (older) head", () => {
  const match = findExistingTrigger(
    [{ id: 1, body: triggerCommentBody("old-sha"), created_at: "2026-08-23T14:00:00Z" }],
    { head: "new-sha" },
  );
  assert.equal(match, null, "a stale older-head trigger must not be reported as covering the new head");
});

test("findExistingTrigger: with a head, matches a trigger comment scoped to that exact head", () => {
  const match = findExistingTrigger(
    [{ id: 1, body: triggerCommentBody("abc123"), created_at: "2026-08-23T14:00:00Z" }],
    { head: "abc123" },
  );
  assert.equal(match.id, 1);
});

test("run: exits 1 when required args are missing", async () => {
  const result = await run({});
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /Missing required args/);
});

test("run: exits 1 on an unknown --kind", async () => {
  const result = await run({ repo: "owner/repo", kind: "pull", number: 50 });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /--kind must be "pr" or "issue"/);
});

test("run: no prior trigger — posts exactly one and returns its timestamp", async () => {
  let ghApiCalls = 0;
  let ghPostCalls = 0;
  const result = await run(
    { repo: "owner/repo", kind: "issue", number: 53 },
    {
      ghApiImpl: async () => {
        ghApiCalls += 1;
        return [];
      },
      ghPostImpl: async () => {
        ghPostCalls += 1;
        return { created_at: "2026-08-23T14:05:00Z", html_url: "https://github.com/owner/repo/issues/53#c1" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(ghApiCalls, 1);
  assert.equal(ghPostCalls, 1, "must post exactly once when no trigger exists yet");
  assert.equal(result.posted, true);
  assert.equal(result.timestamp, "2026-08-23T14:05:00Z");
});

test("run: a prior trigger already exists — skips posting and returns the existing timestamp", async () => {
  let ghPostCalls = 0;
  const result = await run(
    { repo: "owner/repo", kind: "pr", number: 50 },
    {
      ghApiImpl: async () => [
        { id: 1, body: "@codex review", created_at: "2026-08-23T13:00:00Z", html_url: "https://github.com/owner/repo/pull/50#c1" },
      ],
      ghPostImpl: async () => {
        ghPostCalls += 1;
        return { created_at: "should-not-be-used" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(ghPostCalls, 0, "must never post a duplicate trigger");
  assert.equal(result.posted, false);
  assert.equal(result.timestamp, "2026-08-23T13:00:00Z");
});

test("run: --kind pr and --kind issue both check the issues/comments endpoint", async () => {
  const seenPaths = [];
  const ghApiImpl = async (path) => {
    seenPaths.push(path);
    return [];
  };
  const ghPostImpl = async () => ({ created_at: "2026-08-23T14:05:00Z" });
  await run({ repo: "owner/repo", kind: "pr", number: 50 }, { ghApiImpl, ghPostImpl });
  await run({ repo: "owner/repo", kind: "issue", number: 53 }, { ghApiImpl, ghPostImpl });
  assert.deepEqual(seenPaths, ["repos/owner/repo/issues/50/comments", "repos/owner/repo/issues/53/comments"]);
});

test("run: with --head, a stale trigger from an older head does not block posting at the new head", async () => {
  let ghPostCalls = 0;
  const result = await run(
    { repo: "owner/repo", kind: "pr", number: 50, head: "new-sha" },
    {
      ghApiImpl: async () => [{ id: 1, body: triggerCommentBody("old-sha"), created_at: "2026-08-23T13:00:00Z" }],
      ghPostImpl: async ({ head }) => {
        ghPostCalls += 1;
        assert.equal(head, "new-sha");
        return { created_at: "2026-08-23T14:05:00Z", html_url: "https://github.com/owner/repo/pull/50#c2" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(ghPostCalls, 1, "an older-head trigger must not suppress review of the new head");
  assert.equal(result.posted, true);
});

test("run: with --head, a trigger already posted at that same head is not duplicated", async () => {
  let ghPostCalls = 0;
  const result = await run(
    { repo: "owner/repo", kind: "pr", number: 50, head: "abc123" },
    {
      ghApiImpl: async () => [{ id: 1, body: triggerCommentBody("abc123"), created_at: "2026-08-23T13:00:00Z" }],
      ghPostImpl: async () => {
        ghPostCalls += 1;
        return { created_at: "should-not-be-used" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(ghPostCalls, 0);
  assert.equal(result.timestamp, "2026-08-23T13:00:00Z");
});

test("run: --force true bypasses dedup and reposts even when a trigger already exists", async () => {
  let ghApiCalls = 0;
  let ghPostCalls = 0;
  const result = await run(
    { repo: "owner/repo", kind: "issue", number: 53, force: "true" },
    {
      ghApiImpl: async () => {
        ghApiCalls += 1;
        return [{ id: 1, body: "@codex review", created_at: "2026-08-23T13:00:00Z" }];
      },
      ghPostImpl: async () => {
        ghPostCalls += 1;
        return { created_at: "2026-08-24T09:00:00Z", html_url: "https://github.com/owner/repo/issues/53#c2" };
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(ghApiCalls, 0, "--force must skip the dedup read entirely");
  assert.equal(ghPostCalls, 1, "--force must post a fresh retry trigger");
  assert.equal(result.posted, true);
  assert.equal(result.timestamp, "2026-08-24T09:00:00Z");
});

test("run: surfaces a gh api read failure as exit 1 without attempting to post", async () => {
  let ghPostCalls = 0;
  const result = await run(
    { repo: "owner/repo", kind: "issue", number: 53 },
    {
      ghApiImpl: async () => {
        throw new Error("gh: authentication required");
      },
      ghPostImpl: async () => {
        ghPostCalls += 1;
        return { created_at: "x" };
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /gh api call failed/);
  assert.equal(ghPostCalls, 0, "must not attempt to post after a failed read — no partial post");
});

test("run: surfaces a gh post failure as exit 1", async () => {
  const result = await run(
    { repo: "owner/repo", kind: "issue", number: 53 },
    {
      ghApiImpl: async () => [],
      ghPostImpl: async () => {
        throw new Error("gh: could not post comment");
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /gh comment post failed/);
});

test("run: exits 1 on an unexpected (non-array) response shape instead of guessing", async () => {
  const result = await run(
    { repo: "owner/repo", kind: "issue", number: 53 },
    { ghApiImpl: async () => ({ not: "an array" }) },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /Ambiguous existing-trigger read/);
});
