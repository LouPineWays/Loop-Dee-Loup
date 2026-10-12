// Static inspection of .github/workflows/ldl-launcher.yml (issue #1094): the control-issue-only
// workflow_dispatch request keeps the workflow's trust posture. No YAML dependency: textual checks.
//
// Tests: node --test tools/orchestration/ldl-launcher-workflow.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const yml = readFileSync(new URL("../../.github/workflows/ldl-launcher.yml", import.meta.url), "utf8");
const onBlock = yml.slice(yml.indexOf("\non:") + 1, yml.indexOf("\npermissions:"));

test("triggers: issue_comment and workflow_dispatch only; no PR or fork-reachable trigger", () => {
  assert.match(onBlock, /issue_comment:/);
  assert.match(onBlock, /workflow_dispatch:/);
  assert.doesNotMatch(onBlock, /pull_request|pull_request_target|workflow_run|schedule|push:/);
});

test("dispatch form: control_issue is the only required input; nonce is optional legacy", () => {
  const inputs = onBlock.slice(onBlock.indexOf("inputs:"));
  assert.match(inputs, /control_issue:\s*\n\s+description:[^\n]*\n\s+required: true/);
  assert.match(inputs, /nonce:\s*\n\s+description:[^\n]*\n\s+required: false/);
  assert.deepEqual([...inputs.matchAll(/^ {6}(\w+):$/gm)].map((m) => m[1]), ["control_issue", "nonce"]);
});

test("dispatch trust: actor permission, default-branch ref, fork flag come from event context and the module", () => {
  for (const s of ["github.triggering_actor", "github.ref", "github.event.repository.default_branch", "github.event.repository.fork"]) {
    assert.ok(yml.includes(s), s);
  }
  assert.match(yml, /verifyDispatchLaunchRequest/);
  assert.match(yml, /resolveDispatchExecution/);
  assert.match(yml, /collaborators\/\$\{login\}\/permission/);
  // The execution issue is never read from an input.
  assert.doesNotMatch(yml, /inputs\.(execution|objective|actor|permission)/i);
});

test("non-default-ref dispatch cannot start any privileged step (Audit #1096)", () => {
  // Exactly one job; its `if` is evaluated before checkout or any step, so a dispatch selected on
  // a non-default ref never runs repository code or touches a credential.
  const jobs = yml.slice(yml.indexOf("\njobs:"));
  assert.deepEqual([...jobs.matchAll(/^ {2}([\w-]+):\s*$/gm)].map((m) => m[1]), ["authorize-and-claim"]);
  const job = jobs.slice(jobs.indexOf("authorize-and-claim:"));
  const guard = /\n {4}if: >-\n([\s\S]*?)\n {4}runs-on:/.exec(job);
  assert.ok(guard, "job-level if precedes runs-on and steps");
  assert.ok(job.indexOf("\n    if: >-") < job.indexOf("steps:"));
  const cond = guard[1].replace(/\s+/g, " ");
  assert.match(cond, /github\.event_name == 'workflow_dispatch' && github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  // The dispatch clause is the ref-guarded one only: no bare workflow_dispatch disjunct remains.
  const dispatchClauses = cond.split("||").filter((c) => c.includes("'workflow_dispatch'"));
  assert.equal(dispatchClauses.length, 1);
  assert.match(dispatchClauses[0], /github\.ref ==/);
  // Checkout does not select a ref other than the (default-branch) triggering one.
  assert.doesNotMatch(yml, /uses: actions\/checkout@v4\n\s+with:\n(?:\s+[a-z-]+:[^\n]*\n)*?\s+ref:/);
  // The credential-bearing steps all live inside the guarded job (no step before the guard).
  assert.ok(job.indexOf("steps:") > job.indexOf("if: >-"));
});

test("event-derived values reach the script only through env; no secret echoed; least privilege kept", () => {
  const script = yml.slice(yml.indexOf("node --input-type=module"));
  assert.doesNotMatch(script, /\$\{\{/);
  assert.doesNotMatch(script, /console\.log\([^)]*(workerToken|launchToken|OAUTH)/);
  assert.match(yml, /^permissions:\n {2}contents: write\n {2}pull-requests: write\n {2}issues: write\n {2}actions: read\n/m);
  assert.match(yml, /persist-credentials: false/);
});

test("request record precedes the claim; the claim is settled only after the supervisor returns", () => {
  const i = (s) => yml.indexOf(s);
  assert.ok(i("renderDispatchLaunchRecord({") < i("const body = renderClaimBody"));
  assert.ok(i("const body = renderClaimBody") < i("\"tools/orchestration/launcher-run.mjs\""));
  assert.ok(i("\"tools/orchestration/launcher-run.mjs\"") < i('phase: "DONE"'));
});

test("embedded script is syntactically valid", () => {
  const m = /node --input-type=module <<'JS'\n([\s\S]*?)\n\s*JS\n/.exec(yml);
  assert.ok(m);
  const dedented = m[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
  const dir = mkdtempSync(join(tmpdir(), "ldl-wf-"));
  const f = join(dir, "script.mjs");
  writeFileSync(f, dedented);
  execFileSync(process.execPath, ["--check", f]);
});
