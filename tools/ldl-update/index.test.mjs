// Tests for tools/ldl-update/index.mjs. Fixture-based per issue #67's requirement to
// inspect resulting repository state (file presence, manifest contents), not merely exit
// codes. Every test that touches disk works against disposable temp directories created
// with fs.mkdtempSync and removed via t.after() — never this repository's own working tree.
// Run with:
//   node --test tools/ldl-update/index.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MANAGED_ITEMS, SYNC_PR_PERMISSION_WARNING, planAcknowledgeIntegration, run as ldlInit } from "../ldl-init/index.mjs";
import { parseArgs, planUpdate, run } from "./index.mjs";

const SELF_PATH = fileURLToPath(import.meta.url).replace(/\.test\.mjs$/, ".mjs");

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
  writeFileSync(
    join(root, "CLAUDE.md"),
    ["# Claude Code instructions", "", "@AGENTS.md", "", `Repository-local Claude skills (${revisionTag}).`, ""].join("\n"),
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

test("run: rejects a manifest with a malformed skipped[] entry instead of crashing in skipListsEqual", async (t) => {
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, root, "rev-1");

  // Two skipped entries recorded under the same dest with a missing reason. isValidManifest
  // must reject this shape, because skipListsEqual sorts skipped entries by comparing
  // `.reason` with localeCompare once two entries share a dest — an undefined reason would
  // otherwise throw an uncaught TypeError mid-run instead of failing with a clear message.
  const manifest = readManifest(dest);
  manifest.skipped = [{ dest: "docs/foo.md" }, { dest: "docs/foo.md", reason: "bar" }];
  writeFileSync(join(dest, ".ldl", "manifest.json"), JSON.stringify(manifest));

  const result = await run({ dest, root }, { resolveRevisionImpl: () => "rev-1" });

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /expected shape/i);
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

test("run: a checkout-only CRLF representation of an otherwise-unchanged managed file is not a conflict, and the run stays a true no-op (issue #146)", async (t) => {
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, root, "rev-1");

  // Simulate a consumer's own Windows checkout (core.autocrlf=true) converting an
  // LF-installed managed file to CRLF, without any substantive edit.
  const managedPath = join(dest, "docs", "operating-model.md");
  const lfContent = readFileSync(managedPath, "utf8");
  writeFileSync(managedPath, lfContent.replace(/\n/g, "\r\n"));
  const beforeManifest = readManifest(dest);
  const beforeMtime = statSync(join(dest, ".ldl", "manifest.json")).mtimeMs;

  const result = await run({ dest, root }, { resolveRevisionImpl: () => "rev-1" });

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.message);
  assert.equal(parsed.noop, true, "a CRLF-only checkout difference must not itself trigger a write");

  // Untouched: the run recognized the file as unchanged and left the consumer's CRLF
  // representation exactly as it found it, and never rewrote the manifest to say so.
  assert.equal(readFileSync(managedPath, "utf8"), lfContent.replace(/\n/g, "\r\n"));
  assert.deepEqual(readManifest(dest), beforeManifest);
  assert.equal(statSync(join(dest, ".ldl", "manifest.json")).mtimeMs, beforeMtime);
});

test("run: a checkout-only CRLF representation does not block a genuine upstream update, and installs canonical LF content", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, rootV1, "rev-1");

  const managedPath = join(dest, "docs", "operating-model.md");
  writeFileSync(managedPath, readFileSync(managedPath, "utf8").replace(/\n/g, "\r\n"));

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const result = await run({ dest, root: rootV2 }, { resolveRevisionImpl: () => "rev-2" });

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.message);
  assert.ok(parsed.updated > 0);
  const updated = readFileSync(managedPath, "utf8");
  assert.ok(updated.includes("rev-2"));
  assert.ok(!updated.includes("\r\n"), "installed content is always canonical LF, regardless of the prior checkout representation");
});

