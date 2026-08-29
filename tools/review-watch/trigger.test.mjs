// Tests for tools/review-watch/trigger.mjs. All `gh` access is faked via the injected
// `ghApiImpl`/`ghPostImpl` options — never touch the real network or `gh` CLI here. Run
// with: node --test tools/review-watch/trigger.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs,
  headMarker,
  triggerCommentBody,
  findExistingTrigger,
  extractHeadFromTrigger,
  findTriggerRounds,
  attributeRound,
  findPriorGenuineHead,
  extractCommentId,
  findCommentById,
  run,
} from "./trigger.mjs";

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

test("extractHeadFromTrigger: reads the head back out of a trigger comment body", () => {
  assert.equal(extractHeadFromTrigger(triggerCommentBody("abc123")), "abc123");
});

test("extractHeadFromTrigger: null when the comment carries no head marker", () => {
  assert.equal(extractHeadFromTrigger("@codex review"), null);
});

test("findTriggerRounds: collects every trigger comment tagged by its head, oldest first", () => {
  const rounds = findTriggerRounds([
    { body: triggerCommentBody("head-b"), created_at: "2026-08-24T09:00:00Z" },
    { body: "not a trigger", created_at: "2026-08-24T08:30:00Z" },
    { body: triggerCommentBody("head-a"), created_at: "2026-08-24T08:00:00Z" },
  ]);
  assert.deepEqual(rounds, [
    { head: "head-a", timestamp: "2026-08-24T08:00:00Z" },
    { head: "head-b", timestamp: "2026-08-24T09:00:00Z" },
  ]);
});

test("findTriggerRounds: ignores a comment that merely mentions the trigger text without a head marker (Stage 1 review finding on this PR)", () => {
  const rounds = findTriggerRounds([
    { body: triggerCommentBody("old-sha"), created_at: "2026-08-24T08:00:00Z" },
    {
      body: "Once this is fixed we should re-request @codex review at the new head.",
      created_at: "2026-08-24T08:05:00Z",
    },
    {
      body: "## Review finding\n\nAny comment containing `@codex review` text...",
      created_at: "2026-08-24T08:10:00Z",
    },
  ]);
  assert.deepEqual(rounds, [{ head: "old-sha", timestamp: "2026-08-24T08:00:00Z" }]);
});

test("attributeRound: attributes a response to the latest round at or before its timestamp", () => {
  const rounds = [
    { head: "head-a", timestamp: "2026-08-24T08:00:00Z" },
    { head: "head-b", timestamp: "2026-08-24T09:00:00Z" },
  ];
  assert.equal(attributeRound(rounds, "2026-08-24T08:30:00Z").head, "head-a");
  assert.equal(attributeRound(rounds, "2026-08-24T09:30:00Z").head, "head-b");
});

test("attributeRound: null when the response predates every round", () => {
  const rounds = [{ head: "head-a", timestamp: "2026-08-24T08:00:00Z" }];
  assert.equal(attributeRound(rounds, "2026-08-24T07:00:00Z"), null);
});

test("findPriorGenuineHead: finds an earlier head's genuine response (reproduces PR #164's re-trigger loop)", () => {
  const comments = [
    { body: triggerCommentBody("old-sha"), created_at: "2026-08-24T08:00:00Z" },
    {
      user: { login: "chatgpt-codex-connector[bot]" },
      created_at: "2026-08-24T08:10:00Z",
      body: "Found a real defect: off-by-one in the loop bound.",
    },
  ];
  const priorHead = findPriorGenuineHead({ comments, currentHead: "new-sha" });
  assert.equal(priorHead, "old-sha");
});

test("findPriorGenuineHead: null when the only genuine response belongs to the current head", () => {
  const comments = [
    { body: triggerCommentBody("current-sha"), created_at: "2026-08-24T08:00:00Z" },
    {
      user: { login: "chatgpt-codex-connector[bot]" },
      created_at: "2026-08-24T08:10:00Z",
      body: "Looks good, no defects found.",
    },
  ];
  assert.equal(findPriorGenuineHead({ comments, currentHead: "current-sha" }), null);
});

