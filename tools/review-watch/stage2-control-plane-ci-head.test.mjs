import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveControlPlaneCiHead, run, parseArgs } from "./stage2-control-plane-ci-head.mjs";

// Point 1 (audit #508 correction requirement): an ordinary Stage 1 case with no corrected head
// still selects the frozen reviewed head for CI evidence.
test("resolveControlPlaneCiHead: ordinary 'satisfied at <sha>' resolves to that sha as the reviewed head", () => {
  const result = resolveControlPlaneCiHead("satisfied at 9d775fc1a2b3c4d5e6f708192a3b4c5d6e7f8091");
  assert.deepEqual(result, {
    ok: true,
    head: "9d775fc1a2b3c4d5e6f708192a3b4c5d6e7f8091",
    source: "reviewed",
    reviewedHead: "9d775fc1a2b3c4d5e6f708192a3b4c5d6e7f8091",
    correctedHead: null,
  });
});

test("resolveControlPlaneCiHead: ordinary 'exempt at <sha>' resolves to that sha as the reviewed head", () => {
  const result = resolveControlPlaneCiHead("exempt at ABCDEF1");
  assert.equal(result.ok, true);
  assert.equal(result.head, "abcdef1");
  assert.equal(result.source, "reviewed");
});

// Point 2: a correction-satisfied case selects the exact corrected/merge-authorized head, not
// the reviewed head.
test("resolveControlPlaneCiHead: correction-satisfied disposition resolves to the corrected head", () => {
  const result = resolveControlPlaneCiHead(
    "correction-satisfied at 18f960088bb41704f2f970c72089640dc0c63bb9 (reviewed 05c70da1404ef89954c15be720222a81c01a230c)",
  );
  assert.deepEqual(result, {
    ok: true,
    head: "18f960088bb41704f2f970c72089640dc0c63bb9",
    source: "corrected",
    reviewedHead: "05c70da1404ef89954c15be720222a81c01a230c",
    correctedHead: "18f960088bb41704f2f970c72089640dc0c63bb9",
  });
});

// Point 3: the live #507/#499/#508 reproduction — the exact disposition bullet control issue
// #499 carries — resolves to the corrected head 18f9600..., the head that actually shows
// completed Control-plane paths run 34456423959, not reviewed head 05c70da... which has zero
// Actions runs.
test("resolveControlPlaneCiHead: the live #499/#507/#508 reproduction resolves to the corrected head", () => {
  const controlIssue499Bullet =
    "correction-satisfied at 18f960088bb41704f2f970c72089640dc0c63bb9 (reviewed 05c70da1404ef89954c15be720222a81c01a230c)";
  const result = resolveControlPlaneCiHead(controlIssue499Bullet);
  assert.equal(result.ok, true);
  assert.equal(result.head, "18f960088bb41704f2f970c72089640dc0c63bb9");
  assert.notEqual(result.head, "05c70da1404ef89954c15be720222a81c01a230c");
});

// Real-world shape: control issue #499's own live bullet carries a trailing evidence
// annotation after the canonical "(reviewed <sha>)" clause. This must still resolve — the
// annotation documents an already-settled fact, not a competing disposition.
test("resolveControlPlaneCiHead: tolerates a trailing evidence annotation after the canonical shape", () => {
  const result = resolveControlPlaneCiHead(
    "correction-satisfied at 18f960088bb41704f2f970c72089640dc0c63bb9 " +
      "(reviewed 05c70da1404ef89954c15be720222a81c01a230c) — merge authorized via the composed " +
      "`merge-ready-gate.mjs` (`PRE_MERGE_READY_CORRECTION_SATISFIED_NO_WORK_ISSUE`)",
  );
  assert.equal(result.ok, true);
  assert.equal(result.head, "18f960088bb41704f2f970c72089640dc0c63bb9");
  assert.equal(result.source, "corrected");
});

test("resolveControlPlaneCiHead: ordinary disposition also tolerates trailing annotation", () => {
  const result = resolveControlPlaneCiHead("satisfied at 9d775fc1a2b3c4d5e6f708192a3b4c5d6e7f8091 (see PR #94)");
  assert.equal(result.ok, true);
  assert.equal(result.head, "9d775fc1a2b3c4d5e6f708192a3b4c5d6e7f8091");
});

// Point 4: missing, stale, or contradictory reviewed/corrected-head provenance fails closed
// rather than guessing.
test("resolveControlPlaneCiHead: absent bullet fails closed", () => {
  assert.equal(resolveControlPlaneCiHead(null).ok, false);
  assert.equal(resolveControlPlaneCiHead(undefined).ok, false);
  assert.equal(resolveControlPlaneCiHead("").ok, false);
  assert.equal(resolveControlPlaneCiHead("   ").ok, false);
});

