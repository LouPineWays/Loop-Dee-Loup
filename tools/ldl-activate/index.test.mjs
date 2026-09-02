// Tests for tools/ldl-activate/index.mjs. Fixture-based per the same convention
// tools/ldl-update/index.test.mjs uses: a temp `--root` LDL-source fixture and a temp
// `--dest` consumer fixture, both created with fs.mkdtempSync and removed via t.after() —
// never this repository's own working tree.
// Run with:
//   node --test tools/ldl-activate/index.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MANAGED_ITEMS, run as ldlInit, sha256 } from "../ldl-init/index.mjs";
import {
  CAPABILITIES,
  buildCapabilityOps,
  deriveActivatedCapabilityReminder,
  extractExampleWorkflowYaml,
  findCapability,
  planCapabilityFile,
  run,
} from "./index.mjs";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "ldl-activate-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Crafted docs/consumer-contract.md content mirroring the real document's exact heading text
// and four-backtick fence convention (see tools/ldl-activate/index.mjs's own header comment
// for why four backticks), but with small, disposable fixture YAML bodies so tests never
// depend on this repository's real, evolving workflow content. `tag` is folded into both
// workflow bodies so two fixture revisions produce genuinely different target content,
// simulating "an upstream doc correction" rather than merely a different label.
function consumerContractFixture(tag) {
  return [
    "# Consumer contract",
    "",
    "## Some earlier section",
    "",
    "Unrelated prose that must not be mistaken for either capability section.",
    "",
    "## Automated consumer sync",
    "",
    "Intro paragraph describing the sync workflow.",
    "",
    "### Example workflow",
    "",
    "````yaml",
    `name: LDL Sync (${tag})`,
    "on:",
    '  schedule:',
    '    - cron: "22 6 * * *"',
    "jobs:",
    "  sync:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    `      - run: echo "sync ${tag}"`,
    "````",
    "",
    "This is a starting point — copy it into your own workflow.",
    "",
    "## Automated Stage 1 and merge-ready bookkeeping",
    "",
    "Intro paragraph describing the review-gate workflow.",
    "",
    "### Example workflow",
    "",
    "````yaml",
    `name: LDL Sync Review (${tag})`,
    "on:",
    "  pull_request:",
    "    types: [opened]",
    "jobs:",
    "  gate:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    `      - run: echo "review ${tag}"`,
    "````",
    "",
    "## A later, unrelated section",
    "",
    "More prose that must not leak into the extracted block above.",
    "",
  ].join("\n");
}

// Builds a fixture Loop-Dee-Loup source root that mirrors MANAGED_ITEMS exactly (so
// tools/ldl-init's own bootstrap succeeds against it, giving --dest a valid manifest to
// activate against), then overwrites docs/consumer-contract.md with the crafted fixture
// above — the one file tools/ldl-activate itself actually reads.
function makeFixtureRoot(t, tag) {
  const root = tempDir(t);
  for (const item of MANAGED_ITEMS) {
    const absSrc = join(root, item.src);
    if (item.kind === "file") {
      mkdirSync(dirname(absSrc), { recursive: true });
      writeFileSync(absSrc, `fixture content (${tag}): ${item.src}\n`);
    } else {
      mkdirSync(absSrc, { recursive: true });
      writeFileSync(join(absSrc, "SKILL.md"), `fixture content (${tag}): ${item.src}/SKILL.md\n`);
    }
  }
  writeFileSync(
    join(root, "AGENTS.md"),
    ["# Agent operating contract", "", `Generic rule (${tag}).`, ""].join("\n"),
  );
  writeFileSync(join(root, "CLAUDE.md"), ["# Claude Code instructions", "", "@AGENTS.md", ""].join("\n"));
  // Overwrite with the real fixture content this test suite actually exercises.
  writeFileSync(join(root, "docs", "consumer-contract.md"), consumerContractFixture(tag));
  return root;
}

