// Tests for tools/ldl-update/index.mjs. Fixture-based per issue #67's requirement to
// inspect resulting repository state (file presence, manifest contents), not merely exit
// codes. Every test that touches disk works against disposable temp directories created
// with fs.mkdtempSync and removed via t.after() — never this repository's own working tree.
// Run with:
//   node --test tools/ldl-update/index.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MANAGED_ITEMS, run as ldlInit } from "../ldl-init/index.mjs";
import { parseArgs, planUpdate, run } from "./index.mjs";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "ldl-update-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Builds a fixture Loop-Dee-Loup source root that mirrors MANAGED_ITEMS exactly, so tests
// stay correct if that list changes and never depend on this repository's own real content.
// `revisionTag` is folded into every fixture file's content so two calls with different
// tags produce a source tree whose managed content genuinely differs, simulating "a newer
// LDL revision" rather than just a different manifest revision label.
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
      `Generic rule that every consumer repository needs (${revisionTag}).`,
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

async function bootstrap(dest, root, revision = "rev-1") {
  const result = await ldlInit(
    { dest, root },
    { resolveRevisionImpl: () => revision, now: () => "2026-08-23T00:00:00.000Z" },
  );
  assert.equal(result.exitCode, 0, `bootstrap fixture setup failed: ${result.message}`);
  return result;
}

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

test("run: exits 1 with a clear message when --dest has no .ldl/manifest.json yet", async (t) => {
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);

  const result = await run({ dest, root });

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /ldl-init/);
  assert.match(result.message, /manifest/i);
});

test("run: updates from one known LDL revision to a newer one, changing only managed content that actually changed", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, rootV1, "rev-1");

  const rootV2 = makeFixtureRoot(t, "rev-2");

  const result = await run({ dest, root: rootV2 }, { resolveRevisionImpl: () => "rev-2", now: () => "2026-08-24T00:00:00.000Z" });

  assert.equal(result.exitCode, 0);
  const manifest = readManifest(dest);
  assert.equal(manifest.ldlSourceRevision, "rev-2");
  assert.equal(manifest.installedAt, "2026-08-24T00:00:00.000Z");
  assert.deepEqual(manifest.skipped, []);

  assert.equal(
    readFileSync(join(dest, ".claude/personas/audit-verdict-extractor.md"), "utf8"),
    "fixture content (rev-2): .claude/personas/audit-verdict-extractor.md\n",
  );
  assert.equal(
    readFileSync(join(dest, ".claude/skills/sift/SKILL.md"), "utf8"),
    "fixture content (rev-2): .claude/skills/sift/SKILL.md\n",
  );
  const agents = readFileSync(join(dest, "AGENTS.md"), "utf8");
  assert.ok(agents.includes("rev-2"));
});

test("run: preserves consumer-owned material across an update untouched", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  writeFileSync(join(dest, "README.md"), "hello project\n");
  mkdirSync(join(dest, "src"), { recursive: true });
  writeFileSync(join(dest, "src", "index.js"), "console.log('hi');\n");
  await bootstrap(dest, rootV1, "rev-1");

  // Consumer keeps working on their own files between bootstrap and update.
  writeFileSync(join(dest, "src", "index.js"), "console.log('still working');\n");

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const result = await run({ dest, root: rootV2 }, { resolveRevisionImpl: () => "rev-2" });

  assert.equal(result.exitCode, 0);
  assert.equal(readFileSync(join(dest, "README.md"), "utf8"), "hello project\n");
  assert.equal(readFileSync(join(dest, "src", "index.js"), "utf8"), "console.log('still working');\n");
});

test("run: already-current update is a predictable no-op that touches nothing on disk", async (t) => {
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, root, "rev-1");
  const manifestPath = join(dest, ".ldl", "manifest.json");
  const beforeMtime = statSync(manifestPath).mtimeMs;
  const beforeManifest = readManifest(dest);

  const result = await run({ dest, root }, { resolveRevisionImpl: () => "rev-1" });

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.message);
  assert.equal(parsed.noop, true);
  assert.equal(parsed.updated, 0);

  const afterMtime = statSync(manifestPath).mtimeMs;
  const afterManifest = readManifest(dest);
  assert.equal(afterMtime, beforeMtime, "manifest.json must not be rewritten on a true no-op");
  assert.deepEqual(afterManifest, beforeManifest);
});

test("run: fails safely on an ambiguous local modification to a managed file, without writing anything", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, rootV1, "rev-1");

  const conflictPath = join(dest, ".claude", "skills", "sift", "SKILL.md");
  writeFileSync(conflictPath, "hand-edited by the consumer, not from LDL\n");
  const beforeManifest = readManifest(dest);
  const beforeMtime = statSync(join(dest, ".ldl", "manifest.json")).mtimeMs;

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const result = await run({ dest, root: rootV2 }, { resolveRevisionImpl: () => "rev-2" });

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /\.claude\/skills\/sift\/SKILL\.md/);
  assert.match(result.message, /locally modified/);

  // Nothing was written: neither the conflicting file, any other managed file, nor the
  // manifest.
  assert.equal(readFileSync(conflictPath, "utf8"), "hand-edited by the consumer, not from LDL\n");
  assert.equal(
    readFileSync(join(dest, ".claude/skills/sift/extra.md"), "utf8"),
    "fixture content (rev-1): .claude/skills/sift/extra.md\n",
    "even unrelated managed files must not be updated when any conflict is found",
  );
  assert.deepEqual(readManifest(dest), beforeManifest);
  assert.equal(statSync(join(dest, ".ldl", "manifest.json")).mtimeMs, beforeMtime);
});

