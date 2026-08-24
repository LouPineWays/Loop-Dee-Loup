// Tests for tools/telemetry/collect.mjs's shared helpers: identity extraction, session-id
// sanitization (path-traversal defense), and the append/read round-trip. Run with:
//   node --test tools/telemetry/collect.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("extractIdentity keeps only coarse identifiers, never full paths or prompt content", async () => {
  const { extractIdentity } = await import("./collect.mjs");
  const identity = extractIdentity({
    session_id: "abc-123",
    cwd: "C:\\Users\\someone\\projects\\example-repo",
    workspace: { repo: { owner: "LouPineWays", name: "example-repo" } },
    prompt: "this must never be copied anywhere",
  });
  assert.equal(identity.session_id, "abc-123");
  assert.equal(identity.cwd_basename, "example-repo");
  assert.deepEqual(identity.repo, { owner: "LouPineWays", name: "example-repo" });
  assert.equal("prompt" in identity, false);
  assert.equal(JSON.stringify(identity).includes("someone"), false);
});

test("extractIdentity tolerates a missing/malformed payload", async () => {
  const { extractIdentity } = await import("./collect.mjs");
  assert.deepEqual(extractIdentity({}), { session_id: null, repo: null, cwd_basename: null });
  assert.deepEqual(extractIdentity({ workspace: { repo: { owner: "x" } } }), {
    session_id: null,
    repo: null,
    cwd_basename: null,
  });
});

test("crossPlatformBasename handles both separators regardless of host OS", async () => {
  const { crossPlatformBasename } = await import("./collect.mjs");
  assert.equal(crossPlatformBasename("C:\\a\\b\\repo"), "repo");
  assert.equal(crossPlatformBasename("/a/b/repo"), "repo");
  assert.equal(crossPlatformBasename(""), null);
  assert.equal(crossPlatformBasename(undefined), null);
});

test("sanitizeSessionId strips characters that could path-traverse out of the telemetry dir", async () => {
  const { sanitizeSessionId } = await import("./collect.mjs");
  assert.equal(sanitizeSessionId("../../etc/passwd"), ".._.._etc_passwd");
  assert.equal(sanitizeSessionId("normal-session-id_123"), "normal-session-id_123");
});

test("appendEvent + readSessionEvents round-trip through an isolated telemetry dir", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-telemetry-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.LDL_TELEMETRY_DIR = dir;
  // collect.mjs reads LDL_TELEMETRY_DIR at import time, so import fresh with the env set.
  const collect = await import(`./collect.mjs?isolate=${Date.now()}`);

  const wrote = collect.appendEvent("session-1", { kind: "hook", event: "SessionStart" });
  assert.equal(wrote, true);
  const events = collect.readSessionEvents("session-1");
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "SessionStart");

  collect.appendEvent("session-1", { kind: "hook", event: "SessionEnd" });
  assert.equal(collect.readSessionEvents("session-1").length, 2);

  delete process.env.LDL_TELEMETRY_DIR;
});

test("appendEvent is a no-op without a session id, and readSessionEvents returns [] for an unknown session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-telemetry-test-"));
  process.env.LDL_TELEMETRY_DIR = dir;
  const collect = await import(`./collect.mjs?isolate=${Date.now()}`);
  assert.equal(collect.appendEvent(null, { kind: "hook" }), false);
  assert.deepEqual(collect.readSessionEvents("never-seen"), []);
  rmSync(dir, { recursive: true, force: true });
  delete process.env.LDL_TELEMETRY_DIR;
});
