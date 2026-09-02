// Tests for tools/review-watch/consumer-sync-gate.mjs. All `gh` access is faked via the
// injected impl options — never touch the real network or `gh` CLI here. Run with:
// node --test tools/review-watch/consumer-sync-gate.test.mjs
//
// The last section ("YouTubery #98 regression") deliberately verifies against the *real*,
// unmodified stage1-gate.mjs `run` function instead of mocking it, to prove this script's
// repair step makes that existing, untouched gate correctly recognize a genuine response
// drawn by a bare, marker-less human `@codex review` comment — the exact YouTubery PR #98
// shape (issue #274) — without any code change to it.

import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, findBareTrigger, run } from "./consumer-sync-gate.mjs";
import { headMarker } from "./trigger.mjs";
import { run as runStage1GateReal } from "./stage1-gate.mjs";

const REPO = "LouPineWays/YouTubery";
const PR = "98";
const HEAD = "deadbeef00";

function readyGate(overrides = {}) {
  return { exitCode: 0, state: "PRE_MERGE_READY_NO_WORK_ISSUE", ...overrides };
}

// -- parseArgs --------------------------------------------------------------------------

test("parseArgs: reads --repo/--pr/--head/--set-status", () => {
  assert.deepEqual(parseArgs(["--repo", "o/r", "--pr", "5", "--head", "sha", "--set-status", "true"]), {
    repo: "o/r",
    pr: "5",
    head: "sha",
    "set-status": "true",
  });
});

// -- findBareTrigger ----------------------------------------------------------------------

test("findBareTrigger: finds an exact, marker-less trigger comment", () => {
  const bare = findBareTrigger([{ id: 1, body: "@codex review", created_at: "2026-08-20T00:00:00Z" }]);
  assert.equal(bare.id, 1);
});

test("findBareTrigger: ignores a marked trigger comment", () => {
  const bare = findBareTrigger([
    { id: 1, body: `@codex review\n${headMarker(HEAD)}`, created_at: "2026-08-20T00:00:00Z" },
  ]);
  assert.equal(bare, null);
});

test("findBareTrigger: ignores ordinary prose that merely mentions the phrase", () => {
  const bare = findBareTrigger([
    { id: 1, body: "Once this lands we should post @codex review to request Stage 1.", created_at: "2026-08-20T00:00:00Z" },
  ]);
  assert.equal(bare, null);
});

test("findBareTrigger: picks the earliest match when more than one exists", () => {
  const bare = findBareTrigger([
    { id: 2, body: "@codex review", created_at: "2026-08-20T01:00:00Z" },
    { id: 1, body: "@codex review", created_at: "2026-08-20T00:00:00Z" },
  ]);
  assert.equal(bare.id, 1);
});

test("findBareTrigger: null on an empty thread", () => {
  assert.equal(findBareTrigger([]), null);
});

// -- run: argument handling ----------------------------------------------------------------

test("run: exits 1 when required args are missing", async () => {
  const result = await run({ repo: REPO });
  assert.equal(result.exitCode, 1);
  assert.equal(result.status, "error");
});

test("run: derives --head via ghPrViewImpl when omitted", async () => {
  let sawArgs;
  const result = await run(
    { repo: REPO, pr: PR },
    {
      ghPrViewImpl: async (args) => {
        sawArgs = args;
        return HEAD;
      },
      ghApiImpl: async () => [],
      runMergeReadyGateImpl: async (args) => {
        assert.equal(args.head, HEAD);
        return readyGate();
      },
    },
  );
  assert.equal(sawArgs.repo, REPO);
  assert.equal(sawArgs.number, PR);
  assert.equal(result.status, "ready");
});

test("run: exits 1 when head derivation fails", async () => {
  const result = await run(
    { repo: REPO, pr: PR },
    { ghPrViewImpl: async () => { throw new Error("gh pr view failed"); } },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.status, "error");
  assert.match(result.message, /gh pr view failed/);
});

// -- run: never attempts to post a trigger itself --------------------------------------------

test("run: no bare trigger, no marked trigger -> no repair, and never posts a trigger of its own (issue #274's empirical finding: a bot-posted trigger only ever draws a Codex Cloud connector-setup reply, never a review)", async () => {
  const result = await run(
    { repo: REPO, pr: PR, head: HEAD },
    {
      ghApiImpl: async () => [],
      runMergeReadyGateImpl: async () => ({
        exitCode: 2,
        state: "BLOCKED",
        blockedBy: [{ component: "stage1", state: "NOT_REQUESTED" }],
      }),
    },
  );
  assert.equal(result.repaired, false);
  assert.equal(result.exitCode, 2);
  assert.equal(result.status, "not_requested");
});

