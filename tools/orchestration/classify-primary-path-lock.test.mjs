import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizePathForComparison, classifyPrimaryPathLock, runCli } from "./classify-primary-path-lock.mjs";

// -------------------------------------------------------------------------------------------
// normalizePathForComparison
// -------------------------------------------------------------------------------------------

test("normalizePathForComparison unifies separators, case, and trailing slash", () => {
  assert.equal(normalizePathForComparison("C:\\Loop-Dee-Loup"), "c:/loop-dee-loup");
  assert.equal(normalizePathForComparison("C:/Loop-Dee-Loup/"), "c:/loop-dee-loup");
  assert.equal(normalizePathForComparison("c:\\loop-dee-loup\\"), "c:/loop-dee-loup");
});

test("normalizePathForComparison returns null for non-string/empty input", () => {
  assert.equal(normalizePathForComparison(null), null);
  assert.equal(normalizePathForComparison(undefined), null);
  assert.equal(normalizePathForComparison(""), null);
  assert.equal(normalizePathForComparison(42), null);
});

// -------------------------------------------------------------------------------------------
// classifyPrimaryPathLock
// -------------------------------------------------------------------------------------------

const PRIMARY = "C:\\Loop-Dee-Loup";

test("ARCHIVE_CANDIDATE: exactly one matching, non-pinned, non-remote-control session", () => {
  const result = classifyPrimaryPathLock({
    primaryPath: PRIMARY,
    sessions: [
      { sessionId: "s-other", path: "C:\\Loop-Dee-Loup\\.claude\\worktrees\\agent-1" },
      { sessionId: "s-1", path: "c:/loop-dee-loup/" },
    ],
  });
  assert.deepEqual(result, { verdict: "ARCHIVE_CANDIDATE", sessionId: "s-1" });
});

test("PROTECTED_OWNER: matching session is pinned", () => {
  const result = classifyPrimaryPathLock({
    primaryPath: PRIMARY,
    sessions: [{ sessionId: "s-1", path: PRIMARY, pinned: true }],
  });
  assert.deepEqual(result, { verdict: "PROTECTED_OWNER", sessionId: "s-1" });
});

test("PROTECTED_OWNER: matching session is remote-control-active", () => {
  const result = classifyPrimaryPathLock({
    primaryPath: PRIMARY,
    sessions: [{ sessionId: "s-1", path: PRIMARY, remoteControlActive: true }],
  });
  assert.deepEqual(result, { verdict: "PROTECTED_OWNER", sessionId: "s-1" });
});

test("AMBIGUOUS: more than one non-archived session reports the primary path", () => {
  const result = classifyPrimaryPathLock({
    primaryPath: PRIMARY,
    sessions: [
      { sessionId: "s-1", path: PRIMARY },
      { sessionId: "s-2", path: PRIMARY },
    ],
  });
  assert.equal(result.verdict, "AMBIGUOUS");
  assert.deepEqual(result.sessionIds.sort(), ["s-1", "s-2"]);
});

test("NO_VISIBLE_OWNER: empty session list", () => {
  const result = classifyPrimaryPathLock({ primaryPath: PRIMARY, sessions: [] });
  assert.deepEqual(result, { verdict: "NO_VISIBLE_OWNER" });
});

test("NO_VISIBLE_OWNER: no session reports a matching path -- the reproduced #442/#685 condition", () => {
  const result = classifyPrimaryPathLock({
    primaryPath: PRIMARY,
    sessions: [
      { sessionId: "s-1", path: "C:\\Loop-Dee-Loup\\.claude\\worktrees\\agent-1" },
      { sessionId: "s-2", path: null },
    ],
  });
  assert.deepEqual(result, { verdict: "NO_VISIBLE_OWNER" });
});

