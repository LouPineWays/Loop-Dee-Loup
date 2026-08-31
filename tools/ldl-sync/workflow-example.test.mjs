// Regression coverage for issue #232 ("Fail LDL consumer syncs loudly instead of allowing
// silent drift"). The example ldl-sync.yml workflow embedded in docs/consumer-contract.md,
// "Automated consumer sync", is the LDL-provided synchronization mechanism every consumer
// copies verbatim as a starting point. tools/ldl-update already fails loudly on any conflict
// (see tools/ldl-update/index.test.mjs) — but that guarantee only reaches a real consumer
// repository if the CI orchestration wrapping it propagates failure faithfully, rather than a
// broad `set +e` letting a later, unrelated check (e.g. "nothing staged to commit") misreport a
// real upstream failure as a legitimate no-op. This extracts the actual "Open or update sync
// PR" and "Preflight PR-creation permission" steps' shell scripts straight out of the doc and
// runs them against a real temporary git repository — with `git`/`gh` stubbed only where a live
// GitHub remote would otherwise be unavoidable — so a future edit that reintroduces that
// failure mode is caught here instead of only in a live consumer run.
//
// Tests: node --test tools/ldl-sync/workflow-example.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DOC_PATH = join(REPO_ROOT, "docs", "consumer-contract.md");
const DOC_TEXT = readFileSync(DOC_PATH, "utf8");
const PATH_SEP = process.platform === "win32" ? ";" : ":";

// A dependency-free substitute for a real YAML parser (this repository has no npm dependencies
// at all): locates the workflow step whose YAML carries `id: <stepId>`, then reads its
// `run: |` block forward until a line indented at or shallower than the `run:` key itself.
export function extractStepRunBlock(docText, stepId) {
  const idMarker = `id: ${stepId}`;
  const idIdx = docText.indexOf(idMarker);
  if (idIdx === -1) throw new Error(`step "id: ${stepId}" not found in ${DOC_PATH}`);
  const runIdx = docText.indexOf("run: |", idIdx);
  if (runIdx === -1) throw new Error(`no "run: |" found after step "id: ${stepId}"`);
  const runLineStart = docText.lastIndexOf("\n", runIdx) + 1;
  const runIndent = runIdx - runLineStart;
  const blockLines = [];
  for (const line of docText.slice(runIdx).split("\n").slice(1)) {
    if (line.trim() === "") {
      blockLines.push("");
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent <= runIndent) break;
    blockLines.push(line);
  }
  const minIndent = Math.min(...blockLines.filter((l) => l.trim() !== "").map((l) => l.length - l.trimStart().length));
  return blockLines.map((l) => (l.trim() === "" ? "" : l.slice(minIndent))).join("\n");
}

test("extractStepRunBlock: pulls the exact open_pr step body out of the doc", () => {
  const block = extractStepRunBlock(DOC_TEXT, "open_pr");
  assert.ok(block.includes('git checkout -B "$SYNC_BRANCH"'));
  assert.ok(block.includes("gh pr create"));
  assert.ok(!block.includes("\nset +e\ngit config"), "set +e must not cover the git plumbing (issue #232)");
});

// Redirects `git remote set-url origin <url>` to $TEST_REMOTE_URL instead, so the extracted
// script's hardcoded github.com URL never has to reach the real network; every other git
// invocation passes straight through to the real git binary.
function makeGitStub(binDir, realGit) {
  const script = [
    "#!/usr/bin/env bash",
    'if [ "$1" = "remote" ] && [ "$2" = "set-url" ]; then',
    `  exec "${realGit}" remote set-url "$3" "$TEST_REMOTE_URL"`,
    "fi",
    `exec "${realGit}" "$@"`,
    "",
  ].join("\n");
  const gitPath = join(binDir, "git");
  writeFileSync(gitPath, script);
  chmodSync(gitPath, 0o755);
}

