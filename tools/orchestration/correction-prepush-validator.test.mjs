// Tests for tools/orchestration/correction-prepush-validator.mjs and the action-envelope hook's
// pre-publication correction guard (issue #964, control #963; live #951 / #950 / PR #962).
//
// Run with: node --test tools/orchestration/correction-prepush-validator.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyGitPushCommand, validateCorrectionRange } from "./correction-prepush-validator.mjs";
import { decideCorrectionPrePush } from "./action-envelope-hook.mjs";

function repoWith(messages) {
  const dir = mkdtempSync(join(tmpdir(), "ldl-prepush-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "f"), "0");
  git("add", "f");
  git("commit", "-q", "-m", "base");
  const reviewed = git("rev-parse", "HEAD");
  messages.forEach((m, i) => {
    writeFileSync(join(dir, "f"), String(i + 1));
    git("commit", "-q", "-am", m);
  });
  return { dir, reviewed, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function check(messages, issue = 950) {
  const r = repoWith(messages);
  try {
    return await validateCorrectionRange({ executionIssue: issue, reviewedHead: r.reviewed, cwd: r.dir });
  } finally {
    r.cleanup();
  }
}

test("#962 reproduction: `Fix #950 ...` is denied pre-push; `Address #950 ...` passes", async () => {
  const bad = await check(["Fix #950 predecessor head validation for audit #961"]);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /auto-close keyword/);
  const good = await check(["Address #950 predecessor head validation for audit #961"]);
  assert.equal(good.ok, true);
});

test("every closing spelling, case variant, and qualified form is denied", async () => {
  const forms = ["Fix", "Fixes", "Fixed", "Close", "Closes", "Closed", "Resolve", "Resolves", "Resolved", "FIXES", "resolved:", "Fixes owner/repo"];
  for (const f of forms) {
    const r = await check([`${f} #950 thing`]);
    assert.equal(r.ok, false, f);
  }
});

test("closing keyword for a different Issue does not trigger; non-closing forms allowed", async () => {
  assert.equal((await check(["Address #950 and fixes #12"])).ok, true);
  assert.equal((await check(["Implements #950"])).ok, true);
});

test("provenance: missing token, prefix collisions, body token, wrong number", async () => {
  assert.equal((await check(["no reference at all"])).ok, false);
  assert.equal((await check(["Address #9500"])).ok, false);
  assert.equal((await check(["Address #950abc"])).ok, false);
  assert.equal((await check(["Address #951"])).ok, false);
  assert.equal((await check(["subject only\n\nAddresses #950 in the body"])).ok, true);
});

test("multi-commit range: invalid middle commit denied and identified", async () => {
  const r = repoWith(["Address #950 a", "Fixes #950 b", "Address #950 c"]);
  try {
    const out = await validateCorrectionRange({ executionIssue: 950, reviewedHead: r.reviewed, cwd: r.dir });
    assert.equal(out.ok, false);
    assert.equal(out.offenders.length, 1);
    assert.match(out.reason, /auto-close/);
  } finally {
    r.cleanup();
  }
});

test("fail closed: bad reviewed head, empty range, non-repo cwd, git failure", async () => {
  const r = repoWith(["Address #950 a"]);
  try {
    assert.equal((await validateCorrectionRange({ executionIssue: 950, reviewedHead: "deadbeef", cwd: r.dir })).ok, false);
    assert.equal((await validateCorrectionRange({ executionIssue: 950, reviewedHead: "HEAD", cwd: r.dir })).ok, false);
    assert.equal((await validateCorrectionRange({ executionIssue: 950, reviewedHead: r.reviewed, cwd: join(r.dir, "nope") })).ok, false);
    assert.equal(
      (await validateCorrectionRange({ executionIssue: 950, reviewedHead: r.reviewed, cwd: r.dir, gitImpl: () => { throw new Error("boom"); } })).ok,
      false,
    );
  } finally {
    r.cleanup();
  }
});

test("truncated enumeration fails closed", async () => {
  const r = repoWith(["Address #950 a", "Address #950 b"]);
  try {
    const gitImpl = (args, { cwd }) => {
      if (args[0] === "rev-list") return "5\n";
      return execFileSync("git", args, { cwd, encoding: "utf8" });
    };
    const out = await validateCorrectionRange({ executionIssue: 950, reviewedHead: r.reviewed, cwd: r.dir, gitImpl });
    assert.equal(out.ok, false);
    assert.match(out.reason, /incomplete/);
  } finally {
    r.cleanup();
  }
});

test("classifyGitPushCommand: plain, chained, wrapped, and non-push commands", () => {
  assert.equal(classifyGitPushCommand("git status", { baseCwd: "/x" }).push, false);
  assert.equal(classifyGitPushCommand('git commit -m "fix push bug"', { baseCwd: "/x" }).push, false);
  assert.equal(classifyGitPushCommand('echo "git push"', { baseCwd: "/x" }).push, false);
  const p = classifyGitPushCommand("git push -u origin HEAD:refs/heads/b", { baseCwd: "/x" });
  assert.deepEqual(p.pushes, [{ cwd: "/x", candidate: "HEAD" }]);
  const chained = classifyGitPushCommand("git add . && git commit -m x && git push origin HEAD:b", { baseCwd: "/x" });
  assert.equal(chained.push, true);
  assert.equal(chained.classifiable, true);
  assert.equal(classifyGitPushCommand("git -C /repo push origin feat", { baseCwd: "/x" }).pushes[0].cwd, "/repo");
  assert.equal(classifyGitPushCommand("cd sub && git push origin HEAD:b", { baseCwd: "/x" }).pushes[0].cwd, "/x/sub");
  for (const c of ['bash -c "git push"', "eval 'git push'", "git push --all", "git push origin a b", "git push origin :gone", "cd $D && git push origin HEAD:b",
    "git push", "git push origin", "git push -f origin HEAD:b", "git push --force origin HEAD:b", "git push --force-with-lease origin HEAD:b",
    "git push origin +HEAD:b", "git push -fu origin HEAD:b", "git --git-dir /bad/.git push origin HEAD:b", "git --work-tree=/w push origin HEAD:b",
    "GIT_DIR=/bad/.git git push origin HEAD:b", "git -c remote.origin.push=bad:pr push origin"]) {
    const out = classifyGitPushCommand(c, { baseCwd: "/x" });
    assert.equal(out.push, true, c);
    assert.equal(out.classifiable, false, c);
  }
});

test("classifyGitPushCommand: shell-expanded git subcommand is unclassifiable push intent (Audit #1027)", () => {
  for (const c of [
    'S=push; git "$S" origin HEAD:branch',
    "S=push; git $S origin HEAD:branch",
    'P=pu; git "${P}sh" origin HEAD:branch',
    'S=push && git -C /repo "$S" origin HEAD:b',
    'git $(printf %s pu sh) origin HEAD:branch',
    'git -C /repo $(printf %s pu sh) origin HEAD:b',
    'git "$(printf %s pu sh)" origin HEAD:b',
    'git p$(printf %s ush) origin HEAD:b',
    'git `printf %s pu sh` origin HEAD:b',
  ]) {
    const out = classifyGitPushCommand(c, { baseCwd: "/x" });
    assert.equal(out.push, true, c);
    assert.equal(out.classifiable, false, c);
  }
  assert.equal(classifyGitPushCommand('git commit -m "$MSG"', { baseCwd: "/x" }).push, false);
  assert.equal(classifyGitPushCommand('git -C "$D" status', { baseCwd: "/x" }).push, false);
  assert.equal(classifyGitPushCommand('git status "$(date)"', { baseCwd: "/x" }).push, false);
  assert.equal(classifyGitPushCommand("git status `date`", { baseCwd: "/x" }).push, false);
});

test("classifyGitPushCommand: continuations and subshell scope", () => {
  const cont = classifyGitPushCommand("git \\\n push origin HEAD:b", { baseCwd: "/x" });
  assert.equal(cont.classifiable, true);
  assert.deepEqual(cont.pushes, [{ cwd: "/x", candidate: "HEAD" }]);
  const sub = classifyGitPushCommand("(cd /safe); git push origin HEAD:b", { baseCwd: "/x" });
  assert.deepEqual(sub.pushes, [{ cwd: "/x", candidate: "HEAD" }]);
  const inner = classifyGitPushCommand("(cd /safe && git push origin HEAD:b)", { baseCwd: "/x" });
  assert.deepEqual(inner.pushes, [{ cwd: "/safe", candidate: "HEAD" }]);
  const subst = classifyGitPushCommand("echo $(cd /safe); git push origin HEAD:b", { baseCwd: "/x" });
  assert.deepEqual(subst.pushes, [{ cwd: "/x", candidate: "HEAD" }]);
});

const marker = {
  mode: "none",
  correctionCompletion: { pr: 962, controlIssue: 951, executionIssue: 950, reviewedHead: "a".repeat(40), workerAgentId: "w1", blocks: 0 },
};

test("hook guard: only the bound worker's Bash push is evaluated", async () => {
  const validateImpl = async () => ({ ok: false, reason: "bad" });
  const call = (o) => decideCorrectionPrePush(marker, { toolName: "Bash", command: "git push", agentId: "w1", cwd: "/x", ...o }, { validateImpl });
  assert.equal((await call({})).permissionDecision, "deny");
  assert.equal((await call({ agentId: "helper" })).applies, false);
  assert.equal((await call({ agentId: undefined })).applies, false);
  assert.equal((await call({ command: "git status" })).applies, false);
  assert.equal((await call({ toolName: "Read" })).applies, false);
  assert.equal(
    (await decideCorrectionPrePush({ mode: "none" }, { toolName: "Bash", command: "git push", agentId: "w1" }, { validateImpl })).applies,
    false,
  );
  const unbound = { correctionCompletion: { ...marker.correctionCompletion, workerAgentId: undefined } };
  assert.equal((await decideCorrectionPrePush(unbound, { toolName: "Bash", command: "git push", agentId: "w1" }, { validateImpl })).applies, false);
});

test("hook guard: compound/unclassifiable push denied; valid push allowed; denial never directs force-push", async () => {
  const ok = async () => ({ ok: true });
  const base = { toolName: "Bash", agentId: "w1", cwd: "/x" };
  const allow = await decideCorrectionPrePush(marker, { ...base, command: "git push origin HEAD" }, { validateImpl: ok });
  assert.equal(allow.permissionDecision, "allow");
  const chained = await decideCorrectionPrePush(marker, { ...base, command: "npm test && git push" }, { validateImpl: async () => ({ ok: false, reason: "r" }) });
  assert.equal(chained.permissionDecision, "deny");
  const wrapped = await decideCorrectionPrePush(marker, { ...base, command: 'sh -c "git push"' }, { validateImpl: ok });
  assert.equal(wrapped.permissionDecision, "deny");
  assert.match(wrapped.permissionDecisionReason, /Do not force-push/);
  assert.match(wrapped.permissionDecisionReason, /Address #950/);
  const substitution = await decideCorrectionPrePush(marker, { ...base, command: "git $(printf %s pu sh) origin HEAD:b" }, { validateImpl: ok });
  assert.equal(substitution.permissionDecision, "deny");
});

test("hook guard end-to-end on a real repo: #962 message denied, reworded allowed", async () => {
  for (const [msg, expected] of [
    ["Fix #950 predecessor head validation for audit #961", "deny"],
    ["Address #950 predecessor head validation for audit #961", "allow"],
  ]) {
    const r = repoWith([msg]);
    try {
      const m = { correctionCompletion: { ...marker.correctionCompletion, reviewedHead: r.reviewed } };
      const out = await decideCorrectionPrePush(m, { toolName: "Bash", command: "git push origin HEAD:b", agentId: "w1", cwd: r.dir });
      assert.equal(out.permissionDecision, expected);
    } finally {
      r.cleanup();
    }
  }
});
