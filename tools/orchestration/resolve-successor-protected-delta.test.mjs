// Tests for tools/orchestration/resolve-successor-protected-delta.mjs -- issue #980 (control
// #967; live reproduction #867/#868/PR #869: successor cherry-pick of the reviewed AGENTS.md
// clause refused for a worker by the provider's Self-Modification protection).
//
// Run with:
//   node --test tools/orchestration/resolve-successor-protected-delta.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultDeps, tokenize } from "./resolve-protected-conflict.mjs";
import { resolveSuccessorProtectedDelta } from "./resolve-successor-protected-delta.mjs";

const HUNK_869 = JSON.parse(readFileSync(new URL("./fixtures/resolve-protected-conflict-869-hunk.json", import.meta.url), "utf8"));

const BASE = "Rule one applies when alpha holds. Rule two applies when beta holds. Keep it short.\n";
const TARGET = "Rule one applies when alpha or gamma holds. Rule two applies when beta holds. Keep it short.\n";
const REVIEWED = "Rule one applies when alpha holds. Rule two applies when beta holds. Rule three covers delta. Keep it short.\n";
const EXPECTED = "Rule one applies when alpha or gamma holds. Rule two applies when beta holds. Rule three covers delta. Keep it short.\n";
const HEADER = "# Contract\n\nIntro line.\n\n";
const FOOTER = "\nTrailing section.\n";

