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
import { MANAGED_ITEMS, buildOps, deriveConsumerAgents, defaultResolveRevision, parseArgs, planInstall, run } from "./index.mjs";

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
  return root;
}

function readManifest(dest) {
  return JSON.parse(readFileSync(join(dest, ".ldl", "manifest.json"), "utf8"));
}

function expectedOpCount() {
  // Two files per "dir" item (SKILL.md + extra.md) as fixed by makeFixtureRoot, one per
  // "file" item, plus the derived AGENTS.md.
  const dirs = MANAGED_ITEMS.filter((i) => i.kind === "dir").length;
  const files = MANAGED_ITEMS.filter((i) => i.kind === "file").length;
  return dirs * 2 + files + 1;
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
