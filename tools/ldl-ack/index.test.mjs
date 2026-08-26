// Tests for tools/ldl-ack/index.mjs (issue #153). Fixture-based, matching the convention
// already used by tools/ldl-init/index.test.mjs and tools/ldl-update/index.test.mjs: every
// test that touches disk works against disposable mkdtempSync directories cleaned up via
// t.after(), never this repository's own working tree.
//
// Run with: node --test tools/ldl-ack/index.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MANAGED_ITEMS, planAcknowledgeIntegration, run as ldlInit } from "../ldl-init/index.mjs";
import { run as ldlUpdate } from "../ldl-update/index.mjs";
import { parseArgs, run } from "./index.mjs";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "ldl-ack-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Mirrors tools/ldl-update/index.test.mjs's makeFixtureRoot: revisionTag is folded into every
// fixture file's content, including both bridge files, so a "newer revision" fixture is a real
// content change, not just a different label.
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
    ["# Agent operating contract", "", `Generic rule (${revisionTag}).`, "", "<!-- ldl:source-only:start -->", "Instance-specific state.", "<!-- ldl:source-only:end -->", ""].join("\n"),
  );
  writeFileSync(join(root, "CLAUDE.md"), `# Claude Code instructions\n\n@AGENTS.md\n\n(${revisionTag})\n`);
  return root;
}

function readManifest(dest) {
  return JSON.parse(readFileSync(join(dest, ".ldl", "manifest.json"), "utf8"));
}

async function bootstrap(dest, root, revision = "rev-1") {
  const result = await ldlInit({ dest, root }, { resolveRevisionImpl: () => revision, now: () => "2026-08-23T00:00:00.000Z" });
  assert.equal(result.exitCode, 0, `bootstrap fixture setup failed: ${result.message}`);
  return result;
}

test("run: exits 1 when --dest is missing", async () => {
  const result = await run({ bridge: "CLAUDE.md" });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /--dest/);
});

test("run: exits 1 when --bridge is missing", async (t) => {
  const dest = tempDir(t);
  const result = await run({ dest });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /--bridge/);
});

test("run: exits 1 when --dest does not exist", async (t) => {
  const missing = join(tempDir(t), "does-not-exist");
  const result = await run({ dest: missing, bridge: "CLAUDE.md" });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /does not exist/);
});

test("run: exits 1 with a clear message when --dest has no .ldl/manifest.json yet", async (t) => {
  const dest = tempDir(t);
  const result = await run({ dest, bridge: "CLAUDE.md" });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /run tools\/ldl-init first/);
});

test("run: refuses an unknown bridge name and writes nothing", async (t) => {
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  writeFileSync(join(dest, "CLAUDE.md"), "MY PROJECT'S OWN CLAUDE.md, unmerged\n");
  await bootstrap(dest, root, "rev-1");
  const before = readManifest(dest);

  const result = await run({ dest, root, bridge: "README.md" });

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /unknown bridge/);
  assert.deepEqual(readManifest(dest), before);
});

test("run: refuses when there is no pending manual integration for the named bridge", async (t) => {
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, root, "rev-1"); // no pre-existing CLAUDE.md — installs straight to root, nothing pending
  const before = readManifest(dest);
  assert.ok(before.files.some((f) => f.dest === "CLAUDE.md"));

  const result = await run({ dest, root, bridge: "CLAUDE.md" });

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /no pending manual integration/);
  assert.deepEqual(readManifest(dest), before);
});

test("run: acknowledges a genuinely parked bridge, clears pendingManualIntegration, and never adds the destination to files[]", async (t) => {
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  writeFileSync(join(dest, "AGENTS.md"), "# My project\n\nOwn instructions.\n\nGeneric rule (rev-1).\n");
  await bootstrap(dest, root, "rev-1");
  const before = readManifest(dest);
  assert.equal(before.pendingManualIntegration.length, 1);
  assert.equal(before.pendingManualIntegration[0].dest, "AGENTS.md");

  const result = await run({ dest, root, bridge: "AGENTS.md" }, { now: () => "2026-08-24T00:00:00.000Z" });

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.message);
  assert.equal(parsed.acknowledged, "AGENTS.md");
  assert.equal(parsed.template, ".ldl/AGENTS.template.md");
  assert.equal(parsed.manualIntegrationNeeded, 0);

  const after = readManifest(dest);
  assert.deepEqual(after.pendingManualIntegration, []);
  assert.equal(after.manualIntegrationAcknowledgements.length, 1);
  assert.equal(after.manualIntegrationAcknowledgements[0].dest, "AGENTS.md");
  assert.equal(after.manualIntegrationAcknowledgements[0].template, ".ldl/AGENTS.template.md");
  assert.equal(after.manualIntegrationAcknowledgements[0].acknowledgedAt, "2026-08-24T00:00:00.000Z");
  assert.match(after.manualIntegrationAcknowledgements[0].acknowledgedTargetSha256, /^[0-9a-f]{64}$/);
  assert.ok(!after.files.some((f) => f.dest === "AGENTS.md"), "acknowledged bridge must remain consumer-owned, never LDL-managed");
  assert.deepEqual(after.files, before.files, "acknowledging must never change the managed files[] set");
  assert.deepEqual(after.skipped, before.skipped, "acknowledging must never touch the skipped[] set");
  assert.equal(after.ldlSourceRevision, before.ldlSourceRevision, "acknowledging is not an install or update — revision/timestamp stay put");
  assert.equal(after.installedAt, before.installedAt);
  // The consumer's own combined file is untouched on disk.
  assert.equal(readFileSync(join(dest, "AGENTS.md"), "utf8"), "# My project\n\nOwn instructions.\n\nGeneric rule (rev-1).\n");
});

