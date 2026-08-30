// Tests for tools/ldl-init/index.mjs. Fixture-based per issue #66's requirement to inspect
// resulting repository state (file presence, manifest contents), not merely exit codes.
// Every test that touches disk works against disposable temp directories created with
// fs.mkdtempSync and removed via t.after() — never this repository's own working tree.
// Run with:
//   node --test tools/ldl-init/index.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRIDGE_FILES,
  MANAGED_ITEMS,
  SYNC_PR_PERMISSION_WARNING,
  buildOps,
  contentMatchesHash,
  deriveConsumerAgents,
  defaultResolveRevision,
  derivePendingManualIntegration,
  deriveSyncPrerequisiteWarnings,
  findBridgeByDestRel,
  isValidManifest,
  looksBinary,
  normalizeLineEndings,
  parseArgs,
  planAcknowledgeIntegration,
  planBridgeOp,
  planInstall,
  run,
  sha256,
} from "./index.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "ldl-init-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Builds a fixture Loop-Dee-Loup source root that mirrors MANAGED_ITEMS exactly (derived
// from the real list, not hand-copied), so tests stay correct if that list changes and
// never depend on this repository's own real, evolving file content.
function makeFixtureRoot(t) {
  const root = tempDir(t);
  for (const item of MANAGED_ITEMS) {
    const absSrc = join(root, item.src);
    if (item.kind === "file") {
      mkdirSync(dirname(absSrc), { recursive: true });
      writeFileSync(absSrc, `fixture content: ${item.src}\n`);
    } else {
      mkdirSync(absSrc, { recursive: true });
      writeFileSync(join(absSrc, "SKILL.md"), `fixture content: ${item.src}/SKILL.md\n`);
      writeFileSync(join(absSrc, "extra.md"), `fixture content: ${item.src}/extra.md\n`);
    }
  }
  writeFileSync(
    join(root, "AGENTS.md"),
    [
      "# Agent operating contract",
      "",
      "Generic rule that every consumer repository needs.",
      "",
      "<!-- ldl:source-only:start -->",
      "## Loop-Dee-Loup Burn Order",
      "",
      "Instance-specific state that must not leak into a consumer repository.",
      "<!-- ldl:source-only:end -->",
      "",
      "## Slice handoff",
      "",
      "Another generic rule.",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "CLAUDE.md"),
    ["# Claude Code instructions", "", "@AGENTS.md", "", "Repository-local Claude skills live under `.claude/skills/`.", ""].join("\n"),
  );
  return root;
}

function readManifest(dest) {
  return JSON.parse(readFileSync(join(dest, ".ldl", "manifest.json"), "utf8"));
}

function expectedOpCount() {
  // Two files per "dir" item (SKILL.md + extra.md) as fixed by makeFixtureRoot, one per
  // "file" item, plus one per BRIDGE_FILES entry (AGENTS.md, CLAUDE.md).
  const dirs = MANAGED_ITEMS.filter((i) => i.kind === "dir").length;
  const files = MANAGED_ITEMS.filter((i) => i.kind === "file").length;
  return dirs * 2 + files + BRIDGE_FILES.length;
}

test("buildOps resolves every MANAGED_ITEMS path against the real repository", () => {
  // Regression guard: catches a MANAGED_ITEMS entry going stale (renamed/deleted skill,
  // moved doc) the same way tools/check-control-plane-paths.mjs guards its own list.
  const ops = buildOps(REPO_ROOT);
  assert.ok(ops.length >= MANAGED_ITEMS.length, "expected at least one op per managed item");
  const dests = ops.map((o) => o.destRel);
  assert.ok(dests.includes(".claude/personas/audit-verdict-extractor.md"));
  assert.ok(dests.some((d) => d.startsWith(".claude/skills/sift/")));
  assert.ok(dests.includes("docs/operating-model.md"));
  assert.ok(dests.includes("tools/ldl-sync/verify-scope.mjs"));
  assert.ok(dests.includes("tools/ldl-sync/pr-permission.mjs"));
});

test("buildOps normalizes CRLF source content to LF, regardless of the LDL maintainer's own checkout line endings (issue #146)", (t) => {
  const root = makeFixtureRoot(t);
  // Simulate reading this source root from a checkout with core.autocrlf=true, which
  // converts every text file's working-tree bytes to CRLF even though the committed blob
  // (and every other consumer's checkout) is LF.
  const target = join(root, ".claude", "personas", "audit-verdict-extractor.md");
  writeFileSync(target, readFileSync(target, "utf8").replace(/\n/g, "\r\n"));

  const ops = buildOps(root);
  const op = ops.find((o) => o.destRel === ".claude/personas/audit-verdict-extractor.md");
  assert.ok(op, "expected an op for the CRLF-rewritten source file");
  assert.ok(!op.content.toString("utf8").includes("\r"), "buildOps must normalize CRLF source content to LF");
});

test("looksBinary/normalizeLineEndings: text content is normalized, content with a NUL byte is left exact-byte untouched", () => {
  const crlfText = Buffer.from("line one\r\nline two\r\n", "utf8");
  assert.equal(looksBinary(crlfText), false);
  assert.equal(normalizeLineEndings(crlfText).toString("utf8"), "line one\nline two\n");

  const binary = Buffer.from([0x00, 0x01, 0x0d, 0x0a, 0x02]);
  assert.equal(looksBinary(binary), true);
  assert.deepEqual(normalizeLineEndings(binary), binary, "binary content must be preserved exact-byte, not line-ending normalized");
});

test("contentMatchesHash: matches raw bytes, matches a CRLF/LF-normalized equivalent, and rejects a genuine content difference", () => {
  const lf = Buffer.from("alpha\nbeta\n", "utf8");
  const crlf = Buffer.from("alpha\r\nbeta\r\n", "utf8");
  const edited = Buffer.from("alpha\r\nBETA-EDITED\r\n", "utf8");
  const targetHash = sha256(lf);

  assert.equal(contentMatchesHash(lf, targetHash), true);
  assert.equal(contentMatchesHash(crlf, targetHash), true, "a CRLF-only representation difference must still match");
  assert.equal(contentMatchesHash(edited, targetHash), false, "a genuine content edit must not match even under CRLF");
});

test("deriveConsumerAgents strips a source-only block and keeps the rest intact", () => {
  const source = [
    "# Title",
    "",
    "Kept before.",
    "",
    "<!-- ldl:source-only:start -->",
    "Instance-specific, must not survive.",
    "<!-- ldl:source-only:end -->",
    "",
    "Kept after.",
    "",
  ].join("\n");
  const result = deriveConsumerAgents(source);
  assert.ok(!result.includes("Instance-specific"));
  assert.ok(!result.includes("ldl:source-only"));
  assert.ok(result.includes("Kept before."));
  assert.ok(result.includes("Kept after."));
});

test("deriveConsumerAgents strips multiple blocks", () => {
  const source = [
    "A",
    "<!-- ldl:source-only:start -->",
    "drop-1",
    "<!-- ldl:source-only:end -->",
    "B",
    "<!-- ldl:source-only:start -->",
    "drop-2",
    "<!-- ldl:source-only:end -->",
    "C",
  ].join("\n");
  const result = deriveConsumerAgents(source);
  assert.ok(!result.includes("drop-1"));
  assert.ok(!result.includes("drop-2"));
  assert.ok(result.includes("A"));
  assert.ok(result.includes("B"));
  assert.ok(result.includes("C"));
});

test("deriveConsumerAgents throws on an unterminated source-only block", () => {
  const source = "before\n<!-- ldl:source-only:start -->\nnever closed\n";
  assert.throws(() => deriveConsumerAgents(source), /unterminated/);
});

test("deriveConsumerAgents collapses the blank-line run a stripped block leaves behind identically for LF and CRLF source text (issue #146)", () => {
  // Regression fixture reproducing the YouTubery blank-line failure: a CRLF-terminated
  // source (the ordinary result of reading a working tree checked out with
  // core.autocrlf=true) breaks the "\n{3,}" blank-line collapse below, since consecutive
  // blank lines are "\r\n\r\n\r\n" — each "\n" separated by a "\r" rather than adjacent to
  // the next one — if the CRLF is not normalized away first.
  const lfSource = [
    "# Title",
    "",
    "Kept before.",
    "",
    "<!-- ldl:source-only:start -->",
    "Instance-specific, must not survive.",
    "<!-- ldl:source-only:end -->",
    "",
    "Kept after.",
    "",
  ].join("\n");
  const crlfSource = lfSource.replace(/\n/g, "\r\n");

  const lfResult = deriveConsumerAgents(lfSource);
  const crlfResult = deriveConsumerAgents(crlfSource);

  assert.equal(crlfResult, lfResult, "CRLF source must derive to the exact same canonical LF output as LF source");
  assert.ok(!/\n{3,}/.test(lfResult), "the blank-line run left by the stripped block must collapse to a single blank line");
  assert.ok(!crlfResult.includes("\r"), "derived output is always canonical LF, never carries the source's CRLF");
});

test("run: exits 1 when --dest is missing", async () => {
  const result = await run({});
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /--dest/);
});

