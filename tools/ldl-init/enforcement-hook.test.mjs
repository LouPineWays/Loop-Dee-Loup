// Issue #799 Stage 2 correction (Audit #801 finding 1): proves an initialized AND an updated
// LDL-managed consumer has an active, merge-safe enforcement path for the raw thin-control
// Issue-body write guard. Uses this repository's REAL managed content (not a fixture) so the
// installed guard itself is what is exercised, via the exact hook command written to the
// consumer's .claude/settings.json.
// Run with: node --test tools/ldl-init/enforcement-hook.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENFORCEMENT_GUARD_DEST, ENFORCEMENT_HOOK_COMMAND, ensureEnforcementHook, run as ldlInit } from "./index.mjs";
import { run as ldlUpdate } from "../ldl-update/index.mjs";
import { CANONICAL_HOOK_COMMAND, isCanonicalHookOnlyChange, run as verifyScope } from "../ldl-sync/verify-scope.mjs";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "ldl-enforce-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const deps = { resolveRevisionImpl: () => "rev-real", now: () => "2026-09-30T00:00:00.000Z" };
const settingsOf = (dest) => JSON.parse(readFileSync(join(dest, ".claude", "settings.json"), "utf8"));
const guardEntries = (settings) =>
  (settings.hooks?.PreToolUse || []).filter((e) => (e.hooks || []).some((h) => h.command.includes("control-body-write-guard.mjs")));

// Runs the consumer's own installed hook exactly as its settings.json declares it.
function runInstalledHook(dest, command) {
  const hook = guardEntries(settingsOf(dest))[0].hooks[0].command;
  const script = hook.match(/"\$CLAUDE_PROJECT_DIR\/([^"]+)"/)[1];
  const r = spawnSync(process.execPath, [join(dest, ...script.split("/"))], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : { permissionDecision: "allow" };
}

test("fresh init wires an active hook that rejects a raw thin-control body write and allows the canonical writer", async (t) => {
  const dest = tempDir(t);
  const r = await ldlInit({ dest }, deps);
  assert.equal(r.exitCode, 0, r.message);
  assert.equal(JSON.parse(r.message).enforcementHook, "installed");
  const settings = settingsOf(dest);
  assert.equal(guardEntries(settings).length, 1);
  assert.equal(guardEntries(settings)[0].matcher, "Bash");

  const denied = runInstalledHook(dest, "gh issue edit 726 --body-file body.md");
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /write-control-snapshot\.mjs/);
  assert.equal(runInstalledHook(dest, "node tools/orchestration/write-control-snapshot.mjs --control-issue 726 --body-file -").permissionDecision, "allow");
  assert.equal(runInstalledHook(dest, "gh issue edit 726 --add-label priority:now").permissionDecision, "allow");
});

test("init preserves pre-existing consumer-owned settings and is idempotent", async (t) => {
  const dest = tempDir(t);
  mkdirSync(join(dest, ".claude"), { recursive: true });
  const mine = {
    statusLine: { type: "command", command: "echo mine" },
    permissions: { allow: ["Bash(npm test)"] },
    hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo guard-write" }] }], Stop: [{ hooks: [{ type: "command", command: "echo stop" }] }] },
  };
  writeFileSync(join(dest, ".claude", "settings.json"), JSON.stringify(mine, null, 2));
  assert.equal(JSON.parse((await ldlInit({ dest }, deps)).message).enforcementHook, "installed");
  const after = settingsOf(dest);
  assert.deepEqual(after.statusLine, mine.statusLine);
  assert.deepEqual(after.permissions, mine.permissions);
  assert.deepEqual(after.hooks.Stop, mine.hooks.Stop);
  assert.deepEqual(after.hooks.PreToolUse[0], mine.hooks.PreToolUse[0]);
  assert.equal(guardEntries(after).length, 1);

  const before = readFileSync(join(dest, ".claude", "settings.json"), "utf8");
  assert.equal(JSON.parse((await ldlInit({ dest }, deps)).message).enforcementHook, "already-present");
  assert.equal(readFileSync(join(dest, ".claude", "settings.json"), "utf8"), before);
});