function readManifest(dest) {
  return JSON.parse(readFileSync(join(dest, ".ldl", "manifest.json"), "utf8"));
}

async function bootstrap(dest, root, revision = "rev-1", now = "2026-01-01T00:00:00.000Z") {
  const result = await ldlInit({ dest, root }, { resolveRevisionImpl: () => revision, now: () => now });
  assert.equal(result.exitCode, 0, `bootstrap fixture setup failed: ${result.message}`);
  return result;
}

const SYNC_YML = ".github/workflows/ldl-sync.yml";
const REVIEW_YML = ".github/workflows/ldl-sync-review.yml";

// --- 1. --list ---------------------------------------------------------------------------

test("run: --list reports the consumer-sync capability without requiring --dest", async () => {
  const result = await run({ list: undefined });
  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.message);
  assert.equal(parsed.capabilities.length, 1);
  assert.equal(parsed.capabilities[0].id, "consumer-sync");
  assert.ok(parsed.capabilities[0].description.length > 0);
});

test("findCapability: resolves a known id and returns null for an unknown one", () => {
  assert.equal(findCapability("consumer-sync"), CAPABILITIES[0]);
  assert.equal(findCapability("does-not-exist"), null);
});

// --- 2. Fresh activation -------------------------------------------------------------------

test("run: fresh activation installs both target files and records activatedCapabilities with correct hashes", async (t) => {
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, root);
  const beforePending = readManifest(dest).pendingManualIntegration;

  const result = await run({ dest, root, capability: "consumer-sync" }, { now: () => "2026-01-02T00:00:00.000Z" });

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.message);
  assert.equal(parsed.installed, 2);
  assert.equal(parsed.updated, 0);
  assert.equal(parsed.parked, 0);
  assert.equal(parsed.noop, false);

  assert.ok(readFileSync(join(dest, SYNC_YML), "utf8").includes("name: LDL Sync (rev-1)"));
  assert.ok(readFileSync(join(dest, REVIEW_YML), "utf8").includes("name: LDL Sync Review (rev-1)"));

  const manifest = readManifest(dest);
  assert.equal(manifest.activatedCapabilities.length, 1);
  const cap = manifest.activatedCapabilities[0];
  assert.equal(cap.id, "consumer-sync");
  assert.equal(cap.activatedAt, "2026-01-02T00:00:00.000Z");
  assert.equal(cap.files.length, 2);
  assert.ok(cap.files.some((f) => f.dest === SYNC_YML));
  assert.ok(cap.files.some((f) => f.dest === REVIEW_YML));
  assert.deepEqual(manifest.pendingManualIntegration, beforePending, "unrelated pendingManualIntegration state must be untouched");
});

// --- 3. Repeat activation is a true no-op ---------------------------------------------------

test("run: repeat activation with no upstream change is a predictable no-op that touches nothing on disk", async (t) => {
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, root);
  await run({ dest, root, capability: "consumer-sync" });

  const manifestPath = join(dest, ".ldl", "manifest.json");
  const beforeMtime = statSync(manifestPath).mtimeMs;
  const beforeBytes = readFileSync(manifestPath);

  const result = await run({ dest, root, capability: "consumer-sync" });

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.message);
  assert.equal(parsed.noop, true);
  assert.equal(parsed.installed, 0);
  assert.equal(parsed.updated, 0);
  assert.equal(parsed.unchanged, 2);

  assert.equal(statSync(manifestPath).mtimeMs, beforeMtime, "manifest.json must not be rewritten on a true no-op");
  assert.deepEqual(readFileSync(manifestPath), beforeBytes);
});

// --- 4. Pre-existing conflicting file at one destination (YouTubery #100 shape) -------------