test("run: exits 1 when --dest does not exist", async (t) => {
  const missing = join(tempDir(t), "does-not-exist");
  const result = await run({ dest: missing });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /does not exist/);
});

test("run: fresh install into an empty disposable dest installs every managed path and writes a provenance manifest", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);

  const result = await run(
    { dest, root },
    { resolveRevisionImpl: () => "fake-sha-1", now: () => "2026-08-23T00:00:00.000Z" },
  );

  assert.equal(result.exitCode, 0);
  const manifest = readManifest(dest);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.ldlSourceRevision, "fake-sha-1");
  assert.equal(manifest.installedAt, "2026-08-23T00:00:00.000Z");
  assert.equal(manifest.files.length, expectedOpCount());
  assert.deepEqual(manifest.skipped, []);

  // Spot-check actual file content on disk, not just the manifest's claim about it.
  assert.equal(
    readFileSync(join(dest, ".claude/personas/audit-verdict-extractor.md"), "utf8"),
    "fixture content: .claude/personas/audit-verdict-extractor.md\n",
  );
  assert.equal(
    readFileSync(join(dest, ".claude/skills/sift/SKILL.md"), "utf8"),
    "fixture content: .claude/skills/sift/SKILL.md\n",
  );

  const installedAgents = readFileSync(join(dest, "AGENTS.md"), "utf8");
  assert.ok(!installedAgents.includes("Burn Order"));
  assert.ok(!installedAgents.includes("ldl:source-only"));
  assert.ok(installedAgents.includes("Generic rule that every consumer repository needs."));
  assert.ok(manifest.files.some((f) => f.dest === "AGENTS.md"));

  const installedClaude = readFileSync(join(dest, "CLAUDE.md"), "utf8");
  assert.ok(installedClaude.includes("@AGENTS.md"));
  assert.ok(manifest.files.some((f) => f.dest === "CLAUDE.md"));
  assert.deepEqual(manifest.pendingManualIntegration, []);
});

test("run: leaves a pre-existing unmanaged CLAUDE.md untouched and writes the derived template to .ldl/CLAUDE.template.md", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  writeFileSync(join(dest, "CLAUDE.md"), "MY PROJECT'S OWN CLAUDE.md\n");

  const result = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });

  assert.equal(result.exitCode, 0);
  assert.equal(readFileSync(join(dest, "CLAUDE.md"), "utf8"), "MY PROJECT'S OWN CLAUDE.md\n");
  const template = readFileSync(join(dest, ".ldl", "CLAUDE.template.md"), "utf8");
  assert.ok(template.includes("@AGENTS.md"));

  const manifest = readManifest(dest);
  assert.ok(!manifest.files.some((f) => f.dest === "CLAUDE.md"));
  assert.ok(manifest.files.some((f) => f.dest === ".ldl/CLAUDE.template.md"));
  assert.deepEqual(manifest.pendingManualIntegration, [
    {
      dest: "CLAUDE.md",
      template: ".ldl/CLAUDE.template.md",
      reason: "a pre-existing CLAUDE.md was not overwritten — merge .ldl/CLAUDE.template.md into it by hand to activate the LDL operating contract",
    },
  ]);
});

test("run: removes a superseded .ldl/CLAUDE.template.md once the consumer's own CLAUDE.md is gone and LDL starts managing CLAUDE.md directly", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  writeFileSync(join(dest, "CLAUDE.md"), "MY PROJECT'S OWN CLAUDE.md\n");

  const first = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });
  assert.equal(first.exitCode, 0);
  assert.ok(existsSync(join(dest, ".ldl", "CLAUDE.template.md")));
  assert.equal(JSON.parse(first.message).manualIntegrationNeeded, 1);

  rmSync(join(dest, "CLAUDE.md"));

  const second = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });
  assert.equal(second.exitCode, 0);
  assert.equal(JSON.parse(second.message).manualIntegrationNeeded, 0);
  assert.ok(existsSync(join(dest, "CLAUDE.md")), "CLAUDE.md should now be LDL-managed");
  assert.ok(!existsSync(join(dest, ".ldl", "CLAUDE.template.md")), "the superseded template must be removed, not left orphaned");
  const manifest = readManifest(dest);
  assert.ok(manifest.files.some((f) => f.dest === "CLAUDE.md"));
  assert.ok(!manifest.files.some((f) => f.dest === ".ldl/CLAUDE.template.md"));
  assert.deepEqual(manifest.pendingManualIntegration, []);
});