test("run: a real content edit surviving under CRLF is still a conflict, not silently treated as a checkout artifact", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, rootV1, "rev-1");

  const managedPath = join(dest, "docs", "operating-model.md");
  writeFileSync(managedPath, "hand-edited by the consumer, then checked out with CRLF\r\nsecond line\r\n");

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const result = await run({ dest, root: rootV2 }, { resolveRevisionImpl: () => "rev-2" });

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /docs\/operating-model\.md/);
  assert.match(result.message, /locally modified/);
  assert.equal(readFileSync(managedPath, "utf8"), "hand-edited by the consumer, then checked out with CRLF\r\nsecond line\r\n");
});

test("run: a legacy manifest hash recorded from pre-normalization CRLF content does not become a false conflict against a genuine upstream update (Codex P2 finding on PR #147)", async (t) => {
  // Simulates a manifest written by a pre-#146 install whose own buildOps() read+wrote
  // unnormalized CRLF source bytes (this repository's own working tree, checked out with
  // core.autocrlf=true, was exactly this case). The file on disk today is the correct LF
  // content that was genuinely installed, but the *recorded* hash reflects the CRLF-bytes
  // variant that pre-fix run actually hashed — a real cross-platform/history case, distinct
  // from a live checkout-only CRLF difference (covered by the tests above), since here the
  // representation mismatch is baked into stale provenance rather than live on-disk bytes.
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, rootV1, "rev-1");

  const managedPath = join(dest, "docs", "operating-model.md");
  const lfContent = readFileSync(managedPath, "utf8");
  const legacyCrlfHash = createHash("sha256")
    .update(Buffer.from(lfContent.replace(/\n/g, "\r\n"), "utf8"))
    .digest("hex");
  const manifestPath = join(dest, ".ldl", "manifest.json");
  const manifest = readManifest(dest);
  manifest.files.find((f) => f.dest === "docs/operating-model.md").sha256 = legacyCrlfHash;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const result = await run({ dest, root: rootV2 }, { resolveRevisionImpl: () => "rev-2" });

  assert.equal(result.exitCode, 0, `expected a clean update, got: ${result.message}`);
  assert.ok(readFileSync(managedPath, "utf8").includes("rev-2"));
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
  writeFileSync(join(rootV2, "CLAUDE.md"), readFileSync(join(rootV1, "CLAUDE.md")));
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

test("CLI: invoking tools/ldl-update/index.mjs against an uninitialized --dest fails instead of silently running tools/ldl-init as an import side effect", async (t) => {
  // Regression test for a Stage 1 P0 finding: tools/ldl-init/index.mjs used to run its own
  // main() (and process.exit()) whenever *any* script's argv[1] ended in "index.mjs",
  // including tools/ldl-update's own CLI invocation, silently bootstrapping --dest instead
  // of updating it and exiting before tools/ldl-update's own logic ever ran.
  const dest = tempDir(t);

  let stdout = "";
  let exitCode = 0;
  try {
    stdout = execFileSync("node", [SELF_PATH, "--dest", dest], { encoding: "utf8" });
  } catch (err) {
    exitCode = err.status;
    stdout = err.stdout || "";
  }

  assert.equal(exitCode, 1, "must fail, not silently bootstrap");
  assert.equal(existsSync(join(dest, ".ldl", "manifest.json")), false, "must not have installed anything");
  assert.equal(existsSync(join(dest, "AGENTS.md")), false, "must not have installed anything");
});

test("run: refuses the whole update, as a conflict, when a previously managed file was replaced by a symlink", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, rootV1, "rev-1");

  const conflictPath = join(dest, ".claude", "skills", "sift", "SKILL.md");
  const escapeTarget = tempDir(t);
  rmSync(conflictPath);
  try {
    symlinkSync(escapeTarget, conflictPath, "junction");
  } catch (err) {
    t.skip(`symlink creation not permitted in this environment: ${err.message}`);
    return;
  }
  const beforeManifest = readManifest(dest);

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const result = await run({ dest, root: rootV2 }, { resolveRevisionImpl: () => "rev-2" });

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /\.claude\/skills\/sift\/SKILL\.md/);
  assert.match(result.message, /previously LDL-managed/);
  // Nothing written anywhere, including unrelated managed files and the manifest.
  assert.deepEqual(readManifest(dest), beforeManifest);
  assert.equal(
    readFileSync(join(dest, ".claude/skills/sift/extra.md"), "utf8"),
    "fixture content (rev-1): .claude/skills/sift/extra.md\n",
  );
});

