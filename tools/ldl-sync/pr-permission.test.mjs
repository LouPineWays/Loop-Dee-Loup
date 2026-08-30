// Tests for tools/ldl-sync/pr-permission.mjs. All process/network access is faked via the
// injected `execImpl` option — never touch the real filesystem, git, or GitHub here. Run with:
//   node --test tools/ldl-sync/pr-permission.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  REMEDIATION,
  classifyPrCreateFailure,
  formatDeniedSummary,
  formatUnexpectedSummary,
  parseArgs,
  preflightPrPermission,
} from "./pr-permission.mjs";

const MODULE_PATH = fileURLToPath(import.meta.url).replace(/\.test\.mjs$/, ".mjs");

// The exact error text observed on YouTubery scheduled run 33310402496 (issue #217) — this is
// the regression fixture for "update and scope verification succeed but gh pr create is denied
// because Actions cannot create PRs".
const REAL_DENIED_STDERR = "pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)";

test("classifyPrCreateFailure: recognizes the exact GitHub Actions PR-creation-denied error text", () => {
  assert.equal(classifyPrCreateFailure(REAL_DENIED_STDERR), "pr_creation_denied");
});

test("classifyPrCreateFailure: matches case-insensitively", () => {
  assert.equal(classifyPrCreateFailure(REAL_DENIED_STDERR.toUpperCase()), "pr_creation_denied");
});

test("classifyPrCreateFailure: an unrelated failure is classified as unexpected, not silently misdetected", () => {
  assert.equal(classifyPrCreateFailure("pull request create failed: HTTP 503: Service Unavailable"), "unexpected");
});

test("classifyPrCreateFailure: empty/undefined stderr is unexpected, not a crash", () => {
  assert.equal(classifyPrCreateFailure(""), "unexpected");
  assert.equal(classifyPrCreateFailure(undefined), "unexpected");
});

test("formatDeniedSummary: names the exact repository setting to fix", () => {
  const summary = formatDeniedSummary();
  assert.match(summary, /Settings -> Actions -> General -> Workflow permissions/);
  assert.match(summary, /Allow GitHub Actions to create and approve pull requests/);
  assert.ok(summary.includes(REMEDIATION));
});

test("formatDeniedSummary: states the pushed branch must not be treated as a completed sync", () => {
  assert.match(formatDeniedSummary(), /do not[\s\S]*treat the pushed sync branch/i);
});

test("formatUnexpectedSummary: includes the raw stderr for investigation, not a generic collapse", () => {
  const summary = formatUnexpectedSummary("some unrelated gh failure text");
  assert.match(summary, /some unrelated gh failure text/);
});

test("preflightPrPermission: reports denied when the API reports the setting disabled", () => {
  const result = preflightPrPermission("owner/repo", {
    execImpl: () => JSON.stringify({ default_workflow_permissions: "read", can_approve_pull_request_reviews: false }),
  });
  assert.deepEqual(result, { status: "denied" });
});

test("preflightPrPermission: reports allowed when the API reports the setting enabled", () => {
  const result = preflightPrPermission("owner/repo", {
    execImpl: () => JSON.stringify({ default_workflow_permissions: "write", can_approve_pull_request_reviews: true }),
  });
  assert.deepEqual(result, { status: "allowed" });
});

test("preflightPrPermission: reports unknown, not denied, when the read itself fails (e.g. missing token scope)", () => {
  const result = preflightPrPermission("owner/repo", {
    execImpl: () => {
      throw new Error("HTTP 403: Resource not accessible by integration");
    },
  });
  assert.equal(result.status, "unknown");
  assert.match(result.reason, /preflight read failed/);
});

test("preflightPrPermission: reports unknown on malformed JSON rather than throwing", () => {
  const result = preflightPrPermission("owner/repo", { execImpl: () => "not json" });
  assert.equal(result.status, "unknown");
});

test("preflightPrPermission: reports unknown when the expected field is absent from the response", () => {
  const result = preflightPrPermission("owner/repo", { execImpl: () => JSON.stringify({ default_workflow_permissions: "read" }) });
  assert.equal(result.status, "unknown");
  assert.match(result.reason, /can_approve_pull_request_reviews/);
});

test("preflightPrPermission: passes the repo through to the gh invocation", () => {
  let seenArgs;
  preflightPrPermission("some-owner/some-repo", {
    execImpl: (cmd, cmdArgs) => {
      seenArgs = cmdArgs;
      return JSON.stringify({ can_approve_pull_request_reviews: true });
    },
  });
  assert.deepEqual(seenArgs, ["api", "repos/some-owner/some-repo/actions/permissions/workflow"]);
});

test("parseArgs: reads --repo", () => {
  assert.deepEqual(parseArgs(["--repo", "owner/repo"]), { repo: "owner/repo" });
});

test("entrypoint guard: importing this module from a script whose own path also ends in 'pr-permission.mjs' must not trigger main() (Stage 1 review finding on PR #219)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pr-permission-entrypoint-test-"));
  try {
    const importerPath = join(dir, "custom-pr-permission.mjs");
    writeFileSync(importerPath, `import ${JSON.stringify(pathToFileURL(MODULE_PATH).href)};\nconsole.log("imported ok");\n`);
    const output = execFileSync(process.execPath, [importerPath], { encoding: "utf8" });
    assert.equal(output.trim(), "imported ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
