// Tests for the issue #1005 corrected-checklist recovery inside evidence-correction.mjs (live Audit
// #1004 / PR #958 / work #954). Every GitHub interaction is an in-memory fake.
//
// Run with: node --test tools/orchestration/checklist-baseline-recovery.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { Status, evaluateEvidenceCorrection, parseSeverityCounts, runPrepare } from "./evidence-correction.mjs";
import {
  checkPreAuditPendingState,
  findMatchingOpenAuditIssues,
  hasCanonicalAuditShape,
  parseCorrectsAuditRef,
  parseEvidenceRecoveryRef,
  parseVerificationChecklistRef,
} from "../review-watch/lifecycle-gate.mjs";
import { triggerCommentBody } from "../review-watch/trigger.mjs";
import { checkScopeBaseline, ScopeState } from "./scope-baseline.mjs";

const REPO = "o/r";
const MERGE = "d4ef1c57ab45e4d55f24ee78746d1c5347b5770a";
const PARENT = "182c4d9c621bdb7feb547bf6626566f9d4edbcf9";
const STALE = "c2f3676e251ec6b3192c854634d0339d4daa841b";
const FILES = ["docs/bounded-review-cycle.md", "tools/orchestration/next-review-transition-gate.mjs"];
const FOUNDER = "founder";
const BOT = "chatgpt-codex-connector[bot]";
const AUDIT = 1004;
const WORK = 954;
const PR = 958;
const ts = (m) => new Date(Date.UTC(2026, 9, 8, 12, m, 0)).toISOString();
const commentUrl = (issue, id) => `https://github.com/${REPO}/issues/${issue}#issuecomment-${id}`;

function auditBody({ base = STALE, verdict = "NOT CLEAN" } = {}) {
  return [
    "### Merged PR", "", `https://github.com/${REPO}/pull/${PR}`, "",
    "### Work issue", "", `#${WORK}`, "",
    "### Exact merge commit", "", MERGE, "",
    "### Stage 1 inline review disposition", "", "Single inline round.", "",
    "### Audit scope", "", "Two files.", "",
    "**Verification checklist instructions:** numbered list.", "",
    "### Verification checklist", "",
    "1. Confirm A.",
    `2. Confirm the diff (\`git diff ${base} ${MERGE}\`) touches only those two files.`, "",
    '**Required response format:** replace "Pending" below.', "",
    "### Findings", "", "Pending — awaiting Stage 2 audit response.", "",
    "### Verdict", "", verdict, "",
    "### Next authorized action", "", "Pending audit.", "",
  ].join("\n");
}

function report({ counts = { P0: 0, P1: 0, P2: 1, P3: 0 }, mentions = [STALE, PARENT] } = {}) {
  return [
    "# Stage 2 Audit Report", "", `Exact merge commit: \`${MERGE}\``, "",
    "| Severity | Count |", "| --- | ---: |",
    ...Object.entries(counts).map(([k, v]) => `| ${k} | ${v} |`), "",
    `Finding: baseline ${mentions.join(" and ")}.`, "",
    "### Verification checklist", "",
    "1. Confirm A — CONFIRMED",
    "2. Confirm the diff — NOT CONFIRMED: stale baseline", "",
    "Verdict: NOT CLEAN",
  ].join("\n");
}

function makeWorld(over = {}) {
  return {
    issues: { [AUDIT]: { number: AUDIT, body: auditBody(), state: "OPEN", created_at: ts(0), author: FOUNDER } },
    comments: {
      [AUDIT]: [
        { id: 1, body: triggerCommentBody(), created_at: ts(1), user: { login: FOUNDER } },
        { id: 2, body: report(), created_at: ts(5), user: { login: BOT } },
      ],
      [WORK]: [],
    },
    pr: { state: "MERGED", mergeCommit: { oid: MERGE }, mergedAt: ts(-1) },
    openPrs: [],
    commit: { sha: MERGE, parents: [PARENT], files: FILES, filesComplete: true },
    prFiles: [...FILES],
    nextNumber: 1010,
    posts: [],
    ...over,
  };
}

const withUrls = (list, issue) =>
  list.map((c) => ({ ...c, html_url: commentUrl(issue, c.id), issue_url: `https://api.github.com/repos/${REPO}/issues/${issue}` }));