test("run: refuses to discard a locally edited .ldl/AGENTS.template.md when it would otherwise be superseded", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  writeFileSync(join(dest, "AGENTS.md"), "MY PROJECT'S OWN AGENTS.md\n");
  await bootstrap(dest, rootV1, "rev-1");
  assert.ok(existsSync(join(dest, ".ldl", "AGENTS.template.md")));

  // Consumer edits the parked template while reviewing it, then later removes their own
  // AGENTS.md so LDL should start managing AGENTS.md directly.
  writeFileSync(join(dest, ".ldl", "AGENTS.template.md"), "hand-edited template, not from LDL\n");
  rmSync(join(dest, "AGENTS.md"));
  const beforeManifest = readManifest(dest);

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const result = await run({ dest, root: rootV2 }, { resolveRevisionImpl: () => "rev-2" });

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /AGENTS\.template\.md/);
  assert.match(result.message, /locally modified/);
  assert.equal(readFileSync(join(dest, ".ldl", "AGENTS.template.md"), "utf8"), "hand-edited template, not from LDL\n");
  assert.equal(existsSync(join(dest, "AGENTS.md")), false, "must not have installed AGENTS.md either, since the whole run refused");
  assert.deepEqual(readManifest(dest), beforeManifest);
});

test("run: an untouched superseded template is removed and dropped from the manifest, not carried over as a stale record", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  writeFileSync(join(dest, "AGENTS.md"), "MY PROJECT'S OWN AGENTS.md\n");
  await bootstrap(dest, rootV1, "rev-1");
  rmSync(join(dest, "AGENTS.md"));

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const result = await run({ dest, root: rootV2 }, { resolveRevisionImpl: () => "rev-2" });

  assert.equal(result.exitCode, 0);
  assert.equal(existsSync(join(dest, ".ldl", "AGENTS.template.md")), false);
  const manifest = readManifest(dest);
  assert.ok(manifest.files.some((f) => f.dest === "AGENTS.md"));
  assert.ok(!manifest.files.some((f) => f.dest === ".ldl/AGENTS.template.md"), "must not carry over a record for a file that was just deleted");
});

test("run: refuses to discard a locally edited .ldl/CLAUDE.template.md when it would otherwise be superseded", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  writeFileSync(join(dest, "CLAUDE.md"), "MY PROJECT'S OWN CLAUDE.md\n");
  await bootstrap(dest, rootV1, "rev-1");
  assert.ok(existsSync(join(dest, ".ldl", "CLAUDE.template.md")));

  writeFileSync(join(dest, ".ldl", "CLAUDE.template.md"), "hand-edited template, not from LDL\n");
  rmSync(join(dest, "CLAUDE.md"));
  const beforeManifest = readManifest(dest);

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const result = await run({ dest, root: rootV2 }, { resolveRevisionImpl: () => "rev-2" });

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /CLAUDE\.template\.md/);
  assert.match(result.message, /locally modified/);
  assert.equal(readFileSync(join(dest, ".ldl", "CLAUDE.template.md"), "utf8"), "hand-edited template, not from LDL\n");
  assert.equal(existsSync(join(dest, "CLAUDE.md")), false, "must not have installed CLAUDE.md either, since the whole run refused");
  assert.deepEqual(readManifest(dest), beforeManifest);
});

