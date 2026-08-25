// Tests for tools/mcp-server/config.mjs.
// Run with: node --test tools/mcp-server/config.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { delimiter } from "node:path";
import { resolveRepos } from "./config.mjs";

function withEnv(t, value, fn) {
  const previous = process.env.LDL_CONSUMER_REPOS;
  if (value === undefined) delete process.env.LDL_CONSUMER_REPOS;
  else process.env.LDL_CONSUMER_REPOS = value;
  t.after(() => {
    if (previous === undefined) delete process.env.LDL_CONSUMER_REPOS;
    else process.env.LDL_CONSUMER_REPOS = previous;
  });
  return fn();
}

test("resolveRepos: explicit non-empty array wins over the environment", (t) => {
  withEnv(t, "/env/repo-a", () => {
    assert.deepEqual(resolveRepos(["/explicit/repo"]), ["/explicit/repo"]);
  });
});

test("resolveRepos: an explicitly empty array is authoritative, not a fallback trigger", (t) => {
  withEnv(t, "/env/repo-a;/env/repo-b", () => {
    // Regression guard: an explicit `repos: []` must not silently expand back to every
    // environment-configured repository (Stage 1 review finding on PR #110).
    assert.deepEqual(resolveRepos([]), []);
  });
});

test("resolveRepos: omitted repos falls back to LDL_CONSUMER_REPOS", (t) => {
  withEnv(t, `/env/repo-a${delimiter}/env/repo-b`, () => {
    assert.deepEqual(resolveRepos(undefined), ["/env/repo-a", "/env/repo-b"]);
  });
});

test("resolveRepos: omitted repos with no env var set returns an empty array", (t) => {
  withEnv(t, undefined, () => {
    assert.deepEqual(resolveRepos(undefined), []);
  });
});
