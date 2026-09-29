import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readGithubIssue, readGithubPr } from "./github-read.mjs";
import { parseControlBullet } from "./ready-dispatch-gate.mjs";

const restIssue = (over = {}) => ({
  number: 725,
  state: "open",
  body: "- **Lifecycle:** READY\n- **Execution issue:** #12\n",
  created_at: "2026-09-23T10:00:00Z",
  ...over,
});
const fakeExec = (payload, calls = []) => (cmd, args) => {
  calls.push([cmd, ...args]);
  return typeof payload === "string" ? payload : JSON.stringify(payload);
};

test("readGithubIssue uses REST (gh api), never GraphQL-backed `gh issue view`", () => {
  const calls = [];
  const out = readGithubIssue({ repo: "o/r", number: 725, execFileImpl: fakeExec(restIssue(), calls) });
  assert.deepEqual(calls, [["gh", "api", "repos/o/r/issues/725"]]);
  assert.deepEqual(out, { body: restIssue().body, state: "OPEN" });
});

test("readGithubIssue output matches the gh --json shape the gates consume, unchanged parsing", () => {
  const out = readGithubIssue({
    repo: "o/r",
    number: 725,
    fields: ["body", "state", "createdAt"],
    execFileImpl: fakeExec(restIssue({ state: "closed" })),
  });
  assert.equal(out.state, "CLOSED");
  assert.equal(out.createdAt, "2026-09-23T10:00:00Z");
  assert.equal(parseControlBullet(out.body, "Lifecycle"), "READY");
});

test("readGithubIssue with no repo relies on gh's own current-repo placeholders", () => {
  const calls = [];
  readGithubIssue({ number: 5, fields: ["body"], execFileImpl: fakeExec(restIssue({ number: 5 }), calls) });
  assert.equal(calls[0][2], "repos/{owner}/{repo}/issues/5");
});

test("null body reads as empty string, like gh", () => {
  const out = readGithubIssue({ repo: "o/r", number: 725, fields: ["body"], execFileImpl: fakeExec(restIssue({ body: null })) });
  assert.equal(out.body, "");
});

test("unavailable/unauthorized transport propagates as a thrown operational failure", () => {
  const exec = () => {
    throw new Error("gh: HTTP 403 (https://api.github.com/repos/o/r/issues/725)");
  };
  assert.throws(() => readGithubIssue({ repo: "o/r", number: 725, execFileImpl: exec }), /403/);
  assert.throws(() => readGithubPr({ repo: "o/r", number: 1, fields: ["state"], execFileImpl: exec }), /403/);
});

test("malformed or incomplete issue payloads fail closed", () => {
  const bad = [
    "not json",
    "[]",
    "null",
    JSON.stringify(restIssue({ number: 999 })),
    JSON.stringify(restIssue({ state: "weird" })),
    JSON.stringify({ number: 725, body: "x", created_at: "t" }),
    JSON.stringify(restIssue({ body: 42 })),
  ];
  for (const payload of bad) {
    assert.throws(() => readGithubIssue({ repo: "o/r", number: 725, execFileImpl: fakeExec(payload) }), Error, payload);
  }
  assert.throws(
    () => readGithubIssue({ repo: "o/r", number: 725, fields: ["createdAt"], execFileImpl: fakeExec(restIssue({ created_at: undefined })) }),
    /created_at/,
  );
  assert.throws(() => readGithubIssue({ repo: "o/r", number: 725, fields: ["labels"], execFileImpl: fakeExec(restIssue()) }), /does not support/);
});

const restPr = (over = {}) => ({
  number: 7,
  state: "open",
  body: "Stage 1: pending",
  head: { ref: "feature", sha: "abc123" },
  merged_at: null,
  merge_commit_sha: "deadbeef",
  mergeable: true,
  ...over,
});

test("readGithubPr maps REST fields to gh --json shape", () => {
  const all = ["state", "body", "headRefName", "headRefOid", "mergedAt", "mergeCommit", "mergeable"];
  assert.deepEqual(readGithubPr({ repo: "o/r", number: 7, fields: all, execFileImpl: fakeExec(restPr()) }), {
    state: "OPEN",
    body: "Stage 1: pending",
    headRefName: "feature",
    headRefOid: "abc123",
    mergedAt: null,
    mergeCommit: null,
    mergeable: "MERGEABLE",
  });
  const merged = restPr({ state: "closed", merged_at: "2026-09-24T00:00:00Z", mergeable: null });
  const out = readGithubPr({ repo: "o/r", number: 7, fields: all, execFileImpl: fakeExec(merged) });
  assert.equal(out.state, "MERGED");
  assert.deepEqual(out.mergeCommit, { oid: "deadbeef" });
  assert.equal(out.mergedAt, "2026-09-24T00:00:00Z");
  assert.equal(out.mergeable, "UNKNOWN");
  const conflict = readGithubPr({ repo: "o/r", number: 7, fields: ["mergeable"], execFileImpl: fakeExec(restPr({ mergeable: false })) });
  assert.equal(conflict.mergeable, "CONFLICTING");
});

test("malformed PR payloads fail closed", () => {
  const cases = [
    [{ head: {} }, ["headRefOid"]],
    [{ head: { ref: "", sha: "x" } }, ["headRefName"]],
    [{ state: "bogus" }, ["state"]],
    [{ mergeable: "yes" }, ["mergeable"]],
    [{ merged_at: "t", merge_commit_sha: null }, ["mergeCommit"]],
    [{ number: 8 }, ["state"]],
  ];
  for (const [over, fields] of cases) {
    assert.throws(() => readGithubPr({ repo: "o/r", number: 7, fields, execFileImpl: fakeExec(restPr(over)) }), Error);
  }
});

test("no production orchestration/review-watch script reads Issues or PR fields via GraphQL-backed gh commands", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const allowedPrView = new Set(["lifecycle-gate.mjs"]); // closingIssuesReferences has no REST equivalent (recorded in #725)
  for (const dir of [here, path.join(here, "..", "review-watch")]) {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".mjs") || file.endsWith(".test.mjs")) continue;
      const src = fs.readFileSync(path.join(dir, file), "utf8");
      assert.ok(!/"issue",\s*"view"/.test(src), `${file} still shells out to gh issue view`);
      if (!allowedPrView.has(file)) assert.ok(!/"pr",\s*"view"/.test(src), `${file} still shells out to gh pr view`);
    }
  }
});