test("run: an untouched superseded CLAUDE.template.md is removed and dropped from the manifest, and pendingManualIntegration clears", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  writeFileSync(join(dest, "CLAUDE.md"), "MY PROJECT'S OWN CLAUDE.md\n");
  await bootstrap(dest, rootV1, "rev-1");
  assert.equal(readManifest(dest).pendingManualIntegration.length, 1);
  rmSync(join(dest, "CLAUDE.md"));

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const result = await run({ dest, root: rootV2 }, { resolveRevisionImpl: () => "rev-2" });

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.message).manualIntegrationNeeded, 0);
  assert.equal(existsSync(join(dest, ".ldl", "CLAUDE.template.md")), false);
  const manifest = readManifest(dest);
  assert.ok(manifest.files.some((f) => f.dest === "CLAUDE.md"));
  assert.ok(!manifest.files.some((f) => f.dest === ".ldl/CLAUDE.template.md"));
  assert.deepEqual(manifest.pendingManualIntegration, []);
});

test("run: a pre-existing consumer CLAUDE.md that stays unresolved across an otherwise no-op update keeps the run a true no-op", async (t) => {
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  writeFileSync(join(dest, "CLAUDE.md"), "MY PROJECT'S OWN CLAUDE.md\n");
  await bootstrap(dest, root, "rev-1");
  const beforeManifest = readManifest(dest);
  const beforeMtime = statSync(join(dest, ".ldl", "manifest.json")).mtimeMs;

  const result = await run({ dest, root }, { resolveRevisionImpl: () => "rev-1" });

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.message);
  assert.equal(parsed.noop, true, "an unchanged pendingManualIntegration set must not defeat the no-op determination");
  assert.equal(statSync(join(dest, ".ldl", "manifest.json")).mtimeMs, beforeMtime);
  assert.deepEqual(readManifest(dest), beforeManifest);
});

test("run: a consumer who manually merges the parked template graduates the bridge to LDL-managed, clearing pendingManualIntegration", async (t) => {
  // Stage 1 review finding on PR #131: before this fix, planBridgeOp always re-parked a
  // consumer-owned bridge at its template on every run (since existingManifest never recorded
  // it as managed), so the documented manual-merge path could never actually resolve
  // pendingManualIntegration.
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  writeFileSync(join(dest, "CLAUDE.md"), "MY PROJECT'S OWN CLAUDE.md, unmerged\n");
  await bootstrap(dest, rootV1, "rev-1");
  assert.equal(readManifest(dest).pendingManualIntegration.length, 1);
  const templateContent = readFileSync(join(dest, ".ldl", "CLAUDE.template.md"));

  writeFileSync(join(dest, "CLAUDE.md"), templateContent);

  const result = await run({ dest, root: rootV1 }, { resolveRevisionImpl: () => "rev-1" });

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.message).manualIntegrationNeeded, 0);
  const manifest = readManifest(dest);
  assert.ok(manifest.files.some((f) => f.dest === "CLAUDE.md"));
  assert.deepEqual(manifest.pendingManualIntegration, []);
  assert.ok(!existsSync(join(dest, ".ldl", "CLAUDE.template.md")));

  // Now that CLAUDE.md is genuinely LDL-managed, a later hand-edit is a real conflict again —
  // proving graduation activated the normal conflict-safety machinery for this file, rather
  // than merely papering over the ownership question for one run.
  writeFileSync(join(dest, "CLAUDE.md"), "hand-edited after graduation\n");
  const rootV2 = makeFixtureRoot(t, "rev-2");
  const second = await run({ dest, root: rootV2 }, { resolveRevisionImpl: () => "rev-2" });
  assert.equal(second.exitCode, 1);
  assert.match(second.message, /CLAUDE\.md/);
  assert.match(second.message, /locally modified/);
});

test("run: a consumer who manually merges the parked template under a CRLF checkout still graduates the bridge (issue #146)", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  writeFileSync(join(dest, "CLAUDE.md"), "MY PROJECT'S OWN CLAUDE.md, unmerged\n");
  await bootstrap(dest, rootV1, "rev-1");
  const templateContent = readFileSync(join(dest, ".ldl", "CLAUDE.template.md"), "utf8");

  // The consumer merges the template, but their own checkout (core.autocrlf=true) renders
  // the merged file with CRLF line endings rather than the template's LF.
  writeFileSync(join(dest, "CLAUDE.md"), templateContent.replace(/\n/g, "\r\n"));

  const result = await run({ dest, root: rootV1 }, { resolveRevisionImpl: () => "rev-1" });

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.message).manualIntegrationNeeded, 0);
  const manifest = readManifest(dest);
  assert.ok(manifest.files.some((f) => f.dest === "CLAUDE.md"));
  assert.deepEqual(manifest.pendingManualIntegration, []);
  assert.ok(!existsSync(join(dest, ".ldl", "CLAUDE.template.md")));
});

