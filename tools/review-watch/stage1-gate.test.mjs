// Tests for tools/review-watch/stage1-gate.mjs. All `gh` access is faked via the injected
// `ghApiImpl`/`ghPrViewImpl` options — never touch the real network or `gh` CLI here. Run
// with: node --test tools/review-watch/stage1-gate.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { findExemption, isGenuineResponse, parseArgs, run } from "./stage1-gate.mjs";
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

test("findExemption: an empty marker line does not let the next line of description become the reason (Stage 1 review finding)", () => {
  const body = "Stage 1 exemption:\nThis PR touches the payments integration and needs review.";
  assert.equal(
    findExemption(body),
    null,
    "a bare 'Stage 1 exemption:' line with nothing after it on that line must not swallow the following description line as the reason",
  );
});

test("findExemption: still matches when trailing spaces precede the reason on the same line", () => {
  assert.equal(findExemption("Stage 1 exemption:   trivial rename, not review-worthy"), "trivial rename, not review-worthy");
});

test("isGenuineResponse: rejects a leading BLOCKED reply", () => {
  assert.equal(isGenuineResponse("BLOCKED — cannot review, missing context."), false);
});

test("isGenuineResponse: rejects a blocked-mutation-attempt reply", () => {
  assert.equal(isGenuineResponse("I attempted to push a fix but do not have write access to this repository."), false);
  assert.equal(isGenuineResponse("Insufficient permission to commit changes."), false);
});

test("isGenuineResponse: accepts an ordinary review reply", () => {
  assert.equal(isGenuineResponse("Reviewed the diff. No issues found."), true);
});

test("isGenuineResponse: rejects the Codex Cloud 'create an environment' configuration reply (Stage 2 audit finding on issue #141)", () => {
  assert.equal(
    isGenuineResponse("To use Codex here, [create an environment for this repo](https://chatgpt.com/codex/cloud/settings/environments)."),
    false,
  );
});

test("isGenuineResponse: accepts a genuine review that discusses the setup-prompt phrase/URL rather than being one (Stage 1 review finding on PR #142)", () => {
  const genuineReview =
    "**P1** The documented `chatgpt.com/codex/cloud/settings/environments` link this gate matches against is stale; " +
    "Codex Cloud moved environment setup to a different settings page, so a real 'create an environment for this repo' " +
    "reply from that surface would no longer contain this URL.";
  assert.equal(
    isGenuineResponse(genuineReview),
    true,
    "a review that merely mentions the setup-prompt phrase/URL while reviewing unrelated content must not be misclassified as the setup prompt itself",
  );
});

test("isGenuineResponse: rejects a Markdown-heading-wrapped BLOCKED reply (YouTubery PR #14, issue #151)", () => {
  assert.equal(isGenuineResponse("### BLOCKED — checkout unavailable"), false);
});

test("isGenuineResponse: rejects other common leading Markdown wrappers around BLOCKED", () => {
  assert.equal(isGenuineResponse("> BLOCKED — cannot review this PR."), false);
  assert.equal(isGenuineResponse("**BLOCKED** — missing context."), false);
  assert.equal(isGenuineResponse("# BLOCKED\nCheckout unavailable."), false);
});

test("isGenuineResponse: accepts a genuine review that discusses or quotes BLOCKED syntax rather than opening with it (issue #151)", () => {
  const genuineReview =
    "Reviewed the diff. One finding: `stage1-gate.mjs`'s classifier only rejects a reply when it starts with " +
    "`BLOCKED`, so a Markdown heading like `### BLOCKED` slips through the anchor. Recommend normalizing leading " +
    "Markdown before classification.";
  assert.equal(
    isGenuineResponse(genuineReview),
    true,
    "a genuine review that mentions/quotes BLOCKED as findings content, rather than opening with it, must remain genuine",
  );
});

test("isGenuineResponse: rejects a list-wrapped BLOCKED reply (YouTubery PR #14, issue #161 Failure A)", () => {
  assert.equal(isGenuineResponse("- **BLOCKED** — checkout unavailable"), false);
});

test("isGenuineResponse: rejects other common leading list-prefix wrappers around BLOCKED (issue #161 Failure A)", () => {
  assert.equal(isGenuineResponse("+ BLOCKED — checkout unavailable"), false);
  assert.equal(isGenuineResponse("1. BLOCKED — checkout unavailable"), false);
  assert.equal(isGenuineResponse("* BLOCKED — checkout unavailable"), false);
  assert.equal(isGenuineResponse("1) BLOCKED — checkout unavailable"), false);
});

