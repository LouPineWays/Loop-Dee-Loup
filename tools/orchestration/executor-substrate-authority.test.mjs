// Tests for tools/orchestration/executor-substrate-authority.mjs — issue #702.
// Run with: node --test tools/orchestration/executor-substrate-authority.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXECUTOR_COMPONENTS,
  EXECUTOR_SUBSTRATE,
  WORK_PRODUCT,
  checkExecutorSubstrateAuthority as check,
  classifyPath,
  changesFromGit,
} from "./executor-substrate-authority.mjs";

const grant = (component, extra = {}) => ({
  component,
  intendedChange: "bounded change",
  verification: "unit tests + independent review",
  ...extra,
});
const auth = (...grants) => ({ executorSubstrate: grants });
const ROUTING = "tools/orchestration/ready-dispatch-gate.mjs";

// Proving case 1: authorized routing change.
test("authorized routing component may be modified; adjacent model-selection and Manual are rejected", () => {
  const ok = check({ changes: [{ path: ROUTING }], authority: auth(grant("routing-policy")) });
  assert.equal(ok.allowed, true);
  assert.equal(ok.evidence[0].component, "routing-policy");
  assert.ok(ok.evidence[0].outOfScopeNeighbors.includes("model-selection-policy"));

  const bad = check({
    changes: [{ path: ROUTING }, { path: ".claude/skills/model-check/SKILL.md" }, { path: "AGENTS.md" }],
    authority: auth(grant("routing-policy")),
  });
  assert.equal(bad.allowed, false);
  assert.equal(bad.action, "STOP_AND_PROPOSE");
  assert.deepEqual(bad.proposal.unauthorizedComponents.sort(), ["model-selection-policy", "operating-contract"]);
});

// Proving case 2: Manual/compiler change (component injected via registry; #179 not yet present).
test("authorized compiler component excludes adjacent skills, personas, routing, model-selection", () => {
  const registry = [{ component: "manual-compiler", paths: ["tools/manual/**"] }, ...EXECUTOR_COMPONENTS];
  const authority = auth(grant("manual-compiler"));
  assert.equal(check({ registry, authority, changes: [{ path: "tools/manual/compile.mjs" }] }).allowed, true);
  for (const path of [".claude/skills/spend/SKILL.md", ".claude/personas/audit-verdict-extractor.md", ROUTING, ".claude/skills/model-check/SKILL.md"]) {
    assert.equal(check({ registry, authority, changes: [{ path }] }).allowed, false, path);
  }
});

// Proving case 3: ordinary application fix.
test("ordinary source change needs no authority; shared agent configuration is rejected without it", () => {
  const ordinary = check({ changes: [{ path: "src/app/page.ts" }, { path: "README.md" }], authority: {} });
  assert.equal(ordinary.allowed, true);
  assert.equal(ordinary.evidence, undefined);
  const cfg = check({ changes: [{ path: "src/app/page.ts" }, { path: ".claude/settings.json" }], authority: {} });
  assert.equal(cfg.allowed, false);
  assert.equal(cfg.violations[0].component, "worker-configuration");
});

// Proving case 4: cross-component discovery.
test("component A insufficient and component B needed: whole change set stops with a proposal", () => {
  const r = check({
    changes: [{ path: ROUTING }, { path: "tools/orchestration/format-dispatch-prompt.mjs" }],
    authority: auth(grant("routing-policy")),
  });
  assert.equal(r.allowed, false);
  assert.equal(r.action, "STOP_AND_PROPOSE");
  assert.deepEqual(r.proposal.unauthorizedComponents, ["dispatch-prompts"]);
  assert.deepEqual(r.proposal.paths, ["tools/orchestration/format-dispatch-prompt.mjs"]);
});

// Proving case 5: mixed-purpose paths follow semantic effect.
test("mixed-purpose locations classify by semantic effect, not directory", () => {
  assert.equal(classifyPath(ROUTING).class, EXECUTOR_SUBSTRATE);
  assert.equal(classifyPath("tools/orchestration/ready-dispatch-gate.test.mjs").class, WORK_PRODUCT);
  assert.equal(classifyPath("tools/review-watch/fixtures/x.json").class, WORK_PRODUCT);
  assert.equal(classifyPath("docs/operating-model.md").class, EXECUTOR_SUBSTRATE);
  assert.equal(classifyPath("docs/telemetry-battery-log.md").class, WORK_PRODUCT);
  assert.equal(classifyPath("docs/diagnostic-traces/a.json").class, WORK_PRODUCT);
  assert.equal(classifyPath(".claude/settings.json").class, EXECUTOR_SUBSTRATE);
  assert.equal(classifyPath(".claude/settings.local.json").class, WORK_PRODUCT);
  assert.equal(classifyPath(".claude/launch.json").class, WORK_PRODUCT);
  assert.equal(classifyPath(".claude/skills/model-check/SKILL.md").component, "model-selection-policy");
  assert.equal(classifyPath(".claude/skills/retro/SKILL.md").component, "skills");
});