// Stands in for the real `gh` CLI: `pr list` reports `existingPr` (empty means none), and
// `pr create`/`pr edit` either succeeds (writing its argv to $GH_STUB_CALL_LOG) or fails with
// `createStderr` on stderr, exactly as gh itself would.
function makeGhStub(binDir, { existingPr = "", createFails = false, createStderr = "" } = {}) {
  const script = [
    "#!/usr/bin/env bash",
    'if [ "$1" = "pr" ] && [ "$2" = "list" ]; then',
    `  printf '%s' "${existingPr}"`,
    "  exit 0",
    "fi",
    'if [ "$1" = "pr" ] && { [ "$2" = "create" ] || [ "$2" = "edit" ]; }; then',
    '  echo "$@" > "$GH_STUB_CALL_LOG"',
    `  if [ "${createFails ? "1" : "0"}" = "1" ]; then`,
    `    echo "${createStderr}" >&2`,
    "    exit 1",
    "  fi",
    '  echo "https://example.invalid/pr/1"',
    "  exit 0",
    "fi",
    'echo "gh stub: unrecognized invocation: $*" >&2',
    "exit 1",
    "",
  ].join("\n");
  const ghPath = join(binDir, "gh");
  writeFileSync(ghPath, script);
  chmodSync(ghPath, 0o755);
}

function initSelfRepo(dir) {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "hello\n");
  mkdirSync(join(dir, "tools", "ldl-sync"), { recursive: true });
  // The gh-pr-create-denied scenario below exercises the real classify() path, which requires
  // the real pr-permission.mjs this doc's "Open or update sync PR" step actually shells out to
  // — a fixture-authored stand-in would silently stop testing the real classification logic.
  writeFileSync(
    join(dir, "tools", "ldl-sync", "pr-permission.mjs"),
    readFileSync(join(REPO_ROOT, "tools", "ldl-sync", "pr-permission.mjs")),
  );
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  // actions/checkout@v4 always leaves an "origin" remote behind; the extracted step only ever
  // `set-url`s it, never `add`s it, so a fixture without one would fail for a reason the real
  // workflow never hits.
  execFileSync("git", ["remote", "add", "origin", "https://example.invalid/placeholder.git"], { cwd: dir });
}

function runExtractedStep(stepId, { cwd, binDir, env }) {
  const script = extractStepRunBlock(DOC_TEXT, stepId);
  const summaryPath = join(cwd, "..", "step-summary.md");
  writeFileSync(summaryPath, "");
  const callLogPath = join(cwd, "..", "gh-call-log.txt");
  const result = spawnSync("bash", ["-c", script], {
    cwd,
    env: {
      ...process.env,
      PATH: `${binDir}${PATH_SEP}${process.env.PATH}`,
      GITHUB_STEP_SUMMARY: summaryPath,
      GH_STUB_CALL_LOG: callLogPath,
      SYNC_BRANCH: "ldl-sync/auto-update",
      GITHUB_REPOSITORY: "acme/widgets",
      GH_TOKEN: "test-token",
      PRIOR_REV: "abc123",
      TARGET_REV: "def456",
      GIT_TERMINAL_PROMPT: "0",
      ...env,
    },
    encoding: "utf8",
  });
  const summary = readFileSync(summaryPath, "utf8");
  return { ...result, summary };
}