test("run: AGENTS.md and CLAUDE.md ownership resolve independently of each other", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  // Consumer already owns AGENTS.md but not CLAUDE.md.
  writeFileSync(join(dest, "AGENTS.md"), "MY PROJECT'S OWN AGENTS.md\n");

  const result = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });

  assert.equal(result.exitCode, 0);
  assert.equal(readFileSync(join(dest, "AGENTS.md"), "utf8"), "MY PROJECT'S OWN AGENTS.md\n");
  assert.ok(existsSync(join(dest, ".ldl", "AGENTS.template.md")));
  assert.ok(existsSync(join(dest, "CLAUDE.md")), "CLAUDE.md has no pre-existing consumer file, so it installs straight to root");
  assert.ok(!existsSync(join(dest, ".ldl", "CLAUDE.template.md")));

  const manifest = readManifest(dest);
  assert.ok(manifest.files.some((f) => f.dest === "CLAUDE.md"));
  assert.ok(!manifest.files.some((f) => f.dest === "AGENTS.md"));
  assert.equal(manifest.pendingManualIntegration.length, 1);
  assert.equal(manifest.pendingManualIntegration[0].dest, "AGENTS.md");
});

// Stage 1 review finding on PR #131: a bridge that resolved to install straight at its root
// destination but whose write was then skipped for an unrelated reason (an unsafe symlink here)
// must not be silently reported as active. Before this fix, pendingManualIntegration was
// derived purely from planBridgeOp's destination *choice*, not from what actually landed on
// disk, so this case reported manualIntegrationNeeded: 0 despite CLAUDE.md never installing.
test("run: a bridge whose root install is skipped for an unrelated reason is surfaced in pendingManualIntegration, not reported as active", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  const danglingTarget = join(dest, "does-not-exist.md");
  try {
    symlinkSync(danglingTarget, join(dest, "CLAUDE.md"), "file");
  } catch (err) {
    t.skip(`symlink creation not permitted in this environment: ${err.message}`);
    return;
  }

  const result = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.message).manualIntegrationNeeded, 1, "must not report 0 while CLAUDE.md never actually installed");
  const manifest = readManifest(dest);
  assert.ok(!manifest.files.some((f) => f.dest === "CLAUDE.md"));
  assert.ok(manifest.skipped.some((s) => s.dest === "CLAUDE.md" && /symlink/.test(s.reason)));
  assert.equal(manifest.pendingManualIntegration.length, 1);
  assert.equal(manifest.pendingManualIntegration[0].dest, "CLAUDE.md");
  assert.match(manifest.pendingManualIntegration[0].reason, /could not be installed/);
});

// Stage 1 review finding on PR #131: when a bridge's root is consumer-owned *and* something
// unmanaged already occupies the template destination too, the resulting pendingManualIntegration
// entry must not claim a template exists ready to merge — nothing was actually written there.
test("run: an unmanaged collision at a bridge's template destination gets a distinct pendingManualIntegration reason, not the ordinary merge instruction", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  writeFileSync(join(dest, "CLAUDE.md"), "MY PROJECT'S OWN CLAUDE.md\n");
  mkdirSync(join(dest, ".ldl"), { recursive: true });
  writeFileSync(join(dest, ".ldl", "CLAUDE.template.md"), "unrelated pre-existing file, not from LDL\n");

  const result = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });

  assert.equal(result.exitCode, 0);
  assert.equal(readFileSync(join(dest, "CLAUDE.md"), "utf8"), "MY PROJECT'S OWN CLAUDE.md\n");
  assert.equal(
    readFileSync(join(dest, ".ldl", "CLAUDE.template.md"), "utf8"),
    "unrelated pre-existing file, not from LDL\n",
    "the unrelated file at the template path must not be overwritten",
  );

  const manifest = readManifest(dest);
  assert.ok(!manifest.files.some((f) => f.dest === ".ldl/CLAUDE.template.md"));
  assert.ok(manifest.skipped.some((s) => s.dest === ".ldl/CLAUDE.template.md"));
  assert.equal(manifest.pendingManualIntegration.length, 1);
  assert.match(manifest.pendingManualIntegration[0].reason, /could not be written to \.ldl\/CLAUDE\.template\.md either/);
});

// Stage 1 review finding on PR #131: the documented manual-merge path (copy the parked
// template's content into the consumer-owned file) must actually clear pendingManualIntegration,
// not re-park the same template forever because the file was never marked LDL-managed.
test("run: a consumer who manually merges the parked template into their own file graduates the bridge to LDL-managed", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  writeFileSync(join(dest, "CLAUDE.md"), "MY PROJECT'S OWN CLAUDE.md, unmerged\n");

  const first = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });
  assert.equal(first.exitCode, 0);
  assert.equal(JSON.parse(first.message).manualIntegrationNeeded, 1);
  const templateContent = readFileSync(join(dest, ".ldl", "CLAUDE.template.md"));

  // The consumer performs the documented manual merge.
  writeFileSync(join(dest, "CLAUDE.md"), templateContent);

  const second = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });

  assert.equal(second.exitCode, 0);
  assert.equal(JSON.parse(second.message).manualIntegrationNeeded, 0);
  const manifest = readManifest(dest);
  assert.ok(manifest.files.some((f) => f.dest === "CLAUDE.md"), "the merged file must now be recorded as LDL-managed");
  assert.deepEqual(manifest.pendingManualIntegration, []);
  assert.ok(!existsSync(join(dest, ".ldl", "CLAUDE.template.md")), "the now-superseded template must be cleaned up");
});

test("planBridgeOp: resolves by content match when the consumer's pre-existing root file already equals the target content", (t) => {
  const dest = tempDir(t);
  const content = Buffer.from("identical content\n");
  writeFileSync(join(dest, "CLAUDE.md"), content);

  const result = planBridgeOp({
    destRel: "CLAUDE.md",
    templateDestRel: ".ldl/CLAUDE.template.md",
    content,
    destRoot: dest,
    existingManifest: null,
  });

  assert.equal(result.destRel, "CLAUDE.md");
  assert.equal(result.resolvedByContentMatch, true);
});