test("isGenuineResponse: rejects a genuine reviewer permission-denial/refusal response (existing #135/#141 case, still anchored correctly)", () => {
  assert.equal(
    isGenuineResponse("I attempted to push a fix but do not have write access to this repository."),
    false,
  );
  assert.equal(isGenuineResponse("Insufficient permission to commit changes."), false);
});

test("isGenuineResponse: accepts a genuine finding discussing that a reviewer cannot have write permission (issue #161 Failure B)", () => {
  const genuineReview =
    "The reviewer cannot have write permission under this workflow, by design: the Code Review Rules boundary in " +
    "AGENTS.md restricts `@codex review` to a read-only inspection role, and this PR's diff correctly reflects that.";
  assert.equal(
    isGenuineResponse(genuineReview),
    true,
    "a finding that merely discusses a permission-lack phrase, without describing an attempted mutation, must remain genuine",
  );
});

test("isGenuineResponse: accepts a genuine review that discusses permission boundaries and separately gives an ordinary instruction (Stage 1 review finding on PR #164)", () => {
  const genuineReview =
    "The reviewer cannot have write permission under this workflow, by design. Separately: update the test fixture " +
    "to also cover the new list-prefix cases, since the current suite only exercises headings and emphasis.";
  assert.equal(
    isGenuineResponse(genuineReview),
    true,
    "an ordinary instruction verb (e.g. 'update') elsewhere in a genuine review must not be tied to an unrelated permission-lack mention earlier in the message",
  );
});

test("isGenuineResponse: rejects a refusal that uses a mutation verb outside a small hardcoded list (Stage 1 review finding on PR #164)", () => {
  assert.equal(
    isGenuineResponse("I tried to apply the fix, but I don't have write access to this repository."),
    false,
    "a refused mutation attempt must be recognized regardless of which verb (apply/change/push/...) describes the attempted mutation",
  );
});

test("isGenuineResponse: rejects a refused attempt phrased with a gerund instead of an infinitive (second Stage 1 review round on PR #164)", () => {
  assert.equal(
    isGenuineResponse("I tried applying the fix, but I don't have write access to this repository."),
    false,
    "the refusal must be recognized regardless of verb form (infinitive vs. gerund), since real replies aren't guaranteed to phrase it as 'to <verb>'",
  );
});

test("isGenuineResponse: accepts an ordinary review recommendation that happens to use 'need to' (second Stage 1 review round on PR #164)", () => {
  assert.equal(
    isGenuineResponse("The tests need to cover empty input."),
    true,
    "an ordinary unnegated 'need to <verb>' instruction is not a refusal and must not be rejected merely for containing 'need' and an infinitive",
  );
});

test("isGenuineResponse: accepts a genuine finding describing a third party's permission requirement (second Stage 1 review round on PR #164)", () => {
  assert.equal(
    isGenuineResponse("The caller needs permission to read this file."),
    true,
    "a finding describing someone else's (not the responder's own) permission requirement, with no negation, must not be rejected",
  );
});

test("isGenuineResponse: rejects a direct modal refusal with no separate attempt verb (third Stage 1 review round on PR #164)", () => {
  assert.equal(
    isGenuineResponse("I cannot apply this fix because I don't have write access."),
    false,
    "a direct refusal of the mutation itself ('cannot apply') must count as an attempt cue, not only an explicit 'attempted'/'tried'",
  );
});

test("isGenuineResponse: accepts a genuine review whose attempt and permission mentions describe unrelated clauses (third Stage 1 review round on PR #164)", () => {
  const genuineReview =
    "I attempted to reproduce the failure locally. The reviewer cannot have write permission under this workflow; " +
    "the diff violates that boundary.";
  assert.equal(
    isGenuineResponse(genuineReview),
    true,
    "an attempt mentioned in one sentence (reproducing a bug) must not combine with an unrelated permission discussion in a different sentence of the same genuine review",
  );
});

test("isGenuineResponse: accepts genuine security findings that open with 'missing'/'no' permission wording but are not refusals (fourth Stage 1 review round on PR #164)", () => {
  assert.equal(isGenuineResponse("Missing permission checks allow anonymous updates."), true);
  assert.equal(isGenuineResponse("No access control is enforced."), true);
});