test("findPriorGenuineHead: null when the earlier head's response was BLOCKED, not genuine", () => {
  const comments = [
    { body: triggerCommentBody("old-sha"), created_at: "2026-08-24T08:00:00Z" },
    {
      user: { login: "chatgpt-codex-connector[bot]" },
      created_at: "2026-08-24T08:10:00Z",
      body: "BLOCKED — checkout unavailable.",
    },
  ];
  assert.equal(findPriorGenuineHead({ comments, currentHead: "new-sha" }), null);
});

test("findPriorGenuineHead: still attributes correctly when an intervening comment merely mentions the trigger text (Stage 1 review finding on this PR)", () => {
  const comments = [
    { body: triggerCommentBody("old-sha"), created_at: "2026-08-24T08:00:00Z" },
    {
      body: "Once this is fixed we should re-request @codex review at the new head.",
      created_at: "2026-08-24T08:05:00Z",
    },
    {
      user: { login: "chatgpt-codex-connector[bot]" },
      created_at: "2026-08-24T08:10:00Z",
      body: "Found a real defect: `@codex review` handling has an off-by-one bug.",
    },
  ];
  const priorHead = findPriorGenuineHead({ comments, currentHead: "new-sha" });
  assert.equal(
    priorHead,
    "old-sha",
    "a discussion comment or the bot's own response mentioning the trigger text must not create a phantom null-head round that swallows the real attribution",
  );
});

test("findPriorGenuineHead: checks otherItems (pull-comments/pull-reviews) too, not just the issue-comments thread", () => {
  const comments = [{ body: triggerCommentBody("old-sha"), created_at: "2026-08-24T08:00:00Z" }];
  const otherItems = [
    {
      user: { login: "chatgpt-codex-connector[bot]" },
      submitted_at: "2026-08-24T08:10:00Z",
      body: "This line has a real bug.",
    },
  ];
  assert.equal(findPriorGenuineHead({ comments, otherItems, currentHead: "new-sha" }), "old-sha");
});