test("planBridgeOp: parks at the template when the consumer's pre-existing root file differs from the target content", (t) => {
  const dest = tempDir(t);
  writeFileSync(join(dest, "CLAUDE.md"), "different content\n");

  const result = planBridgeOp({
    destRel: "CLAUDE.md",
    templateDestRel: ".ldl/CLAUDE.template.md",
    content: Buffer.from("target content\n"),
    destRoot: dest,
    existingManifest: null,
  });

  assert.equal(result.destRel, ".ldl/CLAUDE.template.md");
  assert.equal(result.resolvedByContentMatch, false);
});

test("derivePendingManualIntegration: distinguishes 'consumer owns it, please merge' from 'could not install at all'", () => {
  const bridgePlans = [
    { bridge: { destRel: "AGENTS.md", templateDestRel: ".ldl/AGENTS.template.md" }, op: { destRel: ".ldl/AGENTS.template.md" } },
    { bridge: { destRel: "CLAUDE.md", templateDestRel: ".ldl/CLAUDE.template.md" }, op: { destRel: "CLAUDE.md" } },
  ];
  const toSkip = [{ dest: "CLAUDE.md", reason: "existing symlink at CLAUDE.md — refusing to write through it" }];

  const pending = derivePendingManualIntegration(bridgePlans, toSkip);

  assert.equal(pending.length, 2);
  const agents = pending.find((p) => p.dest === "AGENTS.md");
  assert.match(agents.reason, /merge \.ldl\/AGENTS\.template\.md into it by hand/);
  const claude = pending.find((p) => p.dest === "CLAUDE.md");
  assert.match(claude.reason, /could not be installed/);
  assert.match(claude.reason, /symlink/);
});

test("derivePendingManualIntegration: a template also blocked by an unmanaged collision gets a distinct reason from a normal parked template", () => {
  const bridgePlans = [
    { bridge: { destRel: "CLAUDE.md", templateDestRel: ".ldl/CLAUDE.template.md" }, op: { destRel: ".ldl/CLAUDE.template.md" } },
  ];
  const toSkip = [{ dest: ".ldl/CLAUDE.template.md", reason: "destination already exists and is not LDL-managed" }];

  const pending = derivePendingManualIntegration(bridgePlans, toSkip);

  assert.equal(pending.length, 1);
  assert.match(pending[0].reason, /could not be written to \.ldl\/CLAUDE\.template\.md either/);
});

test("derivePendingManualIntegration: a fully installed bridge (root or template) reports nothing pending", () => {
  const bridgePlans = [{ bridge: { destRel: "AGENTS.md", templateDestRel: ".ldl/AGENTS.template.md" }, op: { destRel: "AGENTS.md" } }];
  assert.deepEqual(derivePendingManualIntegration(bridgePlans, []), []);
});

test("run: is idempotent — re-running against an already-initialized dest reinstalls the same paths without duplication", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);

  const first = await run(
    { dest, root },
    { resolveRevisionImpl: () => "fake-sha-1", now: () => "2026-08-23T00:00:00.000Z" },
  );
  assert.equal(first.exitCode, 0);
  const firstManifest = readManifest(dest);

  const second = await run(
    { dest, root },
    { resolveRevisionImpl: () => "fake-sha-1", now: () => "2026-08-23T01:00:00.000Z" },
  );
  assert.equal(second.exitCode, 0);
  const secondManifest = readManifest(dest);

  assert.deepEqual(
    secondManifest.files.map((f) => f.dest).sort(),
    firstManifest.files.map((f) => f.dest).sort(),
    "re-running must not duplicate or drop any managed path",
  );
  assert.deepEqual(secondManifest.files, firstManifest.files, "identical source content must hash identically");
  assert.deepEqual(secondManifest.skipped, []);
  assert.notEqual(secondManifest.installedAt, firstManifest.installedAt);
});

test("run: does not clobber an unrelated pre-existing file in a non-empty dest", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  writeFileSync(join(dest, "README.md"), "hello project\n");
  mkdirSync(join(dest, "src"), { recursive: true });
  writeFileSync(join(dest, "src", "index.js"), "console.log('hi');\n");

  const result = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });

  assert.equal(result.exitCode, 0);
  assert.equal(readFileSync(join(dest, "README.md"), "utf8"), "hello project\n");
  assert.equal(readFileSync(join(dest, "src", "index.js"), "utf8"), "console.log('hi');\n");
  assert.ok(existsSync(join(dest, ".claude", "skills", "sift", "SKILL.md")), "managed content still installs alongside unrelated files");
});

test("run: leaves a pre-existing unmanaged AGENTS.md untouched and writes the derived template to .ldl/AGENTS.template.md", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  writeFileSync(join(dest, "AGENTS.md"), "MY PROJECT'S OWN AGENTS.md\n");

  const result = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });

  assert.equal(result.exitCode, 0);
  assert.equal(readFileSync(join(dest, "AGENTS.md"), "utf8"), "MY PROJECT'S OWN AGENTS.md\n");
  const template = readFileSync(join(dest, ".ldl", "AGENTS.template.md"), "utf8");
  assert.ok(!template.includes("Burn Order"));
  assert.ok(template.includes("Generic rule that every consumer repository needs."));

  const manifest = readManifest(dest);
  assert.ok(!manifest.files.some((f) => f.dest === "AGENTS.md"));
  assert.ok(manifest.files.some((f) => f.dest === ".ldl/AGENTS.template.md"));
});

test("run: a second run after AGENTS.md was freshly installed keeps reinstalling AGENTS.md itself, not the template path", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);

  await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1", now: () => "2026-08-23T00:00:00.000Z" });
  const second = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1", now: () => "2026-08-23T01:00:00.000Z" });

  assert.equal(second.exitCode, 0);
  const manifest = readManifest(dest);
  assert.ok(manifest.files.some((f) => f.dest === "AGENTS.md"));
  assert.ok(!manifest.files.some((f) => f.dest === ".ldl/AGENTS.template.md"));
  assert.ok(!existsSync(join(dest, ".ldl", "AGENTS.template.md")));
});