test("resolveControlPlaneCiHead: malformed correction-satisfied bullet fails closed with a specific reason", () => {
  const result = resolveControlPlaneCiHead("correction-satisfied at not-a-sha");
  assert.equal(result.ok, false);
  assert.match(result.reason, /looks like a correction-satisfied disposition/);
});

test("resolveControlPlaneCiHead: unrecognized bullet text fails closed", () => {
  const result = resolveControlPlaneCiHead("some unrelated free text");
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not match any recognized disposition shape/);
});

test("resolveControlPlaneCiHead: 'none' sentinel fails closed rather than being treated as a head", () => {
  const result = resolveControlPlaneCiHead("none");
  assert.equal(result.ok, false);
});

// Point 5: the historical #98 merge-commit-vs-PR-head regression remains impossible — this
// resolver only ever derives a head from the Stage 1 bullet's own two disposition shapes, and
// never accepts or echoes back a merge-commit-shaped input as if it were a valid disposition.
test("resolveControlPlaneCiHead: a bare merge-commit-shaped sha with no disposition keyword fails closed", () => {
  const result = resolveControlPlaneCiHead("968718f1eadf79d99a7502204b47a19bcfeeb199");
  assert.equal(result.ok, false);
});

test("resolveControlPlaneCiHead: case-insensitive sha input is normalized to lowercase", () => {
  const result = resolveControlPlaneCiHead("SATISFIED AT 9D775FC1A2B3C4D5E6F708192A3B4C5D6E7F8091");
  assert.equal(result.ok, true);
  assert.equal(result.head, "9d775fc1a2b3c4d5e6f708192a3b4c5d6e7f8091");
});

test("parseArgs: maps --control-issue to controlIssue", () => {
  const args = parseArgs(["--control-issue", "499", "--repo", "owner/repo"]);
  assert.equal(args.controlIssue, "499");
  assert.equal(args.repo, "owner/repo");
});

// End-to-end `run` coverage using injected fakes, per this repository's existing gate-testing
// convention (no real `gh`/`git` invocation from tests).

test("run: missing --control-issue is an operational error", async () => {
  const result = await run({});
  assert.equal(result.exitCode, 1);
});

test("run: resolves repo via resolveRepoIdentityImpl when --repo is omitted", async () => {
  let seenRepo = null;
  const result = await run(
    { controlIssue: "499" },
    {
      resolveRepoIdentityImpl: () => ({ ok: true, repo: "LouPineWays/Loop-Dee-Loup" }),
      ghIssueViewImpl: ({ repo }) => {
        seenRepo = repo;
        return {
          body:
            "- **Stage 1:** correction-satisfied at 18f960088bb41704f2f970c72089640dc0c63bb9 " +
            "(reviewed 05c70da1404ef89954c15be720222a81c01a230c)\n",
        };
      },
    },
  );
  assert.equal(seenRepo, "LouPineWays/Loop-Dee-Loup");
  assert.equal(result.exitCode, 0);
  assert.equal(result.head, "18f960088bb41704f2f970c72089640dc0c63bb9");
  assert.equal(result.source, "corrected");
});

test("run: unresolvable repo identity is an operational error, never a fail-closed resolution", async () => {
  const result = await run(
    { controlIssue: "499" },
    { resolveRepoIdentityImpl: () => ({ ok: false, reason: "no origin remote configured" }) },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /no origin remote configured/);
});

test("run: an unreadable control issue is an operational error", async () => {
  const result = await run(
    { controlIssue: "499", repo: "owner/repo" },
    {
      ghIssueViewImpl: () => {
        throw new Error("gh issue view failed");
      },
    },
  );
  assert.equal(result.exitCode, 1);
});

test("run: a control issue with no 'Stage 1' bullet exits 2 (fail-closed), not 1 (operational error)", async () => {
  const result = await run(
    { controlIssue: "1", repo: "owner/repo" },
    { ghIssueViewImpl: () => ({ body: "## Control state\n\n- **Lifecycle:** EXECUTING\n" }) },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.ok, false);
});

test("run: the exact live #499 control issue body resolves to exit 0 with the corrected head", async () => {
  const body =
    "## Control state\n\n" +
    "- **Execution issue:** #497\n" +
    "- **Lifecycle:** AUDIT\n" +
    "- **Route:** none\n" +
    "- **Stage 1:** correction-satisfied at 18f960088bb41704f2f970c72089640dc0c63bb9 " +
    "(reviewed 05c70da1404ef89954c15be720222a81c01a230c)\n" +
    "- **Stage 2:** https://github.com/LouPineWays/Loop-Dee-Loup/issues/508 — **Verdict: NOT CLEAN**\n";
  const result = await run(
    { controlIssue: "499", repo: "LouPineWays/Loop-Dee-Loup" },
    { ghIssueViewImpl: () => ({ body }) },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.head, "18f960088bb41704f2f970c72089640dc0c63bb9");
  assert.equal(result.source, "corrected");
});
