// Tests for tools/orchestration/verdict-handoff.mjs and its consumers -- issue #761 (control
// #571), the live #398/#740/PR #760 recurrence: STAGE1_CORRECTION_REQUIRED -> reserve -> format
// with no lifecycle-gate re-run and no controller-authored JSON.
//
// Run with: node --test tools/orchestration/verdict-handoff.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HANDOFF_MAX_AGE_MS,
  clearVerdictHandoff,
  persistVerdictHandoff,
  readVerdictHandoff,
} from "./verdict-handoff.mjs";
import { decidePreToolUse } from "./action-envelope-hook.mjs";
import { getActionEnvelope } from "./action-envelope.mjs";

const FORMAT = fileURLToPath(new URL("./format-dispatch-prompt.mjs", import.meta.url));
const PREFLIGHT = fileURLToPath(new URL("./pr-head-checkout-preflight.mjs", import.meta.url));

// The exact Windows-native shape that broke hand-built JSON in the #398/#740 recurrence.
const WIN_SCRIPT = "C:\\Users\\Some User\\Loop-Dee-Loup\\tools\\orchestration\\pr-head-checkout-preflight.mjs";
const BINDING = {
  path: "C:/Loop-Dee-Loup/.claude/worktrees/pr-760-bind-1111d743",
  token: "1111d743",
  sha: "6a7d640764a13d8e52c35111ed7b8a294b7ba92f",
  branch: "execution-740",
  mode: "created",
  verdict: "CREATED_WORKTREE_AT_HEAD",
  scriptPath: WIN_SCRIPT,
};
const GATE = {
  exitCode: 3,
  state: "STAGE1_CORRECTION_REQUIRED",
  controlIssue: 398,
  issue: 740,
  pr: 760,
  correctionReason: "findings",
  stopAfter: true,
  actionEnvelope: getActionEnvelope("STAGE1_CORRECTION_REQUIRED"),
};

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "ldl-handoff-"));
  return { dir, path: join(dir, "verdict-handoff.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function run(script, args, dir) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    input: "",
    env: { ...process.env, LDL_ACTION_ENVELOPE_STATE_DIR: dir },
  });
}

function seed(dir, verdict, savedAt = Date.now()) {
  writeFileSync(join(dir, "verdict-handoff.json"), JSON.stringify({ version: 1, savedAt, verdict }), "utf8");
}

test("persist/read round-trips the verdict, including Windows backslash and spaced paths, losslessly", () => {
  const t = tmp();
  try {
    assert.equal(persistVerdictHandoff({ ...GATE, checkoutBinding: BINDING }, { path: t.path }), true);
    const r = readVerdictHandoff({ path: t.path, controlIssue: 398 });
    assert.equal(r.ok, true);
    assert.equal(r.verdict.checkoutBinding.scriptPath, WIN_SCRIPT);
  } finally {
    t.cleanup();
  }
});

test("read fails closed: missing, malformed, wrong version, stale, future-dated, wrong control issue", () => {
  const t = tmp();
  try {
    assert.equal(readVerdictHandoff({ path: t.path }).ok, false);
    writeFileSync(t.path, "{not json", "utf8");
    assert.equal(readVerdictHandoff({ path: t.path }).ok, false);
    writeFileSync(t.path, JSON.stringify({ version: 2, savedAt: Date.now(), verdict: GATE }), "utf8");
    assert.equal(readVerdictHandoff({ path: t.path }).ok, false);
    writeFileSync(t.path, JSON.stringify({ version: 1, savedAt: Date.now(), verdict: { pr: 1 } }), "utf8");
    assert.equal(readVerdictHandoff({ path: t.path }).ok, false);
    const now = Date.now();
    writeFileSync(t.path, JSON.stringify({ version: 1, savedAt: now - HANDOFF_MAX_AGE_MS - 1, verdict: GATE }), "utf8");
    assert.match(readVerdictHandoff({ path: t.path, now }).reason, /stale/);
    writeFileSync(t.path, JSON.stringify({ version: 1, savedAt: now + 3_600_000, verdict: GATE }), "utf8");
    assert.equal(readVerdictHandoff({ path: t.path, now }).ok, false);
    persistVerdictHandoff(GATE, { path: t.path });
    assert.match(readVerdictHandoff({ path: t.path, controlIssue: 399 }).reason, /control issue/);
  } finally {
    t.cleanup();
  }
});

