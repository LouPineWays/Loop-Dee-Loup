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
