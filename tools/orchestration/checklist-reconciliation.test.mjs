// Tests for the issue #1193 audit-checklist reconciliation inside evidence-correction.mjs (live shape:
// Audit #1190 -> replacement #1191 for PR #1189 / work #1184). Every GitHub interaction is an in-memory
// fake; nothing mutates live state.
//
// Run with: node --test tools/orchestration/checklist-reconciliation.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  Status,
  composeReplacementAuditBody,
  evaluateEvidenceCorrection,
  formatChecklistReconciliation,
  formatEvidenceCorrectionResult,
  parseChecklistItems,
  parseChecklistReconciliation,
  parseEvidenceCorrectionResult,
  parseReportVerificationStatuses,
  reconcileChecklist,
  runPrepare,
  runRecord,
  runVerify,
} from "./evidence-correction.mjs";
import {
  checkPreAuditPendingState,
  hasCanonicalAuditShape,
  parseCorrectsAuditRef,
  parseEvidenceRecoveryRef,
  parseVerificationChecklistRef,
} from "../review-watch/lifecycle-gate.mjs";
import { triggerCommentBody } from "../review-watch/trigger.mjs";
import { runNextReviewTransitionGate } from "./next-review-transition-gate.mjs";

const REPO = "o/r";
const MERGE = "17a527ed1f079138c02cd056044bdbebd72e6215";
const PARENT = "053ad0de8f76c87459e2b59d032ceb31c1a24abb";
const STALE = "8f484b1760167052644fc47d8fbb832aa3e7568d";
const FILES = ["tools/orchestration/claude-sandbox-live.test.mjs"];
const FOUNDER = "founder";
const BOT = "chatgpt-codex-connector[bot]";
const AUDIT = 1190;
const WORK = 1184;
const PR = 1189;
const ts = (m) => new Date(Date.UTC(2026, 9, 15, 12, m, 0)).toISOString();
const commentUrl = (issue, id) => `https://github.com/${REPO}/issues/${issue}#issuecomment-${id}`;

const ITEM1_OLD = "1. Confirm the live test rejects both malformed and sandbox-disabled `--settings` through the pinned CLI.";
const ITEM1_NEW = "Confirm the live test exercises malformed `--settings` through the pinned CLI and that sandbox-disabled settings are rejected by launcher validation.";
const ITEM2 = "2. Confirm the PR body states its evidence accurately.";
const ITEM3 = "3. Run the affected suites at the merge commit and confirm they pass.";
const scopeItem = (base = PARENT) => `4. Confirm the change scope (\`git diff ${base} ${MERGE}\`) touches only the granted files.`;

function auditBody({ verdict = "NOT CLEAN", checklist = null, disposition = "Correction-satisfied." } = {}) {
  return [
    "This issue is a read-only control boundary.", "",
    "### Merged PR", "", `https://github.com/${REPO}/pull/${PR}`, "",
    "### Work issue", "", `#${WORK}`, "",
    "### Exact merge commit", "", MERGE, "",
    "### Stage 1 inline review disposition", "", disposition, "",
    "### Audit scope", "", "One file.", "",
    "**Verification checklist instructions:** numbered list.", "",
    "### Verification checklist", "",
    checklist ?? [ITEM1_OLD, ITEM2, ITEM3, scopeItem()].join("\n"), "",
    '**Required response format:** replace "Pending" below.', "",
    "### Findings", "", "Pending — awaiting Stage 2 audit response.", "",
    "### Verdict", "", verdict, "",
    "### Next authorized action", "", "Pending audit.", "",
  ].join("\n");
}

// The independent report: items 1 and 2 FAIL (the live #1190 shape), 3 and 4 PASS.
function report({ statuses = ["FAIL", "FAIL", "PASS", "PASS"] } = {}) {
  return [
    "# Stage 2 Audit Report", "", `Exact merge commit: \`${MERGE}\``, "",
    "## Severity", "", "| Severity | Count |", "| --- | ---: |", "| P0 | 0 |", "| P1 | 1 |", "| P2 | 0 |", "| P3 | 0 |", "",
    "## Findings", "",
    "1. **The PR overstates the disabled-sandbox evidence** — items 1 and 2 cannot both pass. Consequence: contradictory checklist. Smallest correction: align them.", "",
    "## Verification", "",
    ...statuses.map((s, i) => `${i + 1}. ${s} — result for item ${i + 1}.`), "",
    "## Founder judgment", "", "Not required.", "",
    "Verdict: NOT CLEAN",
  ].join("\n");
}

