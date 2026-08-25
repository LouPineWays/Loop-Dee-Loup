// Tests for tools/mcp-server/status.mjs. Fixture-based, matching the convention already used
// by tools/ldl-init/index.test.mjs and tools/ldl-update/index.test.mjs: every test that
// touches disk works against disposable mkdtempSync directories cleaned up via t.after(),
// never this repository's own working tree.
//
// Run with: node --test tools/mcp-server/status.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MANAGED_ITEMS, run as ldlInit } from "../ldl-init/index.mjs";
import { computeStatus, computeStatusAll } from "./status.mjs";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "ldl-mcp-status-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Mirrors tools/ldl-update/index.test.mjs's makeFixtureRoot: a source tree whose managed
// content genuinely differs across revisionTag values, so a "newer revision" fixture is a
// real content change, not just a different label.
function makeFixtureRoot(t, revisionTag) {
  const root = tempDir(t);
  for (const item of MANAGED_ITEMS) {
    const absSrc = join(root, item.src);
    if (item.kind === "file") {
      mkdirSync(dirname(absSrc), { recursive: true });
      writeFileSync(absSrc, `fixture content (${revisionTag}): ${item.src}\n`);
    } else {
      mkdirSync(absSrc, { recursive: true });
      writeFileSync(join(absSrc, "SKILL.md"), `fixture content (${revisionTag}): ${item.src}/SKILL.md\n`);
      writeFileSync(join(absSrc, "extra.md"), `fixture content (${revisionTag}): ${item.src}/extra.md\n`);
    }
  }
  writeFileSync(
    join(root, "AGENTS.md"),
    [
      "# Agent operating contract",
      "",
      `Generic rule (${revisionTag}).`,
      "",
      "<!-- ldl:source-only:start -->",
      "Instance-specific state.",
      "<!-- ldl:source-only:end -->",
      "",
    ].join("\n"),
  );
  return root;
}

async function bootstrap(dest, root, revision) {
  const result = await ldlInit({ dest, root }, { resolveRevisionImpl: () => revision, now: () => "2026-08-23T00:00:00.000Z" });
  assert.equal(result.exitCode, 0, `bootstrap fixture setup failed: ${result.message}`);
}

test("computeStatus: missing dest returns an error result", async () => {
  const result = await computeStatus({ dest: undefined, root: "/irrelevant" });
  assert.equal(result.status, "error");
  assert.match(result.error, /dest/);
});

test("computeStatus: nonexistent dest returns an error result", async (t) => {
  const missing = join(tempDir(t), "does-not-exist");
  const result = await computeStatus({ dest: missing, root: "/irrelevant" });
  assert.equal(result.status, "error");
  assert.match(result.error, /does not exist/);
});

test("computeStatus: dest with no .ldl/manifest.json is not_initialized", async (t) => {
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  const result = await computeStatus({ dest, root }, { resolveRevisionImpl: () => "rev-1" });
  assert.equal(result.status, "not_initialized");
  assert.equal(result.installedRevision, null);
  assert.equal(result.sourceRevision, "rev-1");
  assert.equal(result.next, "ldl_init");
});

test("computeStatus: malformed manifest is treated as not_initialized, not a crash", async (t) => {
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  mkdirSync(join(dest, ".ldl"), { recursive: true });
  writeFileSync(join(dest, ".ldl", "manifest.json"), JSON.stringify({ dest: "AGENTS.md" }));
  const result = await computeStatus({ dest, root }, { resolveRevisionImpl: () => "rev-1" });
  assert.equal(result.status, "not_initialized");
  assert.match(result.note, /not in the expected shape/);
});

test("computeStatus: invalid JSON manifest is a deterministic error, not a throw", async (t) => {
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  mkdirSync(join(dest, ".ldl"), { recursive: true });
  writeFileSync(join(dest, ".ldl", "manifest.json"), "{not json");
  const result = await computeStatus({ dest, root }, { resolveRevisionImpl: () => "rev-1" });
  assert.equal(result.status, "error");
  assert.match(result.error, /not valid JSON/);
});

