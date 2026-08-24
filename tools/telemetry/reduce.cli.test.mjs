// End-to-end test for tools/telemetry/reduce.mjs's CLI entry point: writes fixture events
// through the real append path, then runs the reducer as a subprocess and checks both the
// stdout JSON and the on-disk record file it writes. The pure-logic cases already live in
// reduce.test.mjs against fixtures directly; this file only covers the CLI plumbing (argv,
// stdout, --out). Run with:
//   node --test tools/telemetry/reduce.cli.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REDUCE_PATH = join(HERE, "reduce.mjs");
const FIXTURE = readFileSync(join(HERE, "fixtures", "normal.jsonl"), "utf8");

function setUpTelemetryDir() {
  const dir = mkdtempSync(join(tmpdir(), "ldl-telemetry-reduce-cli-test-"));
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, "fixture-normal-0001.jsonl"), FIXTURE, "utf8");
  return dir;
}

test("reduce.mjs prints the record to stdout and writes it under records/<session_id>.json by default", () => {
  const dir = setUpTelemetryDir();
  try {
    const result = spawnSync(process.execPath, [REDUCE_PATH, "fixture-normal-0001"], {
      encoding: "utf8",
      env: { ...process.env, LDL_TELEMETRY_DIR: dir },
    });
    assert.equal(result.status, 0);
    const printed = JSON.parse(result.stdout);
    assert.equal(printed.measured.identity.session_id, "fixture-normal-0001");

    const written = JSON.parse(readFileSync(join(dir, "records", "fixture-normal-0001.json"), "utf8"));
    assert.deepEqual(written.measured, printed.measured);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reduce.mjs --out writes to the given path instead of the default records dir", () => {
  const dir = setUpTelemetryDir();
  const outPath = join(dir, "custom-out.json");
  try {
    const result = spawnSync(process.execPath, [REDUCE_PATH, "fixture-normal-0001", "--out", outPath], {
      encoding: "utf8",
      env: { ...process.env, LDL_TELEMETRY_DIR: dir },
    });
    assert.equal(result.status, 0);
    const written = JSON.parse(readFileSync(outPath, "utf8"));
    assert.equal(written.measured.identity.session_id, "fixture-normal-0001");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reduce.mjs with no session id argument exits non-zero with a usage message", () => {
  const result = spawnSync(process.execPath, [REDUCE_PATH], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: node tools\/telemetry\/reduce\.mjs/);
});

test("reduce.mjs for a session with no raw log produces an all-null record rather than failing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-telemetry-reduce-cli-test-"));
  try {
    const result = spawnSync(process.execPath, [REDUCE_PATH, "never-seen-session"], {
      encoding: "utf8",
      env: { ...process.env, LDL_TELEMETRY_DIR: dir },
    });
    assert.equal(result.status, 0);
    const printed = JSON.parse(result.stdout);
    assert.equal(printed.measured.identity.session_id, null);
    assert.equal(printed.measured.cost_usd_total, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
