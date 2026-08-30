// Tests for tools/ldl-sync/verify-scope.mjs. All git/filesystem access is faked via the
// injected `gitChangedPathsImpl`/`readFileImpl` options — never touch the real filesystem or
// git here. Run with:
//   node --test tools/ldl-sync/verify-scope.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findUnexpectedPaths, parseArgs, run } from "./verify-scope.mjs";

const MODULE_PATH = fileURLToPath(import.meta.url).replace(/\.test\.mjs$/, ".mjs");

test("findUnexpectedPaths: allows .ldl/manifest.json even though it's never in the manifest's own files list", () => {
  const unexpected = findUnexpectedPaths([".ldl/manifest.json", "AGENTS.md"], ["AGENTS.md"]);
  assert.deepEqual(unexpected, []);
});

test("findUnexpectedPaths: allows every path the new manifest itself claims as managed", () => {
  const unexpected = findUnexpectedPaths(
    [".ldl/manifest.json", "AGENTS.md", "docs/consumer-contract.md"],
    ["AGENTS.md", "docs/consumer-contract.md"],
  );
  assert.deepEqual(unexpected, []);
});

test("findUnexpectedPaths: flags a changed path outside both the manifest sentinel and the managed set", () => {
  const unexpected = findUnexpectedPaths([".ldl/manifest.json", "AGENTS.md", "src/some-feature/notes.md"], ["AGENTS.md"]);
  assert.deepEqual(unexpected, ["src/some-feature/notes.md"]);
});

test("findUnexpectedPaths: allows a superseded bridge template's deletion even though the new manifest no longer lists it (Stage 1 review finding on PR #219)", () => {
  // A consumer-owned AGENTS.md that used to force .ldl/AGENTS.template.md parking was removed
  // (or now matches content), so this update installs straight to AGENTS.md and deletes the
  // now-superseded template — dropping it from the new manifest's files[] entirely, by design.
  const unexpected = findUnexpectedPaths([".ldl/manifest.json", "AGENTS.md", ".ldl/AGENTS.template.md"], ["AGENTS.md"]);
  assert.deepEqual(unexpected, []);
});

test("findUnexpectedPaths: allows any other .ldl/ path to change, not only manifest.json and templates", () => {
  const unexpected = findUnexpectedPaths([".ldl/some-future-ldl-owned-file.json"], []);
  assert.deepEqual(unexpected, []);
});

test("findUnexpectedPaths: returns every unexpected path, not just the first", () => {
  const unexpected = findUnexpectedPaths(["a.txt", "b.txt", "AGENTS.md"], ["AGENTS.md"]);
  assert.deepEqual(unexpected, ["a.txt", "b.txt"]);
});

test("parseArgs: defaults --dest to the current directory", () => {
  assert.deepEqual(parseArgs([]), { dest: "." });
});

test("parseArgs: reads an explicit --dest", () => {
  assert.deepEqual(parseArgs(["--dest", "self"]), { dest: "self" });
});

test("run: exits 0 when every changed path is accounted for", () => {
  const manifest = { files: [{ dest: "AGENTS.md" }, { dest: "docs/consumer-contract.md" }] };
  const result = run(
    { dest: "self" },
    {
      readFileImpl: () => JSON.stringify(manifest),
      gitChangedPathsImpl: () => [".ldl/manifest.json", "AGENTS.md"],
    },
  );
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.message), { ok: true, changed: 2 });
});

test("run: exits 1 and names every unexpected path when the diff exceeds the managed set", () => {
  const manifest = { files: [{ dest: "AGENTS.md" }] };
  const result = run(
    { dest: "self" },
    {
      readFileImpl: () => JSON.stringify(manifest),
      gitChangedPathsImpl: () => [".ldl/manifest.json", "AGENTS.md", "assets/banner.png"],
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /assets\/banner\.png/);
});

test("run: exits 1 when the manifest can't be read", () => {
  const result = run(
    { dest: "self" },
    {
      readFileImpl: () => {
        throw new Error("ENOENT");
      },
      gitChangedPathsImpl: () => [],
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /failed reading/);
});

test("run: exits 1 when git status can't be read", () => {
  const manifest = { files: [] };
  const result = run(
    { dest: "self" },
    {
      readFileImpl: () => JSON.stringify(manifest),
      gitChangedPathsImpl: () => {
        throw new Error("not a git repository");
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /failed reading git status/);
});

test("run: defaults --dest to the current directory when omitted", () => {
  const manifest = { files: [{ dest: "AGENTS.md" }] };
  let seenDest;
  const result = run(
    {},
    {
      readFileImpl: () => JSON.stringify(manifest),
      gitChangedPathsImpl: (dest) => {
        seenDest = dest;
        return [".ldl/manifest.json"];
      },
    },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(seenDest, ".");
});

test("entrypoint guard: importing this module from a script whose own path also ends in 'verify-scope.mjs' must not trigger main() (Stage 1 review finding on PR #219)", () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-scope-entrypoint-test-"));
  try {
    const importerPath = join(dir, "custom-verify-scope.mjs");
    writeFileSync(importerPath, `import ${JSON.stringify(pathToFileURL(MODULE_PATH).href)};\nconsole.log("imported ok");\n`);
    const output = execFileSync(process.execPath, [importerPath], { encoding: "utf8" });
    assert.equal(output.trim(), "imported ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