test("run: skips a destination colliding with a pre-existing unmanaged file inside a managed directory, and records why", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  mkdirSync(join(dest, ".claude", "skills", "context-clearing"), { recursive: true });
  writeFileSync(join(dest, ".claude", "skills", "context-clearing", "SKILL.md"), "pre-existing, not LDL's\n");

  const result = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });

  assert.equal(result.exitCode, 0);
  assert.equal(
    readFileSync(join(dest, ".claude", "skills", "context-clearing", "SKILL.md"), "utf8"),
    "pre-existing, not LDL's\n",
    "a pre-existing unmanaged file must never be overwritten",
  );
  // Its sibling in the same fixture directory has no naming collision and still installs.
  assert.equal(
    readFileSync(join(dest, ".claude", "skills", "context-clearing", "extra.md"), "utf8"),
    "fixture content: .claude/skills/context-clearing/extra.md\n",
  );

  const manifest = readManifest(dest);
  assert.deepEqual(manifest.skipped, [
    { dest: ".claude/skills/context-clearing/SKILL.md", reason: "destination already exists and is not LDL-managed" },
  ]);
  assert.ok(!manifest.files.some((f) => f.dest === ".claude/skills/context-clearing/SKILL.md"));
});

test("run: skips, without crashing, a destination whose parent already exists as a plain file", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  // tools/local-worker/** and tools/review-watch/** both need "tools" to be a directory.
  writeFileSync(join(dest, "tools"), "not a directory\n");

  const result = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });

  assert.equal(result.exitCode, 0);
  assert.equal(readFileSync(join(dest, "tools"), "utf8"), "not a directory\n", "the blocking file must be left untouched");
  const manifest = readManifest(dest);
  assert.ok(manifest.skipped.some((s) => s.dest.startsWith("tools/")));
  assert.ok(!manifest.files.some((f) => f.dest.startsWith("tools/")));
  // Unrelated managed paths still install fine.
  assert.ok(manifest.files.some((f) => f.dest === "docs/operating-model.md"));
});

test("run: refuses to write through a pre-existing symlink in the destination path", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  const escapeTarget = tempDir(t);
  mkdirSync(join(dest, ".claude", "skills"), { recursive: true });
  try {
    symlinkSync(escapeTarget, join(dest, ".claude", "skills", "sift"), "junction");
  } catch (err) {
    t.skip(`symlink creation not permitted in this environment: ${err.message}`);
    return;
  }

  const result = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });

  assert.equal(result.exitCode, 0);
  assert.equal(existsSync(join(escapeTarget, "SKILL.md")), false, "must never have written through the symlink");
  const manifest = readManifest(dest);
  assert.ok(manifest.skipped.some((s) => s.dest.startsWith(".claude/skills/sift/") && /symlink/.test(s.reason)));
});

test("run: refuses to write through a dangling symlink at a managed destination (Stage 2 audit finding on PR #75)", async (t) => {
  // existsSync() follows symlinks and reports false for a dangling one (Node's own
  // documented behavior), so a naive existsSync-based check would miss a dangling symlink
  // entirely and let fs.writeFileSync (which also follows symlinks) write through it,
  // materializing the write wherever the symlink points — possibly outside --dest. This
  // regression-tests the fix: findUnsafeDestReason() must use lstat-based detection so a
  // dangling leaf symlink is caught the same as a live one.
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  mkdirSync(join(dest, ".claude", "personas"), { recursive: true });
  const danglingTarget = join(dest, ".claude", "personas", "nonexistent-target.md");
  const danglingLink = join(dest, ".claude", "personas", "audit-verdict-extractor.md");
  try {
    symlinkSync(danglingTarget, danglingLink, "file");
  } catch (err) {
    t.skip(`symlink creation not permitted in this environment: ${err.message}`);
    return;
  }
  assert.equal(existsSync(danglingLink), false, "sanity check: existsSync must report false for a dangling symlink");

  const result = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });

  assert.equal(result.exitCode, 0);
  assert.equal(existsSync(danglingTarget), false, "must never have written through the dangling symlink");
  const manifest = readManifest(dest);
  assert.ok(
    manifest.skipped.some((s) => s.dest === ".claude/personas/audit-verdict-extractor.md" && /symlink/.test(s.reason)),
    "the dangling symlink destination must be recorded under skipped, not silently installed",
  );
  assert.ok(!manifest.files.some((f) => f.dest === ".claude/personas/audit-verdict-extractor.md"));
});

test("run: installs .github/ISSUE_TEMPLATE content required by the installed bounded-review-cycle docs", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);

  const result = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });

  assert.equal(result.exitCode, 0);
  assert.ok(existsSync(join(dest, ".github", "ISSUE_TEMPLATE", "SKILL.md")));
  const manifest = readManifest(dest);
  assert.ok(manifest.files.some((f) => f.dest.startsWith(".github/ISSUE_TEMPLATE/")));
});

test("run: removes a superseded .ldl/AGENTS.template.md once the consumer's own AGENTS.md is gone and LDL starts managing AGENTS.md directly", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  writeFileSync(join(dest, "AGENTS.md"), "MY PROJECT'S OWN AGENTS.md\n");

  const first = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });
  assert.equal(first.exitCode, 0);
  assert.ok(existsSync(join(dest, ".ldl", "AGENTS.template.md")));

  // The consumer removes their own AGENTS.md between runs.
  rmSync(join(dest, "AGENTS.md"));

  const second = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });
  assert.equal(second.exitCode, 0);
  assert.ok(existsSync(join(dest, "AGENTS.md")), "AGENTS.md should now be LDL-managed");
  assert.ok(!existsSync(join(dest, ".ldl", "AGENTS.template.md")), "the superseded template must be removed, not left orphaned");
  const manifest = readManifest(dest);
  assert.ok(manifest.files.some((f) => f.dest === "AGENTS.md"));
  assert.ok(!manifest.files.some((f) => f.dest === ".ldl/AGENTS.template.md"));
});

test("run: treats a .ldl/manifest.json with an unexpected shape as absent instead of crashing or trusting it", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  mkdirSync(join(dest, ".ldl"), { recursive: true });
  writeFileSync(join(dest, ".ldl", "manifest.json"), JSON.stringify({ someOtherTool: true }));

  const result = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });

  assert.equal(result.exitCode, 0);
  const manifest = readManifest(dest);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.skipped.length, 0, "an unrecognized manifest shape must not be read as a managed-file record");
  assert.ok(manifest.files.some((f) => f.dest === "docs/operating-model.md"));
});