test("run: a pre-existing consumer-owned file at one target path is parked, not overwritten, while the other target installs normally in the same run (reproduces the YouTubery PR #100 gap: reusable helpers present, activation wiring never applied)", async (t) => {
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, root);
  mkdirSync(join(dest, ".github", "workflows"), { recursive: true });
  writeFileSync(join(dest, SYNC_YML), "name: My Own Custom Sync\non: push\n");

  const result = await run({ dest, root, capability: "consumer-sync" }, { now: () => "2026-01-02T00:00:00.000Z" });

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.message);
  assert.equal(parsed.installed, 1, "the unrelated, absent review workflow still installs");
  assert.equal(parsed.parked, 1);

  // The pre-existing file is untouched.
  assert.equal(readFileSync(join(dest, SYNC_YML), "utf8"), "name: My Own Custom Sync\non: push\n");
  // The canonical content is parked for manual review instead.
  const templatePath = join(dest, ".ldl", "templates", "consumer-sync", "ldl-sync.yml");
  assert.ok(existsSync(templatePath));
  assert.ok(readFileSync(templatePath, "utf8").includes("name: LDL Sync (rev-1)"));
  // The other file installed straight through.
  assert.ok(existsSync(join(dest, REVIEW_YML)));

  const manifest = readManifest(dest);
  assert.ok(manifest.pendingManualIntegration.some((p) => p.dest === SYNC_YML && p.template === ".ldl/templates/consumer-sync/ldl-sync.yml"));
  const cap = manifest.activatedCapabilities.find((c) => c.id === "consumer-sync");
  assert.ok(!cap.files.some((f) => f.dest === SYNC_YML), "a parked file must never join the capability's own managed files[] set");
  assert.ok(cap.files.some((f) => f.dest === REVIEW_YML));
});

// --- 5. Upstream doc correction updates an already-activated, untouched file ----------------

test("run: an upstream doc correction safely updates an already-activated, locally-untouched file and preserves the original activatedAt", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, rootV1);
  await run({ dest, root: rootV1, capability: "consumer-sync" }, { now: () => "2026-01-02T00:00:00.000Z" });

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const result = await run({ dest, root: rootV2, capability: "consumer-sync" }, { now: () => "2026-01-03T00:00:00.000Z" });

  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.message);
  assert.equal(parsed.updated, 2);
  assert.equal(parsed.installed, 0);
  assert.equal(parsed.noop, false);

  assert.ok(readFileSync(join(dest, SYNC_YML), "utf8").includes("name: LDL Sync (rev-2)"));
  assert.ok(readFileSync(join(dest, REVIEW_YML), "utf8").includes("name: LDL Sync Review (rev-2)"));

  const manifest = readManifest(dest);
  const cap = manifest.activatedCapabilities.find((c) => c.id === "consumer-sync");
  assert.equal(cap.activatedAt, "2026-01-02T00:00:00.000Z", "activatedAt must be preserved across a safe re-activation, not reset");
});

// --- 6. Local edit + upstream change => conflict, nothing written ---------------------------

test("run: a local edit to an already-activated file combined with an upstream change is a conflict that writes nothing", async (t) => {
  const rootV1 = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, rootV1);
  await run({ dest, root: rootV1, capability: "consumer-sync" });

  writeFileSync(join(dest, SYNC_YML), "hand-edited by the consumer, not from LDL\n");
  const beforeManifest = readManifest(dest);
  const manifestPath = join(dest, ".ldl", "manifest.json");
  const beforeMtime = statSync(manifestPath).mtimeMs;

  const rootV2 = makeFixtureRoot(t, "rev-2");
  const result = await run({ dest, root: rootV2, capability: "consumer-sync" });

  assert.equal(result.exitCode, 1);
  assert.match(result.message, new RegExp(SYNC_YML.replace(/[/.]/g, "\\$&")));
  assert.match(result.message, /locally modified/);

  assert.equal(readFileSync(join(dest, SYNC_YML), "utf8"), "hand-edited by the consumer, not from LDL\n");
  assert.equal(readFileSync(join(dest, REVIEW_YML), "utf8").includes("name: LDL Sync Review (rev-1)"), true, "unrelated file in the same capability must not be written either");
  assert.deepEqual(readManifest(dest), beforeManifest);
  assert.equal(statSync(manifestPath).mtimeMs, beforeMtime);
});

