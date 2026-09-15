import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("../../", import.meta.url);

function read(path) {
  return readFileSync(new URL(path, ROOT), "utf8");
}

function fieldBlock(yaml, id) {
  const marker = `    id: ${id}\n`;
  const markerIndex = yaml.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing Issue Form field id: ${id}`);

  const start = yaml.lastIndexOf("  - type:", markerIndex);
  assert.notEqual(start, -1, `field ${id} has no form-item boundary`);

  const next = yaml.indexOf("\n  - type:", markerIndex + marker.length);
  return yaml.slice(start, next === -1 ? yaml.length : next);
}

function assertField(yaml, id, label) {
  const block = fieldBlock(yaml, id);
  assert.match(block, new RegExp(`\\n      label: ${label.replace(/[.*+?^$\{\}()|[\\]\\]/g, "\\$&")}\\n`));
  return block;
}

test("parent execution preserves parser-sensitive headings and canonical empty defaults", () => {
  const yaml = read(".github/ISSUE_TEMPLATE/parent-execution.yml");

  assertField(yaml, "state", "State");
  const blocker = assertField(yaml, "blocker", "Current blocker");
  const interrupt = assertField(yaml, "interrupt", "Founder interrupt");
  const next = assertField(yaml, "next", "Next slice / resulting slices");

  assert.match(blocker, /\n      value: "None"\n/);
  assert.match(interrupt, /\n      value: "None"\n/);
  assert.match(next, /\n      value: "None"\n/);
});

test("Stage 2 audit preserves headings consumed by audit lifecycle tooling", () => {
  const yaml = read(".github/ISSUE_TEMPLATE/audit-control-issue.yml");

  assertField(yaml, "work_issue", "Work issue");
  assertField(yaml, "merge_commit", "Exact merge commit");
  assertField(yaml, "verification_checklist", "Verification checklist");
  const verdict = assertField(yaml, "verdict", "Verdict");

  for (const option of ["PENDING", "CLEAN", "NOT CLEAN"]) {
    assert.match(verdict, new RegExp(`\\n        - ${option.replace(/[.*+?^$\{\}()|[\\]\\]/g, "\\$&")}\\n`));
  }
});

test("Idea intake priority field stays compatible with deterministic priority-label projection", () => {
  const yaml = read(".github/ISSUE_TEMPLATE/idea-intake.yml");
  const workflow = read(".github/workflows/priority-labels.yml");
  const horizon = assertField(yaml, "horizon", "Priority horizon");

  for (const option of ["Now", "Soon", "Later", "Wishes"]) {
    assert.match(horizon, new RegExp(`\\n        - ${option}\\n`));
  }

  assert.match(workflow, /Priority horizon/);
  assert.match(workflow, /Now\|Soon\|Later\|Wishes/);
  assert.match(workflow, /priority:/);
  assert.match(workflow, /idea-intake/);
});