test("run: treats a manifest with a malformed skipped[] entry as absent instead of trusting it", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  mkdirSync(join(dest, ".ldl"), { recursive: true });
  // Two skipped entries sharing a dest with a missing reason: harmless here since ldl-init
  // never sorts/compares `skipped`, but tools/ldl-update's skipListsEqual does, and would
  // crash on the undefined reason if this manifest were trusted instead of rejected.
  writeFileSync(
    join(dest, ".ldl", "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      installedAt: "x",
      files: [],
      skipped: [{ dest: "docs/foo.md" }, { dest: "docs/foo.md", reason: "bar" }],
    }),
  );

  const result = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });

  assert.equal(result.exitCode, 0);
  const manifest = readManifest(dest);
  assert.ok(manifest.files.some((f) => f.dest === "docs/operating-model.md"), "must proceed as a fresh install");
});

test("run: refuses to run, before writing anything, when --dest/.ldl is a pre-existing symlink", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  const escapeTarget = tempDir(t);
  try {
    symlinkSync(escapeTarget, join(dest, ".ldl"), "junction");
  } catch (err) {
    t.skip(`symlink creation not permitted in this environment: ${err.message}`);
    return;
  }

  const result = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /\.ldl/);
  assert.equal(existsSync(join(escapeTarget, "manifest.json")), false, "must never have written through the symlink");
  assert.ok(!existsSync(join(dest, "docs", "operating-model.md")), "must fail closed before installing anything, not partially");
});

test("run: refuses to run, before writing anything, when --dest/.ldl is a pre-existing regular file", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  writeFileSync(join(dest, ".ldl"), "not a directory\n");

  const result = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /\.ldl/);
  assert.equal(readFileSync(join(dest, ".ldl"), "utf8"), "not a directory\n");
  assert.ok(!existsSync(join(dest, "docs", "operating-model.md")), "must fail closed before installing anything, not partially");
});

const VALID_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85";

test("run: treats a manifest with a null files[] entry as absent instead of crashing on it later", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  mkdirSync(join(dest, ".ldl"), { recursive: true });
  writeFileSync(
    join(dest, ".ldl", "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      installedAt: "x",
      files: [null, { dest: "docs/operating-model.md", sha256: VALID_SHA256 }],
      skipped: [],
    }),
  );

  const result = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });

  assert.equal(result.exitCode, 0);
  const manifest = readManifest(dest);
  assert.ok(manifest.files.some((f) => f.dest === "docs/operating-model.md"));
});

test("run: an incomplete files[] entry (missing sha256) must not be trusted as an LDL ownership claim over a consumer's own AGENTS.md", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  writeFileSync(join(dest, "AGENTS.md"), "MY PROJECT'S OWN AGENTS.md — never installed by LDL\n");
  mkdirSync(join(dest, ".ldl"), { recursive: true });
  // A forged/incomplete record falsely claiming AGENTS.md is already LDL-managed, missing
  // the sha256 a genuine install always writes.
  writeFileSync(
    join(dest, ".ldl", "manifest.json"),
    JSON.stringify({ schemaVersion: 1, installedAt: "x", files: [{ dest: "AGENTS.md" }], skipped: [] }),
  );

  const result = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });

  assert.equal(result.exitCode, 0);
  assert.equal(
    readFileSync(join(dest, "AGENTS.md"), "utf8"),
    "MY PROJECT'S OWN AGENTS.md — never installed by LDL\n",
    "an incomplete manifest entry must not license overwriting the consumer's real AGENTS.md",
  );
  assert.ok(existsSync(join(dest, ".ldl", "AGENTS.template.md")));
});

test("run: refuses to run when --dest/.ldl is a dangling symlink (lstat, not existsSync, decides absence)", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  const nonexistentTarget = join(tempDir(t), "does-not-exist");
  try {
    symlinkSync(nonexistentTarget, join(dest, ".ldl"), "junction");
  } catch (err) {
    t.skip(`symlink creation not permitted in this environment: ${err.message}`);
    return;
  }

  const result = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /\.ldl/);
  assert.ok(!existsSync(join(dest, "docs", "operating-model.md")), "must fail closed before installing anything, not partially");
});

test("run: refuses to run when --dest/.ldl is a real directory but .ldl/manifest.json itself is a symlink", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  const escapeTarget = tempDir(t);
  mkdirSync(join(dest, ".ldl"), { recursive: true });
  try {
    symlinkSync(join(escapeTarget, "manifest.json"), join(dest, ".ldl", "manifest.json"));
  } catch (err) {
    t.skip(`symlink creation not permitted in this environment: ${err.message}`);
    return;
  }

  const result = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /manifest\.json/);
  assert.equal(existsSync(join(escapeTarget, "manifest.json")), false, "must never have written through the symlink");
});

test("defaultResolveRevision appends -dirty when the working tree has uncommitted changes, and not when it's clean", (t) => {
  const dir = tempDir(t);
  const gitEnv = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
  } catch (err) {
    t.skip(`git not available in this environment: ${err.message}`);
    return;
  }
  writeFileSync(join(dir, "file.txt"), "a\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env: { ...process.env, ...gitEnv } });

  const clean = defaultResolveRevision(dir);
  assert.doesNotMatch(clean, /-dirty$/);

  writeFileSync(join(dir, "file.txt"), "a\nb\n");
  const dirty = defaultResolveRevision(dir);
  assert.match(dirty, /-dirty$/);
  assert.equal(dirty.replace(/-dirty$/, ""), clean);
});

test("planInstall: treats a path recorded in an existing manifest as LDL-managed, not a conflict", () => {
  const ops = [{ destRel: "docs/operating-model.md", content: Buffer.from("x") }];
  const existingManifest = { files: [{ dest: "docs/operating-model.md", sha256: "irrelevant" }] };
  // existsSync will be false here (no real file on disk for this unit-level check), which
  // alone already routes it to toInstall; this test documents that a managed record does
  // not itself force a skip even when combined with an existence check elsewhere.
  const { toInstall, toSkip } = planInstall({ ops, destRoot: "/does/not/matter", existingManifest });
  assert.equal(toSkip.length, 0);
  assert.equal(toInstall.length, 1);
});

test("parseArgs: reads --dest and --root flags", () => {
  const args = parseArgs(["--dest", "/tmp/consumer", "--root", "/tmp/ldl"]);
  assert.equal(args.dest, "/tmp/consumer");
  assert.equal(args.root, "/tmp/ldl");
});

test("defaultResolveRevision returns 'unknown' for a directory with no git history", (t) => {
  const dir = tempDir(t);
  assert.equal(defaultResolveRevision(dir), "unknown");
});