test("isGenuineResponse: rejects a prefaced first-person 'not authorized' refusal (fourth Stage 1 review round on PR #164)", () => {
  assert.equal(
    isGenuineResponse("Sorry, I tried to push, but I am not authorized to update this branch."),
    false,
    "'not authorized' must count as a permission-lack phrase even when not anchored at the very start of the message",
  );
});

test("isGenuineResponse: rejects a refusal split across two consecutive first-person sentences (fourth Stage 1 review round on PR #164)", () => {
  assert.equal(
    isGenuineResponse("I tried to push a fix. I don't have write access."),
    false,
    "an attempt and its permission-lack outcome stated as two consecutive first-person sentences describe one refusal, not two unrelated clauses",
  );
});

test("isGenuineResponse: rejects an access refusal phrased with 'lack' (fifth Stage 1 review round on PR #164)", () => {
  assert.equal(
    isGenuineResponse("I tried to push a fix, but I lack write access."),
    false,
    "'lack write access' is a negation phrase on its own and must count as a permission-lack signal, not only 'do not have'/'cannot have' wording",
  );
});

test("isGenuineResponse: rejects an access refusal phrased with passive 'denied' (sixth Stage 1 review round on PR #164)", () => {
  assert.equal(
    isGenuineResponse("I tried to push a fix, but write access was denied."),
    false,
    "'write access was denied' is a negation phrase and must count as a permission-lack signal alongside 'do not have'/'lack'/'cannot have'",
  );
});

test("isGenuineResponse: accepts a genuine finding whose 'no permission to <verb>' opening continues into an unrelated main clause (sixth Stage 1 review round on PR #164)", () => {
  assert.equal(
    isGenuineResponse("No permission to push is required before this workflow updates protected branches."),
    true,
    "the elliptical refusal phrase must account for (approximately) the whole message, not merely match as a prefix of a longer descriptive sentence",
  );
});

test("isGenuineResponse: rejects an impersonal authorization refusal with a longer direct object (seventh Stage 1 review round on PR #164)", () => {
  assert.equal(
    isGenuineResponse("Not authorized to push changes to this branch."),
    false,
    "an unbounded direct-object/prepositional-phrase completion of the same verb must not be capped to a fixed small word count",
  );
});

test("isGenuineResponse: rejects an impersonal refusal with a causal 'because' explanation (eighth Stage 1 review round on PR #164, finding 1 -- accepted)", () => {
  assert.equal(
    isGenuineResponse("Not authorized to push changes to this branch because repository write permission is unavailable."),
    false,
    "a 'because'/'since' clause explaining the same refusal is part of it, not an unrelated topic shift, even when that reason clause itself contains a word like 'is'",
  );
});

// Two other findings from the same eighth Stage 1 review round on PR #164 were declined by
// founder decision as out of this issue's scope (parsing arbitrary English main verbs as
// clause boundaries, and binding a permission phrase to the same grammatical subject as an
// attempt elsewhere in the sentence -- see stage1-gate.mjs's ELLIPTICAL_REFUSAL_PATTERN
// comment and LDL issue #165). No test is added for either: they describe known, accepted
// residual gaps, not verified-and-fixed behavior.

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

test("run: PENDING — a BLOCKED reply does not open the gate (Stage 1 review finding)", async () => {
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
              body: "BLOCKED — insufficient repository permission to inspect the PR.",
              created_at: "2026-08-23T13:05:00Z",
            },
          ];
        }
        return [];
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PENDING");
  assert.equal(result.nonGenuineMatches.length, 1);
});

test("run: RESPONSE_RECEIVED — a genuine reply after an earlier BLOCKED one still opens the gate", async () => {
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
              body: "BLOCKED — insufficient repository permission.",
              created_at: "2026-08-23T13:05:00Z",
            },
            {
              id: 3,
              user: { login: "chatgpt-codex-connector[bot]" },
              body: "Reviewed after retry. No issues found.",
              created_at: "2026-08-23T13:20:00Z",
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
  assert.equal(result.matches[0].id, 3);
});

test("run: PENDING — a Markdown-heading-wrapped BLOCKED reply does not open the gate (YouTubery PR #14, issue #151)", async () => {
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
              body: "### BLOCKED — checkout unavailable",
              created_at: "2026-08-23T13:05:00Z",
            },
          ];
        }
        return [];
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PENDING");
  assert.equal(result.nonGenuineMatches.length, 1);
});

