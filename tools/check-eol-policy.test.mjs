#!/usr/bin/env node
// Regression guard for issue #470: this repository declares an explicit `.gitattributes`
// EOL policy so tracked text checks out with deterministic LF line endings regardless of
// a cloning machine's `core.autocrlf` setting. Without this guard, a future edit that
// removes or narrows the policy (e.g. deleting `.gitattributes`, or dropping `eol=lf`)
// would silently reintroduce the CRLF-checkout-dependent `stage2-report.test.mjs`
// module-load failure documented in docs/eol-policy-proof-runs.md, with nothing catching
// the regression until it reproduced again on a `core.autocrlf=true` machine.
//
// This exercises Git's own effective attribute resolution (`git check-attr`), not just
// the presence of a line in `.gitattributes`, so a policy that's present but no longer
// applies to the files that matter still fails this check.
//
// Run with: node --test tools/check-eol-policy.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GITATTRIBUTES = join(ROOT, ".gitattributes");

// The exact file whose LF-anchored parsing this policy exists to protect (issue #470's
// demonstrated reproduction: extractCanonicalSkeletonFence in stage2-report.test.mjs),
// plus a couple of other representative tracked text files/extensions.
const PROTECTED_FILES = [
  "docs/stage2-audit-contract.md",
  "tools/review-watch/stage2-report.test.mjs",
  "AGENTS.md",
  ".gitattributes",
];

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("`.gitattributes` exists and declares a repository-wide LF policy", () => {
  assert.ok(existsSync(GITATTRIBUTES), ".gitattributes is missing -- the repository EOL policy has been removed");
  const contents = readFileSync(GITATTRIBUTES, "utf8");
  assert.match(
    contents,
    /^\*\s+text=auto\s+eol=lf\s*$/m,
    "expected a `* text=auto eol=lf` rule in .gitattributes -- has the repo-wide policy been narrowed or removed?"
  );
});

for (const file of PROTECTED_FILES) {
  test(`git resolves ${file} to text=auto, eol=lf regardless of local core.autocrlf`, () => {
    assert.ok(existsSync(join(ROOT, file)), `${file} no longer exists -- update this regression guard's protected-file list`);
    // -c core.autocrlf=true simulates the exact developer-machine setting that originally
    // caused the CRLF checkout defect; the attribute policy must still resolve to eol=lf.
    const output = execFileSync("git", ["-c", "core.autocrlf=true", "check-attr", "text", "eol", "--", file], {
      cwd: ROOT,
      encoding: "utf8",
    });
    const escaped = escapeForRegExp(file);
    assert.match(output, new RegExp(`${escaped}: text: auto`), `expected ${file} to resolve text=auto; got:\n${output}`);
    assert.match(output, new RegExp(`${escaped}: eol: lf`), `expected ${file} to resolve eol=lf; got:\n${output}`);
  });
}

test("committed docs/stage2-audit-contract.md blob is LF-only (nothing for the checkout policy to fight against)", () => {
  const blob = execFileSync("git", ["show", "HEAD:docs/stage2-audit-contract.md"], { cwd: ROOT });
  assert.ok(!blob.includes("\r"), "committed blob contains CR bytes -- committed content should stay LF-only per issue #470's constraints");
});

test("committed tools/review-watch/stage2-report.test.mjs blob is LF-only", () => {
  const blob = execFileSync("git", ["show", "HEAD:tools/review-watch/stage2-report.test.mjs"], { cwd: ROOT });
  assert.ok(!blob.includes("\r"), "committed blob contains CR bytes -- committed content should stay LF-only per issue #470's constraints");
});