test("persist never throws and clear removes the handoff", () => {
  const t = tmp();
  try {
    assert.equal(
      persistVerdictHandoff(GATE, {
        path: t.path,
        writeFileImpl: () => {
          throw new Error("disk");
        },
      }),
      false,
    );
    persistVerdictHandoff(GATE, { path: t.path });
    assert.equal(existsSync(t.path), true);
    clearVerdictHandoff({ path: t.path });
    assert.equal(existsSync(t.path), false);
  } finally {
    t.cleanup();
  }
});

test("#398/#740 recurrence: format-dispatch-prompt --from-handoff renders the canonical prompt from a reserved handoff with a Windows scriptPath", () => {
  const t = tmp();
  try {
    seed(t.dir, { ...GATE, checkoutBinding: BINDING });
    const r = run(FORMAT, ["--from-handoff", "--control-issue", "398"], t.dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Stage 1 correction worker dispatch/i);
    assert.ok(r.stdout.includes(`node "${WIN_SCRIPT}"`), "scriptPath is transported verbatim, unescaped");
    assert.ok(r.stdout.includes(BINDING.path));
    assert.match(r.stdout, /#760/);
  } finally {
    t.cleanup();
  }
});

test("format --from-handoff fails closed: no handoff, wrong control issue, unreserved correction, non-ready state", () => {
  const t = tmp();
  try {
    let r = run(FORMAT, ["--from-handoff"], t.dir);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, "");
    seed(t.dir, { ...GATE, checkoutBinding: BINDING });
    r = run(FORMAT, ["--from-handoff", "--control-issue", "999"], t.dir);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, "");
    seed(t.dir, GATE); // findings correction with no reservation: formatter must refuse
    r = run(FORMAT, ["--from-handoff"], t.dir);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /checkoutBinding/);
    seed(t.dir, { ...GATE, state: "CHECKOUT_BINDING_UNVERIFIED" });
    r = run(FORMAT, ["--from-handoff"], t.dir);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, "");
  } finally {
    t.cleanup();
  }
});

test("format --from-handoff rejects a scriptPath that would break the quoted invocation", () => {
  const t = tmp();
  try {
    seed(t.dir, { ...GATE, checkoutBinding: { ...BINDING, scriptPath: 'C:\\x"; y' } });
    const r = run(FORMAT, ["--from-handoff"], t.dir);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, "");
  } finally {
    t.cleanup();
  }
});

test("reserve --from-handoff: fails closed with no handoff; an already-reserved handoff is returned unchanged, never reserved twice", () => {
  const t = tmp();
  try {
    let r = run(PREFLIGHT, ["--reserve-from-gate", "--from-handoff", "--repo", "o/r"], t.dir);
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, "");
    const reserved = { ...GATE, checkoutBinding: BINDING };
    seed(t.dir, reserved);
    r = run(PREFLIGHT, ["--reserve-from-gate", "--from-handoff", "--repo", "o/r", "--control-issue", "398"], t.dir);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), reserved);
    r = run(PREFLIGHT, ["--reserve-from-gate", "--from-handoff", "--repo", "o/r", "--control-issue", "1"], t.dir);
    assert.notEqual(r.status, 0);
  } finally {
    t.cleanup();
  }
});

test("reserve --from-handoff passes a non-reservable verdict through and persists it unchanged", () => {
  const t = tmp();
  try {
    const closing = { ...GATE, correctionReason: "closing-reference" };
    seed(t.dir, closing);
    const r = run(PREFLIGHT, ["--reserve-from-gate", "--from-handoff", "--repo", "o/r"], t.dir);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), closing);
    assert.deepEqual(JSON.parse(readFileSync(join(t.dir, "verdict-handoff.json"), "utf8")).verdict, closing);
  } finally {
    t.cleanup();
  }
});

test("action envelope: the handoff pipeline commands are allowed but a lifecycle-gate re-run is still denied after the bounded verdict", () => {
  const marker = {
    mode: "bounded",
    state: "STAGE1_CORRECTION_REQUIRED",
    authorizedActions: GATE.actionEnvelope.authorizedActions,
  };
  const bash = (command) => decidePreToolUse(marker, { toolName: "Bash", command }).permissionDecision;
  assert.equal(bash("node tools/orchestration/pr-head-checkout-preflight.mjs --reserve-from-gate --from-handoff"), "allow");
  assert.equal(bash("node tools/orchestration/format-dispatch-prompt.mjs --from-handoff"), "allow");
  assert.equal(bash("node tools/orchestration/session-entry-gate.mjs --control-issue 398"), "deny");
  assert.equal(bash("node tools/orchestration/next-review-transition-gate.mjs --control-issue 398"), "deny");
});