test("findPriorGenuineHead: null when no trigger has been posted yet", () => {
  assert.equal(findPriorGenuineHead({ comments: [], currentHead: "abc123" }), null);
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

test("extractCommentId: parses the id from gh pr/issue comment's printed URL", () => {
  assert.equal(extractCommentId("https://github.com/owner/repo/pull/50#issuecomment-123456789\n"), "123456789");
});

test("extractCommentId: throws on unparseable output instead of silently returning garbage", () => {
  assert.throws(() => extractCommentId("not a url"), /could not parse comment id/);
});

test("findCommentById: selects the comment matching the given id, not merely the earliest trigger match — reproduces the audit's forced-retry scenario (issue #85)", () => {
  const comments = [
    { id: 1, body: "@codex review", created_at: "2026-08-24T08:00:00Z", html_url: "https://github.com/owner/repo/issues/53#issuecomment-1" },
    { id: 2, body: "@codex review", created_at: "2026-08-24T09:00:00Z", html_url: "https://github.com/owner/repo/issues/53#issuecomment-2" },
  ];
  const newId = extractCommentId("https://github.com/owner/repo/issues/53#issuecomment-2");
  const found = findCommentById(comments, newId);
  assert.equal(found.id, 2, "must select the just-posted comment by id, not findExistingTrigger's earliest match");
  assert.equal(found.created_at, "2026-08-24T09:00:00Z");
});

test("findCommentById: returns null when no comment matches the id", () => {
  assert.equal(findCommentById([{ id: 1 }], "999"), null);
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
    { repo: "owner/repo", kind: "issue", number: 53 },
    {
      ghApiImpl: async () => [
        { id: 1, body: "@codex review", created_at: "2026-08-23T13:00:00Z", html_url: "https://github.com/owner/repo/issues/53#c1" },
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

test("run: --kind pr (with --head) and --kind issue both check the issues/comments endpoint", async () => {
  const seenPaths = [];
  const ghApiImpl = async (path) => {
    seenPaths.push(path);
    return [];
  };
  const ghPostImpl = async () => ({ created_at: "2026-08-23T14:05:00Z" });
  await run({ repo: "owner/repo", kind: "pr", number: 50, head: "abc123" }, { ghApiImpl, ghPostImpl });
  await run({ repo: "owner/repo", kind: "issue", number: 53 }, { ghApiImpl, ghPostImpl });
  assert.ok(seenPaths.includes("repos/owner/repo/issues/50/comments"));
  assert.ok(seenPaths.includes("repos/owner/repo/issues/53/comments"));
});

test("run: --kind pr without --head is rejected instead of silently skipping the cross-head block (Stage 1 review finding on this PR)", async () => {
  const result = await run(
    { repo: "owner/repo", kind: "pr", number: 50 },
    { ghApiImpl: async () => [], ghPostImpl: async () => ({ created_at: "x" }) },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /--head is required for --kind pr/);
});

test("run: --kind pr without --head is rejected even with --force (the combination that would otherwise skip every check)", async () => {
  let ghApiCalls = 0;
  let ghPostCalls = 0;
  const result = await run(
    { repo: "owner/repo", kind: "pr", number: 50, force: "true" },
    {
      ghApiImpl: async () => {
        ghApiCalls += 1;
        return [];
      },
      ghPostImpl: async () => {
        ghPostCalls += 1;
        return { created_at: "x" };
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(ghApiCalls, 0);
  assert.equal(ghPostCalls, 0, "must not post unconditionally just because --head was omitted");
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

test("run: with --head, refuses to post when an earlier head on this PR already received a genuine response (issue #165)", async () => {
  let ghPostCalls = 0;
  const endpointsSeen = [];
  const result = await run(
    { repo: "owner/repo", kind: "pr", number: 164, head: "new-sha" },
    {
      ghApiImpl: async (path) => {
        endpointsSeen.push(path);
        if (path.endsWith("/comments") && path.includes("/issues/")) {
          return [
            { body: triggerCommentBody("old-sha"), created_at: "2026-08-23T13:00:00Z" },
            {
              user: { login: "chatgpt-codex-connector[bot]" },
              created_at: "2026-08-23T13:10:00Z",
              body: "Found a real off-by-one bug in the loop bound.",
            },
          ];
        }
        return [];
      },
      ghPostImpl: async () => {
        ghPostCalls += 1;
        return { created_at: "should-not-be-used" };
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.priorGenuineHead, "old-sha");
  assert.match(result.message, /already received a genuine Codex response/);
  assert.equal(ghPostCalls, 0, "must not post a second round without an explicit override");
  assert.ok(
    endpointsSeen.some((p) => p.includes("/pulls/") && p.includes("/comments")),
    "must check the pull-comments endpoint for the prior round's response, not just issue-comments",
  );
  assert.ok(
    endpointsSeen.some((p) => p.includes("/pulls/") && p.includes("/reviews")),
    "must check the pull-reviews endpoint for the prior round's response, not just issue-comments",
  );
});

test("run: --ack-repeat-round is rejected outright (issue #211), even when no cross-head block would otherwise apply", async () => {
  let ghApiCalls = 0;
  let ghPostCalls = 0;
  const result = await run(
    { repo: "owner/repo", kind: "pr", number: 50, head: "abc123", "ack-repeat-round": "trust me" },
    {
      ghApiImpl: async () => {
        ghApiCalls += 1;
        return [];
      },
      ghPostImpl: async () => {
        ghPostCalls += 1;
        return { created_at: "should-not-be-used" };
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /--ack-repeat-round has been removed/);
  assert.equal(ghApiCalls, 0, "the flag is rejected before any read happens");
  assert.equal(ghPostCalls, 0);
});

test("run: reproduces YouTubery PR #46 — an executor cannot self-authorize a second Stage 1 round with --ack-repeat-round after a mechanical rebuild changes the head", async () => {
  // Sequence per issue #211: Stage 1 triggered and genuinely reviewed at "old-sha", the branch
  // is mechanically rebuilt onto main producing "new-sha", and the executor that trigger.mjs's
  // cross-head guard just blocked tries to talk its way past it with its own reason string.
  let ghPostCalls = 0;
  const result = await run(
    {
      repo: "LouPineWays/YouTubery",
      kind: "pr",
      number: 46,
      head: "new-sha",
      "ack-repeat-round": "old and new content are byte-identical after the rebuild",
    },
    {
      ghApiImpl: async (path) => {
        if (path.includes("/issues/")) {
          return [
            { body: triggerCommentBody("old-sha"), created_at: "2026-08-23T13:00:00Z" },
            {
              user: { login: "chatgpt-codex-connector[bot]" },
              created_at: "2026-08-23T13:10:00Z",
              body: "Found a real off-by-one bug in the loop bound.",
            },
          ];
        }
        return [];
      },
      ghPostImpl: async () => {
        ghPostCalls += 1;
        return { created_at: "should-not-be-used" };
      },
    },
  );
  assert.equal(result.exitCode, 1, "the flag is rejected before the cross-head check even runs");
  assert.match(result.message, /--ack-repeat-round has been removed/);
  assert.equal(ghPostCalls, 0, "no self-authorized second round may post");
});

test("run: with --head, the cross-head block has no automated override — a repeat trigger stays blocked with no way for the executor to proceed", async () => {
  let ghPostCalls = 0;
  const result = await run(
    { repo: "owner/repo", kind: "pr", number: 164, head: "new-sha" },
    {
      ghApiImpl: async (path) => {
        if (path.includes("/issues/")) {
          return [
            { body: triggerCommentBody("old-sha"), created_at: "2026-08-23T13:00:00Z" },
            {
              user: { login: "chatgpt-codex-connector[bot]" },
              created_at: "2026-08-23T13:10:00Z",
              body: "Found a real off-by-one bug in the loop bound.",
            },
          ];
        }
        return [];
      },
      ghPostImpl: async () => {
        ghPostCalls += 1;
        return { created_at: "should-not-be-used" };
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.priorGenuineHead, "old-sha");
  assert.match(result.message, /founder interrupt with no automated override/);
  assert.equal(ghPostCalls, 0);
});

test("run: --force true never bypasses the cross-head guard, even when it would bypass same-head dedup", async () => {
  let ghPostCalls = 0;
  const result = await run(
    { repo: "owner/repo", kind: "pr", number: 164, head: "new-sha", force: "true" },
    {
      ghApiImpl: async (path) => {
        if (path.includes("/issues/")) {
          return [
            { body: triggerCommentBody("old-sha"), created_at: "2026-08-23T13:00:00Z" },
            {
              user: { login: "chatgpt-codex-connector[bot]" },
              created_at: "2026-08-23T13:10:00Z",
              body: "Found a real off-by-one bug in the loop bound.",
            },
          ];
        }
        return [];
      },
      ghPostImpl: async () => {
        ghPostCalls += 1;
        return { created_at: "should-not-be-used" };
      },
    },
  );
  assert.equal(result.exitCode, 2, "--force only bypasses same-head dedup, never the cross-head block");
  assert.equal(result.priorGenuineHead, "old-sha");
  assert.equal(ghPostCalls, 0);
});

test("run: cross-head block does not apply to --kind issue (Stage 2 audits have no heads)", async () => {
  let ghPostCalls = 0;
  const result = await run(
    { repo: "owner/repo", kind: "issue", number: 53 },
    {
      ghApiImpl: async () => [
        { body: "@codex review", created_at: "2026-08-23T13:00:00Z" },
        {
          user: { login: "chatgpt-codex-connector[bot]" },
          created_at: "2026-08-23T13:10:00Z",
          body: "Audit findings: none.",
        },
      ],
      ghPostImpl: async () => {
        ghPostCalls += 1;
        return { created_at: "x" };
      },
    },
  );
  // A trigger already exists on the thread (dedup, not the cross-head block, is what stops
  // this repost) — the point of this test is that exitCode is never 2 for --kind issue.
  assert.equal(result.exitCode, 0);
  assert.equal(ghPostCalls, 0);
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