test("run: repairs a bare trigger by appending the current head's marker", async () => {
  const bareComment = { id: 7, body: "@codex review", created_at: "2026-08-20T00:00:00Z" };
  let patchArgs;
  const result = await run(
    { repo: REPO, pr: PR, head: HEAD },
    {
      ghApiImpl: async () => [bareComment],
      ghPatchImpl: async (args) => {
        patchArgs = args;
      },
      runMergeReadyGateImpl: async () => readyGate(),
    },
  );
  assert.equal(result.repaired, true);
  assert.equal(patchArgs.repo, REPO);
  assert.equal(patchArgs.commentId, 7);
  assert.equal(patchArgs.body, `@codex review\n${headMarker(HEAD)}`);
});

test("run: does not repair when a marked trigger for this head already exists", async () => {
  let patchCalls = 0;
  const result = await run(
    { repo: REPO, pr: PR, head: HEAD },
    {
      ghApiImpl: async () => [{ id: 1, body: `@codex review\n${headMarker(HEAD)}`, created_at: "2026-08-20T00:00:00Z" }],
      ghPatchImpl: async () => {
        patchCalls += 1;
      },
      runMergeReadyGateImpl: async () => readyGate(),
    },
  );
  assert.equal(patchCalls, 0);
  assert.equal(result.repaired, false);
});

// -- run: composition with merge-ready-gate.mjs (mocked) ------------------------------------