// Proving case 6: no-op negative control.
test("formatting-only or value-equivalent edits to executor surfaces are not over-classified", () => {
  assert.equal(classifyPath("AGENTS.md", { before: "a  \r\nb\r\n\r\n", after: "a\nb\n" }).class, WORK_PRODUCT);
  const json = classifyPath(".claude/settings.json", {
    before: '{"a":1,"b":{"x":2}}',
    after: '{\n  "b": {"x": 2},\n  "a": 1\n}',
  });
  assert.equal(json.class, WORK_PRODUCT);
  // A real change is still substrate, and content-less (unknown) edits fail closed.
  assert.equal(classifyPath("AGENTS.md", { before: "a", after: "b" }).class, EXECUTOR_SUBSTRATE);
  assert.equal(classifyPath(".claude/settings.json", { before: '{"a":1}', after: '{"a":2}' }).class, EXECUTOR_SUBSTRATE);
  assert.equal(classifyPath("AGENTS.md").class, EXECUTOR_SUBSTRATE);
  const r = check({ changes: [{ path: "AGENTS.md", before: "x\n", after: "x  \n" }, { path: "src/a.ts" }], authority: {} });
  assert.equal(r.allowed, true);
});

test("category-level, unknown, and incomplete grants are not authority", () => {
  for (const g of [
    { component: "*", intendedChange: "x", verification: "y" },
    { component: "CONTROL_PLANE_WRITE", intendedChange: "x", verification: "y" },
    { component: "nonexistent", intendedChange: "x", verification: "y" },
    { component: "routing-policy", verification: "y" },
    { component: "routing-policy", intendedChange: "x" },
    { component: "routing-policy", intendedChange: "x", verification: "y", paths: [] },
  ]) {
    const r = check({ changes: [{ path: ROUTING }], authority: auth(g) });
    assert.equal(r.allowed, false, JSON.stringify(g));
    assert.ok(r.authorityProblems.length > 0);
  }
  assert.equal(check({ changes: [{ path: ROUTING }], authority: { executorSubstrate: "routing-policy" } }).allowed, false);
});

test("a grant's paths envelope bounds the component; escaping paths fail closed", () => {
  const authority = auth(grant("routing-policy", { paths: [ROUTING] }));
  assert.equal(check({ changes: [{ path: ROUTING }], authority }).allowed, true);
  const out = check({ changes: [{ path: "tools/orchestration/route-qualification.mjs" }], authority });
  assert.equal(out.allowed, false);
  assert.match(out.violations[0].reason, /outside the bounded envelope/);
  assert.equal(check({ changes: [{ path: "../outside.txt" }], authority }).allowed, false);
});

test("registry covers every real executor surface (no unregistered shared file)", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const orch = readdirSync(join(root, "tools/orchestration")).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"));
  for (const f of orch) assert.equal(classifyPath(`tools/orchestration/${f}`).class, EXECUTOR_SUBSTRATE, f);
  for (const d of readdirSync(join(root, ".claude/skills"))) {
    assert.equal(classifyPath(`.claude/skills/${d}/SKILL.md`).class, EXECUTOR_SUBSTRATE, d);
  }
  for (const p of ["AGENTS.md", "CLAUDE.md", "docs/bounded-review-cycle.md", "tools/review-watch/trigger.mjs", "tools/ldl-init/index.mjs"]) {
    assert.equal(classifyPath(p).class, EXECUTOR_SUBSTRATE, p);
  }
});

test("CLI/changesFromGit: working-tree diff against a base is checked with content", () => {
  const dir = mkdtempSync(join(tmpdir(), "ess-"));
  const g = (...a) => execFileSync("git", ["-c", "user.email=a@b.c", "-c", "user.name=t", ...a], { cwd: dir, stdio: "pipe" });
  g("init", "-q");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "AGENTS.md"), "one\n");
  writeFileSync(join(dir, "src/a.ts"), "1\n");
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  writeFileSync(join(dir, "AGENTS.md"), "one  \r\n");
  writeFileSync(join(dir, "src/a.ts"), "2\n");
  assert.equal(check({ changes: changesFromGit("HEAD", dir), authority: {} }).allowed, true);
  writeFileSync(join(dir, "AGENTS.md"), "two\n");
  assert.equal(check({ changes: changesFromGit("HEAD", dir), authority: {} }).allowed, false);
  const cli = join(dirname(fileURLToPath(import.meta.url)), "executor-substrate-authority.mjs");
  assert.equal(spawnSync("node", [cli, "--base", "HEAD"], { cwd: dir }).status, 1);
  assert.equal(spawnSync("node", [cli], { cwd: dir }).status, 2);
});