test("run: refuses the whole update, as a conflict, when a superseded bridge template was replaced by a symlink whose target content coincidentally matches the recorded hash", async (t) => {
  // Stage 2 audit finding (P1) on PR #131: the template-supersession check compared on-disk
  // content hash directly via existsSync/readFileSync, without the findUnsafeDestReason guard
  // every other previously-managed destination gets — so a template path replaced by a symlink
  // whose target happens to hash-match the recorded template hash was misclassified as safely
  // superseded and removed, instead of refused as a conflict like any other tampered managed path.
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  writeFileSync(join(dest, "CLAUDE.md"), "MY PROJECT'S OWN CLAUDE.md\n");
  await bootstrap(dest, rootV1, "rev-1");
  const templatePath = join(dest, ".ldl", "CLAUDE.template.md");
  assert.ok(existsSync(templatePath));
  const templateContent = readFileSync(templatePath);

  // Consumer removes their own CLAUDE.md (this run would otherwise supersede/delete the now-
  // stale template), but first the template itself is replaced by a symlink to a different file
  // whose content happens to hash-match the recorded template hash exactly.
  rmSync(join(dest, "CLAUDE.md"));
  const decoyPath = join(dest, "decoy-template-target.md");
  writeFileSync(decoyPath, templateContent);
  rmSync(templatePath);
  try {
    symlinkSync(decoyPath, templatePath, "file");
  } catch (err) {
    t.skip(`symlink creation not permitted in this environment: ${err.message}`);
    return;
  }
  const beforeManifest = readManifest(dest);

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const result = await run({ dest, root: rootV2 }, { resolveRevisionImpl: () => "rev-2" });

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /CLAUDE\.template\.md/);
  assert.match(result.message, /symlink/);
  assert.equal(existsSync(decoyPath), true, "the symlink's target file must be untouched");
  assert.deepEqual(readManifest(dest), beforeManifest, "nothing must have been written, including the manifest");
});

test("run: a newly colliding unmanaged destination is recorded under skipped even when no managed file content changed", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, rootV1, "rev-1");

  // Wipe one path's manifest record (as if a newer MANAGED_ITEMS entry appears) while a
  // real, unrelated file already occupies the destination, and keep everything else at
  // byte-identical rev-1 content so no managed file otherwise needs writing.
  const manifestPath = join(dest, ".ldl", "manifest.json");
  const manifest = readManifest(dest);
  manifest.files = manifest.files.filter((f) => f.dest !== "docs/decision-forms.md");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  writeFileSync(join(dest, "docs", "decision-forms.md"), "consumer's own unrelated content\n");
  const beforeMtime = statSync(manifestPath).mtimeMs;

  const result = await run({ dest, root: rootV1 }, { resolveRevisionImpl: () => "rev-1" });

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.message);
  assert.equal(parsed.noop, undefined, "must not report itself as a no-op — the skip set changed");
  const afterManifest = readManifest(dest);
  assert.ok(afterManifest.skipped.some((s) => s.dest === "docs/decision-forms.md"));
  assert.notEqual(statSync(manifestPath).mtimeMs, beforeMtime);

  // A second run with nothing new to report really is a no-op now.
  const second = await run({ dest, root: rootV1 }, { resolveRevisionImpl: () => "rev-1" });
  assert.equal(JSON.parse(second.message).noop, true);
});

// Issue #153: ownership-preserving manual integration acknowledgement, exercised through
// tools/ldl-update's own run() rather than tools/ldl-init's, to prove every surface agrees.