test("run: PENDING — a list-formatted BLOCKED reply does not open the gate (YouTubery PR #14, issue #161 Failure A)", async () => {
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
              body: "- **BLOCKED** — checkout unavailable",
              created_at: "2026-08-23T13:05:00Z",
            },
          ];
        }
        return [];
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PENDING");
  assert.equal(result.nonGenuineMatches.length, 1);
});

test("run: RESPONSE_RECEIVED — a genuine finding discussing permission rules opens the gate (issue #161 Failure B)", async () => {
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
              body: "Reviewed the diff. Note: the reviewer cannot have write permission under this workflow, by design.",
              created_at: "2026-08-23T13:05:00Z",
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
});

test("run: PENDING — a Codex Cloud 'create an environment' reply does not open the gate (Stage 2 audit finding on issue #141)", async () => {
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
              body: "To use Codex here, [create an environment for this repo](https://chatgpt.com/codex/cloud/settings/environments).",
              created_at: "2026-08-23T13:00:04Z",
            },
          ];
        }
        return [];
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PENDING");
  assert.equal(result.nonGenuineMatches.length, 1);
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

// Head-correlation regression fixtures for issue #163: a genuine response must be provably
// bound to the exact frozen `--head` being gated, not merely timestamped after that head's
// trigger. Every fixture models a PR with two Stage 1 trigger rounds on the same thread —
// head A (older) then head B (newer) — so ambiguity between them is actually possible.