// --- 7. Unknown capability -------------------------------------------------------------------

test("run: an unknown --capability id exits 1 and lists known ids", async (t) => {
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, root);

  const result = await run({ dest, root, capability: "does-not-exist" });

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /Unknown capability/);
  assert.match(result.message, /consumer-sync/);
});

// --- 8. Missing/invalid manifest ---------------------------------------------------------------

test("run: exits 1 with a clear message when --dest has no .ldl/manifest.json yet", async (t) => {
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);

  const result = await run({ dest, root, capability: "consumer-sync" });

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /ldl-init/);
  assert.match(result.message, /manifest/i);
});

test("run: exits 1 when --dest/.ldl/manifest.json is not in the expected shape", async (t) => {
  const root = makeFixtureRoot(t, "rev-1");
  const dest = tempDir(t);
  await bootstrap(dest, root);
  writeFileSync(join(dest, ".ldl", "manifest.json"), JSON.stringify({ someOtherTool: true }));

  const result = await run({ dest, root, capability: "consumer-sync" });

  assert.equal(result.exitCode, 1);
  assert.match(result.message, /expected shape/i);
});

test("run: exits 1 when --dest is missing", async () => {
  const result = await run({ capability: "consumer-sync" });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /--dest/);
});

// --- 9. extractExampleWorkflowYaml unit tests -------------------------------------------------

test("extractExampleWorkflowYaml: extracts the fenced yaml block under the matching heading, bounded by the next heading", () => {
  const doc = [
    "# Doc",
    "",
    "## Section A",
    "",
    "Intro.",
    "",
    "### Example workflow",
    "",
    "````yaml",
    "name: Foo",
    "on: push",
    "````",
    "",
    "## Section B",
    "",
    "Unrelated content that must not leak in.",
    "",
  ].join("\n");

  const extracted = extractExampleWorkflowYaml(doc, "## Section A");
  assert.equal(extracted, "name: Foo\non: push\n");
  assert.ok(!extracted.includes("Unrelated"));
});

test("extractExampleWorkflowYaml: throws when the section heading is not found", () => {
  const doc = "## Section A\n\n````yaml\nfoo: 1\n````\n";
  assert.throws(() => extractExampleWorkflowYaml(doc, "## Section Z"), /section heading not found/);
});

test("extractExampleWorkflowYaml: throws when the fenced yaml block is unterminated", () => {
  const doc = "## Section A\n\n````yaml\nfoo: 1\n(never closed)\n";
  assert.throws(() => extractExampleWorkflowYaml(doc, "## Section A"), /unterminated fenced yaml block/);
});

test("extractExampleWorkflowYaml: throws when no fenced yaml block exists at all under the heading", () => {
  const doc = "## Section A\n\nJust prose, no fenced block.\n\n## Section B\n";
  assert.throws(() => extractExampleWorkflowYaml(doc, "## Section A"), /no fenced yaml example workflow found/);
});

// --- 10. Guard against real doc drift (issues #37/#39/#41 pattern: see tools/check-control-plane-paths.mjs) ---

test("extractExampleWorkflowYaml: extracts real, recognizable content from this repository's actual docs/consumer-contract.md for both real capability sections", () => {
  const docText = readFileSync(join(REPO_ROOT, "docs", "consumer-contract.md"), "utf8");

  const syncYaml = extractExampleWorkflowYaml(docText, "## Automated consumer sync");
  assert.match(syncYaml, /name:\s*LDL Sync\b/);
  assert.ok(!syncYaml.includes("LDL Sync Review"), "must not have captured into the next section's own workflow");

  const reviewYaml = extractExampleWorkflowYaml(docText, "## Automated Stage 1 and merge-ready bookkeeping");
  assert.match(reviewYaml, /name:\s*LDL Sync Review\b/);
  assert.ok(reviewYaml.includes("consumer-sync-gate.mjs") || reviewYaml.includes("merge-ready-gate.mjs"));
});