test("computeStatus: freshly bootstrapped repo against the same revision is current", async (t) => {
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, root, "rev-1");
  const result = await computeStatus({ dest, root }, { resolveRevisionImpl: () => "rev-1" });
  assert.equal(result.status, "current");
  assert.equal(result.installedRevision, "rev-1");
  assert.equal(result.sourceRevision, "rev-1");
  assert.equal(result.updateAvailable, false);
  assert.equal(result.next, "none");
  assert.deepEqual(result.conflicts, []);
  assert.ok(result.managedFileCount > 0);
});

test("computeStatus: repo bootstrapped from an older revision is outdated", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, rootV1, "rev-1");

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const result = await computeStatus({ dest, root: rootV2 }, { resolveRevisionImpl: () => "rev-2" });
  assert.equal(result.status, "outdated");
  assert.equal(result.installedRevision, "rev-1");
  assert.equal(result.sourceRevision, "rev-2");
  assert.equal(result.updateAvailable, true);
  assert.equal(result.next, "ldl_update");
  assert.deepEqual(result.conflicts, []);
});

test("computeStatus: locally modified managed file against a newer revision is a conflict", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, rootV1, "rev-1");

  writeFileSync(join(dest, "docs", "operating-model.md"), "locally hand-edited, do not overwrite\n");

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const result = await computeStatus({ dest, root: rootV2 }, { resolveRevisionImpl: () => "rev-2" });
  assert.equal(result.status, "conflict");
  assert.equal(result.next, "manual_resolution");
  assert.ok(result.conflicts.some((c) => c.dest === "docs/operating-model.md"));
});

test("computeStatus: a .ldl replaced by a symlink is refused, not reported current/outdated", async (t) => {
  // Regression guard for a Stage 1 review finding on PR #110: an initialized repo whose
  // .ldl directory was replaced by a symlink must not be reported as a safe status
  // (current/outdated) when ldl_update would refuse the same repository outright.
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, root, "rev-1");
  rmSync(join(dest, ".ldl"), { recursive: true, force: true });
  const escapeTarget = tempDir(t);
  try {
    symlinkSync(escapeTarget, join(dest, ".ldl"), "junction");
  } catch (err) {
    t.skip(`symlink creation not permitted in this environment: ${err.message}`);
    return;
  }

  const result = await computeStatus({ dest, root }, { resolveRevisionImpl: () => "rev-1" });
  assert.equal(result.status, "error");
  assert.match(result.error, /symlink/);
});

test("computeStatus: a managed file replaced by a directory is a per-repo error, not an unhandled throw", async (t) => {
  // Regression guard for a Stage 1 review finding on PR #110: readFileSync throwing EISDIR
  // deep inside planUpdate() must not escape computeStatus as an uncaught rejection.
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, rootV1, "rev-1");

  rmSync(join(dest, "docs", "operating-model.md"), { force: true });
  mkdirSync(join(dest, "docs", "operating-model.md"), { recursive: true });

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const result = await computeStatus({ dest, root: rootV2 }, { resolveRevisionImpl: () => "rev-2" });
  assert.equal(result.status, "error");
  assert.ok(result.error);
});

test("computeStatusAll: one repository throwing does not discard other repositories' healthy results", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");

  const broken = tempDir(t);
  await bootstrap(broken, rootV1, "rev-1");
  rmSync(join(broken, "docs", "operating-model.md"), { force: true });
  mkdirSync(join(broken, "docs", "operating-model.md"), { recursive: true });

  const healthy = tempDir(t);
  await bootstrap(healthy, rootV1, "rev-1");

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const results = await computeStatusAll(
    { repos: [broken, healthy], root: rootV2 },
    { resolveRevisionImpl: () => "rev-2" },
  );
  assert.equal(results[0].status, "error");
  assert.equal(results[1].status, "outdated");
});

test("computeStatusAll: resolves each repository independently in the given order", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const destCurrent = tempDir(t);
  await bootstrap(destCurrent, rootV1, "rev-1");
  const destUninitialized = tempDir(t);

  const results = await computeStatusAll(
    { repos: [destCurrent, destUninitialized], root: rootV1 },
    { resolveRevisionImpl: () => "rev-1" },
  );

  assert.equal(results.length, 2);
  assert.equal(results[0].dest, destCurrent);
  assert.equal(results[0].status, "current");
  assert.equal(results[1].dest, destUninitialized);
  assert.equal(results[1].status, "not_initialized");
});
