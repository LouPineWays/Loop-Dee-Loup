// Tests for issue #776: structured Codex `+1` clean-reaction evidence for Stage 1. Fixtures
// reproduce the live PR #754/#771/#773/#775 timestamps (reaction one second before the clean
// comment) and the findings-bearing controls #756/#637/#673 (no Codex +1 reaction).
// Run with: node --test tools/review-watch/stage1-clean-reaction.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { run } from "./stage1-gate.mjs";
import { triggerCommentBody } from "./trigger.mjs";
import { isCleanStage1Response } from "./consumer-sync-gate.mjs";
import { findQualifyingCleanReaction, hasExplicitFindingsSignal } from "./stage1-clean-reaction.mjs";
import { resolvePreMergeVerdict } from "../orchestration/next-review-transition-gate.mjs";

const BOT = "chatgpt-codex-connector[bot]";
const ENVELOPE =
  "\n\n**Reviewed commit:** `3a8d3d1820`\n\n<details> <summary>ℹ️ About Codex in GitHub</summary>\n<br>\n\n[Your team has set up Codex to review pull requests in this repo](https://chatgpt.com/codex/cloud/settings/general). Reviews are triggered when you";

const LIVE = [
  { pr: 754, head: "131c24aa7bb013073b03199d6fa620a54f2e2ccf", trigger: "2026-09-28T23:30:00Z", reaction: "2026-09-28T23:34:42Z", comment: "2026-09-28T23:34:43Z", prose: "Codex Review: Didn't find any major issues. :rocket:" },
  { pr: 771, head: "300afe40535b13839fdc5a6739444927b04f5856", trigger: "2026-09-29T20:30:00Z", reaction: "2026-09-29T20:38:39Z", comment: "2026-09-29T20:38:40Z", prose: "Codex Review: Didn't find any major issues. Hooray!" },
  { pr: 773, head: "f62700d751526bc0c1d34e7d08326f1e374c4082", trigger: "2026-09-29T21:10:00Z", reaction: "2026-09-29T21:17:08Z", comment: "2026-09-29T21:17:09Z", prose: "Codex Review: Didn't find any major issues. Hooray!" },
  { pr: 775, head: "3a8d3d1820c9369e63d1471a13dbd88de5f7d522", trigger: "2026-09-29T21:40:00Z", reaction: "2026-09-29T21:49:40Z", comment: "2026-09-29T21:49:41Z", prose: "Codex Review: Didn't find any major issues. Another round soon, please!" },
];

function fake({ head, trigger, comment, prose, reactions, extraComments = [], reviews = [] }) {
  return async (path) => {
    if (path.endsWith("/reactions")) return reactions;
    if (path.endsWith("/reviews")) return reviews;
    if (path.endsWith("/comments") && path.includes("/pulls/")) return [];
    return [
      { id: 1, body: triggerCommentBody(head), created_at: trigger },
      ...(comment ? [{ id: 2, user: { login: BOT }, body: prose + ENVELOPE, created_at: comment }] : []),
      ...extraComments,
    ];
  };
}

const reaction = (over = {}) => ({ id: 9, user: { login: BOT }, content: "+1", created_at: "2026-09-29T21:49:40Z", ...over });

for (const c of LIVE) {
  test(`run: live PR #${c.pr} clean round resolves RESPONSE_RECEIVED via post-trigger Codex +1 reaction, no prose enumeration`, async () => {
    const result = await run(
      { repo: "o/r", number: c.pr, head: c.head },
      { ghPrViewImpl: async () => "x", ghApiImpl: fake({ ...c, reactions: [reaction({ created_at: c.reaction })] }) },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.state, "RESPONSE_RECEIVED");
    if (c.pr !== 754) assert.equal(result.cleanReaction.created_at, c.reaction);
    assert.equal(isCleanStage1Response(result), true);
  });
}

const base = LIVE[3];
const runWith = (reactions, extra = {}) =>
  run(
    { repo: "o/r", number: 775, head: base.head },
    { ghPrViewImpl: async () => "x", ghApiImpl: fake({ ...base, reactions, ...extra }) },
  );

test("negatives: stale (pre-trigger), non-Codex, and non-+1 reactions never make the round clean", async () => {
  for (const r of [
    reaction({ created_at: "2026-09-29T21:39:59Z" }),
    reaction({ user: { login: "LouPineWays" } }),
    reaction({ content: "eyes" }),
    reaction({ content: "-1" }),
  ]) {
    const result = await runWith([r]);
    assert.equal(result.exitCode, 2);
    assert.equal(result.state, "FINDINGS_LACK_FORMAL_REVIEW");
  }
  assert.equal((await runWith([])).state, "FINDINGS_LACK_FORMAL_REVIEW");
});