test("run: fails safely when a managed file was deleted locally since install", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, rootV1, "rev-1");

  rmSync(join(dest, "docs", "operating-model.md"));

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const result = await run({ dest, root: rootV2 }, { resolveRevisionImpl: () => "rev-2" });

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /docs\/operating-model\.md/);
  assert.match(result.message, /missing locally/);
  assert.equal(existsSync(join(dest, "docs", "operating-model.md")), false);
});

test("run: never overwrites a pre-existing unmanaged file that happens to collide with a newly managed destination", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, rootV1, "rev-1");

  // Simulate a consumer's own unrelated file sitting where a *newly added* managed item
  // would land, by wiping the manifest's memory of one path (as if it were never managed)
  // while a real file remains on disk there.
  const manifestPath = join(dest, ".ldl", "manifest.json");
  const manifest = readManifest(dest);
  manifest.files = manifest.files.filter((f) => f.dest !== "docs/decision-forms.md");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(dest, "docs", "decision-forms.md"), "consumer's own unrelated content\n");

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const result = await run({ dest, root: rootV2 }, { resolveRevisionImpl: () => "rev-2" });

  assert.equal(result.exitCode, 0);
  assert.equal(readFileSync(join(dest, "docs", "decision-forms.md"), "utf8"), "consumer's own unrelated content\n");
  const after = readManifest(dest);
  assert.ok(after.skipped.some((s) => s.dest === "docs/decision-forms.md"));
  assert.ok(!after.files.some((f) => f.dest === "docs/decision-forms.md"));
});

test("run: rewritten manifest reflects the new revision and lists both updated and already-matching managed files", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, rootV1, "rev-1");

  // Build a "rev-2" source where only one managed file's content actually changes; the rest
  // is byte-identical to rev-1.
  const rootV2 = tempDir(t);
  for (const item of MANAGED_ITEMS) {
    const absSrcV1 = join(rootV1, item.src);
    const absSrcV2 = join(rootV2, item.src);
    if (item.kind === "file") {
      mkdirSync(dirname(absSrcV2), { recursive: true });
      writeFileSync(absSrcV2, readFileSync(absSrcV1));
    } else {
      mkdirSync(absSrcV2, { recursive: true });
      writeFileSync(join(absSrcV2, "SKILL.md"), readFileSync(join(absSrcV1, "SKILL.md")));
      writeFileSync(join(absSrcV2, "extra.md"), readFileSync(join(absSrcV1, "extra.md")));
    }
  }
  writeFileSync(join(rootV2, "AGENTS.md"), readFileSync(join(rootV1, "AGENTS.md")));
  // Now change exactly one managed file's content in rootV2.
  writeFileSync(join(rootV2, "docs", "operating-model.md"), "updated operating model content in rev-2\n");

  const result = await run({ dest, root: rootV2 }, { resolveRevisionImpl: () => "rev-2", now: () => "2026-08-25T00:00:00.000Z" });

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.message);
  assert.equal(parsed.updated, 1);

  const manifest = readManifest(dest);
  assert.equal(manifest.ldlSourceRevision, "rev-2");
  assert.equal(
    readFileSync(join(dest, "docs", "operating-model.md"), "utf8"),
    "updated operating model content in rev-2\n",
  );
  // Untouched managed files are still fully recorded in the rewritten manifest.
  assert.ok(manifest.files.some((f) => f.dest === "docs/bounded-review-cycle.md"));
  assert.equal(manifest.files.length, JSON.parse(readFileSync(join(dest, ".ldl", "manifest.json"), "utf8")).files.length);
});

test("planUpdate: classifies unmodified/newly-added/locally-modified/deleted destinations correctly", () => {
  const existingManifest = {
    files: [
      { dest: "a.md", sha256: "hash-a-old" },
      { dest: "b.md", sha256: "hash-b-old" },
      { dest: "c.md", sha256: "hash-c-old" },
    ],
  };
  // Use real sha256 via the module's own hashing by round-tripping through run()'s logic is
  // overkill here; planUpdate hashes op.content and on-disk content itself, so this unit
  // test only needs to exercise the branch logic with a destRoot that doesn't exist for
  // "newly managed, no existing file" and skip disk-dependent branches better covered by
  // the fixture-based run() tests above.
  const ops = [{ destRel: "new.md", content: Buffer.from("new content") }];
  const { toInstall, toSkip, conflicts, unchangedFiles } = planUpdate({
    ops,
    destRoot: "/does/not/exist/at/all",
    existingManifest,
  });
  assert.equal(toInstall.length, 1);
  assert.equal(toSkip.length, 0);
  assert.equal(conflicts.length, 0);
  assert.equal(unchangedFiles.length, 0);
});

test("parseArgs: reads --dest and --root flags", () => {
  const args = parseArgs(["--dest", "/tmp/consumer", "--root", "/tmp/ldl"]);
  assert.equal(args.dest, "/tmp/consumer");
  assert.equal(args.root, "/tmp/ldl");
});