// Work-issue comments: 100 = pre-audit authority; 101 = post-report evidence; 102 (added by tests) = reconciliation.
function makeWorld(over = {}) {
  return {
    issues: {
      [AUDIT]: { number: AUDIT, body: auditBody(), state: "OPEN", created_at: ts(0), author: FOUNDER },
      [WORK]: { number: WORK, body: "work", state: "OPEN", created_at: ts(-100), author: FOUNDER },
    },
    comments: {
      [AUDIT]: [
        { id: 1, body: triggerCommentBody(), created_at: ts(1), user: { login: FOUNDER } },
        { id: 2, body: report(), created_at: ts(5), user: { login: BOT } },
      ],
      [WORK]: [
        { id: 100, body: "original accepted requirement recorded before the audit", created_at: ts(-50), user: { login: FOUNDER } },
        { id: 101, body: "corrected PR body evidence", created_at: ts(10), user: { login: FOUNDER } },
      ],
    },
    pr: { state: "MERGED", mergeCommit: { oid: MERGE }, mergedAt: ts(-1) },
    openPrs: [],
    commit: { sha: MERGE, parents: [PARENT], files: FILES, filesComplete: true },
    prFiles: [...FILES],
    nextNumber: 1191,
    nextCommentId: 5000,
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
      let m = /^repos\/o\/r\/issues\/comments\/(\d+)$/.exec(path);
      if (m) {
        for (const [issue, list] of Object.entries(world.comments)) {
          const c = list.find((x) => String(x.id) === m[1]);
          if (c) return withUrls([c], issue)[0];
        }
        throw new Error("404");
      }
      m = /^repos\/o\/r\/issues\/(\d+)$/.exec(path);
      if (m) {
        const i = world.issues[m[1]];
        if (!i) throw new Error("404");
        return { number: i.number, body: i.body, state: i.state.toLowerCase(), created_at: i.created_at, user: { login: i.author } };
      }
      throw new Error(`unexpected ghGet ${path}`);
    },
    ghPost: async (path, payload) => {
      world.posts.push({ path, payload });
      let m = /^repos\/o\/r\/issues\/(\d+)\/comments$/.exec(path);
      if (m) {
        const id = world.nextCommentId++;
        (world.comments[m[1]] ??= []).push({ id, body: payload.body, created_at: ts(60 + world.posts.length), user: { login: FOUNDER } });
        return { html_url: commentUrl(m[1], id) };
      }
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
      Object.values(world.issues).map((i) => ({ number: i.number, title: i.title ?? "", body: i.body, state: i.state, createdAt: i.created_at, author: i.author })),
    readCommit: async () => world.commit,
    listPrFiles: async () => world.prFiles,
  };
}

// Adds a reconciliation comment on the work Issue and returns its URL.
function addReconciliation(world, over = {}, { id = 102, created = ts(20), author = FOUNDER, issue = WORK, raw = null } = {}) {
  const body =
    raw ??
    formatChecklistReconciliation({
      auditIssue: AUDIT,
      workIssue: WORK,
      findingUrl: commentUrl(AUDIT, 2),
      authorityUrls: [commentUrl(WORK, 100)],
      items: [{ number: 1, text: ITEM1_NEW }],
      ...over,
    });
  (world.comments[issue] ??= []).push({ id, body, created_at: created, user: { login: author } });
  return commentUrl(issue, id);
}

const record = (world, opts = {}) =>
  runRecord(
    { repo: REPO, auditIssue: AUDIT, evidence: opts.evidence ?? [commentUrl(WORK, 101)], reconciliation: opts.reconciliation ?? commentUrl(WORK, 102) },
    makeIo(world),
  );
const evaluate = (world) => evaluateEvidenceCorrection({ repo: REPO, auditIssue: AUDIT }, makeIo(world));

const refusedWithoutPosting = async (world, pattern, opts) => {
  const r = await record(world, opts);
  assert.equal(r.exitCode, 2, JSON.stringify(r));
  assert.match(String(r.reason), pattern);
  assert.equal(world.posts.length, 0, "nothing may be posted");
  return r;
};