test("head mismatch: a reaction attributed to a later different-head round cannot satisfy this head", async () => {
  const extraComments = [{ id: 3, body: triggerCommentBody("other-head"), created_at: "2026-09-29T21:45:00Z" }];
  const result = await runWith([reaction()], { extraComments });
  assert.notEqual(result.state, "RESPONSE_RECEIVED");
  assert.equal(result.cleanReaction, undefined);
});

test("a reaction read failure is an operational error, not silent clean", async () => {
  const result = await run(
    { repo: "o/r", number: 775, head: base.head },
    {
      ghPrViewImpl: async () => "x",
      ghApiImpl: async (path) => {
        if (path.endsWith("/reactions")) throw new Error("boom");
        return fake({ ...base, reactions: [] })(path);
      },
    },
  );
  assert.equal(result.exitCode, 1);
});

test("findings controls (#756/#637/#673 shape): substantive finding comment with no Codex +1 stays FINDINGS_LACK_FORMAL_REVIEW", async () => {
  const result = await runWith([], { prose: "P1: credentials are logged in the new handler." });
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "FINDINGS_LACK_FORMAL_REVIEW");
});

test("formal findings review + synthetic clean reaction: formal findings path wins, never cleanReaction", async () => {
  const reviews = [
    { id: 5, user: { login: BOT }, body: "P1: missing null check.", submitted_at: "2026-09-29T21:49:30Z", commit_id: base.head },
  ];
  const result = await runWith([reaction()], { reviews, comment: null });
  assert.equal(result.state, "RESPONSE_RECEIVED");
  assert.equal(result.cleanReaction, undefined);
  const verdict = resolvePreMergeVerdict(
    { stage1: result, mergeReady: { exitCode: 0, state: "MERGE_READY" } },
    { head: base.head },
  );
  assert.equal(verdict.state, "STAGE1_CORRECTION_REQUIRED");
});

test("explicit findings heading + clean reaction fails closed with a diagnosable conflict", async () => {
  const result = await runWith([reaction()], { prose: "### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request." });
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "FINDINGS_LACK_FORMAL_REVIEW");
  assert.ok(result.cleanReactionConflict);
});

test("plain severity-labelled finding + clean reaction fails closed with a diagnosable conflict (PR #777 finding)", async () => {
  const result = await runWith([reaction()], { prose: "P1: credentials are logged in the retry path." });
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "FINDINGS_LACK_FORMAL_REVIEW");
  assert.ok(result.cleanReactionConflict);
});

test("non-genuine provider failure with a reaction stays non-genuine (PENDING)", async () => {
  const result = await runWith([reaction()], { prose: "BLOCKED - Codex could not review this PR." });
  assert.equal(result.exitCode, 2);
  assert.notEqual(result.state, "RESPONSE_RECEIVED");
});

test("composition: structured clean evidence + MERGE_READY resolves the normal merge/Stage 2 transition", async () => {
  const stage1 = await runWith([reaction()]);
  const verdict = resolvePreMergeVerdict(
    { stage1, mergeReady: { exitCode: 0, state: "MERGE_READY" } },
    { head: base.head },
  );
  assert.equal(verdict.state, "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2");
});

test("findQualifyingCleanReaction: pure checks", () => {
  const rounds = [{ head: "h", timestamp: "2026-09-29T10:00:00Z" }];
  const args = { bot: BOT, sinceMs: Date.parse("2026-09-29T10:00:00Z"), head: "h", rounds };
  assert.ok(findQualifyingCleanReaction([reaction({ created_at: "2026-09-29T10:01:00Z" })], args));
  assert.equal(findQualifyingCleanReaction(null, args), null);
  assert.equal(hasExplicitFindingsSignal("Codex Review: Didn't find any major issues."), false);
});

test("hasExplicitFindingsSignal: recognizes plain and badge severity labels, not clean prose", () => {
  assert.equal(hasExplicitFindingsSignal("P1: credentials are logged"), true);
  assert.equal(hasExplicitFindingsSignal("**P2** Badge - fix this"), true);
  assert.equal(hasExplicitFindingsSignal("Hooray! Another round soon, please!"), false);
});
