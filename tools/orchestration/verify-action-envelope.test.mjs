import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Stage 1 finding on PR #534: the CLI's arg parser previously consumed the next token as an
// option's value unconditionally, even when that token was missing or was itself another
// "--option". These tests lock in the fix — a malformed invocation must fail closed with a
// usage error (exit 1), never silently certify compliance (exit 0) with a dropped or empty
// actions list.

const SCRIPT = fileURLToPath(new URL("./verify-action-envelope.mjs", import.meta.url));

function run(args) {
  try {
    const stdout = execFileSync("node", [SCRIPT, ...args], { encoding: "utf8" });
    return { exitCode: 0, stdout };
  } catch (err) {
    return { exitCode: err.status, stdout: err.stdout, stderr: err.stderr };
  }
}

test("verify-action-envelope: a normal compliant invocation exits 0", () => {
  const result = run(["--state", "READY_TO_DISPATCH", "--actions", "dispatch-execution-worker"]);
  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.status, "compliant");
});

// Issue #703: STAGE1_CORRECTION_REQUIRED's envelope depends on the verdict's correctionReason.
test("verify-action-envelope: --correction-reason narrows STAGE1_CORRECTION_REQUIRED exactly as the verdict field does", () => {
  assert.equal(run(["--state", "STAGE1_CORRECTION_REQUIRED", "--actions", "reserve-correction-checkout,dispatch-correction-worker"]).exitCode, 0);
  assert.equal(run(["--state", "STAGE1_CORRECTION_REQUIRED", "--actions", "dispatch-correction-worker"]).exitCode, 5);
  assert.equal(
    run(["--state", "STAGE1_CORRECTION_REQUIRED", "--correction-reason", "closing-reference", "--actions", "dispatch-correction-worker"]).exitCode,
    0,
  );
});

// Stage 1 correction on PR #721: STAGE2_PREPARATION_REQUIRED's envelope depends on the Stage 2
// preparation worker's own reported outcome and whether a control Issue exists to finalize onto.
test("verify-action-envelope: --preparation-result/--control-issue narrow STAGE2_PREPARATION_REQUIRED exactly as the worker's own reported outcome does", () => {
  assert.equal(run(["--state", "STAGE2_PREPARATION_REQUIRED", "--actions", "dispatch-stage2-preparation-worker"]).exitCode, 0);
  assert.equal(
    run([
      "--state",
      "STAGE2_PREPARATION_REQUIRED",
      "--preparation-result",
      "AUDIT_READY",
      "--control-issue",
      "322",
      "--actions",
      "dispatch-stage2-preparation-worker,write-control-snapshot,post-stage2-reviewer-trigger",
    ]).exitCode,
    0,
  );
  assert.equal(
    run([
      "--state",
      "STAGE2_PREPARATION_REQUIRED",
      "--preparation-result",
      "AUDIT_READY",
      "--actions",
      "dispatch-stage2-preparation-worker,verify-direct-reference-audit,post-stage2-reviewer-trigger",
    ]).exitCode,
    0,
  );
  assert.equal(
    run([
      "--state",
      "STAGE2_PREPARATION_REQUIRED",
      "--preparation-result",
      "AUDIT_PREPARATION_FAILED",
      "--actions",
      "dispatch-stage2-preparation-worker",
    ]).exitCode,
    0,
  );
  assert.equal(
    run([
      "--state",
      "STAGE2_PREPARATION_REQUIRED",
      "--preparation-result",
      "AUDIT_PREPARATION_FAILED",
      "--actions",
      "dispatch-stage2-preparation-worker,write-control-snapshot",
    ]).exitCode,
    5,
  );
});

test("verify-action-envelope: a normal violation invocation exits 5", () => {
  const result = run(["--state", "READY_TO_DISPATCH", "--actions", "dispatch-execution-worker,wait-for-completion"]);
  assert.equal(result.exitCode, 5);
});

test("verify-action-envelope: --state given another option's value (missing --actions value) is a usage error, exit 1, never a silent exit 0", () => {
  const result = run(["--state", "--actions", "rerun-gate"]);
  assert.equal(result.exitCode, 1);
  assert.ok(result.stderr.includes("requires a value"));
});

test("verify-action-envelope: --actions-file with no following value is a usage error, exit 1, never a silent empty-actions exit 0", () => {
  const result = run(["--state", "READY_TO_DISPATCH", "--actions-file"]);
  assert.equal(result.exitCode, 1);
  assert.ok(result.stderr.includes("requires a value"));
});