test("run: PENDING — a genuine response bound via commit_id to an older head does not satisfy a newer head's gate (issue #163)", async () => {
  const result = await run(
    { repo: "owner/repo", number: 50, head: "sha-b" },
    {
      ghPrViewImpl: async () => "no exemption",
      ghApiImpl: async (path) => {
        if (path.includes("/issues/")) {
          return [
            { id: 1, body: triggerCommentBody("sha-a"), created_at: "2026-08-23T13:00:00Z" },
            { id: 2, body: triggerCommentBody("sha-b"), created_at: "2026-08-23T14:00:00Z" },
          ];
        }
        if (path.includes("/reviews")) {
          // Delayed response for head A, but it actually arrives after head B's trigger —
          // the exact race issue #163 describes. Its commit_id names A, not B.
          return [
            {
              id: 9,
              user: { login: "chatgpt-codex-connector[bot]" },
              body: "Reviewed head A. No issues found.",
              submitted_at: "2026-08-23T15:00:00Z",
              commit_id: "sha-a",
            },
          ];
        }
        return [];
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PENDING");
  assert.equal(result.unboundGenuineMatches.length, 1);
  assert.equal(result.unboundGenuineMatches[0].commit_id, "sha-a");
});

test("run: PENDING — an unbound issue-comment response arriving after a newer head's trigger does not satisfy that head once multiple rounds exist (issue #163's delayed-response race)", async () => {
  const result = await run(
    { repo: "owner/repo", number: 50, head: "sha-b" },
    {
      ghPrViewImpl: async () => "no exemption",
      ghApiImpl: async (path) => {
        if (path.includes("/issues/")) {
          return [
            { id: 1, body: triggerCommentBody("sha-a"), created_at: "2026-08-23T13:00:00Z" },
            { id: 2, body: triggerCommentBody("sha-b"), created_at: "2026-08-23T14:00:00Z" },
            {
              id: 3,
              user: { login: "chatgpt-codex-connector[bot]" },
              body: "Reviewed. No issues found.",
              created_at: "2026-08-23T15:00:00Z",
            },
          ];
        }
        return [];
      },
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "PENDING");
  assert.equal(
    result.unboundGenuineMatches.length,
    1,
    "a plain issue comment with no commit identity cannot be reliably bound to either head once two rounds exist, so it must not open the gate for B",
  );
});

test("run: RESPONSE_RECEIVED — a genuine response bound via commit_id to the requested head satisfies the gate even with an older head's trigger also present", async () => {
  const result = await run(
    { repo: "owner/repo", number: 50, head: "sha-b" },
    {
      ghPrViewImpl: async () => "no exemption",
      ghApiImpl: async (path) => {
        if (path.includes("/issues/")) {
          return [
            { id: 1, body: triggerCommentBody("sha-a"), created_at: "2026-08-23T13:00:00Z" },
            { id: 2, body: triggerCommentBody("sha-b"), created_at: "2026-08-23T14:00:00Z" },
          ];
        }
        if (path.includes("/reviews")) {
          return [
            {
              id: 10,
              user: { login: "chatgpt-codex-connector[bot]" },
              body: "Reviewed head B. No issues found.",
              submitted_at: "2026-08-23T14:05:00Z",
              commit_id: "sha-b",
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
  assert.equal(result.matches[0].commit_id, "sha-b");
});

test("run: RESPONSE_RECEIVED — multiple response surfaces for one same-head round are all counted without requiring a second round (issue #163 requirement 6)", async () => {
  const result = await run(
    { repo: "owner/repo", number: 50, head: "sha-a" },
    {
      ghPrViewImpl: async () => "no exemption",
      ghApiImpl: async (path) => {
        if (path.includes("/issues/")) {
          return [
            { id: 1, body: triggerCommentBody("sha-a"), created_at: "2026-08-23T13:00:00Z" },
            {
              id: 2,
              user: { login: "chatgpt-codex-connector[bot]" },
              body: "Filed as a standalone comment as well.",
              created_at: "2026-08-23T13:06:00Z",
            },
          ];
        }
        if (path.includes("/reviews")) {
          return [
            {
              id: 20,
              user: { login: "chatgpt-codex-connector[bot]" },
              body: "Reviewed. No issues found.",
              submitted_at: "2026-08-23T13:05:00Z",
              commit_id: "sha-a",
            },
          ];
        }
        return [];
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "RESPONSE_RECEIVED");
  assert.equal(result.matches.length, 2);
});

test("run: RESPONSE_RECEIVED — a same-head retry (two trigger comments, one head) still opens the gate on an unbound genuine response (Stage 1 review finding on issue #163's own PR)", async () => {
  const result = await run(
    { repo: "owner/repo", number: 50, head: "sha-a" },
    {
      ghPrViewImpl: async () => "no exemption",
      ghApiImpl: async (path) => {
        if (path.includes("/issues/")) {
          return [
            { id: 1, body: triggerCommentBody("sha-a"), created_at: "2026-08-23T13:00:00Z" },
            {
              id: 2,
              user: { login: "chatgpt-codex-connector[bot]" },
              body: "BLOCKED — insufficient repository permission.",
              created_at: "2026-08-23T13:05:00Z",
            },
            // A --force retry at the same frozen head after the BLOCKED reply above — a
            // second trigger comment, but not a second distinct head.
            { id: 3, body: triggerCommentBody("sha-a"), created_at: "2026-08-23T13:10:00Z" },
            {
              id: 4,
              user: { login: "chatgpt-codex-connector[bot]" },
              body: "Reviewed after retry. No issues found.",
              created_at: "2026-08-23T13:20:00Z",
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
  assert.equal(result.matches[0].id, 4);
});

test("run: RESPONSE_RECEIVED — a bound match satisfies the gate but still surfaces a genuine unbound finding for the controller to verify (Stage 1 review finding on issue #163's own PR)", async () => {
  const result = await run(
    { repo: "owner/repo", number: 50, head: "sha-b" },
    {
      ghPrViewImpl: async () => "no exemption",
      ghApiImpl: async (path) => {
        if (path.includes("/issues/")) {
          return [
            { id: 1, body: triggerCommentBody("sha-a"), created_at: "2026-08-23T13:00:00Z" },
            { id: 2, body: triggerCommentBody("sha-b"), created_at: "2026-08-23T14:00:00Z" },
            {
              id: 3,
              user: { login: "chatgpt-codex-connector[bot]" },
              // Genuine, but no commit identity, and two distinct heads exist on the thread —
              // cannot be reliably bound to either head, yet it is still a real finding the
              // controller must not silently lose sight of.
              body: "Also noting a related concern as a standalone comment.",
              created_at: "2026-08-23T14:06:00Z",
            },
          ];
        }
        if (path.includes("/reviews")) {
          return [
            {
              id: 10,
              user: { login: "chatgpt-codex-connector[bot]" },
              body: "Reviewed head B. No issues found.",
              submitted_at: "2026-08-23T14:05:00Z",
              commit_id: "sha-b",
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
  assert.equal(result.matches[0].commit_id, "sha-b");
  assert.equal(
    result.unboundGenuineMatches.length,
    1,
    "a genuine finding that fails head-binding must still be surfaced, not silently dropped, once a different bound match already opens the gate",
  );
  assert.equal(result.unboundGenuineMatches[0].id, 3);
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