function sh(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// main: base -> target advance. Predecessor branch: reviewed commit (adds the clause) then an
// attributable correction commit. Successor branch cut from current main with the reviewed
// cherry-pick (optionally the correction too) left conflicted.
function buildFixture({
  base = BASE,
  reviewed = REVIEWED,
  target = TARGET,
  pick = "reviewed", // "reviewed" | "correction" | "unattributed"
  otherConflict = false,
  successorBranch = "issue-868-successor-of-869-attempt-1",
  correctionMessage = "Apply correction (#868)",
  correctionTouchesAgents = false,
} = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ldl-rspd-test-")));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  sh(repo, "config", "user.email", "t@example.com");
  sh(repo, "config", "user.name", "t");
  const w = (f, t) => writeFileSync(join(repo, f), t);
  w("AGENTS.md", HEADER + base + FOOTER);
  w("code.txt", "base code\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", "base");
  sh(repo, "checkout", "-q", "-b", "pred");
  w("AGENTS.md", HEADER + reviewed + FOOTER);
  if (otherConflict) w("code.txt", "pred code\n");
  sh(repo, "commit", "-q", "-am", "reviewed change (#868)");
  const reviewedSha = sh(repo, "rev-parse", "HEAD");
  if (correctionTouchesAgents) w("AGENTS.md", HEADER + reviewed.replace("Keep it short.", "Rule five covers epsilon. Keep it short.") + FOOTER);
  else w("code2.txt", "correction\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-q", "-m", correctionMessage);
  const correctedSha = sh(repo, "rev-parse", "HEAD");
  sh(repo, "checkout", "-q", "main");
  w("AGENTS.md", HEADER + target + FOOTER);
  if (otherConflict) w("code.txt", "main code\n");
  sh(repo, "commit", "-q", "-am", "target advance");
  const tip = sh(repo, "rev-parse", "HEAD");
  sh(repo, "checkout", "-q", "-b", successorBranch);
  const picked = pick === "correction" || pick === "unattributed" ? correctedSha : reviewedSha;
  try {
    sh(repo, "cherry-pick", picked);
  } catch {
    // expected: conflict
  }
  return { root, repo, reviewed: reviewedSha, corrected: correctedSha, tip, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function depsFor(fx, { prHead = null, baseTip = null, state = "OPEN", stage1 = null, execution = 868, pr = 869 } = {}) {
  return {
    ...defaultDeps(),
    readPr: async () => ({ headRefOid: prHead ?? fx.corrected, baseRefName: "main", state }),
    readBranchTip: async () => baseTip ?? fx.tip,
    readIssue: async () => ({
      state: "OPEN",
      body:
        `- **Execution:** #${execution}\n- **PR:** #${pr}\n` +
        `- **Stage 1:** ${stage1 ?? `correction-satisfied at ${fx.corrected} (reviewed ${fx.reviewed})`}\n`,
    }),
  };
}

const args = (fx, extra = {}) => ({
  repo: "o/r",
  controlIssue: 867,
  executionIssue: 868,
  predecessorPr: 869,
  reviewedHead: fx.reviewed,
  correctedHead: fx.corrected,
  cwd: fx.repo,
  ...extra,
});

const agents = (fx) => readFileSync(join(fx.repo, "AGENTS.md"), "utf8");
const unmerged = (fx) =>
  [...new Set(sh(fx.repo, "ls-files", "-u").split("\n").filter(Boolean).map((l) => l.split("\t")[1]))];

function assertUntouched(fx, before) {
  assert.equal(agents(fx), before, "protected file must be byte-identical after a fail-closed result");
  assert.ok(unmerged(fx).includes("AGENTS.md"), "AGENTS.md must remain unmerged");
}

test("positive: dry run mutates nothing; apply carries the reviewed delta onto current target without a worker edit", async () => {
  const fx = buildFixture();
  try {
    const before = agents(fx);
    assert.match(before, /<<<<<<</);
    // Simulated provider Self-Modification veto on any worker-authored protected edit.
    let workerEdits = 0;
    const workerEdit = () => {
      workerEdits++;
      throw new Error("Self-Modification denied");
    };
    const dry = await resolveSuccessorProtectedDelta(args(fx), depsFor(fx));
    assert.equal(dry.verdict, "WOULD_RESOLVE");
    assert.equal(dry.mutated, false);
    assertUntouched(fx, before);
    const done = await resolveSuccessorProtectedDelta({ ...args(fx), apply: true }, depsFor(fx));
    assert.equal(done.verdict, "RESOLVED", JSON.stringify(done));
    assert.equal(done.mutated, true);
    assert.equal(workerEdits, 0);
    assert.equal(typeof workerEdit, "function");
    assert.equal(agents(fx), HEADER + EXPECTED + FOOTER);
    assert.deepEqual(unmerged(fx), []);
    assert.equal(sh(fx.repo, "show", ":AGENTS.md"), (HEADER + EXPECTED + FOOTER).trimEnd());
    assert.equal(sh(fx.repo, "rev-parse", "HEAD"), fx.tip, "the helper never commits");
  } finally {
    fx.cleanup();
  }
});

test("positive: the real #869 AGENTS.md hunk (reviewed clause onto newer main) is carried forward preserving target text", async () => {
  const fx = buildFixture({ base: HUNK_869.baseText, reviewed: HUNK_869.prText, target: HUNK_869.targetText });
  try {
    assert.match(agents(fx), /<<<<<<</);
    const r = await resolveSuccessorProtectedDelta({ ...args(fx), apply: true }, depsFor(fx));
    assert.equal(r.verdict, "RESOLVED", JSON.stringify(r));
    const out = agents(fx);
    assert.doesNotMatch(out, /<<<<<<<|>>>>>>>/);
    assert.ok(out.includes("STAGE2_REPLACEMENT_AUDIT_REQUIRED"));
    // Every target-side token survives in order (target authority fully preserved).
    const tt = tokenize(HUNK_869.targetText);
    let i = 0;
    for (const tok of tokenize(out)) if (tok === tt[i]) i++;
    assert.equal(i, tt.length);
  } finally {
    fx.cleanup();
  }
});

test("re-entry is idempotent for the exact proven delta and never mutates again", async () => {
  const fx = buildFixture();
  try {
    const first = await resolveSuccessorProtectedDelta({ ...args(fx), apply: true }, depsFor(fx));
    assert.equal(first.verdict, "RESOLVED");
    const staged = sh(fx.repo, "ls-files", "--stage", "AGENTS.md");
    const second = await resolveSuccessorProtectedDelta({ ...args(fx), apply: true }, depsFor(fx));
    assert.equal(second.verdict, "ALREADY_RESOLVED", JSON.stringify(second));
    assert.equal(second.mutated, false);
    assert.equal(sh(fx.repo, "ls-files", "--stage", "AGENTS.md"), staged);
    assert.equal(sh(fx.repo, "branch", "--list", "issue-*").split("\n").length, 1, "no second successor branch");
  } finally {
    fx.cleanup();
  }
});

test("re-entry refuses a staged protected path that is not exactly the proven result", async () => {
  const fx = buildFixture();
  try {
    writeFileSync(join(fx.repo, "AGENTS.md"), HEADER + EXPECTED.replace("delta", "zeta") + FOOTER);
    sh(fx.repo, "add", "AGENTS.md");
    const r = await resolveSuccessorProtectedDelta({ ...args(fx), apply: true }, depsFor(fx));
    assert.equal(r.verdict, "FAIL_CLOSED");
    assert.equal(r.code, "NOT_A_CONTENT_CONFLICT");
    assert.ok(agents(fx).includes("zeta"));
  } finally {
    fx.cleanup();
  }
});

test("a correction-range commit attributable to the execution Issue is accepted", async () => {
  const fx = buildFixture({ pick: "correction", correctionTouchesAgents: true, target: TARGET });
  try {
    // Reviewed pick lands first (HEAD already contains it via a resolved pick), then the correction.
    sh(fx.repo, "cherry-pick", "--abort");
    try { sh(fx.repo, "cherry-pick", fx.reviewed); } catch { /* conflict */ }
    const first = await resolveSuccessorProtectedDelta({ ...args(fx), apply: true }, depsFor(fx));
    assert.equal(first.verdict, "RESOLVED", JSON.stringify(first));
    sh(fx.repo, "-c", "core.editor=true", "cherry-pick", "--continue");
    try { sh(fx.repo, "cherry-pick", fx.corrected); } catch { /* conflict expected */ }
    assert.deepEqual(unmerged(fx), ["AGENTS.md"]);
    const second = await resolveSuccessorProtectedDelta({ ...args(fx), apply: true }, depsFor(fx));
    assert.equal(second.verdict, "RESOLVED", JSON.stringify(second));
    assert.ok(agents(fx).includes("Rule five covers epsilon."));
    assert.ok(agents(fx).includes("alpha or gamma"));
    assert.deepEqual(unmerged(fx), []);
  } finally {
    fx.cleanup();
  }
});

test("fails closed, with no mutation, for wrong or stale identity and provenance", async () => {
  const cases = [
    ["wrong reviewed sha", (fx) => ({ ...args(fx), reviewedHead: fx.tip }), () => ({}), /./],
    ["wrong corrected sha", (fx) => ({ ...args(fx), correctedHead: fx.tip }), () => ({}), /./],
    ["wrong execution", (fx) => ({ ...args(fx), executionIssue: 999 }), () => ({}), /./],
    ["wrong predecessor PR", (fx) => ({ ...args(fx), predecessorPr: 870 }), () => ({}), /./],
    ["control binds another execution", (fx) => args(fx), () => ({ execution: 123 }), /CORRECTION_PROVENANCE_UNVERIFIED/],
    ["control binds another PR", (fx) => args(fx), () => ({ pr: 870 }), /CORRECTION_PROVENANCE_UNVERIFIED/],
    ["control heads differ", (fx) => args(fx), (fx) => ({ stage1: `correction-satisfied at ${fx.tip} (reviewed ${fx.reviewed})` }), /CORRECTION_PROVENANCE_UNVERIFIED/],
    ["control not correction-satisfied", (fx) => args(fx), () => ({ stage1: "requested" }), /CORRECTION_PROVENANCE_UNVERIFIED/],
    ["predecessor head moved", (fx) => args(fx), (fx) => ({ prHead: fx.tip }), /STALE_PREDECESSOR_HEAD/],
    ["predecessor not open", (fx) => args(fx), () => ({ state: "MERGED" }), /PREDECESSOR_NOT_OPEN/],
    ["target moved past successor", (fx) => args(fx), () => ({ baseTip: "f".repeat(40) }), /STALE_TARGET/],
  ];
  for (const [name, mkArgs, mkDeps, codeRe] of cases) {
    const fx = buildFixture();
    try {
      const before = agents(fx);
      const r = await resolveSuccessorProtectedDelta({ ...mkArgs(fx), apply: true }, depsFor(fx, mkDeps(fx)));
      assert.notEqual(r.exitCode, 0, name);
      assert.ok(r.verdict === "FAIL_CLOSED" || r.verdict === "OPERATIONAL_ERROR", name);
      if (r.verdict === "FAIL_CLOSED") assert.match(r.code, codeRe, name);
      assert.notEqual(r.mutated, true, name);
      assertUntouched(fx, before);
    } finally {
      fx.cleanup();
    }
  }
});

test("fails closed on a non-canonical successor branch and when no cherry-pick is in progress", async () => {
  const fx = buildFixture({ successorBranch: "scratch-branch" });
  try {
    const before = agents(fx);
    const r = await resolveSuccessorProtectedDelta({ ...args(fx), apply: true }, depsFor(fx));
    assert.equal(r.code, "SUCCESSOR_IDENTITY_UNVERIFIED");
    assertUntouched(fx, before);
  } finally {
    fx.cleanup();
  }
  const fx2 = buildFixture();
  try {
    sh(fx2.repo, "cherry-pick", "--abort");
    const r = await resolveSuccessorProtectedDelta({ ...args(fx2), apply: true }, depsFor(fx2));
    assert.equal(r.code, "NO_CHERRY_PICK_IN_PROGRESS");
    assert.doesNotMatch(agents(fx2), /REPLACEMENT|delta/);
  } finally {
    fx2.cleanup();
  }
});

test("a pick outside the attributable reviewed..corrected range is refused", async () => {
  const fx = buildFixture({ pick: "unattributed", correctionTouchesAgents: true, correctionMessage: "Unrelated edit" });
  try {
    const before = agents(fx);
    const r = await resolveSuccessorProtectedDelta({ ...args(fx), apply: true }, depsFor(fx));
    assert.equal(r.verdict, "FAIL_CLOSED");
    assert.equal(r.code, "CORRECTION_PROVENANCE_UNVERIFIED");
    assertUntouched(fx, before);
  } finally {
    fx.cleanup();
  }
});

test("competing target semantics adjacent to the reviewed clause are refused, never guessed", async () => {
  const fx = buildFixture({ target: "Rule one applies when alpha holds. Rule two applies when beta holds. Rule four covers theta. Keep it short.\n" });
  try {
    const before = agents(fx);
    const r = await resolveSuccessorProtectedDelta({ ...args(fx), apply: true }, depsFor(fx));
    assert.equal(r.verdict, "FAIL_CLOSED");
    assert.ok(["COMPETING_CHANGE", "AMBIGUOUS_ALIGNMENT"].includes(r.code), r.code);
    assertUntouched(fx, before);
  } finally {
    fx.cleanup();
  }
});

test("a reviewed-side deletion of newer target authority is refused", async () => {
  const fx = buildFixture({ reviewed: "Rule one applies when alpha holds. Keep it short.\n" });
  try {
    const before = agents(fx);
    const r = await resolveSuccessorProtectedDelta({ ...args(fx), apply: true }, depsFor(fx));
    assert.equal(r.verdict, "FAIL_CLOSED");
    assertUntouched(fx, before);
  } finally {
    fx.cleanup();
  }
});

test("ordinary non-protected conflicts stay worker-owned: only the protected path is touched", async () => {
  const fx = buildFixture({ otherConflict: true });
  try {
    assert.deepEqual(unmerged(fx).sort(), ["AGENTS.md", "code.txt"]);
    const codeBefore = readFileSync(join(fx.repo, "code.txt"), "utf8");
    const r = await resolveSuccessorProtectedDelta({ ...args(fx), apply: true }, depsFor(fx));
    assert.equal(r.verdict, "RESOLVED", JSON.stringify(r));
    assert.deepEqual(r.paths.map((p) => p.path), ["AGENTS.md"]);
    assert.deepEqual(unmerged(fx), ["code.txt"]);
    assert.equal(readFileSync(join(fx.repo, "code.txt"), "utf8"), codeBefore);
  } finally {
    fx.cleanup();
  }
});

test("malformed arguments are an operational error, not a verdict", async () => {
  const r = await resolveSuccessorProtectedDelta({ repo: "o/r", controlIssue: 1, executionIssue: 2, predecessorPr: 3, reviewedHead: "abc", correctedHead: "def" }, {});
  assert.equal(r.exitCode, 1);
  assert.equal(r.verdict, "OPERATIONAL_ERROR");
});
