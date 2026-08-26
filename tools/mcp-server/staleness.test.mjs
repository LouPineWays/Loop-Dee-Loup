// Tests for tools/mcp-server/staleness.mjs (issue #146). server.test.mjs's own
// "process coherence" tests exercise this through the real MCP protocol surface; these tests
// exercise implementationFingerprint() directly and cheaply.
//
// Run with: node --test tools/mcp-server/staleness.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { IMPLEMENTATION_FILES, implementationFingerprint } from "./staleness.mjs";

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "ldl-staleness-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeImplementationFiles(root, tag) {
  for (const relPath of IMPLEMENTATION_FILES) {
    const abs = join(root, ...relPath.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `fixture implementation content (${tag}): ${relPath}\n`);
  }
}

test("implementationFingerprint is deterministic for unchanged content", (t) => {
  const root = tempDir(t);
  writeImplementationFiles(root, "a");
  assert.equal(implementationFingerprint(root), implementationFingerprint(root));
});

test("implementationFingerprint changes when any one implementation file's content changes", (t) => {
  const root = tempDir(t);
  writeImplementationFiles(root, "a");
  const before = implementationFingerprint(root);

  const changedFile = join(root, ...IMPLEMENTATION_FILES[0].split("/"));
  writeFileSync(changedFile, "changed content\n");

  assert.notEqual(implementationFingerprint(root), before);
});

test("implementationFingerprint does not throw when an implementation file is missing, and differs from the present case", (t) => {
  const rootWithFiles = tempDir(t);
  writeImplementationFiles(rootWithFiles, "a");
  const present = implementationFingerprint(rootWithFiles);

  const rootMissing = tempDir(t);
  // Intentionally leave rootMissing empty — none of IMPLEMENTATION_FILES exist under it.
  const missing = implementationFingerprint(rootMissing);

  assert.notEqual(present, missing);
});

test("implementationFingerprint is unaffected by unrelated files elsewhere under root", (t) => {
  const root = tempDir(t);
  writeImplementationFiles(root, "a");
  const before = implementationFingerprint(root);

  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "unrelated.md"), "not part of the synchronization implementation\n");

  assert.equal(implementationFingerprint(root), before);
});