function writeManifest(dest, manifest) {
  writeFileSync(join(dest, ".ldl", "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

test("run: an acknowledged bridge stays resolved across an unrelated update whose own bridge target content is unchanged", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  writeFileSync(join(dest, "CLAUDE.md"), "MY PROJECT'S OWN CLAUDE.md, unmerged\n");
  await bootstrap(dest, rootV1, "rev-1");
  const bootstrapped = readManifest(dest);
  assert.equal(bootstrapped.pendingManualIntegration.length, 1);

  const ack = planAcknowledgeIntegration({ bridgeDestRel: "CLAUDE.md", root: rootV1, destRoot: dest, existingManifest: bootstrapped });
  assert.equal(ack.ok, true);
  const acknowledgements = [
    { dest: ack.dest, template: ack.template, acknowledgedTargetSha256: ack.acknowledgedTargetSha256, acknowledgedAt: "2026-08-23T00:00:00.000Z" },
  ];
  writeManifest(dest, { ...bootstrapped, pendingManualIntegration: [], manualIntegrationAcknowledgements: acknowledgements });

  // Simulate an unrelated LDL source update: everything else advances to rev-2, but the
  // bridge's own target content is held byte-identical to what was acknowledged.
  const rootV2 = makeFixtureRoot(t, "rev-2");
  writeFileSync(join(rootV2, "CLAUDE.md"), readFileSync(join(rootV1, "CLAUDE.md")));

  const result = await run({ dest, root: rootV2 }, { resolveRevisionImpl: () => "rev-2" });

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.message).manualIntegrationNeeded, 0);
  const after = readManifest(dest);
  assert.deepEqual(after.pendingManualIntegration, []);
  assert.deepEqual(after.manualIntegrationAcknowledgements, acknowledgements);
  assert.ok(!after.files.some((f) => f.dest === "CLAUDE.md"), "an acknowledged bridge must never be added to the managed files[] set");
});

test("run: an acknowledged bridge reports pending again once its own target content actually changes", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  writeFileSync(join(dest, "CLAUDE.md"), "MY PROJECT'S OWN CLAUDE.md, unmerged\n");
  await bootstrap(dest, rootV1, "rev-1");
  const bootstrapped = readManifest(dest);

  const ack = planAcknowledgeIntegration({ bridgeDestRel: "CLAUDE.md", root: rootV1, destRoot: dest, existingManifest: bootstrapped });
  assert.equal(ack.ok, true);
  const acknowledgements = [
    { dest: ack.dest, template: ack.template, acknowledgedTargetSha256: ack.acknowledgedTargetSha256, acknowledgedAt: "2026-08-23T00:00:00.000Z" },
  ];
  writeManifest(dest, { ...bootstrapped, pendingManualIntegration: [], manualIntegrationAcknowledgements: acknowledgements });

  // rootV2's own makeFixtureRoot bakes revisionTag into CLAUDE.md's content, so this is a
  // genuine change to the bridge's own target, not merely a different revision label.
  const rootV2 = makeFixtureRoot(t, "rev-2");
  const result = await run({ dest, root: rootV2 }, { resolveRevisionImpl: () => "rev-2" });

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.message).manualIntegrationNeeded, 1, "a genuinely changed bridge target must become pending again");
  const after = readManifest(dest);
  assert.equal(after.pendingManualIntegration.length, 1);
  assert.equal(after.pendingManualIntegration[0].dest, "CLAUDE.md");
  // The stale acknowledgement is preserved, not deleted out from under the consumer — it just
  // no longer suppresses the newly changed target's pending state.
  assert.deepEqual(after.manualIntegrationAcknowledgements, acknowledgements);
  assert.ok(existsSync(join(dest, ".ldl", "CLAUDE.template.md")), "the refreshed template must be re-parked for a fresh merge/acknowledgement");
});