test("NO_VISIBLE_OWNER: malformed/non-array sessions input never becomes a false match", () => {
  assert.deepEqual(classifyPrimaryPathLock({ primaryPath: PRIMARY, sessions: undefined }), { verdict: "NO_VISIBLE_OWNER" });
  assert.deepEqual(classifyPrimaryPathLock({ primaryPath: PRIMARY, sessions: null }), { verdict: "NO_VISIBLE_OWNER" });
});

test("archived sessions are never candidates, even with a matching path", () => {
  const result = classifyPrimaryPathLock({
    primaryPath: PRIMARY,
    sessions: [{ sessionId: "s-1", path: PRIMARY, archived: true }],
  });
  assert.deepEqual(result, { verdict: "NO_VISIBLE_OWNER" });
});

test("an archived duplicate does not turn an otherwise-single match into AMBIGUOUS", () => {
  const result = classifyPrimaryPathLock({
    primaryPath: PRIMARY,
    sessions: [
      { sessionId: "s-archived", path: PRIMARY, archived: true },
      { sessionId: "s-live", path: PRIMARY },
    ],
  });
  assert.deepEqual(result, { verdict: "ARCHIVE_CANDIDATE", sessionId: "s-live" });
});

test("a session with an unknown (null) path never matches, regardless of other fields", () => {
  const result = classifyPrimaryPathLock({
    primaryPath: PRIMARY,
    sessions: [{ sessionId: "s-1", path: null, pinned: false }],
  });
  assert.deepEqual(result, { verdict: "NO_VISIBLE_OWNER" });
});

test("OPERATIONAL_ERROR: missing/empty primaryPath", () => {
  assert.equal(classifyPrimaryPathLock({ primaryPath: "", sessions: [] }).verdict, "OPERATIONAL_ERROR");
  assert.equal(classifyPrimaryPathLock({ primaryPath: undefined, sessions: [] }).verdict, "OPERATIONAL_ERROR");
});

// -------------------------------------------------------------------------------------------
// CLI
// -------------------------------------------------------------------------------------------

test("runCli: missing --primary-path fails with exit 1", () => {
  const outcome = runCli({ argv: ["--sessions-json", "-"] });
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.message, /--primary-path is required/);
});

test("runCli: missing --sessions-json fails with exit 1", () => {
  const outcome = runCli({ argv: ["--primary-path", PRIMARY] });
  assert.equal(outcome.exitCode, 1);
  assert.match(outcome.message, /--sessions-json is required/);
});

test("runCli: reads a real sessions-json file and returns the classified verdict", () => {
  const dir = mkdtempSync(join(tmpdir(), "classify-primary-path-lock-"));
  try {
    const file = join(dir, "sessions.json");
    writeFileSync(file, JSON.stringify([{ sessionId: "s-1", path: PRIMARY }]), "utf8");
    const outcome = runCli({ argv: ["--primary-path", PRIMARY, "--sessions-json", file] });
    assert.equal(outcome.exitCode, 0);
    assert.deepEqual(outcome.result, { verdict: "ARCHIVE_CANDIDATE", sessionId: "s-1" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCli: non-array sessions-json content fails with exit 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "classify-primary-path-lock-"));
  try {
    const file = join(dir, "sessions.json");
    writeFileSync(file, JSON.stringify({ not: "an array" }), "utf8");
    const outcome = runCli({ argv: ["--primary-path", PRIMARY, "--sessions-json", file] });
    assert.equal(outcome.exitCode, 1);
    assert.match(outcome.message, /must contain a JSON array/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runCli: --sessions-json - reads from an injected stdin implementation", () => {
  const outcome = runCli({
    argv: ["--primary-path", PRIMARY, "--sessions-json", "-"],
    readFileImpl: (fd, enc) => {
      assert.equal(fd, 0);
      assert.equal(enc, "utf8");
      return JSON.stringify([{ sessionId: "s-1", path: PRIMARY, pinned: true }]);
    },
  });
  assert.equal(outcome.exitCode, 0);
  assert.deepEqual(outcome.result, { verdict: "PROTECTED_OWNER", sessionId: "s-1" });
});