function makeIo(world) {
  return {
    ghApi: async (path) => {
      const m = /^repos\/o\/r\/issues\/(\d+)\/comments$/.exec(path);
      if (!m) throw new Error(`unexpected ghApi ${path}`);
      return withUrls(world.comments[m[1]] ?? [], m[1]);
    },
    ghGet: async (path) => {
      const m = /^repos\/o\/r\/issues\/(\d+)$/.exec(path);
      if (m) {
        const i = world.issues[m[1]];
        if (!i) throw new Error("404");
        return { number: i.number, body: i.body, state: i.state.toLowerCase(), created_at: i.created_at, user: { login: i.author } };
      }
      throw new Error(`unexpected ghGet ${path}`);
    },
    ghPost: async (path, payload) => {
      world.posts.push({ path, payload });
      if (path === "repos/o/r/issues") {
        const number = world.nextNumber++;
        world.issues[number] = { number, body: payload.body, state: "OPEN", created_at: ts(70 + world.posts.length), author: FOUNDER, title: payload.title };
        return { number };
      }
      throw new Error(`unexpected ghPost ${path}`);
    },
    readPr: async () => world.pr,
    listOpenPrs: async () => world.openPrs,
    listIssuesSince: async () =>
      Object.values(world.issues).map((i) => ({ number: i.number, title: "", body: i.body, state: i.state, createdAt: i.created_at, author: i.author })),
    readCommit: async () => world.commit,
    listPrFiles: async () => world.prFiles,
  };
}

const evaluate = (world) => evaluateEvidenceCorrection({ repo: REPO, auditIssue: AUDIT }, makeIo(world));

test("parseSeverityCounts reads the four-row table, rejects missing/duplicate rows", () => {
  assert.deepEqual(parseSeverityCounts(report()), { P0: 0, P1: 0, P2: 1, P3: 0 });
  assert.equal(parseSeverityCounts("| P0 | 0 |"), null);
  assert.equal(parseSeverityCounts(`${report()}\n| P2 | 1 |`), null);
});

test("#1004 shape: stale original-base checklist + independent report naming both SHAs -> SATISFIED via checklist proof, no result comment", async () => {
  const r = await evaluate(makeWorld());
  assert.equal(r.status, Status.SATISFIED);
  assert.equal(r.replacement, null);
  assert.deepEqual(r.checklistCorrection, { staleBase: STALE, firstParent: PARENT });
  assert.equal(r.resultUrl, commentUrl(AUDIT, 2));
});

test("prepare creates exactly one corrected-checklist successor: only the SHA changes, predecessor untouched, idempotent", async () => {
  const world = makeWorld();
  const predecessorBefore = JSON.stringify({ i: world.issues[AUDIT], c: world.comments[AUDIT] });
  const io = makeIo(world);
  const res = await runPrepare({ repo: REPO, auditIssue: AUDIT }, io);
  assert.equal(res.state, "REAUDIT_PREPARED");
  const created = world.posts.filter((p) => p.path === "repos/o/r/issues");
  assert.equal(created.length, 1);
  assert.match(created[0].payload.title, /Corrected-checklist re-audit/);
  const body = world.issues[res.replacementAuditIssue].body;
  assert.equal(hasCanonicalAuditShape(body), true);
  assert.deepEqual(checkPreAuditPendingState(body), { ok: true });
  assert.equal(parseEvidenceRecoveryRef(body), AUDIT);
  assert.equal(parseCorrectsAuditRef(body), AUDIT);
  assert.equal(parseVerificationChecklistRef(body), parseVerificationChecklistRef(auditBody()).replace(STALE, PARENT));
  assert.equal(checkScopeBaseline({ checklist: parseVerificationChecklistRef(body), mergeCommit: MERGE, commit: world.commit }).state, ScopeState.OK);
  assert.equal(JSON.stringify({ i: world.issues[AUDIT], c: world.comments[AUDIT] }), predecessorBefore);
  assert.equal(world.issues[AUDIT].body, auditBody());

  const again = await runPrepare({ repo: REPO, auditIssue: AUDIT }, io);
  assert.equal(again.state, "REAUDIT_ALREADY_PREPARED");
  assert.equal(world.posts.filter((p) => p.path === "repos/o/r/issues").length, 1);

  // the predecessor is superseded, so the successor is the sole current candidate for trigger uniqueness
  const candidates = Object.values(world.issues).map((i) => ({ number: i.number, body: i.body, state: i.state }));
  assert.deepEqual(
    findMatchingOpenAuditIssues(candidates, { mergeCommitOid: MERGE, executionIssue: WORK }).map((c) => c.number),
    [res.replacementAuditIssue],
  );
});

test("dry run composes the body without creating anything", async () => {
  const world = makeWorld();
  const res = await runPrepare({ repo: REPO, auditIssue: AUDIT, dryRun: true }, makeIo(world));
  assert.equal(res.state, "REAUDIT_DRY_RUN");
  assert.equal(world.posts.length, 0);
});