test("run: acknowledging one bridge leaves the other bridge's own pending state untouched", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  writeFileSync(join(dest, "AGENTS.md"), "MY PROJECT'S OWN AGENTS.md, unmerged\n");
  writeFileSync(join(dest, "CLAUDE.md"), "MY PROJECT'S OWN CLAUDE.md, unmerged\n");
  await bootstrap(dest, rootV1, "rev-1");
  const bootstrapped = readManifest(dest);
  assert.equal(bootstrapped.pendingManualIntegration.length, 2);

  const ack = planAcknowledgeIntegration({ bridgeDestRel: "CLAUDE.md", root: rootV1, destRoot: dest, existingManifest: bootstrapped });
  assert.equal(ack.ok, true);
  const acknowledgements = [
    { dest: ack.dest, template: ack.template, acknowledgedTargetSha256: ack.acknowledgedTargetSha256, acknowledgedAt: "2026-08-23T00:00:00.000Z" },
  ];
  const pendingAfterAck = bootstrapped.pendingManualIntegration.filter((p) => p.dest !== "CLAUDE.md");
  writeManifest(dest, { ...bootstrapped, pendingManualIntegration: pendingAfterAck, manualIntegrationAcknowledgements: acknowledgements });

  const result = await run({ dest, root: rootV1 }, { resolveRevisionImpl: () => "rev-1" });

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.message).noop, true, "an unchanged pending/acknowledgement state must still be a true no-op");
  const after = readManifest(dest);
  assert.equal(after.pendingManualIntegration.length, 1);
  assert.equal(after.pendingManualIntegration[0].dest, "AGENTS.md");
  assert.deepEqual(after.manualIntegrationAcknowledgements, acknowledgements);
});

test("run: a local edit to an acknowledged, ownership-preserving bridge file is never treated as an LDL-managed conflict", async (t) => {
  // Contrasts with the exact-content-match graduation case above ("a consumer who manually
  // merges the parked template graduates the bridge to LDL-managed"), where a later hand-edit
  // IS a real conflict — because that path adds the destination to files[]. Acknowledgement
  // deliberately never does that (requirement 3), so this must stay a plain update, not a
  // refusal, no matter what the consumer's own file now contains.
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  writeFileSync(join(dest, "CLAUDE.md"), "MY PROJECT'S OWN CLAUDE.md, unmerged\n");
  await bootstrap(dest, rootV1, "rev-1");
  const bootstrapped = readManifest(dest);

  const ack = planAcknowledgeIntegration({ bridgeDestRel: "CLAUDE.md", root: rootV1, destRoot: dest, existingManifest: bootstrapped });
  assert.equal(ack.ok, true);
  writeManifest(dest, {
    ...bootstrapped,
    pendingManualIntegration: [],
    manualIntegrationAcknowledgements: [
      { dest: ack.dest, template: ack.template, acknowledgedTargetSha256: ack.acknowledgedTargetSha256, acknowledgedAt: "2026-08-23T00:00:00.000Z" },
    ],
  });

  writeFileSync(join(dest, "CLAUDE.md"), "hand-edited again after acknowledgement, unrelated to the merge\n");

  const result = await run({ dest, root: rootV1 }, { resolveRevisionImpl: () => "rev-1" });

  assert.equal(result.exitCode, 0, "an acknowledged bridge's own file is not LDL-managed, so a local edit must never refuse the update");
  assert.equal(
    readFileSync(join(dest, "CLAUDE.md"), "utf8"),
    "hand-edited again after acknowledgement, unrelated to the merge\n",
    "CLAUDE.md remains entirely consumer-owned — the update must never touch it",
  );
});

test("parseArgs: reads --dest and --root flags", () => {
  const args = parseArgs(["--dest", "/tmp/consumer", "--root", "/tmp/ldl"]);
  assert.equal(args.dest, "/tmp/consumer");
  assert.equal(args.root, "/tmp/ldl");
});

test("run: a genuine change to tools/ldl-sync content on update surfaces the PR-creation-permission warning (issue #217)", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, rootV1, "rev-1");

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const result = await run({ dest, root: rootV2 }, { resolveRevisionImpl: () => "rev-2", now: () => "2026-08-24T00:00:00.000Z" });

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.message);
  assert.equal(parsed.noop, undefined);
  assert.deepEqual(parsed.warnings, [SYNC_PR_PERMISSION_WARNING]);
});