test("run: a consumer-shaped install of the real repository's spend skill has no unconditional dependency on the undistributed tools/telemetry/sufficiency.mjs (issue #152)", async (t) => {
  // Regression guard: installs this repository's REAL .claude/skills/spend/SKILL.md content
  // (not a fixture) into a disposable consumer-shaped dest, the same way tools/ldl-init would
  // for a real consumer repository, then inspects the installed artifact directly — proving
  // the distributed workflow is internally complete rather than only checking the source tree.
  const dest = tempDir(t);

  const result = await run({ dest, root: REPO_ROOT }, { resolveRevisionImpl: () => "fake-sha-1" });
  assert.equal(result.exitCode, 0);

  // tools/telemetry/ is deliberately not distributed (see docs/consumer-contract.md) — confirm
  // that stays true, since the fallback below only matters while this holds.
  assert.ok(
    !existsSync(join(dest, "tools", "telemetry", "sufficiency.mjs")),
    "tools/telemetry/sufficiency.mjs must not be distributed to consumers",
  );

  const installedSkill = readFileSync(join(dest, ".claude", "skills", "spend", "SKILL.md"), "utf8");
  const normalizedSkill = installedSkill.replace(/\s+/g, " ");
  assert.match(
    normalizedSkill,
    /first\s+check whether `tools\/telemetry\/sufficiency\.mjs` exists/,
    "installed spend skill must gate the sufficiency script on a presence check, not invoke it unconditionally",
  );
  assert.match(
    normalizedSkill,
    /If `tools\/telemetry\/sufficiency\.mjs` does not exist/,
    "installed spend skill must define an explicit fallback for the missing-script case",
  );
  assert.match(
    normalizedSkill,
    /never promote a claim to CLEAN merely because the deterministic gate itself is unavailable/,
    "installed spend skill's fallback must preserve issue #139's evidence boundary (no promotion to CLEAN on missing evidence)",
  );

  const installedContract = readFileSync(join(dest, "docs", "consumer-contract.md"), "utf8");
  assert.ok(
    installedContract.includes("evidence-sufficiency verdict gate itself"),
    "installed consumer-contract.md must describe the verdict-gate fallback, not only the per-field fallback",
  );
});

// Issue #153: ownership-preserving manual integration acknowledgement.

test("findBridgeByDestRel: resolves a known bridge and returns null for an unknown name", () => {
  assert.equal(findBridgeByDestRel("CLAUDE.md").templateDestRel, ".ldl/CLAUDE.template.md");
  assert.equal(findBridgeByDestRel("AGENTS.md").templateDestRel, ".ldl/AGENTS.template.md");
  assert.equal(findBridgeByDestRel("README.md"), null);
});

test("isValidManifest: accepts a valid manualIntegrationAcknowledgements array and rejects a malformed entry", () => {
  const base = { schemaVersion: 1, files: [] };
  const goodEntry = {
    dest: "CLAUDE.md",
    template: ".ldl/CLAUDE.template.md",
    acknowledgedTargetSha256: sha256(Buffer.from("x")),
    acknowledgedAt: "2026-08-23T00:00:00.000Z",
  };
  assert.equal(isValidManifest({ ...base, manualIntegrationAcknowledgements: [goodEntry] }), true);
  assert.equal(isValidManifest({ ...base, manualIntegrationAcknowledgements: [{ dest: "CLAUDE.md" }] }), false, "missing fields must be rejected");
  assert.equal(
    isValidManifest({ ...base, manualIntegrationAcknowledgements: [{ ...goodEntry, acknowledgedTargetSha256: "not-a-hash" }] }),
    false,
    "a non-sha256 acknowledgedTargetSha256 must be rejected",
  );
  assert.equal(
    isValidManifest({ ...base, manualIntegrationAcknowledgements: [{ ...goodEntry, acknowledgedAt: "" }] }),
    false,
    "an empty acknowledgedAt must be rejected",
  );
});

test("derivePendingManualIntegration: a matching acknowledgement (by exact target content hash) suppresses a parked bridge from pending", () => {
  const content = Buffer.from("current CLAUDE.md target content\n");
  const bridgePlans = [
    { bridge: { destRel: "CLAUDE.md", templateDestRel: ".ldl/CLAUDE.template.md" }, op: { destRel: ".ldl/CLAUDE.template.md", content } },
  ];
  const acknowledgements = [
    { dest: "CLAUDE.md", template: ".ldl/CLAUDE.template.md", acknowledgedTargetSha256: sha256(content), acknowledgedAt: "2026-08-23T00:00:00.000Z" },
  ];

  assert.deepEqual(derivePendingManualIntegration(bridgePlans, [], acknowledgements), []);
});

test("derivePendingManualIntegration: an acknowledgement bound to a superseded target does not suppress the newly changed pending bridge", () => {
  const content = Buffer.from("NEW CLAUDE.md target content\n");
  const bridgePlans = [
    { bridge: { destRel: "CLAUDE.md", templateDestRel: ".ldl/CLAUDE.template.md" }, op: { destRel: ".ldl/CLAUDE.template.md", content } },
  ];
  const acknowledgements = [
    {
      dest: "CLAUDE.md",
      template: ".ldl/CLAUDE.template.md",
      acknowledgedTargetSha256: sha256(Buffer.from("OLD CLAUDE.md target content\n")),
      acknowledgedAt: "2026-08-23T00:00:00.000Z",
    },
  ];

  const pending = derivePendingManualIntegration(bridgePlans, [], acknowledgements);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].dest, "CLAUDE.md");
});

test("derivePendingManualIntegration: an acknowledgement for a different bridge does not suppress this one", () => {
  const content = Buffer.from("current AGENTS.md target content\n");
  const bridgePlans = [
    { bridge: { destRel: "AGENTS.md", templateDestRel: ".ldl/AGENTS.template.md" }, op: { destRel: ".ldl/AGENTS.template.md", content } },
  ];
  const acknowledgements = [
    { dest: "CLAUDE.md", template: ".ldl/CLAUDE.template.md", acknowledgedTargetSha256: sha256(content), acknowledgedAt: "2026-08-23T00:00:00.000Z" },
  ];

  const pending = derivePendingManualIntegration(bridgePlans, [], acknowledgements);
  assert.equal(pending.length, 1);
});

test("planAcknowledgeIntegration: refuses without an existing manifest", (t) => {
  const dest = tempDir(t);
  const result = planAcknowledgeIntegration({ bridgeDestRel: "CLAUDE.md", root: REPO_ROOT, destRoot: dest, existingManifest: null });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no \.ldl\/manifest\.json/);
});