test("run: merge-ready-gate PRE_MERGE_READY_NO_WORK_ISSUE -> ready", async () => {
  const result = await run(
    { repo: REPO, pr: PR, head: HEAD },
    {
      ghApiImpl: async () => [],
      runMergeReadyGateImpl: async (args) => {
        assert.equal(args.issue, "none");
        return readyGate();
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.status, "ready");
});

test("run: merge-ready-gate BLOCKED on stage1 NOT_REQUESTED -> not_requested, distinct from pending", async () => {
  const result = await run(
    { repo: REPO, pr: PR, head: HEAD },
    {
      ghApiImpl: async () => [],
      runMergeReadyGateImpl: async () => ({
        exitCode: 2,
        state: "BLOCKED",
        blockedBy: [{ component: "stage1", state: "NOT_REQUESTED" }],
      }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.status, "not_requested");
});

test("run: merge-ready-gate BLOCKED on stage1 PENDING alone -> pending, not blocked", async () => {
  const result = await run(
    { repo: REPO, pr: PR, head: HEAD },
    {
      ghApiImpl: async () => [],
      runMergeReadyGateImpl: async () => ({
        exitCode: 2,
        state: "BLOCKED",
        blockedBy: [{ component: "stage1", state: "PENDING" }],
      }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.status, "pending");
});

test("run: merge-ready-gate BLOCKED on a closing-reference violation -> blocked, not pending", async () => {
  const result = await run(
    { repo: REPO, pr: PR, head: HEAD },
    {
      ghApiImpl: async () => [],
      runMergeReadyGateImpl: async () => ({
        exitCode: 2,
        state: "BLOCKED",
        blockedBy: [{ component: "lifecycle", state: "BLOCKED_CLOSING_REFERENCE" }],
      }),
    },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.status, "blocked");
});

test("run: merge-ready-gate operational error -> error, never ready", async () => {
  const result = await run(
    { repo: REPO, pr: PR, head: HEAD },
    {
      ghApiImpl: async () => [],
      runMergeReadyGateImpl: async () => ({ exitCode: 1, state: "OPERATIONAL_ERROR", message: "gh failure" }),
    },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.status, "error");
});

// -- run: --set-status ----------------------------------------------------------------------

test("run: --set-status true posts a commit status mapped from the composed result", async () => {
  let statusCall;
  const result = await run(
    { repo: REPO, pr: PR, head: HEAD, "set-status": "true" },
    {
      ghApiImpl: async () => [],
      runMergeReadyGateImpl: async () => readyGate(),
      setStatusImpl: async (args) => {
        statusCall = args;
      },
    },
  );
  assert.equal(result.status, "ready");
  assert.equal(statusCall.repo, REPO);
  assert.equal(statusCall.head, HEAD);
  assert.equal(statusCall.result.status, "ready");
});

test("run: --set-status omitted never calls setStatusImpl", async () => {
  let calls = 0;
  await run(
    { repo: REPO, pr: PR, head: HEAD },
    {
      ghApiImpl: async () => [],
      runMergeReadyGateImpl: async () => readyGate(),
      setStatusImpl: async () => {
        calls += 1;
      },
    },
  );
  assert.equal(calls, 0);
});

test("run: a failure setting the commit status is reported as an error, not swallowed", async () => {
  const result = await run(
    { repo: REPO, pr: PR, head: HEAD, "set-status": "true" },
    {
      ghApiImpl: async () => [],
      runMergeReadyGateImpl: async () => readyGate(),
      setStatusImpl: async () => {
        throw new Error("gh api statuses failed");
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.status, "error");
  assert.match(result.message, /gh api statuses failed/);
});

// -- YouTubery #98 regression: real stage1-gate.mjs, no mocks --------------------------------

test("YouTubery #98 regression: a bare human @codex review trigger with a genuine response is NOT_REQUESTED before repair", async () => {
  const comments = [
    { id: 1, body: "@codex review", created_at: "2026-08-20T00:00:00Z", user: { login: "the-founder" } },
    {
      id: 2,
      body: "Looks correct, no issues found.",
      created_at: "2026-08-20T00:05:00Z",
      user: { login: "chatgpt-codex-connector[bot]" },
    },
  ];
  const stage1Before = await runStage1GateReal(
    { repo: REPO, number: PR, head: HEAD },
    {
      ghPrViewImpl: async () => "",
      ghApiImpl: async (path) => (path.endsWith("/comments") ? comments : []),
    },
  );
  // Reproduces the exact issue #274 / YouTubery PR #98 defect: a genuine response already
  // exists, but the gate cannot see it because the trigger that drew it carries no head
  // marker.
  assert.equal(stage1Before.exitCode, 2);
  assert.equal(stage1Before.state, "NOT_REQUESTED");
});

test("YouTubery #98 regression: consumer-sync-gate's repair makes the same fixture RESPONSE_RECEIVED, via the real stage1-gate.mjs", async () => {
  const comments = [
    { id: 1, body: "@codex review", created_at: "2026-08-20T00:00:00Z", user: { login: "the-founder" } },
    {
      id: 2,
      body: "Looks correct, no issues found.",
      created_at: "2026-08-20T00:05:00Z",
      user: { login: "chatgpt-codex-connector[bot]" },
    },
  ];
  const commentsPath = `repos/${REPO}/issues/${PR}/comments`;

  const result = await run(
    { repo: REPO, pr: PR, head: HEAD },
    {
      ghApiImpl: async (path) => (path === commentsPath ? comments : []),
      ghPatchImpl: async ({ commentId, body }) => {
        const c = comments.find((c) => c.id === commentId);
        c.body = body;
      },
      runMergeReadyGateImpl: async () => readyGate(),
    },
  );

  assert.equal(result.repaired, true, "the bare founder trigger must be repaired with the current head's marker");
  assert.equal(comments[0].body, `@codex review\n${headMarker(HEAD)}`);
  assert.equal(result.status, "ready");

  // The real, unmodified stage1-gate.mjs -- given the now-repaired comment thread -- must
  // independently agree the response is bound to this head, with no code change to it.
  const stage1After = await runStage1GateReal(
    { repo: REPO, number: PR, head: HEAD },
    {
      ghPrViewImpl: async () => "",
      ghApiImpl: async (path) => (path === commentsPath ? comments : []),
    },
  );
  assert.equal(stage1After.exitCode, 0);
  assert.equal(stage1After.state, "RESPONSE_RECEIVED");
});

// -- Codex Cloud connector-setup reply (issue #274's empirical finding) never counts ---------

test("run: a Codex Cloud connector-setup reply to a bare trigger stays NOT genuine, via the real stage1-gate.mjs (issue #274, LDL PR #275)", async () => {
  // Reproduces the exact reply this script's own header comment documents: posting the
  // trigger as a bot identity with no connected Codex account draws this fixed setup prompt,
  // never a review. It must never be mistaken for RESPONSE_RECEIVED, before or after repair.
  const comments = [
    { id: 1, body: "@codex review", created_at: "2026-08-20T00:00:00Z", user: { login: "github-actions[bot]" } },
    {
      id: 2,
      body: "To use Codex here, [create a Codex account and connect to github](https://chatgpt.com/codex/cloud/settings/connectors).",
      created_at: "2026-08-20T00:00:05Z",
      user: { login: "chatgpt-codex-connector[bot]" },
    },
  ];
  const commentsPath = `repos/${REPO}/issues/${PR}/comments`;

  const result = await run(
    { repo: REPO, pr: PR, head: HEAD },
    {
      ghApiImpl: async (path) => (path === commentsPath ? comments : []),
      ghPatchImpl: async ({ commentId, body }) => {
        comments.find((c) => c.id === commentId).body = body;
      },
      runMergeReadyGateImpl: async () => ({
        exitCode: 2,
        state: "BLOCKED",
        blockedBy: [{ component: "stage1", state: "PENDING" }],
      }),
    },
  );
  assert.equal(result.status, "pending");

  const stage1 = await runStage1GateReal(
    { repo: REPO, number: PR, head: HEAD },
    {
      ghPrViewImpl: async () => "",
      ghApiImpl: async (path) => (path === commentsPath ? comments : []),
    },
  );
  assert.equal(stage1.exitCode, 2);
  assert.equal(stage1.state, "PENDING");
});