test("update wires the hook into a consumer initialized before it existed, without touching other settings", async (t) => {
  const dest = tempDir(t);
  await ldlInit({ dest }, deps);
  // Simulate an older install: guard file present, hook entry absent, consumer-owned keys present.
  writeFileSync(join(dest, ".claude", "settings.json"), JSON.stringify({ model: "mine", hooks: { PreToolUse: [] } }));
  const r = await ldlUpdate({ dest }, deps);
  assert.equal(r.exitCode, 0, r.message);
  assert.equal(JSON.parse(r.message).enforcementHook, "installed");
  const s = settingsOf(dest);
  assert.equal(s.model, "mine");
  assert.equal(guardEntries(s).length, 1);
  assert.equal(runInstalledHook(dest, "gh api repos/o/r/issues/1 -X PATCH -f body=x").permissionDecision, "deny");
  assert.equal(JSON.parse((await ldlUpdate({ dest }, deps)).message).enforcementHook, "already-present");
});

test("unparseable or unexpectedly shaped consumer settings are left untouched and reported, never overwritten", (t) => {
  for (const content of ["{ not json", "[]", JSON.stringify({ hooks: [] }), JSON.stringify({ hooks: { PreToolUse: {} } })]) {
    const dest = tempDir(t);
    mkdirSync(join(dest, ".claude"), { recursive: true });
    mkdirSync(join(dest, ...ENFORCEMENT_GUARD_DEST.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(dest, ...ENFORCEMENT_GUARD_DEST.split("/")), "// stub\n");
    writeFileSync(join(dest, ".claude", "settings.json"), content);
    const r = ensureEnforcementHook(dest, { guardManaged: true });
    assert.equal(r.status, "skipped", content);
    assert.match(r.reason, /by hand/);
    assert.equal(readFileSync(join(dest, ".claude", "settings.json"), "utf8"), content);
  }
});

test("hook command shape matches this repository's own wiring", () => {
  const own = JSON.parse(readFileSync(new URL("../../.claude/settings.json", import.meta.url), "utf8"));
  assert.ok(own.hooks.PreToolUse.some((e) => e.matcher === "Bash" && e.hooks.some((h) => h.command === ENFORCEMENT_HOOK_COMMAND)));
});

const guardFile = (dest) => join(dest, ...ENFORCEMENT_GUARD_DEST.split("/"));

test("pre-guard upgrade: one update installs the guard file AND the canonical active hook", async (t) => {
  const dest = tempDir(t);
  await ldlInit({ dest }, deps);
  // Simulate a consumer initialized before the guard existed: no guard file, no manifest record, no settings.
  rmSync(guardFile(dest));
  rmSync(join(dest, ".claude", "settings.json"));
  const mPath = join(dest, ".ldl", "manifest.json");
  const m = JSON.parse(readFileSync(mPath, "utf8"));
  m.files = m.files.filter((f) => f.dest !== ENFORCEMENT_GUARD_DEST);
  writeFileSync(mPath, JSON.stringify(m, null, 2));
  const r = await ldlUpdate({ dest }, deps);
  assert.equal(r.exitCode, 0, r.message);
  assert.equal(JSON.parse(r.message).enforcementHook, "installed");
  assert.equal(guardEntries(settingsOf(dest)).length, 1);
  assert.equal(runInstalledHook(dest, "gh issue edit 726 --body-file b.md").permissionDecision, "deny");
});

test("unmanaged collision at the guard destination is never wired or reported active", async (t) => {
  const dest = tempDir(t);
  mkdirSync(join(dest, ...ENFORCEMENT_GUARD_DEST.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(guardFile(dest), "// consumer file, not LDL\n");
  const r = await ldlInit({ dest }, deps);
  assert.equal(r.exitCode, 0, r.message);
  const out = JSON.parse(r.message);
  assert.equal(out.enforcementHook, "skipped");
  assert.ok(out.warnings.some((w) => /not wired/.test(w)));
  assert.equal(readFileSync(guardFile(dest), "utf8"), "// consumer file, not LDL\n");
  let hasHook = false;
  try {
    hasHook = guardEntries(settingsOf(dest)).length > 0;
  } catch {
    /* no settings written */
  }
  assert.equal(hasHook, false);
  // A later update must not wire it either.
  const u = JSON.parse((await ldlUpdate({ dest }, deps)).message);
  assert.equal(u.enforcementHook, "skipped");
});

test("hook lookalikes do not satisfy already-present; the canonical hook does", (t) => {
  const mk = (preToolUse) => {
    const dest = tempDir(t);
    mkdirSync(join(dest, ".claude"), { recursive: true });
    mkdirSync(join(dest, ...ENFORCEMENT_GUARD_DEST.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(guardFile(dest), "// stub\n");
    writeFileSync(join(dest, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: preToolUse } }));
    return dest;
  };
  const cmd = ENFORCEMENT_HOOK_COMMAND;
  const lookalikes = [
    [{ matcher: "Write", hooks: [{ type: "command", command: cmd }] }],
    [{ matcher: "Bash", hooks: [{ type: "prompt", command: cmd }] }],
    [{ matcher: "Bash", hooks: [{ type: "command", command: "echo control-body-write-guard.mjs" }] }],
  ];
  for (const l of lookalikes) {
    const dest = mk(l);
    assert.equal(ensureEnforcementHook(dest, { guardManaged: true }).status, "installed", JSON.stringify(l));
    assert.equal(settingsOf(dest).hooks.PreToolUse.length, 2);
  }
  const ok = mk([{ matcher: "Bash", hooks: [{ type: "command", command: cmd }] }]);
  assert.equal(ensureEnforcementHook(ok, { guardManaged: true }).status, "already-present");
});

test("symlinked .claude or .claude/settings.json is never written through", (t) => {
  const outside = tempDir(t);
  writeFileSync(join(outside, "settings.json"), JSON.stringify({ keep: true }));
  const prep = () => {
    const dest = tempDir(t);
    mkdirSync(join(dest, ...ENFORCEMENT_GUARD_DEST.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(guardFile(dest), "// stub\n");
    return dest;
  };
  try {
    const d1 = prep();
    symlinkSync(outside, join(d1, ".claude"), "junction");
    assert.equal(ensureEnforcementHook(d1, { guardManaged: true }).status, "skipped");
    const d2 = prep();
    mkdirSync(join(d2, ".claude"));
    symlinkSync(join(outside, "settings.json"), join(d2, ".claude", "settings.json"), "file");
    assert.equal(ensureEnforcementHook(d2, { guardManaged: true }).status, "skipped");
  } catch (err) {
    if (err.code === "EPERM") return t.skip("symlink creation not permitted on this host");
    throw err;
  }
  assert.deepEqual(JSON.parse(readFileSync(join(outside, "settings.json"), "utf8")), { keep: true });
});

test("verify-scope accepts exactly the canonical hook mutation of consumer-owned settings and nothing else", () => {
  assert.equal(CANONICAL_HOOK_COMMAND, ENFORCEMENT_HOOK_COMMAND);
  const entry = { matcher: "Bash", hooks: [{ type: "command", command: ENFORCEMENT_HOOK_COMMAND }] };
  assert.equal(isCanonicalHookOnlyChange(null, { hooks: { PreToolUse: [entry] } }), true);
  const mine = { model: "x", hooks: { PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo" }] }], Stop: [] } };
  const withHook = JSON.parse(JSON.stringify(mine));
  withHook.hooks.PreToolUse.push(entry);
  assert.equal(isCanonicalHookOnlyChange(mine, withHook), true);
  // Unrelated consumer-owned change alongside the hook, a non-canonical entry, or a missing hook: rejected.
  assert.equal(isCanonicalHookOnlyChange(mine, { ...withHook, model: "y" }), false);
  assert.equal(isCanonicalHookOnlyChange(null, { model: "y", hooks: { PreToolUse: [entry] } }), false);
  assert.equal(isCanonicalHookOnlyChange(mine, { ...mine, extra: 1 }), false);
  assert.equal(isCanonicalHookOnlyChange(null, { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "evil" }] }] } }), false);
  assert.equal(isCanonicalHookOnlyChange(null, { hooks: { PreToolUse: [{ ...entry, extra: 1 }] } }), false);

  const mkRun = (paths, pair) =>
    verifyScope(
      { dest: "x" },
      {
        readFileImpl: () => JSON.stringify({ files: [{ dest: "AGENTS.md" }] }),
        gitChangedPathsImpl: () => paths,
        readSettingsPairImpl: () => {
          if (pair === null) throw new Error("unreadable");
          return pair;
        },
      },
    );
  assert.equal(mkRun([".ldl/manifest.json", "AGENTS.md", ".claude/settings.json"], { before: null, after: { hooks: { PreToolUse: [entry] } } }).exitCode, 0);
  assert.equal(mkRun([".claude/settings.json"], { before: mine, after: { ...withHook, model: "y" } }).exitCode, 1);
  assert.equal(mkRun(["src/x.js"], { before: null, after: {} }).exitCode, 1);
  assert.equal(mkRun([".claude/settings.json"], null).exitCode, 1); // unreadable -> fail closed
});

test("CI reachability: the control-plane workflow executes this suite", () => {
  const wf = readFileSync(new URL("../../.github/workflows/control-plane-paths.yml", import.meta.url), "utf8");
  assert.match(wf, /node --test tools\/ldl-init\/enforcement-hook\.test\.mjs/);
});