function withFixture(fn) {
  const root = mkdtempSync(join(tmpdir(), "ldl-sync-workflow-"));
  const selfDir = join(root, "self");
  const binDir = join(root, "bin");
  mkdirSync(selfDir);
  mkdirSync(binDir);
  const realGit = execFileSync(process.platform === "win32" ? "where" : "command", process.platform === "win32" ? ["git"] : ["-v", "git"], {
    encoding: "utf8",
  })
    .split("\n")[0]
    .trim();
  makeGitStub(binDir, realGit);
  initSelfRepo(selfDir);
  try {
    return fn({ root, selfDir, binDir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("open_pr step: a genuine no-op (nothing staged) exits 0 without ever attempting a push or a PR call", () => {
  withFixture(({ selfDir, binDir, root }) => {
    // No changes made since the fixture's own initial commit — checkout + add stages nothing.
    execFileSync("git", ["checkout", "-b", "ldl-sync/auto-update"], { cwd: selfDir });
    execFileSync("git", ["checkout", "main"], { cwd: selfDir });
    const result = runExtractedStep("open_pr", {
      cwd: selfDir,
      binDir,
      env: { TEST_REMOTE_URL: join(root, "does-not-exist.git") },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Nothing to commit/);
    assert.equal(result.summary, "", "a genuine no-op must not write any failure summary");
  });
});

test("open_pr step: an induced git-plumbing failure (invalid ref name) fails loudly instead of falling through to the no-op branch", () => {
  withFixture(({ selfDir, binDir, root }) => {
    writeFileSync(join(selfDir, "managed.txt"), "changed content\n");
    const result = runExtractedStep("open_pr", {
      cwd: selfDir,
      binDir,
      env: {
        TEST_REMOTE_URL: join(root, "does-not-exist.git"),
        // ".." is rejected by `git check-ref-format`, so `git checkout -B` fails outright —
        // this is the exact shape of failure a blanket `set +e` previously swallowed, letting
        // the step reach `git diff --cached --quiet` and misreport success (issue #232).
        SYNC_BRANCH: "bad..branch",
      },
    });
    assert.notEqual(result.status, 0, "an induced git failure must not exit 0");
    assert.doesNotMatch(
      result.stdout,
      /Nothing to commit/,
      "a real git failure must never be reported as the legitimate no-op branch",
    );
  });
});

test("open_pr step: a push failure against an unreachable remote fails loudly and leaves a durable step-summary record", () => {
  withFixture(({ selfDir, binDir, root }) => {
    writeFileSync(join(selfDir, "managed.txt"), "changed content\n");
    const result = runExtractedStep("open_pr", {
      cwd: selfDir,
      binDir,
      env: { TEST_REMOTE_URL: join(root, "does-not-exist.git") },
    });
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /Nothing to commit/);
    assert.match(result.summary, /LDL Sync: failed to push the sync branch/);
  });
});

test("open_pr step: a successful sync with real changes pushes and calls gh pr create, reported as success", () => {
  withFixture(({ selfDir, binDir, root }) => {
    const bareRemote = join(root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", bareRemote]);
    makeGhStub(binDir, {});
    writeFileSync(join(selfDir, "managed.txt"), "changed content\n");
    const result = runExtractedStep("open_pr", {
      cwd: selfDir,
      binDir,
      env: { TEST_REMOTE_URL: bareRemote },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.summary, "", "a genuine success must not write any failure summary");
    const callLog = readFileSync(join(root, "gh-call-log.txt"), "utf8");
    assert.match(callLog, /pr create/);
  });
});

test("open_pr step: gh pr create denied by repository policy is classified and reported, matching the YouTubery incident (issue #217)", () => {
  withFixture(({ selfDir, binDir, root }) => {
    const bareRemote = join(root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", bareRemote]);
    makeGhStub(binDir, {
      createFails: true,
      createStderr: "GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)",
    });
    writeFileSync(join(selfDir, "managed.txt"), "changed content\n");
    const result = runExtractedStep("open_pr", {
      cwd: selfDir,
      binDir,
      env: { TEST_REMOTE_URL: bareRemote },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.summary, /PR creation blocked by repository policy/);
    assert.match(result.summary, /Allow GitHub Actions to create and approve pull requests/);
  });
});

test("preflight step: an unexpected crash (not the known 'denied' exit code) still fails the step instead of being silently treated as allowed (issue #232)", () => {
  withFixture(({ selfDir, binDir }) => {
    // Point the preflight step at a script path that doesn't exist so node exits with its own
    // generic module-not-found failure — a real crash, not the pr-permission.mjs CLI's own
    // documented exit code 3.
    const script = extractStepRunBlock(DOC_TEXT, "preflight").replace(
      "self/tools/ldl-sync/pr-permission.mjs",
      "self/tools/ldl-sync/does-not-exist.mjs",
    );
    const summaryPath = join(selfDir, "..", "step-summary.md");
    writeFileSync(summaryPath, "");
    const result = spawnSync("bash", ["-c", script], {
      cwd: selfDir,
      env: {
        ...process.env,
        PATH: `${binDir}${PATH_SEP}${process.env.PATH}`,
        GITHUB_STEP_SUMMARY: summaryPath,
        GITHUB_REPOSITORY: "acme/widgets",
      },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, "a genuine crash must not be treated as an allowed/unknown preflight result");
    const summary = readFileSync(summaryPath, "utf8");
    assert.match(summary, /preflight check failed unexpectedly/);
  });
});