// -- pure helpers ---------------------------------------------------------------------------------

test("checklist items: consecutive parse, byte-exact round trip, exact substitution, fail closed on gaps", () => {
  const checklist = [ITEM1_OLD, ITEM2, ITEM3, scopeItem()].join("\n");
  assert.equal(reconcileChecklist(checklist, new Map()), checklist);
  const out = reconcileChecklist(checklist, new Map([[1, ITEM1_NEW]]));
  assert.deepEqual(out.split("\n"), [`1. ${ITEM1_NEW}`, ITEM2, ITEM3, scopeItem()]);
  assert.equal(parseChecklistItems("1. a\n3. c"), null);
  assert.equal(parseChecklistItems("no items"), null);
  assert.equal(reconcileChecklist(checklist, new Map([[9, "x"]])), null);
  // A multi-line item keeps its continuation lines when unnamed.
  const multi = "1. a\n   cont\n2. b";
  assert.equal(reconcileChecklist(multi, new Map([[2, "B"]])), "1. a\n   cont\n2. B");
});

test("report verification statuses: per-item PASS/FAIL/BLOCKED, absent section and duplicates are null", () => {
  assert.deepEqual([...parseReportVerificationStatuses(report())], [[1, "FAIL"], [2, "FAIL"], [3, "PASS"], [4, "PASS"]]);
  assert.equal(parseReportVerificationStatuses("no section"), null);
  assert.equal(parseReportVerificationStatuses("## Verification\n1. PASS a\n1. FAIL b\n"), null);
});

test("reconciliation comment: strict round trip; malformed shapes fail closed", () => {
  const good = formatChecklistReconciliation({
    auditIssue: AUDIT, workIssue: WORK, findingUrl: commentUrl(AUDIT, 2), authorityUrls: [commentUrl(WORK, 100)], items: [{ number: 1, text: ITEM1_NEW }],
  });
  const parsed = parseChecklistReconciliation(good);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.fields.items.get(1), ITEM1_NEW);
  assert.equal(parseChecklistReconciliation(`${good}- **Audit issue:** #1\n`).ok, false, "duplicate");
  assert.equal(parseChecklistReconciliation(`${good}- **Surprise:** x\n`).ok, false, "unknown");
  assert.equal(parseChecklistReconciliation(good.replace("PROVEN", "UNCERTAIN")).ok, false);
  assert.equal(parseChecklistReconciliation(good.replace("Source defects:** none", "Source defects:** one")).ok, false);
  assert.equal(parseChecklistReconciliation(good.replace(`  - 1: ${ITEM1_NEW}`, "  - 1:")).ok, false, "empty replacement");
  assert.equal(parseChecklistReconciliation(good.replace(commentUrl(WORK, 100), "https://example.com/x")).ok, false);
  assert.equal(parseChecklistReconciliation(good.replace(`  - ${commentUrl(WORK, 100)}`, "")).ok, false, "no authority");
  assert.equal(parseChecklistReconciliation(`${good.trimEnd()}\n  - 1: again\n`).ok, false, "duplicate item");
  assert.equal(parseChecklistReconciliation("hello").ok, false);
});

test("result comment: reconciliation fields round-trip, are mandatory together, and keep the #883 shape otherwise", () => {
  const base = { auditIssue: AUDIT, workIssue: WORK, pr: PR, mergeCommit: MERGE, findingUrl: commentUrl(AUDIT, 2) };
  const withBoth = formatEvidenceCorrectionResult({ ...base, evidenceUrls: [commentUrl(WORK, 101)], reconciliationUrl: commentUrl(WORK, 102), reconciledItems: [1] });
  const parsed = parseEvidenceCorrectionResult(withBoth);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.fields.reconciliationUrl, commentUrl(WORK, 102));
  assert.deepEqual(parsed.fields.reconciledItems, [1]);
  // Reconciliation alone is a valid payload (no evidence comment needed), evidence alone is unchanged #883.
  assert.equal(parseEvidenceCorrectionResult(formatEvidenceCorrectionResult({ ...base, evidenceUrls: [], reconciliationUrl: commentUrl(WORK, 102), reconciledItems: [1] })).ok, true);
  const plain = formatEvidenceCorrectionResult({ ...base, evidenceUrls: [commentUrl(WORK, 101)] });
  assert.equal(plain.includes("reconciliation"), false);
  assert.equal(parseEvidenceCorrectionResult(plain).fields.reconciliationUrl, null);
  // Neither evidence nor reconciliation, a half pair, duplicate items, unknown fields: all fail closed.
  assert.equal(parseEvidenceCorrectionResult(formatEvidenceCorrectionResult({ ...base, evidenceUrls: [] })).ok, false);
  assert.equal(parseEvidenceCorrectionResult(withBoth.replace(/- \*\*Reconciled items:\*\* 1\n/, "")).ok, false);
  assert.equal(parseEvidenceCorrectionResult(withBoth.replace("Reconciled items:** 1", "Reconciled items:** 1, 1")).ok, false);
  assert.equal(parseEvidenceCorrectionResult(`${withBoth}- **Extra:** x\n`).ok, false);
});