test("planAcknowledgeIntegration: refuses an unknown bridge name", (t) => {
  const dest = tempDir(t);
  const result = planAcknowledgeIntegration({
    bridgeDestRel: "README.md",
    root: REPO_ROOT,
    destRoot: dest,
    existingManifest: { schemaVersion: 1, files: [] },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unknown bridge/);
});

test("planAcknowledgeIntegration: refuses when the named bridge has no pending manual integration right now", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  const install = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });
  assert.equal(install.exitCode, 0);
  const manifest = readManifest(dest);

  const result = planAcknowledgeIntegration({ bridgeDestRel: "CLAUDE.md", root, destRoot: dest, existingManifest: manifest });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no pending manual integration/);
});

test("planAcknowledgeIntegration: succeeds for a genuinely parked bridge and binds to the current target content hash", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  writeFileSync(join(dest, "CLAUDE.md"), "MY PROJECT'S OWN CLAUDE.md, unmerged\n");

  const install = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });
  assert.equal(install.exitCode, 0);
  const manifest = readManifest(dest);

  const result = planAcknowledgeIntegration({ bridgeDestRel: "CLAUDE.md", root, destRoot: dest, existingManifest: manifest });
  assert.equal(result.ok, true);
  assert.equal(result.dest, "CLAUDE.md");
  assert.equal(result.template, ".ldl/CLAUDE.template.md");
  const targetContent = normalizeLineEndings(readFileSync(join(root, "CLAUDE.md")));
  assert.equal(result.acknowledgedTargetSha256, sha256(targetContent));
});

test("planAcknowledgeIntegration: refuses when the parked template is missing", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  writeFileSync(join(dest, "CLAUDE.md"), "MY PROJECT'S OWN CLAUDE.md, unmerged\n");
  const install = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });
  assert.equal(install.exitCode, 0);
  const manifest = readManifest(dest);
  rmSync(join(dest, ".ldl", "CLAUDE.template.md"));

  const result = planAcknowledgeIntegration({ bridgeDestRel: "CLAUDE.md", root, destRoot: dest, existingManifest: manifest });
  assert.equal(result.ok, false);
  assert.match(result.reason, /does not exist/);
});

test("planAcknowledgeIntegration: refuses when the parked template is a symlink", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  writeFileSync(join(dest, "CLAUDE.md"), "MY PROJECT'S OWN CLAUDE.md, unmerged\n");
  const install = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });
  assert.equal(install.exitCode, 0);
  const manifest = readManifest(dest);
  const templatePath = join(dest, ".ldl", "CLAUDE.template.md");
  rmSync(templatePath);
  const elsewhere = join(dest, "elsewhere.md");
  writeFileSync(elsewhere, "not the real template\n");
  try {
    symlinkSync(elsewhere, templatePath);
  } catch (err) {
    t.skip(`symlink creation not permitted in this environment: ${err.message}`);
    return;
  }

  const result = planAcknowledgeIntegration({ bridgeDestRel: "CLAUDE.md", root, destRoot: dest, existingManifest: manifest });
  assert.equal(result.ok, false);
  assert.match(result.reason, /symlink/);
});

test("planAcknowledgeIntegration: refuses when the consumer-owned destination is a symlink", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  const elsewhere = join(dest, "elsewhere.md");
  writeFileSync(elsewhere, "MY PROJECT'S OWN CLAUDE.md via symlink, unmerged\n");
  try {
    symlinkSync(elsewhere, join(dest, "CLAUDE.md"));
  } catch (err) {
    t.skip(`symlink creation not permitted in this environment: ${err.message}`);
    return;
  }
  const install = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });
  assert.equal(install.exitCode, 0);
  const manifest = readManifest(dest);

  const result = planAcknowledgeIntegration({ bridgeDestRel: "CLAUDE.md", root, destRoot: dest, existingManifest: manifest });
  assert.equal(result.ok, false);
  assert.match(result.reason, /symlink/);
});

test("run: carries forward an existing manualIntegrationAcknowledgements array unchanged across a reinit when the acknowledged target hasn't changed", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  writeFileSync(join(dest, "CLAUDE.md"), "MY PROJECT'S OWN CLAUDE.md, unmerged\n");

  const first = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });
  assert.equal(first.exitCode, 0);
  const manifestPath = join(dest, ".ldl", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.deepEqual(manifest.manualIntegrationAcknowledgements, []);

  const ack = planAcknowledgeIntegration({ bridgeDestRel: "CLAUDE.md", root, destRoot: dest, existingManifest: manifest });
  assert.equal(ack.ok, true);
  manifest.manualIntegrationAcknowledgements = [
    { dest: ack.dest, template: ack.template, acknowledgedTargetSha256: ack.acknowledgedTargetSha256, acknowledgedAt: "2026-08-23T00:00:00.000Z" },
  ];
  manifest.pendingManualIntegration = [];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const second = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha-1" });
  assert.equal(second.exitCode, 0);
  const secondManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.deepEqual(secondManifest.manualIntegrationAcknowledgements, manifest.manualIntegrationAcknowledgements);
  assert.deepEqual(
    secondManifest.pendingManualIntegration,
    [],
    "an acknowledged bridge whose target hasn't changed must stay resolved across a reinit",
  );
  assert.ok(
    !secondManifest.files.some((f) => f.dest === "CLAUDE.md"),
    "an acknowledged bridge must never be added to the managed files[] set",
  );
});


test("deriveSyncPrerequisiteWarnings: warns when a destination path falls under tools/ldl-sync/ (issue #217)", () => {
  assert.deepEqual(deriveSyncPrerequisiteWarnings(["tools/ldl-sync/verify-scope.mjs", "AGENTS.md"]), [SYNC_PR_PERMISSION_WARNING]);
});

test("deriveSyncPrerequisiteWarnings: stays empty when no path falls under tools/ldl-sync/", () => {
  assert.deepEqual(deriveSyncPrerequisiteWarnings(["AGENTS.md", "docs/consumer-contract.md"]), []);
});

test("deriveSyncPrerequisiteWarnings: does not false-positive on an unrelated path merely prefixed similarly", () => {
  assert.deepEqual(deriveSyncPrerequisiteWarnings(["tools/ldl-sync-unrelated/file.md"]), []);
});

test("run: a fresh install of tools/ldl-sync surfaces the PR-creation-permission warning in the result (issue #217)", async (t) => {
  const root = makeFixtureRoot(t);
  const dest = tempDir(t);
  const result = await run({ dest, root }, { resolveRevisionImpl: () => "fake-sha" });
  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.message);
  assert.deepEqual(parsed.warnings, [SYNC_PR_PERMISSION_WARNING]);
});