test("run: independently acknowledges CLAUDE.md, leaving AGENTS.md's own pending state untouched", async (t) => {
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  writeFileSync(join(dest, "AGENTS.md"), "MY PROJECT'S OWN AGENTS.md, unmerged\n");
  writeFileSync(join(dest, "CLAUDE.md"), "MY PROJECT'S OWN CLAUDE.md, unmerged\n");
  await bootstrap(dest, root, "rev-1");
  assert.equal(readManifest(dest).pendingManualIntegration.length, 2);

  const result = await run({ dest, root, bridge: "CLAUDE.md" });

  assert.equal(result.exitCode, 0);
  const after = readManifest(dest);
  assert.equal(after.pendingManualIntegration.length, 1);
  assert.equal(after.pendingManualIntegration[0].dest, "AGENTS.md");
  assert.equal(after.manualIntegrationAcknowledgements.length, 1);
  assert.equal(after.manualIntegrationAcknowledgements[0].dest, "CLAUDE.md");
});

test("run: re-acknowledging a bridge whose own target changed upserts (replaces) its prior acknowledgement rather than accumulating", async (t) => {
  // An acknowledgement binds to the bridge's *target* content hash (what LDL would install),
  // not the consumer's own file — so only a real target change (a newer Loop-Dee-Loup revision
  // that actually edits the bridge) reopens pendingManualIntegration; editing the consumer's
  // own combined file again does not, by design (see planAcknowledgeIntegration's own comment).
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  writeFileSync(join(dest, "CLAUDE.md"), "MY PROJECT'S OWN CLAUDE.md, unmerged\n");
  await bootstrap(dest, rootV1, "rev-1");

  const first = await run({ dest, root: rootV1, bridge: "CLAUDE.md" }, { now: () => "2026-08-24T00:00:00.000Z" });
  assert.equal(first.exitCode, 0);
  assert.equal(readManifest(dest).manualIntegrationAcknowledgements.length, 1);

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const updateResult = await ldlUpdate({ dest, root: rootV2 }, { resolveRevisionImpl: () => "rev-2" });
  assert.equal(updateResult.exitCode, 0);
  assert.equal(readManifest(dest).pendingManualIntegration.length, 1, "sanity check: a genuinely changed bridge target must reopen pending");

  const second = await run({ dest, root: rootV2, bridge: "CLAUDE.md" }, { now: () => "2026-08-25T00:00:00.000Z" });
  assert.equal(second.exitCode, 0);

  const after = readManifest(dest);
  assert.equal(after.manualIntegrationAcknowledgements.length, 1, "must upsert, not accumulate a second entry for the same bridge");
  assert.equal(after.manualIntegrationAcknowledgements[0].acknowledgedAt, "2026-08-25T00:00:00.000Z");
  assert.deepEqual(after.pendingManualIntegration, []);
});

test("run: refuses when the parked template is missing, writing nothing", async (t) => {
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  writeFileSync(join(dest, "CLAUDE.md"), "MY PROJECT'S OWN CLAUDE.md, unmerged\n");
  await bootstrap(dest, root, "rev-1");
  const before = readManifest(dest);
  rmSync(join(dest, ".ldl", "CLAUDE.template.md"));
  const beforeMtime = statSync(join(dest, ".ldl", "manifest.json")).mtimeMs;

  const result = await run({ dest, root, bridge: "CLAUDE.md" });

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /does not exist/);
  assert.deepEqual(readManifest(dest), before);
  assert.equal(statSync(join(dest, ".ldl", "manifest.json")).mtimeMs, beforeMtime);
});

