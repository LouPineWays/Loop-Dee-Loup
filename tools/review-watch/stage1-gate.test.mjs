// Tests for tools/review-watch/stage1-gate.mjs. All `gh` access is faked via the injected
// `ghApiImpl`/`ghPrViewImpl` options — never touch the real network or `gh` CLI here. Run
// with: node --test tools/review-watch/stage1-gate.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { findExemption, parseArgs, run } from "./stage1-gate.mjs";
import { triggerCommentBody } from "./trigger.mjs";

test("findExemption: matches the documented 'Stage 1 exemption:' line", () => {
  const reason = findExemption("Some PR description.\n\nStage 1 exemption: docs typo, not review-worthy.\n");
  assert.equal(reason, "docs typo, not review-worthy.");
});

test("findExemption: returns null when no exemption line is present", () => {
  assert.equal(findExemption("Just a normal PR body."), null);
});

test("findExemption: returns null for an empty/undefined body", () => {
  assert.equal(findExemption(undefined), null);
  assert.equal(findExemption(""), null);
});

test("findExemption: is case-insensitive on the label", () => {
  assert.equal(findExemption("stage 1 EXEMPTION: reason here"), "reason here");
});

test("parseArgs: reads flags and defaults the bot login", () => {
  const args = parseArgs(["--repo", "owner/repo", "--number", "50", "--head", "abc123"]);
  assert.equal(args.repo, "owner/repo");
  assert.equal(args.number, "50");
  assert.equal(args.head, "abc123");
  assert.equal(args.bot, "chatgpt-codex-connector[bot]");
});

test("run: exits 1 when required args are missing", async () => {
  const result = await run({});
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /Missing required args/);
});

test("run: EXEMPT — an explicit exemption in the PR body short-circuits before any trigger read", async () => {
  let ghApiCalls = 0;
  const result = await run(
    { repo: "owner/repo", number: 50, head: "abc123" },
    {
      ghPrViewImpl: async () => "Stage 1 exemption: trivial docs fix, not review-worthy.",
      ghApiImpl: async () => {
        ghApiCalls += 1;
        return [];
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "EXEMPT");
  assert.equal(result.reason, "trivial docs fix, not review-worthy.");
  assert.equal(ghApiCalls, 0, "an exemption must short-circuit before reading any comment thread");
});

test("run: NOT_REQUESTED — no trigger comment at the given head", async () => {
  const result = await run(
    { repo: "owner/repo", number: 50, head: "abc123" },
    {
      ghPrViewImpl: async () => "A normal PR body with no exemption.",
      ghApiImpl: async () => [],
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "NOT_REQUESTED");
});

test("run: NOT_REQUESTED — a trigger exists but only at a different (older) head", async () => {
  const result = await run(
    { repo: "owner/repo", number: 50, head: "new-sha" },
    {
      ghPrViewImpl: async () => "no exemption",
      ghApiImpl: async () => [{ id: 1, body: triggerCommentBody("old-sha"), created_at: "2026-08-23T13:00:00Z" }],
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "NOT_REQUESTED");
});

test("run: PENDING — trigger exists at the head but no genuine bot response yet", async () => {
  const result = await run(
    { repo: "owner/repo", number: 50, head: "abc123" },
    {
      ghPrViewImpl: async () => "no exemption",
      ghApiImpl: async (path) => {
        if (path.includes("/issues/")) {
          return [{ id: 1, body: triggerCommentBody("abc123"), created_at: "2026-08-23T13:00:00Z" }];
        }
        return [];
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PENDING");
  assert.equal(result.triggerTimestamp, "2026-08-23T13:00:00Z");
});

test("run: PENDING — a bot comment exists but predates the trigger (stale prior-round response)", async () => {
  const result = await run(
    { repo: "owner/repo", number: 50, head: "abc123" },
    {
      ghPrViewImpl: async () => "no exemption",
      ghApiImpl: async (path) => {
        if (path.includes("/issues/")) {
          return [
            { id: 1, body: triggerCommentBody("abc123"), created_at: "2026-08-23T13:00:00Z" },
            {
              id: 2,
              user: { login: "chatgpt-codex-connector[bot]" },
              body: "stale response from an earlier round",
              created_at: "2026-08-23T12:00:00Z",
            },
          ];
        }
        return [];
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PENDING");
});

test("run: RESPONSE_RECEIVED — trigger plus a genuine post-trigger bot response on the issue-comments thread", async () => {
  const result = await run(
    { repo: "owner/repo", number: 50, head: "abc123" },
    {
      ghPrViewImpl: async () => "no exemption",
      ghApiImpl: async (path) => {
        if (path.includes("/issues/")) {
          return [
            { id: 1, body: triggerCommentBody("abc123"), created_at: "2026-08-23T13:00:00Z" },
            {
              id: 2,
              user: { login: "chatgpt-codex-connector[bot]" },
              body: "Reviewed. No findings.",
              created_at: "2026-08-23T13:05:00Z",
              html_url: "https://github.com/owner/repo/pull/50#issuecomment-2",
            },
          ];
        }
        return [];
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "RESPONSE_RECEIVED");
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].endpoint, "issue-comments");
});

test("run: RESPONSE_RECEIVED — a genuine response on the pull-reviews endpoint also counts", async () => {
  const result = await run(
    { repo: "owner/repo", number: 50, head: "abc123" },
    {
      ghPrViewImpl: async () => "no exemption",
      ghApiImpl: async (path) => {
        if (path.includes("/issues/")) {
          return [{ id: 1, body: triggerCommentBody("abc123"), created_at: "2026-08-23T13:00:00Z" }];
        }
        if (path.includes("/reviews")) {
          return [
            {
              id: 9,
              user: { login: "chatgpt-codex-connector[bot]" },
              body: "LGTM",
              submitted_at: "2026-08-23T13:10:00Z",
              html_url: "https://github.com/owner/repo/pull/50#pullrequestreview-9",
            },
          ];
        }
        return [];
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "RESPONSE_RECEIVED");
  assert.equal(result.matches[0].endpoint, "pull-reviews");
});

test("run: surfaces a gh pr view failure as exit 1", async () => {
  const result = await run(
    { repo: "owner/repo", number: 50, head: "abc123" },
    {
      ghPrViewImpl: async () => {
        throw new Error("gh: not found");
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /gh pr view failed/);
});

test("run: surfaces a gh api read failure as exit 1", async () => {
  const result = await run(
    { repo: "owner/repo", number: 50, head: "abc123" },
    {
      ghPrViewImpl: async () => "no exemption",
      ghApiImpl: async () => {
        throw new Error("gh: authentication required");
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /gh api call failed/);
});

test("run: exits 1 on an unexpected (non-array) comments response instead of guessing", async () => {
  const result = await run(
    { repo: "owner/repo", number: 50, head: "abc123" },
    {
      ghPrViewImpl: async () => "no exemption",
      ghApiImpl: async () => ({ not: "an array" }),
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /Ambiguous trigger read/);
});