test("run: an already-current no-op reports no warnings — a quiet no-op stays quiet (issue #217)", async (t) => {
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, root, "rev-1");

  const result = await run({ dest, root }, { resolveRevisionImpl: () => "rev-1" });

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.message);
  assert.equal(parsed.noop, true);
  assert.equal(parsed.warnings, undefined);
});

// Issue #282: activatedCapabilities (tools/ldl-activate's own durable record of which optional
// integrations a consumer has turned on) must survive an update exactly like
// manualIntegrationAcknowledgements does — run() builds a fresh manifest object literal rather
// than spreading parsedManifest, so any field not explicitly carried forward is silently wiped
// whenever the manifest is actually rewritten. Regression guard for exactly that data-loss bug,
// exercised in both the no-op path (never rewrites the manifest at all, so survives trivially)
// and a path where something else genuinely changes and the manifest does get rewritten.
test("run: carries forward an existing activatedCapabilities array unchanged across a true no-op update (issue #282)", async (t) => {
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, root, "rev-1");
  const manifestPath = join(dest, ".ldl", "manifest.json");
  const manifest = readManifest(dest);
  manifest.activatedCapabilities = [
    {
      id: "consumer-sync",
      activatedAt: "2026-01-01T00:00:00.000Z",
      files: [
        { dest: ".github/workflows/ldl-sync.yml", sha256: createHash("sha256").update("x").digest("hex") },
        { dest: ".github/workflows/ldl-sync-review.yml", sha256: createHash("sha256").update("y").digest("hex") },
      ],
    },
  ];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const result = await run({ dest, root }, { resolveRevisionImpl: () => "rev-1" });

  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.message).noop, true);
  assert.deepEqual(readManifest(dest).activatedCapabilities, manifest.activatedCapabilities);
});

test("run: carries forward an existing activatedCapabilities array unchanged across a genuine content update (issue #282)", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, rootV1, "rev-1");
  const manifestPath = join(dest, ".ldl", "manifest.json");
  const manifest = readManifest(dest);
  const activatedCapabilities = [
    {
      id: "consumer-sync",
      activatedAt: "2026-01-01T00:00:00.000Z",
      files: [{ dest: ".github/workflows/ldl-sync.yml", sha256: createHash("sha256").update("x").digest("hex") }],
    },
  ];
  manifest.activatedCapabilities = activatedCapabilities;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const result = await run({ dest, root: rootV2 }, { resolveRevisionImpl: () => "rev-2" });

  assert.equal(result.exitCode, 0);
  assert.notEqual(JSON.parse(result.message).noop, true, "sanity check: this run must genuinely rewrite the manifest");
  assert.deepEqual(
    readManifest(dest).activatedCapabilities,
    activatedCapabilities,
    "activatedCapabilities must survive a genuine content update untouched, not be silently wiped",
  );
});

test("run: surfaces the activated-capability staleness reminder in warnings only when the run genuinely changes something", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, rootV1, "rev-1");
  const manifestPath = join(dest, ".ldl", "manifest.json");
  const manifest = readManifest(dest);
  manifest.activatedCapabilities = [{ id: "consumer-sync", activatedAt: "2026-01-01T00:00:00.000Z", files: [] }];
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const noopResult = await run({ dest, root: rootV1 }, { resolveRevisionImpl: () => "rev-1" });
  assert.equal(JSON.parse(noopResult.message).noop, true);
  assert.equal(JSON.parse(noopResult.message).warnings, undefined, "a quiet no-op must never resurface this reminder unprompted");

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const changedResult = await run({ dest, root: rootV2 }, { resolveRevisionImpl: () => "rev-2" });
  const parsed = JSON.parse(changedResult.message);
  assert.ok(parsed.warnings.some((w) => w.includes("consumer-sync") && w.includes("tools/ldl-activate")));
});