test("run: refuses when the consumer-owned destination is a symlink", async (t) => {
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  const elsewhere = join(dest, "elsewhere.md");
  writeFileSync(elsewhere, "MY PROJECT'S OWN CLAUDE.md via symlink, unmerged\n");
  try {
    symlinkSync(elsewhere, join(dest, "CLAUDE.md"));
  } catch (err) {
    t.skip(`symlink creation not permitted in this environment: ${err.message}`);
    return;
  }
  await bootstrap(dest, root, "rev-1");

  const result = await run({ dest, root, bridge: "CLAUDE.md" });

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /symlink/);
});

test("run: rejects a malformed .ldl/manifest.json instead of acknowledging against untrusted state", async (t) => {
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  mkdirSync(join(dest, ".ldl"), { recursive: true });
  writeFileSync(join(dest, ".ldl", "manifest.json"), JSON.stringify({ dest: "AGENTS.md" }));

  const result = await run({ dest, root, bridge: "AGENTS.md" });

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /not in the expected shape/);
});

test("run: aborts without writing anything when deps.beforeWrite reports staleness immediately before the write (Stage 1 review finding on PR #159)", async (t) => {
  // tools/mcp-server wires deps.beforeWrite to its own process-coherence recheck, called right
  // before the manifest write rather than only once at MCP tool-call entry — this test proves
  // run() actually honors that hook at the correct point, independent of MCP server plumbing.
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  writeFileSync(join(dest, "CLAUDE.md"), "MY PROJECT'S OWN CLAUDE.md, unmerged\n");
  await bootstrap(dest, root, "rev-1");
  const manifestPath = join(dest, ".ldl", "manifest.json");
  const before = readFileSync(manifestPath, "utf8");

  const result = await run(
    { dest, root, bridge: "CLAUDE.md" },
    { beforeWrite: () => "simulated staleness: backing checkout changed mid-call" },
  );

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /simulated staleness/);
  assert.equal(readFileSync(manifestPath, "utf8"), before, "a reported staleness must abort before any write, leaving the manifest untouched");
});

test("run: a falsy deps.beforeWrite result (the CLI default) never blocks a genuine acknowledgement", async (t) => {
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  writeFileSync(join(dest, "CLAUDE.md"), "MY PROJECT'S OWN CLAUDE.md, unmerged\n");
  await bootstrap(dest, root, "rev-1");

  const result = await run({ dest, root, bridge: "CLAUDE.md" }, { beforeWrite: () => null });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(readManifest(dest).pendingManualIntegration, []);
});

// Stage 1 review finding on PR #159: acknowledging must fail closed rather than binding to a
// target the parked template on disk never actually showed the consumer.

test("planAcknowledgeIntegration: refuses when the parked template is stale relative to the current --root bridge content", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  writeFileSync(join(dest, "CLAUDE.md"), "MY PROJECT'S OWN CLAUDE.md, unmerged\n");
  await bootstrap(dest, rootV1, "rev-1");
  // Sanity check: the template on disk right now genuinely reflects rev-1.
  const templateBefore = readFileSync(join(dest, ".ldl", "CLAUDE.template.md"), "utf8");
  assert.match(templateBefore, /\(rev-1\)/);

  // The LDL checkout advances to rev-2 (a real content change to CLAUDE.md's own target), but
  // the consumer never ran tools/ldl-update to refresh the parked template — it's still rev-1.
  const rootV2 = makeFixtureRoot(t, "rev-2");
  const manifest = readManifest(dest);

  const result = planAcknowledgeIntegration({ bridgeDestRel: "CLAUDE.md", root: rootV2, destRoot: dest, existingManifest: manifest });

  assert.equal(result.ok, false);
  assert.match(result.reason, /does not match the current bridge target content/);
  assert.match(result.reason, /run tools\/ldl-update/i);
});

test("planAcknowledgeIntegration: refuses when the bridge destination is a directory, not a regular file", async (t) => {
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  // A directory literally named CLAUDE.md — planBridgeOp still parks a template because
  // readFileSync on a directory throws, but there is no actual file a human could have merged
  // anything into.
  mkdirSync(join(dest, "CLAUDE.md"), { recursive: true });
  await bootstrap(dest, root, "rev-1");
  const manifest = readManifest(dest);
  assert.equal(manifest.pendingManualIntegration.length, 1, "sanity check: a directory collision must still park the template");

  const result = planAcknowledgeIntegration({ bridgeDestRel: "CLAUDE.md", root, destRoot: dest, existingManifest: manifest });

  assert.equal(result.ok, false);
  assert.match(result.reason, /not a regular file/);
});

test("parseArgs: reads --dest, --bridge, and --root flags", () => {
  const args = parseArgs(["--dest", "/tmp/consumer", "--bridge", "AGENTS.md", "--root", "/tmp/ldl"]);
  assert.equal(args.dest, "/tmp/consumer");
  assert.equal(args.bridge, "AGENTS.md");
  assert.equal(args.root, "/tmp/ldl");
});
