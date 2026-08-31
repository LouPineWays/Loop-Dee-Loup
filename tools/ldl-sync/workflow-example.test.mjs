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

// bash's own PATH lookup needs a colon-separated value. On a Windows/MSYS toolchain, the OS's
// $PATH is semicolon-separated and MSYS auto-translates it to POSIX form only for its *own*
// process's inherited PATH at startup — an arbitrary env var this suite hands a child bash
// process (LDL_TEST_REAL_PATH, below) never goes through that translation, so passing
// process.env.PATH straight through leaves the git stub unable to find the real git binary on
// Windows. Round-tripping through a real bash process (a no-op on Linux, where PATH is already
// POSIX) gets the form bash itself will actually be able to use.
const REAL_PATH = execFileSync("bash", ["-c", 'printf "%s" "$PATH"'], { encoding: "utf8" });

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
// invocation passes straight through to the real git binary. Resolves "the real git binary" by
// re-scoping PATH to $LDL_TEST_REAL_PATH (the PATH captured before this stub's own binDir was
// prepended to it) for that one lookup, rather than asking Node to locate git's absolute path
// itself — `command -v git`/`where git` requires spawning a `command`/`where` executable, and on
// the Ubuntu runner this suite's own CI actually uses, `command` is a shell builtin with no
// standalone executable at all, so `execFileSync("command", ...)` fails with ENOENT before any
// fixture even runs (Stage 1 review finding on PR #236).
function makeGitStub(binDir) {
  const script = [
    "#!/usr/bin/env bash",
    'if [ "$1" = "remote" ] && [ "$2" = "set-url" ]; then',
    '  PATH="$LDL_TEST_REAL_PATH" git remote set-url "$3" "$TEST_REMOTE_URL"',
    "  exit $?",
    "fi",
    'PATH="$LDL_TEST_REAL_PATH" exec git "$@"',
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
  // GitHub Actions' own default bash shell for `run:` steps is
  // `bash --noprofile --norc -eo pipefail {0}` — plain `bash -c script` runs with neither `-e`
  // nor `pipefail`, so a plumbing failure the real workflow would abort on (e.g. `checkout -B`)
  // would instead let this harness keep running past it, potentially still reaching a later,
  // unrelated failure (a broken push) and reporting a non-zero exit for the wrong reason. Stage
  // 1 review on PR #236 confirmed exactly this: the induced-git-failure test below still passed
  // even with the prohibited blanket `set +e` reintroduced, because the harness itself wasn't
  // enforcing the abort-on-error semantics it was supposed to be checking for.
  const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
    cwd,
    env: {
      ...process.env,
      LDL_TEST_REAL_PATH: REAL_PATH,
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
  makeGitStub(binDir);
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
    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: selfDir, encoding: "utf8" }).trim();
    writeFileSync(join(selfDir, "managed.txt"), "changed content\n");
    const result = runExtractedStep("open_pr", {
      cwd: selfDir,
      binDir,
      env: {
        // Point push at a path that doesn't exist, so if execution *incorrectly* reaches the
        // push line (the bug this test exists to catch) it would still fail there too — a
        // weaker assertion further down could otherwise mistake that unrelated push failure for
        // this test having actually verified the checkout failure stopped execution (Stage 1
        // review finding on PR #236: this exact test still passed with the prohibited blanket
        // `set +e` reintroduced, purely because the later push also failed).
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
    // The decisive check: execution must never have reached `git commit` at all. A run that
    // (incorrectly) survives the checkout failure would stage and commit the change before
    // failing later at push — moving HEAD — even though the overall exit code and stdout checks
    // above could look identical either way.
    const headAfter = execFileSync("git", ["rev-parse", "HEAD"], { cwd: selfDir, encoding: "utf8" }).trim();
    assert.equal(headAfter, headBefore, "no commit should exist — execution must have stopped at the failed checkout, before ever staging or committing");
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
    // Same Actions-faithful shell invocation as runExtractedStep — see its own comment.
    const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script], {
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