// -- positive: the #1190 -> #1191 shape -----------------------------------------------------------

test("positive: item 1 reconciled, items 2-4 byte-identical -> record, verify, prepare and replacement equality all succeed", async () => {
  const world = makeWorld();
  addReconciliation(world);
  assert.equal((await evaluate(world)).status, Status.NO_RESULT);

  const recorded = await record(world);
  assert.equal(recorded.state, "EVIDENCE_RECORDED", JSON.stringify(recorded));
  const posted = world.posts.filter((p) => p.path.endsWith(`/issues/${WORK}/comments`));
  assert.equal(posted.length, 1);
  assert.match(posted[0].payload.body, /- \*\*Checklist reconciliation:\*\* https:\/\/github\.com\/o\/r\/issues\/1184#issuecomment-102\n- \*\*Reconciled items:\*\* 1\n/);

  const verified = await runVerify({ repo: REPO, auditIssue: AUDIT }, makeIo(world));
  assert.equal(verified.state, "EVIDENCE_SATISFIED");
  assert.deepEqual(verified.checklistReconciliation.items.map((i) => i.number), [1]);

  const predecessorBefore = JSON.stringify({ i: world.issues[AUDIT], c: world.comments[AUDIT] });
  const prepared = await runPrepare({ repo: REPO, auditIssue: AUDIT }, makeIo(world));
  assert.equal(prepared.state, "REAUDIT_PREPARED", JSON.stringify(prepared));
  const replacement = world.issues[prepared.replacementAuditIssue];

  assert.equal(hasCanonicalAuditShape(replacement.body), true);
  assert.deepEqual(checkPreAuditPendingState(replacement.body), { ok: true });
  assert.equal(parseEvidenceRecoveryRef(replacement.body), AUDIT);
  assert.equal(parseCorrectsAuditRef(replacement.body), AUDIT);
  assert.deepEqual(parseVerificationChecklistRef(replacement.body).split("\n"), [`1. ${ITEM1_NEW}`, ITEM2, ITEM3, scopeItem()]);
  assert.match(replacement.body, /Item 1 previous requirement \(verbatim\): Confirm the live test rejects both/);
  assert.match(replacement.body, /Item 1 reconciled requirement \(verbatim\): Confirm the live test exercises malformed/);
  assert.match(replacement.body, /Evidence-recovery re-audit of audit issue #1190/);
  // Only the checklist and the disposition provenance differ from the predecessor; verdict reset.
  const strip = (b) => b.replace(/### Verdict\n\n[^\n]*/, "").replace(/### Stage 1 inline review disposition[\s\S]*?### Audit scope/, "").replace(/### Verification checklist[\s\S]*?\*\*Required/, "");
  assert.equal(strip(replacement.body), strip(world.issues[AUDIT].body));
  assert.equal(JSON.stringify({ i: world.issues[AUDIT], c: world.comments[AUDIT] }), predecessorBefore, "predecessor untouched");

  const after = await evaluate(world);
  assert.equal(after.status, Status.SATISFIED);
  assert.equal(after.replacement.number, prepared.replacementAuditIssue);
  assert.equal(after.replacement.pending, true);
  assert.equal((await runPrepare({ repo: REPO, auditIssue: AUDIT }, makeIo(world))).state, "REAUDIT_ALREADY_PREPARED");
});

test("positive: reconciliation alone (no evidence comment) records when every FAIL is reconciled", async () => {
  const world = makeWorld({});
  world.comments[AUDIT][1].body = report({ statuses: ["FAIL", "PASS", "PASS", "PASS"] });
  addReconciliation(world);
  const r = await record(world, { evidence: [] });
  assert.equal(r.state, "EVIDENCE_RECORDED", JSON.stringify(r));
});

test("positive: end to end through the post-merge gate reaches STAGE2_EVIDENCE_REAUDIT_READY, and a hand-edited replacement is AMBIGUOUS with no nextCommand", async () => {
  const world = makeWorld();
  addReconciliation(world);
  const io = makeIo(world);
  const controlBody = [
    "## Current state", "", "- **Lifecycle:** AUDIT", `- **Execution:** #${WORK}`, "- **Route:** implementation worker", `- **PR:** #${PR}`,
    "- **Stage 1:** satisfied", `- **Stage 2:** #${AUDIT}`, "- **Blocker:** none", "- **Founder decision:** none", "",
  ].join("\n");
  const gate = () =>
    runNextReviewTransitionGate(
      { repo: REPO, controlIssue: "1183" },
      {
        ghIssueViewImpl: async ({ number }) =>
          Number(number) === 1183 ? { body: controlBody, state: "OPEN" } : { body: world.issues[number].body, state: world.issues[number].state },
        ghPrStateImpl: async () => ({ headRefOid: "h", state: "MERGED", mergeCommit: { oid: MERGE } }),
        checkPostAuditImpl: async ({ "audit-issue": audit }) => ({ exitCode: 0, state: "OK", rawVerdict: "NOT CLEAN", verdict: "NOT CLEAN", workIssue: WORK, auditIssue: Number(audit) }),
        reconcileStage2CorrectionPrImpl: async () => ({ crossed: false }),
        evaluateEvidenceCorrectionImpl: (args) => evaluateEvidenceCorrection(args, io),
      },
    );
  assert.equal((await gate()).evidenceOnlyEligible, true);
  assert.equal((await runRecord({ repo: REPO, auditIssue: AUDIT, evidence: [commentUrl(WORK, 101)], reconciliation: commentUrl(WORK, 102) }, io)).state, "EVIDENCE_RECORDED");
  assert.equal((await gate()).state, "STAGE2_EVIDENCE_REAUDIT_PREPARATION_REQUIRED");
  const prepared = await runPrepare({ repo: REPO, auditIssue: AUDIT }, io);
  assert.equal((await gate()).state, "STAGE2_EVIDENCE_REAUDIT_READY");

  // Hand-edit the persisted replacement checklist after prepare: rejected before any trigger command.
  const n = prepared.replacementAuditIssue;
  world.issues[n].body = world.issues[n].body.replace(`1. ${ITEM1_NEW}`, "1. Confirm anything at all.");
  const blocked = await gate();
  assert.equal(blocked.state, "AMBIGUOUS");
  assert.equal(blocked.nextCommand, undefined);
  assert.match(blocked.reason, /not exactly the mechanically corrected checklist|verification checklist/);
});

// -- negatives: record fails closed, nothing posted ----------------------------------------------

test("negative: reconciling an item the report marked PASS", async () => {
  const world = makeWorld();
  addReconciliation(world, { items: [{ number: 3, text: "Run something else." }] });
  await refusedWithoutPosting(world, /item 3 was not marked FAIL/);
});

test("negative: item count change (an item beyond the checklist) and an empty replacement", async () => {
  const world = makeWorld();
  addReconciliation(world, { items: [{ number: 5, text: "A fifth requirement." }] });
  await refusedWithoutPosting(world, /item 5 does not exist|item count is fixed/);
  const empty = makeWorld();
  addReconciliation(empty, {}, { raw: formatChecklistReconciliation({ auditIssue: AUDIT, workIssue: WORK, findingUrl: commentUrl(AUDIT, 2), authorityUrls: [commentUrl(WORK, 100)], items: [{ number: 1, text: ITEM1_NEW }] }).replace(`  - 1: ${ITEM1_NEW}`, "  - 1:") });
  await refusedWithoutPosting(empty, /malformed/);
});

test("negative: no replacement text identical to the current requirement; no unnamed item can change", async () => {
  const world = makeWorld();
  addReconciliation(world, { items: [{ number: 1, text: ITEM1_OLD.slice(3) }] });
  await refusedWithoutPosting(world, /identical to the existing requirement/);
  // Unnamed items cannot be altered through the reconciliation: the recomputed checklist keeps them byte-identical.
  const checklist = [ITEM1_OLD, ITEM2, ITEM3, scopeItem()].join("\n");
  const recomputed = reconcileChecklist(checklist, new Map([[1, ITEM1_NEW]])).split("\n");
  assert.deepEqual(recomputed.slice(1), [ITEM2, ITEM3, scopeItem()]);
});

test("negative: no authority citation, authority recorded after the audit (restating the finding), or authority on another Issue", async () => {
  const world = makeWorld();
  addReconciliation(world, {}, { raw: formatChecklistReconciliation({ auditIssue: AUDIT, workIssue: WORK, findingUrl: commentUrl(AUDIT, 2), authorityUrls: [commentUrl(WORK, 100)], items: [{ number: 1, text: ITEM1_NEW }] }).replace(`  - ${commentUrl(WORK, 100)}\n`, "") });
  await refusedWithoutPosting(world, /cites no comment URL/);

  const late = makeWorld();
  addReconciliation(late, { authorityUrls: [commentUrl(WORK, 101)] }); // 101 is post-report evidence, not original authority
  await refusedWithoutPosting(late, /was not recorded before the audit existed/);

  const reviewerOnly = makeWorld();
  addReconciliation(reviewerOnly, { authorityUrls: [commentUrl(AUDIT, 2)] }); // the reviewer finding itself
  await refusedWithoutPosting(reviewerOnly, /not on the authoritative work Issue/);

  const foreign = makeWorld();
  foreign.issues[999] = { number: 999, body: "x", state: "OPEN", created_at: ts(-200), author: FOUNDER };
  foreign.comments[999] = [{ id: 900, body: "other", created_at: ts(-150), user: { login: FOUNDER } }];
  addReconciliation(foreign, { authorityUrls: [commentUrl(999, 900)] });
  await refusedWithoutPosting(foreign, /not on the authoritative work Issue/);

  const wrongAuthor = makeWorld();
  wrongAuthor.comments[WORK][0].user.login = "someone-else";
  addReconciliation(wrongAuthor);
  await refusedWithoutPosting(wrongAuthor, /authority not verified/);
});

test("negative: uncertain inconsistency or a carried source defect takes the source route", async () => {
  for (const [from, to, pattern] of [
    ["Inconsistency:** PROVEN", "Inconsistency:** UNCERTAIN", /Inconsistency is not PROVEN/],
    ["Source defects:** none", "Source defects:** possible", /Source defects is not none/],
    ["Classification:** AUDIT_REQUIREMENT_ERROR", "Classification:** EVIDENCE_ONLY", /Classification is not AUDIT_REQUIREMENT_ERROR/],
  ]) {
    const world = makeWorld();
    const good = formatChecklistReconciliation({ auditIssue: AUDIT, workIssue: WORK, findingUrl: commentUrl(AUDIT, 2), authorityUrls: [commentUrl(WORK, 100)], items: [{ number: 1, text: ITEM1_NEW }] });
    addReconciliation(world, {}, { raw: good.replace(from, to) });
    await refusedWithoutPosting(world, pattern);
  }
});

test("negative: wrong author, comment predating the report, wrong issue, mismatched identity or declared items", async () => {
  const wrongAuthor = makeWorld();
  addReconciliation(wrongAuthor, {}, { author: "intruder" });
  await refusedWithoutPosting(wrongAuthor, /not authored by the audit's controlling account/);

  const early = makeWorld();
  addReconciliation(early, {}, { created: ts(3) });
  await refusedWithoutPosting(early, /predates the NOT CLEAN report/);

  const wrongIssue = makeWorld();
  wrongIssue.issues[999] = { number: 999, body: "x", state: "OPEN", created_at: ts(-200), author: FOUNDER };
  addReconciliation(wrongIssue, {}, { issue: 999 });
  await refusedWithoutPosting(wrongIssue, /not on the authoritative work Issue/);

  const identity = makeWorld();
  addReconciliation(identity, { auditIssue: 1 });
  await refusedWithoutPosting(identity, /identity does not match/);

  const finding = makeWorld();
  addReconciliation(finding, { findingUrl: commentUrl(AUDIT, 1) });
  await refusedWithoutPosting(finding, /identity does not match/);

  // A result that declares different items than the reconciliation it cites is INCOMPLETE.
  const declared = makeWorld();
  addReconciliation(declared);
  declared.comments[WORK].push({
    id: 103,
    body: formatEvidenceCorrectionResult({
      auditIssue: AUDIT, workIssue: WORK, pr: PR, mergeCommit: MERGE, findingUrl: commentUrl(AUDIT, 2),
      evidenceUrls: [commentUrl(WORK, 101)], reconciliationUrl: commentUrl(WORK, 102), reconciledItems: [1, 2],
    }),
    created_at: ts(30),
    user: { login: FOUNDER },
  });
  const r = await evaluate(declared);
  assert.equal(r.status, Status.INCOMPLETE);
  assert.match(r.reason, /Reconciled items do not equal/);
});

test("negative: a result posted before the reconciliation it cites is not authority", async () => {
  const world = makeWorld();
  addReconciliation(world, {}, { created: ts(40) });
  world.comments[WORK].push({
    id: 103,
    body: formatEvidenceCorrectionResult({
      auditIssue: AUDIT, workIssue: WORK, pr: PR, mergeCommit: MERGE, findingUrl: commentUrl(AUDIT, 2),
      evidenceUrls: [commentUrl(WORK, 101)], reconciliationUrl: commentUrl(WORK, 102), reconciledItems: [1],
    }),
    created_at: ts(30),
    user: { login: FOUNDER },
  });
  const r = await evaluate(world);
  assert.equal(r.status, Status.INCOMPLETE);
  assert.match(r.reason, /not earlier than the result comment/);
});

test("negative: weakened or dropped change-scope baseline", async () => {
  // Replacing the scope item with one that drops the git diff command.
  const dropped = makeWorld();
  addReconciliation(dropped, {}, { raw: formatChecklistReconciliation({ auditIssue: AUDIT, workIssue: WORK, findingUrl: commentUrl(AUDIT, 2), authorityUrls: [commentUrl(WORK, 100)], items: [{ number: 4, text: "Confirm nothing else changed." }] }) });
  dropped.comments[AUDIT][1].body = report({ statuses: ["FAIL", "FAIL", "PASS", "FAIL"] });
  await refusedWithoutPosting(dropped, /drop or alter a mandatory change-scope command/);

  // Replacing it with a stale-base command.
  const stale = makeWorld();
  addReconciliation(stale, { items: [{ number: 4, text: `Confirm scope (\`git diff ${STALE} ${MERGE}\`).` }] });
  stale.comments[AUDIT][1].body = report({ statuses: ["FAIL", "FAIL", "PASS", "FAIL"] });
  await refusedWithoutPosting(stale, /change-scope baseline does not verify/);

  // An original checklist whose scope baseline is already stale is the #1005 route, not a reconciliation.
  const originalStale = makeWorld();
  originalStale.issues[AUDIT].body = auditBody({ checklist: [ITEM1_OLD, ITEM2, ITEM3, scopeItem(STALE)].join("\n") });
  addReconciliation(originalStale);
  await refusedWithoutPosting(originalStale, /original checklist's change-scope baseline does not verify/);
});

test("negative: one re-audit per lineage (a recovery re-audit, or a lineage that already holds one, cannot reconcile again)", async () => {
  const recoveryAudit = makeWorld();
  recoveryAudit.issues[AUDIT].body = auditBody({ disposition: "Evidence-recovery re-audit of audit issue #1100 (issue #883)." });
  addReconciliation(recoveryAudit);
  const r = await record(recoveryAudit);
  assert.equal(r.exitCode, 2);
  assert.equal(r.state, "EVIDENCE_NOT_ELIGIBLE");
  assert.equal(recoveryAudit.posts.length, 0);

  const spent = makeWorld();
  spent.issues[1100] = { number: 1100, body: auditBody({ verdict: "PENDING", disposition: "Evidence-recovery re-audit of audit issue #1099 (issue #883)." }), state: "OPEN", created_at: ts(2), author: FOUNDER };
  addReconciliation(spent);
  const s = await record(spent);
  assert.equal(s.exitCode, 2);
  assert.equal(s.state, "EVIDENCE_NOT_ELIGIBLE");
  assert.equal(spent.posts.length, 0);
});

test("negative: an open source-correction PR underway refuses reconciliation recording", async () => {
  const world = makeWorld({ openPrs: [{ number: 901, state: "OPEN", headRefName: `fix/issue-${WORK}-correction`, body: "", title: "" }] });
  addReconciliation(world);
  const r = await record(world);
  assert.equal(r.exitCode, 2);
  assert.equal(world.posts.length, 0);
});

// -- negatives: replacement checklist divergence -------------------------------------------------

async function preparedWorld() {
  const world = makeWorld();
  addReconciliation(world);
  assert.equal((await record(world)).state, "EVIDENCE_RECORDED");
  const prepared = await runPrepare({ repo: REPO, auditIssue: AUDIT }, makeIo(world));
  assert.equal(prepared.state, "REAUDIT_PREPARED");
  return { world, number: prepared.replacementAuditIssue };
}

test("negative: a replacement hand-edited after prepare (reconciled item, unnamed item, item count) is AMBIGUOUS", async () => {
  for (const [from, to] of [
    [`1. ${ITEM1_NEW}`, "1. Confirm anything at all."],
    [ITEM2, "2. Confirm something weaker."],
    [ITEM3, `${ITEM3}\n5. A surprise extra requirement.`],
    [`${ITEM3}\n`, ""],
  ]) {
    const { world, number } = await preparedWorld();
    assert.ok(world.issues[number].body.includes(from));
    world.issues[number].body = world.issues[number].body.replace(from, to);
    const r = await evaluate(world);
    assert.equal(r.status, Status.AMBIGUOUS, JSON.stringify(from));
    assert.match(r.reason, /verification checklist is not exactly the mechanically corrected checklist/);
  }
});

test("negative: reverting a hand-edit to the unreconciled predecessor checklist is also rejected", async () => {
  const { world, number } = await preparedWorld();
  world.issues[number].body = world.issues[number].body.replace(`1. ${ITEM1_NEW}`, ITEM1_OLD);
  assert.equal((await evaluate(world)).status, Status.AMBIGUOUS);
});

test("negative: the recorded reconciliation being edited away after the result invalidates the satisfied state", async () => {
  const { world } = await preparedWorld();
  world.comments[WORK].find((c) => c.id === 102).body = world.comments[WORK].find((c) => c.id === 102).body.replace("PROVEN", "UNCERTAIN");
  const r = await evaluate(world);
  assert.equal(r.status, Status.INCOMPLETE);
});

// -- unchanged routes ---------------------------------------------------------------------------

test("a result without reconciliation keeps the #883 behavior: checklist cloned unchanged, no equality constraint on a plain replacement", async () => {
  const world = makeWorld();
  const recorded = await runRecord({ repo: REPO, auditIssue: AUDIT, evidence: [commentUrl(WORK, 101)] }, makeIo(world));
  assert.equal(recorded.state, "EVIDENCE_RECORDED");
  assert.equal(world.posts[0].payload.body.includes("reconciliation"), false);
  const prepared = await runPrepare({ repo: REPO, auditIssue: AUDIT }, makeIo(world));
  assert.equal(prepared.state, "REAUDIT_PREPARED");
  assert.equal(parseVerificationChecklistRef(world.issues[prepared.replacementAuditIssue].body), parseVerificationChecklistRef(world.issues[AUDIT].body));
  const direct = composeReplacementAuditBody(world.issues[AUDIT].body, { predecessor: AUDIT, workIssue: WORK, mergeCommit: MERGE, resultUrl: commentUrl(WORK, 7) });
  assert.equal(parseVerificationChecklistRef(direct), parseVerificationChecklistRef(world.issues[AUDIT].body));
  // The record command without evidence or reconciliation is still refused.
  const none = await runRecord({ repo: REPO, auditIssue: AUDIT, evidence: [] }, makeIo(makeWorld()));
  assert.equal(none.exitCode, 2);
});