test("buildCapabilityOps: resolves the real repository's consumer-sync capability content end to end", () => {
  const ops = buildCapabilityOps(REPO_ROOT, findCapability("consumer-sync"));
  assert.equal(ops.length, 2);
  const sync = ops.find((o) => o.destRel === SYNC_YML);
  const review = ops.find((o) => o.destRel === REVIEW_YML);
  assert.ok(sync.content.toString("utf8").includes("name: LDL Sync"));
  assert.ok(review.content.toString("utf8").includes("name: LDL Sync Review"));
  assert.ok(!sync.content.toString("utf8").includes("\r"), "extracted content must be normalized to LF regardless of this checkout's own line endings");
});

// --- planCapabilityFile unit tests (mirrors the direct planBridgeOp/planUpdate coverage style) ---

test("planCapabilityFile: installs when the destination is absent and never activated", (t) => {
  const dest = tempDir(t);
  const result = planCapabilityFile({
    destRel: "x.yml",
    content: Buffer.from("target\n"),
    destRoot: dest,
    activatedFileRecord: undefined,
    capabilityId: "consumer-sync",
  });
  assert.equal(result.action, "install");
});

test("planCapabilityFile: recognizes a byte-identical pre-existing file as already active (content-match graduation)", (t) => {
  const dest = tempDir(t);
  writeFileSync(join(dest, "x.yml"), "target\n");
  const result = planCapabilityFile({
    destRel: "x.yml",
    content: Buffer.from("target\n"),
    destRoot: dest,
    activatedFileRecord: undefined,
    capabilityId: "consumer-sync",
  });
  assert.equal(result.action, "unchanged");
});

test("planCapabilityFile: parks when a differing pre-existing file is never activated", (t) => {
  const dest = tempDir(t);
  writeFileSync(join(dest, "x.yml"), "something else entirely\n");
  const result = planCapabilityFile({
    destRel: "x.yml",
    content: Buffer.from("target\n"),
    destRoot: dest,
    activatedFileRecord: undefined,
    capabilityId: "consumer-sync",
  });
  assert.equal(result.action, "park");
  assert.equal(result.templateDestRel, ".ldl/templates/consumer-sync/x.yml");
});

test("planCapabilityFile: updates when on-disk content still matches the recorded (older) activation hash", (t) => {
  const dest = tempDir(t);
  const oldContent = Buffer.from("old target\n");
  writeFileSync(join(dest, "x.yml"), oldContent);
  const result = planCapabilityFile({
    destRel: "x.yml",
    content: Buffer.from("new target\n"),
    destRoot: dest,
    activatedFileRecord: { dest: "x.yml", sha256: sha256(oldContent) },
    capabilityId: "consumer-sync",
  });
  assert.equal(result.action, "update");
});

test("planCapabilityFile: conflicts when previously activated file is missing locally", (t) => {
  const dest = tempDir(t);
  const result = planCapabilityFile({
    destRel: "x.yml",
    content: Buffer.from("target\n"),
    destRoot: dest,
    activatedFileRecord: { dest: "x.yml", sha256: "irrelevant-but-present" },
    capabilityId: "consumer-sync",
  });
  assert.equal(result.action, "conflict");
  assert.match(result.reason, /missing locally/);
});

// --- deriveActivatedCapabilityReminder unit tests ---

test("deriveActivatedCapabilityReminder: empty for no activated capabilities", () => {
  assert.deepEqual(deriveActivatedCapabilityReminder([]), []);
  assert.deepEqual(deriveActivatedCapabilityReminder(undefined), []);
});

test("deriveActivatedCapabilityReminder: names every activated capability id", () => {
  const reminder = deriveActivatedCapabilityReminder([{ id: "consumer-sync" }]);
  assert.equal(reminder.length, 1);
  assert.match(reminder[0], /consumer-sync/);
  assert.match(reminder[0], /tools\/ldl-activate\/index\.mjs/);
});
