// Issue #799 Stage 2 correction (Audit #801 finding 1): proves an initialized AND an updated
// LDL-managed consumer has an active, merge-safe enforcement path for the raw thin-control
// Issue-body write guard. Uses this repository's REAL managed content (not a fixture) so the
// installed guard itself is what is exercised, via the exact hook command written to the
// consumer's .claude/settings.json.
// Run with: node --test tools/ldl-init/enforcement-hook.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENFORCEMENT_GUARD_DEST, ENFORCEMENT_HOOK_COMMAND, ensureEnforcementHook, run as ldlInit } from "./index.mjs";
import { run as ldlUpdate } from "../ldl-update/index.mjs";

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
    const r = ensureEnforcementHook(dest);
    assert.equal(r.status, "skipped", content);
    assert.match(r.reason, /by hand/);
    assert.equal(readFileSync(join(dest, ".claude", "settings.json"), "utf8"), content);
  }
});

test("hook command shape matches this repository's own wiring", () => {
  const own = JSON.parse(readFileSync(new URL("../../.claude/settings.json", import.meta.url), "utf8"));
  assert.ok(own.hooks.PreToolUse.some((e) => e.matcher === "Bash" && e.hooks.some((h) => h.command === ENFORCEMENT_HOOK_COMMAND)));
});