test("single-use: the successor itself is never eligible for another recovery audit", async () => {
  const world = makeWorld();
  const io = makeIo(world);
  const { replacementAuditIssue } = await runPrepare({ repo: REPO, auditIssue: AUDIT }, io);
  world.issues[replacementAuditIssue].body = world.issues[replacementAuditIssue].body.replace("### Verdict\n\nPENDING", "### Verdict\n\nNOT CLEAN");
  const r = await evaluateEvidenceCorrection({ repo: REPO, auditIssue: replacementAuditIssue }, io);
  assert.equal(r.status, Status.NOT_ELIGIBLE);
});

test("negative: a correct (first-parent) baseline is not a checklist defect -> stays NO_RESULT (#883 / source routes unchanged)", async () => {
  const world = makeWorld();
  world.issues[AUDIT].body = auditBody({ base: PARENT });
  assert.equal((await evaluate(world)).status, Status.NO_RESULT);
});

test("negative: unprovable topology (no parent, unreadable commit, truncated list) never satisfies", async () => {
  for (const commit of [{ sha: MERGE, parents: [], files: FILES, filesComplete: true }, null]) {
    assert.equal((await evaluate(makeWorld({ commit }))).status, Status.NO_RESULT);
  }
  const trunc = makeWorld({ commit: { sha: MERGE, parents: [PARENT], files: FILES, filesComplete: false } });
  assert.equal((await evaluate(trunc)).status, Status.NO_RESULT);
  const io = {
    ...makeIo(makeWorld()),
    readCommit: async () => {
      throw new Error("boom");
    },
  };
  assert.equal((await evaluateEvidenceCorrection({ repo: REPO, auditIssue: AUDIT }, io)).status, Status.NO_RESULT);
});

test("negative: merge file list that differs from the merged PR's file list is not proof", async () => {
  assert.equal((await evaluate(makeWorld({ prFiles: [...FILES, "AGENTS.md"] }))).status, Status.NO_RESULT);
  assert.equal((await evaluate(makeWorld({ prFiles: [FILES[0]] }))).status, Status.NO_RESULT);
});

test("negative: report that does not independently name both SHAs, or has extra/severe findings, is not proof", async () => {
  for (const rep of [
    report({ mentions: [STALE] }),
    report({ mentions: [PARENT] }),
    report({ counts: { P0: 0, P1: 1, P2: 0, P3: 0 } }),
    report({ counts: { P0: 0, P1: 0, P2: 2, P3: 0 } }),
    report({ counts: { P0: 0, P1: 0, P2: 0, P3: 0 } }),
  ]) {
    const world = makeWorld();
    world.comments[AUDIT][1].body = rep;
    assert.notEqual((await evaluate(world)).status, Status.SATISFIED);
  }
});

test("negative: wrong merge, underway correction PR, mutated or duplicated successor all fail closed", async () => {
  const wrongMerge = makeWorld({ pr: { state: "MERGED", mergeCommit: { oid: "0".repeat(40) }, mergedAt: ts(-1) } });
  assert.equal((await evaluate(wrongMerge)).status, Status.NOT_ELIGIBLE);

  const open = makeWorld({ openPrs: [{ number: 2000, body: `Addresses #${WORK}`, title: "fix", state: "OPEN" }] });
  assert.notEqual((await evaluate(open)).status, Status.SATISFIED);

  const world = makeWorld();
  const io = makeIo(world);
  const { replacementAuditIssue: n } = await runPrepare({ repo: REPO, auditIssue: AUDIT }, io);
  const good = world.issues[n].body;
  world.issues[n].body = good.replace(`${PARENT} ${MERGE}`, `${STALE} ${MERGE}`);
  assert.equal((await evaluate(world)).status, Status.AMBIGUOUS);
  world.issues[n].body = good.replace(commentUrl(AUDIT, 2), "https://example.com/x");
  assert.equal((await evaluate(world)).status, Status.AMBIGUOUS);
  world.issues[n].body = good;
  world.issues[2222] = { number: 2222, body: good, state: "OPEN", created_at: ts(90), author: FOUNDER };
  assert.equal((await evaluate(world)).status, Status.AMBIGUOUS);
});

test("an untrusted author's look-alike successor is not recognized as lineage authority", async () => {
  const world = makeWorld();
  const io = makeIo(world);
  const { replacementAuditIssue: n } = await runPrepare({ repo: REPO, auditIssue: AUDIT }, io);
  world.issues[n].author = "mallory";
  const r = await evaluate(world);
  assert.equal(r.status, Status.SATISFIED);
  assert.equal(r.replacement, null);
});