test("verify-action-envelope: an unknown option is a usage error, exit 1", () => {
  const result = run(["--state", "READY_TO_DISPATCH", "--bogus", "x"]);
  assert.equal(result.exitCode, 1);
  assert.ok(result.stderr.includes("unknown option"));
});

test("verify-action-envelope: a positional argument (not an --option) is a usage error, exit 1", () => {
  const result = run(["READY_TO_DISPATCH"]);
  assert.equal(result.exitCode, 1);
  assert.ok(result.stderr.includes("unexpected positional argument"));
});

test("verify-action-envelope: missing --state entirely is still a usage error, exit 1", () => {
  const result = run(["--actions", "dispatch-execution-worker"]);
  assert.equal(result.exitCode, 1);
  assert.ok(result.stderr.includes("--state"));
});

// Stage 1 review finding on PR #647 (issue #646, P2): a context-sensitive state's authorized
// actions come entirely from the verdict's own `nextCommand`. The CLI previously called
// `classifyEnvelopeCompliance(state, actions)` with no context at all, so a genuinely authorized
// trigger+finalize sequence was misreported as a violation, and, worse, an *empty* observed-
// actions list was misreported as "compliant" merely because no nextCommand was ever seen. These
// tests lock in the fix: missing required context now fails closed (exit 1), and supplying it
// correctly distinguishes control-mode from direct-reference-mode authorized sequences.

const CONTROL_MODE_NEXT_COMMAND =
  "node tools/review-watch/trigger.mjs --repo o/r --kind pr --number 644 --head correctionhead && node tools/orchestration/finalize-pr-breakpoint.mjs --control-issue 322 --execution-issue 375 --pr 644 --head correctionhead";
const DIRECT_REFERENCE_NEXT_COMMAND = "node tools/review-watch/trigger.mjs --repo o/r --kind pr --number 644 --head correctionhead";

test("verify-action-envelope: a context-sensitive state with no --next-command fails closed, exit 1, never a silent empty-actions exit 0", () => {
  const result = run(["--state", "STAGE2_CORRECTION_PR_NEEDS_FINALIZATION", "--actions", "run-review-watch-trigger"]);
  assert.equal(result.exitCode, 1);
  assert.ok(result.stderr.includes("--next-command"));
});

test("verify-action-envelope: a context-sensitive state with no --next-command and NO observed actions still fails closed, never a silent empty-actions exit 0", () => {
  const result = run(["--state", "STAGE2_CORRECTION_PR_NEEDS_FINALIZATION"]);
  assert.equal(result.exitCode, 1);
});

test("verify-action-envelope: control-mode nextCommand — the actual trigger+finalize sequence verifies compliant", () => {
  const result = run([
    "--state",
    "STAGE2_CORRECTION_PR_NEEDS_FINALIZATION",
    "--actions",
    "run-review-watch-trigger,run-finalize-pr-breakpoint",
    "--next-command",
    CONTROL_MODE_NEXT_COMMAND,
  ]);
  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.status, "compliant");
});

test("verify-action-envelope: control-mode nextCommand — omitting the finalize action is a violation", () => {
  const result = run([
    "--state",
    "STAGE2_CORRECTION_PR_NEEDS_FINALIZATION",
    "--actions",
    "run-review-watch-trigger",
    "--next-command",
    CONTROL_MODE_NEXT_COMMAND,
  ]);
  assert.equal(result.exitCode, 5);
});

test("verify-action-envelope: direct-reference-mode nextCommand — only the narrower trigger-only sequence verifies compliant", () => {
  const result = run([
    "--state",
    "STAGE2_CORRECTION_PR_NEEDS_FINALIZATION",
    "--actions",
    "run-review-watch-trigger",
    "--next-command",
    DIRECT_REFERENCE_NEXT_COMMAND,
  ]);
  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.status, "compliant");
});

test("verify-action-envelope: direct-reference-mode nextCommand — run-finalize-pr-breakpoint remains unauthorized (no control Issue to project onto)", () => {
  const result = run([
    "--state",
    "STAGE2_CORRECTION_PR_NEEDS_FINALIZATION",
    "--actions",
    "run-review-watch-trigger,run-finalize-pr-breakpoint",
    "--next-command",
    DIRECT_REFERENCE_NEXT_COMMAND,
  ]);
  assert.equal(result.exitCode, 5);
  assert.ok(result.stderr.includes("run-finalize-pr-breakpoint"));
});
