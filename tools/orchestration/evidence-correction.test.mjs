// Tests for tools/orchestration/evidence-correction.mjs -- issue #883. Every GitHub interaction is
// an in-memory fake (io members), never the real network or `gh` CLI.
//
// Run with:
//   node --test tools/orchestration/evidence-correction.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  RESULT_HEADING,
  Status,
  composeReplacementAuditBody,
  evaluateEvidenceCorrection,
  formatEvidenceCorrectionResult,
  parseEvidenceCorrectionResult,
  runPrepare,
  runRecord,
  runVerify,
} from "./evidence-correction.mjs";
import {
  checkPreAuditPendingState,
  findMatchingOpenAuditIssues,
  hasCanonicalAuditShape,
  parseCorrectsAuditRef,
  parseEvidenceRecoveryRef,
  parseMergeCommitRef,
  parseStage2Verdict,
  parseWorkIssueRef,
} from "../review-watch/lifecycle-gate.mjs";
import { triggerCommentBody } from "../review-watch/trigger.mjs";
import { runNextReviewTransitionGate } from "./next-review-transition-gate.mjs";

const REPO = "o/r";
const MERGE = "408dbd889f9cd0a5f16b74e7fa8a8c36343f22c2";
const OTHER_MERGE = "0123456789abcdef0123456789abcdef01234567";
const FOUNDER = "founder";
const BOT = "chatgpt-codex-connector[bot]";
const AUDIT = 881;
const WORK = 877;
const PR = 880;

function auditBody({ verdict = "NOT CLEAN", workIssue = WORK, commit = MERGE, extraDisposition = "" } = {}) {
  return [
    "This issue is a read-only control boundary.",
    "",
    "### Merged PR",
    "",
    `https://github.com/${REPO}/pull/${PR}`,
    "",
    "### Work issue",
    "",
    workIssue === "none" ? "none" : `#${workIssue}`,
    "",
    "### Exact merge commit",
    "",
    commit,
    "",
    "### Stage 1 inline review disposition",
    "",
    `Single inline Stage 1 round on PR #${PR}.${extraDisposition}`,
    "",
    "### Audit scope",
    "",
    `Exact merge commit ${commit} on main.`,
    "",
    "**Verification checklist instructions:** the checklist below is a numbered list.",
    "",
    "### Verification checklist",
    "",
    "1. Confirm A.",
    "2. Confirm B.",
    "",
    '**Required response format:** replace "Pending" below with your completed audit report.',
    "",
    "### Findings",
    "",
    "Pending — awaiting Stage 2 audit response.",
    "",
    "### Verdict",
    "",
    verdict,
    "",
    "### Next authorized action",
    "",
    "Pending audit.",
    "",
  ].join("\n");
}

const ts = (minutes) => new Date(Date.UTC(2026, 9, 3, 12, minutes, 0)).toISOString();
const commentUrl = (issue, id) => `https://github.com/${REPO}/issues/${issue}#issuecomment-${id}`;

function notCleanReport(commit = MERGE) {
  return [
    `# Stage 2 Audit Report`,
    "",
    `Exact merge commit: \`${commit}\``,
    "",
    "### Verification checklist",
    "",
    "1. Confirm A — CONFIRMED",
    "2. Confirm B — NOT CONFIRMED: live proof missing",
    "",
    "Verdict: NOT CLEAN",
  ].join("\n");
}

// In-memory GitHub. `world.issues[n]` = { body, state, created_at, author, number }.
// `world.comments[n]` = [{ id, body, created_at, user:{login} }].
function makeWorld(overrides = {}) {
  const world = {
    issues: {
      [AUDIT]: { number: AUDIT, body: auditBody(), state: "OPEN", created_at: ts(0), author: FOUNDER },
      [WORK]: { number: WORK, body: "work", state: "OPEN", created_at: ts(-100), author: FOUNDER },
    },
    comments: {
      [AUDIT]: [
        { id: 1, body: triggerCommentBody(), created_at: ts(1), user: { login: FOUNDER } },
        { id: 2, body: notCleanReport(), created_at: ts(5), user: { login: BOT } },
      ],
      [WORK]: [{ id: 100, body: "live proof run output", created_at: ts(20), user: { login: FOUNDER } }],
    },
    pr: { state: "MERGED", mergeCommit: { oid: MERGE }, mergedAt: ts(-1) },
    openPrs: [],
    nextNumber: 900,
    nextCommentId: 5000,
    posts: [],
    ...overrides,
  };
  return world;
}

function withHtmlUrls(comments, issue) {
  return comments.map((c) => ({ ...c, html_url: commentUrl(issue, c.id), issue_url: `https://api.github.com/repos/${REPO}/issues/${issue}` }));
}

function makeIo(world) {
  return {
    ghApi: async (path) => {
      const m = /^repos\/o\/r\/issues\/(\d+)\/comments$/.exec(path);
      if (!m) throw new Error(`unexpected ghApi path ${path}`);
      return withHtmlUrls(world.comments[m[1]] ?? [], m[1]);
    },
    ghGet: async (path) => {
      let m = /^repos\/o\/r\/issues\/comments\/(\d+)$/.exec(path);
      if (m) {
        for (const [issue, list] of Object.entries(world.comments)) {
          const c = list.find((x) => String(x.id) === m[1]);
          if (c) return withHtmlUrls([c], issue)[0];
        }
        throw new Error("404");
      }
      m = /^repos\/o\/r\/issues\/(\d+)$/.exec(path);
      if (m) {
        const i = world.issues[m[1]];
        if (!i) throw new Error("404");
        return { number: i.number, body: i.body, state: i.state.toLowerCase(), created_at: i.created_at, user: { login: i.author } };
      }
      throw new Error(`unexpected ghGet path ${path}`);
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
      throw new Error(`unexpected ghPost path ${path}`);
    },
    readPr: async () => world.pr,
    listOpenPrs: async () => world.openPrs,
    listIssuesSince: async () =>
      Object.values(world.issues).map((i) => ({
        number: i.number,
        title: i.title ?? "",
        body: i.body,
        state: i.state,
        createdAt: i.created_at,
        author: i.author,
      })),
  };
}

function addEvidence(world, { id = 101, author = FOUNDER, created = ts(30), issue = WORK } = {}) {
  (world.comments[issue] ??= []).push({ id, body: "evidence", created_at: created, user: { login: author } });
  return commentUrl(issue, id);
}

function addResult(world, overrides = {}, { created = ts(40), author = FOUNDER, evidence = [commentUrl(WORK, 100)] } = {}) {
  const body = formatEvidenceCorrectionResult({
    auditIssue: AUDIT,
    workIssue: WORK,
    pr: PR,
    mergeCommit: MERGE,
    findingUrl: commentUrl(AUDIT, 2),
    evidenceUrls: evidence,
    ...overrides,
  });
  const id = world.nextCommentId++;
  world.comments[WORK].push({ id, body, created_at: created, user: { login: author } });
  return { id, body };
}

// -- result comment format ------------------------------------------------------------------

test("format/parse round-trip of the fixed-format result comment", () => {
  const body = formatEvidenceCorrectionResult({
    auditIssue: 881,
    workIssue: 877,
    pr: 880,
    mergeCommit: MERGE,
    findingUrl: commentUrl(881, 2),
    evidenceUrls: [commentUrl(877, 100), commentUrl(877, 101)],
  });
  assert.ok(body.startsWith(RESULT_HEADING));
  const parsed = parseEvidenceCorrectionResult(body);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.fields.evidenceUrls, [commentUrl(877, 100), commentUrl(877, 101)]);
  assert.equal(parsed.fields.classification, "EVIDENCE_ONLY");
  assert.equal(parsed.fields.sourceChanged, "none");
  assert.equal(parsed.fields.disposition, "SATISFIED");
  assert.equal(parsed.fields.mergeCommit, MERGE);
});

test("parseEvidenceCorrectionResult rejects missing heading, duplicate fields, non-comment evidence, short sha, and stray prose", () => {
  assert.equal(parseEvidenceCorrectionResult("hello").ok, false);
  const good = formatEvidenceCorrectionResult({
    auditIssue: 1, workIssue: 2, pr: 3, mergeCommit: MERGE, findingUrl: commentUrl(1, 2), evidenceUrls: [commentUrl(2, 3)],
  });
  assert.equal(parseEvidenceCorrectionResult(`${good}- **PR:** #4\n`).ok, false);
  assert.equal(parseEvidenceCorrectionResult(good.replace(commentUrl(2, 3), "https://example.com/x")).ok, false);
  assert.equal(parseEvidenceCorrectionResult(good.replace(MERGE, "abc1234")).ok, false);
  assert.equal(parseEvidenceCorrectionResult(`${good}it passed, trust me\n`).ok, false);
  const bad = parseEvidenceCorrectionResult(`${RESULT_HEADING}\n\n- **Audit issue:** #881\n`);
  assert.equal(bad.ok, false);
  assert.equal(bad.auditIssue, 881);
});

// -- replacement body -------------------------------------------------------------------------

test("composeReplacementAuditBody: canonical, pending, same identity, provenance markers parse, predecessor text otherwise untouched", () => {
  const predecessor = auditBody();
  const body = composeReplacementAuditBody(predecessor, {
    predecessor: AUDIT,
    workIssue: WORK,
    mergeCommit: MERGE,
    resultUrl: commentUrl(WORK, 7),
  });
  assert.equal(hasCanonicalAuditShape(body), true);
  assert.deepEqual(checkPreAuditPendingState(body), { ok: true });
  assert.equal(parseStage2Verdict(body), "PENDING");
  assert.equal(parseMergeCommitRef(body), MERGE);
  assert.equal(parseWorkIssueRef(body), WORK);
  assert.equal(parseEvidenceRecoveryRef(body), AUDIT);
  assert.equal(parseCorrectsAuditRef(body), AUDIT);
  assert.equal(parseEvidenceRecoveryRef(predecessor), null);
  // Checklist and scope (the unchanged canonical reviewer contract) are byte-identical.
  for (const heading of ["### Audit scope", "### Verification checklist"]) {
    const slice = (text) => text.slice(text.indexOf(heading), text.indexOf("###", text.indexOf(heading) + 5));
    assert.equal(slice(body), slice(predecessor));
  }
  assert.match(body, new RegExp(commentUrl(WORK, 7).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("composeReplacementAuditBody returns null when the predecessor has no disposition block to carry provenance", () => {
  assert.equal(composeReplacementAuditBody("### Verdict\n\nNOT CLEAN\n", { predecessor: 1, workIssue: 2, mergeCommit: MERGE, resultUrl: "u" }), null);
});

// -- lifecycle-gate matching exclusion ----------------------------------------------------------

test("findMatchingOpenAuditIssues excludes a predecessor named by a canonical same-identity evidence-recovery successor", () => {
  const replacementBody = composeReplacementAuditBody(auditBody(), {
    predecessor: AUDIT, workIssue: WORK, mergeCommit: MERGE, resultUrl: commentUrl(WORK, 7),
  });
  const candidates = [
    { number: AUDIT, state: "OPEN", body: auditBody({ verdict: "PENDING" }) },
    { number: 900, state: "OPEN", body: replacementBody },
  ];
  const matches = findMatchingOpenAuditIssues(candidates, { mergeCommitOid: MERGE, executionIssue: WORK });
  assert.deepEqual(matches.map((m) => m.number), [900]);
  // A successor for a DIFFERENT merge never supersedes a predecessor.
  const otherMerge = findMatchingOpenAuditIssues(candidates, { mergeCommitOid: OTHER_MERGE, executionIssue: WORK });
  assert.deepEqual(otherMerge, []);
  // Without the successor, the predecessor remains an ordinary match.
  assert.deepEqual(
    findMatchingOpenAuditIssues([candidates[0]], { mergeCommitOid: MERGE, executionIssue: WORK }).map((m) => m.number),
    [AUDIT],
  );
});

// -- evaluateEvidenceCorrection ----------------------------------------------------------------

const evaluate = (world, opts) => evaluateEvidenceCorrection({ repo: REPO, auditIssue: AUDIT }, makeIo(world), opts);

test("#881 baseline: valid recorded NOT CLEAN, backed report, no result yet -> NO_RESULT (eligible)", async () => {
  const result = await evaluate(makeWorld());
  assert.equal(result.status, Status.NO_RESULT);
  assert.equal(result.workIssue, WORK);
  assert.equal(result.pr, PR);
  assert.equal(result.mergeCommit, MERGE);
  assert.equal(result.reportUrl, commentUrl(AUDIT, 2));
  assert.equal(result.trustedLogin, FOUNDER);
});

test("NOT_ELIGIBLE: not a recorded NOT CLEAN, no work issue, PR not merged at the audited commit, open correction PR, no backed report", async () => {
  let world = makeWorld();
  world.issues[AUDIT].body = auditBody({ verdict: "PENDING" });
  assert.equal((await evaluate(world)).status, Status.NOT_ELIGIBLE);

  world = makeWorld();
  world.issues[AUDIT].body = auditBody({ workIssue: "none" });
  assert.equal((await evaluate(world)).status, Status.NOT_ELIGIBLE);

  world = makeWorld({ pr: { state: "MERGED", mergeCommit: { oid: OTHER_MERGE }, mergedAt: ts(-1) } });
  assert.equal((await evaluate(world)).status, Status.NOT_ELIGIBLE);

  world = makeWorld({ pr: { state: "OPEN", mergeCommit: null, mergedAt: null } });
  assert.equal((await evaluate(world)).status, Status.NOT_ELIGIBLE);

  world = makeWorld({ openPrs: [{ number: 901, state: "OPEN", headRefName: `fix/issue-${WORK}-correction`, body: "", title: "" }] });
  const open = await evaluate(world);
  assert.equal(open.status, Status.NOT_ELIGIBLE);
  assert.match(open.reason, /#901/);

  world = makeWorld();
  world.comments[AUDIT] = [{ id: 1, body: triggerCommentBody(), created_at: ts(1), user: { login: FOUNDER } }];
  assert.equal((await evaluate(world)).status, Status.NOT_ELIGIBLE);

  world = makeWorld();
  world.comments[AUDIT][1].body = notCleanReport().replace("Verdict: NOT CLEAN", "Verdict: CLEAN");
  assert.equal((await evaluate(world)).status, Status.NOT_ELIGIBLE);
});

test("source-defect control: a NOT CLEAN whose report cites a different commit is not eligible for the evidence-only route", async () => {
  const world = makeWorld();
  world.comments[AUDIT][1].body = notCleanReport(OTHER_MERGE);
  const result = await evaluate(world);
  assert.equal(result.status, Status.NOT_ELIGIBLE);
});

test("bound: an evidence-recovery re-audit is itself never eligible (replacement NOT CLEAN follows the source route)", async () => {
  const world = makeWorld();
  world.issues[AUDIT].body = auditBody({ extraDisposition: ` Evidence-recovery re-audit of audit issue #800 (x).` });
  const result = await evaluate(world);
  assert.equal(result.status, Status.NOT_ELIGIBLE);
  assert.match(result.reason, /one evidence-recovery re-audit per exact PR\/work\/merge lineage/);
});

test("bound: a lineage already holding a re-audit of a DIFFERENT predecessor is exhausted", async () => {
  const world = makeWorld();
  world.issues[950] = {
    number: 950,
    body: auditBody({ verdict: "PENDING", extraDisposition: " Evidence-recovery re-audit of audit issue #800 (x)." }),
    state: "OPEN",
    created_at: ts(2),
    author: FOUNDER,
  };
  const result = await evaluate(world);
  assert.equal(result.status, Status.NOT_ELIGIBLE);
  assert.match(result.reason, /#950/);
});

test("evidence-only unsatisfied: malformed result, wrong author, predating result, unverifiable/untrusted/early evidence all stay INCOMPLETE", async () => {
  let world = makeWorld();
  world.comments[WORK].push({ id: 300, body: `${RESULT_HEADING}\n\n- **Audit issue:** #${AUDIT}\n`, created_at: ts(40), user: { login: FOUNDER } });
  assert.equal((await evaluate(world)).status, Status.INCOMPLETE);

  world = makeWorld();
  addResult(world, {}, { author: "someone-else" });
  assert.equal((await evaluate(world)).status, Status.INCOMPLETE);

  world = makeWorld();
  addResult(world, {}, { created: ts(3) });
  assert.equal((await evaluate(world)).status, Status.INCOMPLETE);

  world = makeWorld();
  addResult(world, {}, { evidence: [commentUrl(WORK, 999)] });
  assert.equal((await evaluate(world)).status, Status.INCOMPLETE);

  world = makeWorld();
  world.comments[WORK][0].user.login = "stranger";
  addResult(world);
  assert.equal((await evaluate(world)).status, Status.INCOMPLETE);

  world = makeWorld();
  world.comments[WORK][0].created_at = ts(2);
  addResult(world);
  assert.equal((await evaluate(world)).status, Status.INCOMPLETE);

  world = makeWorld();
  addResult(world, { sourceChanged: undefined });
  const bodyWithSource = world.comments[WORK].at(-1);
  bodyWithSource.body = bodyWithSource.body.replace("**Source changed:** none", "**Source changed:** tools/x.mjs");
  assert.equal((await evaluate(world)).status, Status.INCOMPLETE);
});

test("evidence-only satisfied: durable verified result and unchanged audited source state -> SATISFIED, no replacement yet", async () => {
  const world = makeWorld();
  const { id } = addResult(world);
  const result = await evaluate(world);
  assert.equal(result.status, Status.SATISFIED);
  assert.equal(result.replacement, null);
  assert.equal(result.resultUrl, commentUrl(WORK, id));
});

test("a later result comment supersedes an earlier incomplete one (latest governs)", async () => {
  const world = makeWorld();
  addResult(world, {}, { author: "someone-else", created: ts(35) });
  addResult(world, {}, { created: ts(45) });
  assert.equal((await evaluate(world)).status, Status.SATISFIED);
});

test("provenance mismatch: result naming another merge/work/PR/finding is PROVENANCE_MISMATCH, never satisfied", async () => {
  for (const override of [
    { mergeCommit: OTHER_MERGE },
    { workIssue: 111 },
    { pr: 111 },
    { findingUrl: commentUrl(AUDIT, 1) },
  ]) {
    const world = makeWorld();
    addResult(world, override);
    assert.equal((await evaluate(world)).status, Status.PROVENANCE_MISMATCH, JSON.stringify(override));
  }
});

test("a result for a different audit issue on the same work issue is ignored", async () => {
  const world = makeWorld();
  addResult(world, { auditIssue: 5 });
  assert.equal((await evaluate(world)).status, Status.NO_RESULT);
});

test("replacement present: SATISFIED reports the single re-audit and whether it is still pending", async () => {
  const world = makeWorld();
  const { id } = addResult(world);
  world.issues[900] = {
    number: 900,
    body: composeReplacementAuditBody(auditBody(), { predecessor: AUDIT, workIssue: WORK, mergeCommit: MERGE, resultUrl: commentUrl(WORK, id) }),
    state: "OPEN",
    created_at: ts(50),
    author: FOUNDER,
  };
  const result = await evaluate(world);
  assert.equal(result.status, Status.SATISFIED);
  assert.deepEqual(result.replacement, { number: 900, state: "OPEN", pending: true });
});

test("ambiguity fails closed: two re-audits, a re-audit with no result comment, a closed re-audit", async () => {
  const mk = (resultUrl) =>
    composeReplacementAuditBody(auditBody(), { predecessor: AUDIT, workIssue: WORK, mergeCommit: MERGE, resultUrl });
  let world = makeWorld();
  addResult(world);
  world.issues[900] = { number: 900, body: mk("u"), state: "OPEN", created_at: ts(50), author: FOUNDER };
  world.issues[901] = { number: 901, body: mk("u"), state: "OPEN", created_at: ts(51), author: FOUNDER };
  assert.equal((await evaluate(world)).status, Status.AMBIGUOUS);

  world = makeWorld();
  world.issues[900] = { number: 900, body: mk("u"), state: "OPEN", created_at: ts(50), author: FOUNDER };
  assert.equal((await evaluate(world)).status, Status.AMBIGUOUS);

  world = makeWorld();
  addResult(world);
  world.issues[900] = { number: 900, body: mk("u"), state: "CLOSED", created_at: ts(50), author: FOUNDER };
  assert.equal((await evaluate(world)).status, Status.AMBIGUOUS);
});

// -- record -----------------------------------------------------------------------------------

test("record: verifies cited evidence first, posts exactly one fixed-format comment on the work issue, then reports SATISFIED", async () => {
  const world = makeWorld();
  const evidence = commentUrl(WORK, 100);
  const result = await runRecord({ repo: REPO, auditIssue: AUDIT, evidence: [evidence] }, makeIo(world));
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "EVIDENCE_RECORDED");
  assert.equal(world.posts.length, 1);
  assert.equal(world.posts[0].path, `repos/o/r/issues/${WORK}/comments`);
  assert.ok(world.posts[0].payload.body.startsWith(RESULT_HEADING));
  assert.deepEqual(parseEvidenceCorrectionResult(world.posts[0].payload.body).fields.evidenceUrls, [evidence]);
  // Idempotent: a second run posts nothing.
  const again = await runRecord({ repo: REPO, auditIssue: AUDIT, evidence: [evidence] }, makeIo(world));
  assert.equal(again.exitCode, 0);
  assert.equal(again.alreadyRecorded, true);
  assert.equal(world.posts.length, 1);
});

test("record: unverifiable or missing evidence is refused BEFORE anything is posted", async () => {
  for (const evidence of [[], [commentUrl(WORK, 999)], ["https://example.com/x"]]) {
    const world = makeWorld();
    const result = await runRecord({ repo: REPO, auditIssue: AUDIT, evidence }, makeIo(world));
    assert.equal(result.exitCode, 2);
    assert.equal(world.posts.length, 0);
  }
});

test("record: a non-eligible audit (source-defect control / spent lineage) is refused without posting", async () => {
  const world = makeWorld({ openPrs: [{ number: 901, state: "OPEN", headRefName: `fix/issue-${WORK}-correction`, body: "", title: "" }] });
  const result = await runRecord({ repo: REPO, auditIssue: AUDIT, evidence: [commentUrl(WORK, 100)] }, makeIo(world));
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "EVIDENCE_NOT_ELIGIBLE");
  assert.equal(world.posts.length, 0);
});

// Race: mutate the world as the SECOND evaluation (the freshness re-proof just before the POST)
// begins, i.e. after record's initial evaluation and evidence verification.
function racingIo(world, mutate) {
  const io = makeIo(world);
  let auditReads = 0;
  const inner = io.ghGet;
  io.ghGet = async (path) => {
    if (path === `repos/o/r/issues/${AUDIT}` && ++auditReads === 2) mutate(world);
    return inner(path);
  };
  return io;
}

test("record: authority changing between initial evaluation and the POST prevents the POST (audit edit, correction PR, consumed re-audit allowance)", async () => {
  const mutations = {
    "audit edit": (w) => { w.issues[AUDIT].body += "\nedited"; },
    "correction PR": (w) => { w.openPrs = [{ number: 901, state: "OPEN", headRefName: `fix/issue-${WORK}-correction`, body: "", title: "" }]; },
    "consumed re-audit": (w) => {
      w.issues[900] = {
        number: 900,
        body: composeReplacementAuditBody(auditBody(), { predecessor: AUDIT, workIssue: WORK, mergeCommit: MERGE, resultUrl: "u" }),
        state: "OPEN",
        created_at: ts(50),
        author: FOUNDER,
      };
    },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const world = makeWorld();
    const result = await runRecord({ repo: REPO, auditIssue: AUDIT, evidence: [commentUrl(WORK, 100)] }, racingIo(world, mutate));
    assert.equal(result.exitCode, 2, name);
    assert.equal(world.posts.length, 0, `${name}: nothing may be posted`);
  }
  // Stable positive control.
  const stable = makeWorld();
  const ok = await runRecord({ repo: REPO, auditIssue: AUDIT, evidence: [commentUrl(WORK, 100)] }, racingIo(stable, () => {}));
  assert.equal(ok.exitCode, 0);
  assert.equal(stable.posts.length, 1);
  assert.equal((await runVerify({ repo: REPO, auditIssue: AUDIT }, makeIo(stable))).exitCode, 0);
});

test("record: report content edit at the same permalink prevents the POST", async () => {
  const world = makeWorld();
  const result = await runRecord({ repo: REPO, auditIssue: AUDIT, evidence: [commentUrl(WORK, 100)] }, racingIo(world, (w) => {
    w.comments[AUDIT][1].body += " edited after initial evaluation";
  }));
  assert.equal(result.exitCode, 2);
  assert.equal(world.posts.length, 0);
});

test("record: malformed result plus a newly created replacement (consumed slot hidden behind INCOMPLETE) prevents the POST", async () => {
  const world = makeWorld();
  const result = await runRecord({ repo: REPO, auditIssue: AUDIT, evidence: [commentUrl(WORK, 100)] }, racingIo(world, (w) => {
    w.comments[WORK].push({ id: 7001, body: RESULT_HEADING + " malformed", created_at: ts(41), user: { login: FOUNDER } });
    w.issues[900] = {
      number: 900,
      body: composeReplacementAuditBody(auditBody(), { predecessor: AUDIT, workIssue: WORK, mergeCommit: MERGE, resultUrl: "u" }),
      state: "OPEN",
      created_at: ts(50),
      author: FOUNDER,
    };
  }));
  assert.equal(result.exitCode, 2);
  assert.equal(world.posts.length, 0);
});

test("record: a concurrent authorized record between evaluation and recheck converges idempotently with no duplicate POST", async () => {
  const world = makeWorld();
  const result = await runRecord({ repo: REPO, auditIssue: AUDIT, evidence: [commentUrl(WORK, 100)] }, racingIo(world, (w) => {
    addResult(w);
  }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "EVIDENCE_RECORDED");
  assert.equal(result.alreadyRecorded, true);
  assert.equal(world.posts.length, 0);
});

// -- prepare ----------------------------------------------------------------------------------

test("prepare: refuses (no creation) when evidence is not durably satisfied", async () => {
  for (const world of [makeWorld(), (() => { const w = makeWorld(); addResult(w, { mergeCommit: OTHER_MERGE }); return w; })()]) {
    const result = await runPrepare({ repo: REPO, auditIssue: AUDIT }, makeIo(world));
    assert.equal(result.exitCode, 2);
    assert.equal(world.posts.length, 0);
  }
});

test("prepare: creates exactly one canonical same-identity replacement, leaves the predecessor untouched, and is idempotent on re-entry", async () => {
  const world = makeWorld();
  addResult(world);
  const predecessorBefore = JSON.stringify({ issue: world.issues[AUDIT], comments: world.comments[AUDIT] });
  const io = makeIo(world);
  const result = await runPrepare({ repo: REPO, auditIssue: AUDIT }, io);
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "REAUDIT_PREPARED");
  assert.equal(result.replacementAuditIssue, 900);
  const created = world.posts.filter((p) => p.path === "repos/o/r/issues");
  assert.equal(created.length, 1);
  assert.match(created[0].payload.title, /^\[Audit\] /);
  const body = world.issues[900].body;
  assert.equal(hasCanonicalAuditShape(body), true);
  assert.deepEqual(checkPreAuditPendingState(body), { ok: true });
  assert.equal(parseMergeCommitRef(body), MERGE);
  assert.equal(parseWorkIssueRef(body), WORK);
  assert.equal(parseEvidenceRecoveryRef(body), AUDIT);
  assert.equal(JSON.stringify({ issue: world.issues[AUDIT], comments: world.comments[AUDIT] }), predecessorBefore);

  const again = await runPrepare({ repo: REPO, auditIssue: AUDIT }, io);
  assert.equal(again.exitCode, 0);
  assert.equal(again.state, "REAUDIT_ALREADY_PREPARED");
  assert.equal(again.replacementAuditIssue, 900);
  assert.equal(world.posts.filter((p) => p.path === "repos/o/r/issues").length, 1);

  // The verify surface now reports the single re-audit.
  const verified = await runVerify({ repo: REPO, auditIssue: AUDIT }, io);
  assert.equal(verified.state, "EVIDENCE_SATISFIED");
  assert.equal(verified.replacement.number, 900);
});

test("prepare: a second no-source-change re-audit for the same lineage fails closed (replacement NOT CLEAN is not eligible)", async () => {
  const world = makeWorld();
  addResult(world);
  const io = makeIo(world);
  await runPrepare({ repo: REPO, auditIssue: AUDIT }, io);
  // The replacement reaches a recorded NOT CLEAN with its own backed report.
  world.issues[900].body = world.issues[900].body.replace(/### Verdict\n\nPENDING/, "### Verdict\n\nNOT CLEAN");
  world.comments[900] = [
    { id: 11, body: triggerCommentBody(), created_at: ts(80), user: { login: FOUNDER } },
    { id: 12, body: notCleanReport(), created_at: ts(85), user: { login: BOT } },
  ];
  const second = await evaluateEvidenceCorrection({ repo: REPO, auditIssue: 900 }, io);
  assert.equal(second.status, Status.NOT_ELIGIBLE);
  const prepared = await runPrepare({ repo: REPO, auditIssue: 900 }, io);
  assert.equal(prepared.exitCode, 2);
  assert.equal(world.posts.filter((p) => p.path === "repos/o/r/issues").length, 1);
});

test("prepare --dry-run composes the replacement without creating anything", async () => {
  const world = makeWorld();
  addResult(world);
  const result = await runPrepare({ repo: REPO, auditIssue: AUDIT, dryRun: true }, makeIo(world));
  assert.equal(result.state, "REAUDIT_DRY_RUN");
  assert.equal(world.posts.length, 0);
  assert.equal(parseEvidenceRecoveryRef(result.body), AUDIT);
});

test("prepare: a concurrent preparer's duplicate is detected after creation and fails closed", async () => {
  const world = makeWorld();
  addResult(world);
  const io = makeIo(world);
  const realPost = io.ghPost;
  io.ghPost = async (path, payload) => {
    const out = await realPost(path, payload);
    if (path === "repos/o/r/issues") {
      // Another session lands its own replacement between our create and our re-check.
      world.issues[777] = { number: 777, body: payload.body, state: "OPEN", created_at: ts(90), author: FOUNDER };
    }
    return out;
  };
  const result = await runPrepare({ repo: REPO, auditIssue: AUDIT }, io);
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "EVIDENCE_AMBIGUOUS");
});

// -- end-to-end through the post-merge gate (real evaluator over the in-memory world) ---------

test("#883 end-to-end: NOT CLEAN -> correction (eligible) -> record -> prepare-required -> prepare -> ready; every re-entry is idempotent", async () => {
  const world = makeWorld();
  const io = makeIo(world);
  const controlBody = [
    "## Current state",
    "",
    "- **Lifecycle:** AUDIT",
    `- **Execution:** #${WORK}`,
    "- **Route:** implementation worker",
    `- **PR:** #${PR}`,
    "- **Stage 1:** satisfied",
    `- **Stage 2:** #${AUDIT}`,
    "- **Blocker:** none",
    "- **Founder decision:** none",
    "",
  ].join("\n");
  const gate = () =>
    runNextReviewTransitionGate(
      { repo: REPO, controlIssue: "780" },
      {
        ghIssueViewImpl: async ({ number }) =>
          Number(number) === 780
            ? { body: controlBody, state: "OPEN" }
            : { body: world.issues[number].body, state: world.issues[number].state },
        ghPrStateImpl: async () => ({ headRefOid: "h", state: "MERGED", mergeCommit: { oid: MERGE } }),
        checkPostAuditImpl: async ({ "audit-issue": audit }) => ({
          exitCode: 0,
          state: "OK",
          rawVerdict: "NOT CLEAN",
          verdict: "NOT CLEAN",
          workIssue: WORK,
          auditIssue: Number(audit),
        }),
        reconcileStage2CorrectionPrImpl: async () => ({ crossed: false }),
        evaluateEvidenceCorrectionImpl: (args) => evaluateEvidenceCorrection(args, io),
      },
    );

  const first = await gate();
  assert.equal(first.state, "STAGE2_CORRECTION_REQUIRED");
  assert.equal(first.evidenceOnlyEligible, true);

  const recorded = await runRecord({ repo: REPO, auditIssue: AUDIT, evidence: [commentUrl(WORK, 100)] }, io);
  assert.equal(recorded.state, "EVIDENCE_RECORDED");

  const second = await gate();
  assert.equal(second.state, "STAGE2_EVIDENCE_REAUDIT_PREPARATION_REQUIRED");
  assert.equal(second.nextCommand, `node tools/orchestration/evidence-correction.mjs prepare --repo ${REPO} --audit-issue ${AUDIT}`);
  assert.equal((await gate()).state, "STAGE2_EVIDENCE_REAUDIT_PREPARATION_REQUIRED");

  const prepared = await runPrepare({ repo: REPO, auditIssue: AUDIT }, io);
  assert.equal(prepared.state, "REAUDIT_PREPARED");

  const third = await gate();
  assert.equal(third.state, "STAGE2_EVIDENCE_REAUDIT_READY");
  assert.equal(third.replacementAuditIssue, 900);
  assert.equal(
    third.nextCommand,
    `node tools/orchestration/finalize-audit-breakpoint.mjs --control-issue 780 --execution-issue ${WORK} --pr ${PR} ` +
      `--audit-issue 900 --stale-audit-issue ${AUDIT} --revalidate-uniqueness true && node tools/review-watch/trigger.mjs --repo ${REPO} --kind issue --number 900`,
  );
  assert.equal((await gate()).state, "STAGE2_EVIDENCE_REAUDIT_READY");
  // Exactly one result comment and one replacement were ever created.
  assert.equal(world.posts.filter((p) => p.path.endsWith("/comments")).length, 1);
  assert.equal(world.posts.filter((p) => p.path === "repos/o/r/issues").length, 1);
});

// -- Stage 1 correction on PR #884 ------------------------------------------------------------

test("evidence on another Issue (even by the trusted account, after the report) cannot satisfy record or verify", async () => {
  const world = makeWorld();
  world.issues[999] = { number: 999, body: "unrelated", state: "OPEN", created_at: ts(0), author: FOUNDER };
  const other = addEvidence(world, { id: 777, issue: 999 });
  const rec = await runRecord({ repo: REPO, auditIssue: AUDIT, evidence: [other] }, makeIo(world));
  assert.equal(rec.exitCode, 2);
  assert.match(rec.reason, /not on the authoritative work Issue/);
  assert.equal(world.posts.length, 0);
  // A result comment already on the work issue that cites it is INCOMPLETE, never SATISFIED.
  addResult(world, {}, { evidence: [other] });
  assert.equal((await evaluate(world)).status, Status.INCOMPLETE);
});

test("a spoofed (non-controlling-account) replacement audit is not authority: it neither blocks nor becomes the replacement", async () => {
  const world = makeWorld();
  const { id } = addResult(world);
  world.issues[900] = {
    number: 900,
    body: composeReplacementAuditBody(auditBody(), { predecessor: AUDIT, workIssue: WORK, mergeCommit: MERGE, resultUrl: commentUrl(WORK, id) }),
    state: "OPEN",
    created_at: ts(50),
    author: "mallory",
  };
  const result = await evaluate(world);
  assert.equal(result.status, Status.SATISFIED);
  assert.equal(result.replacement, null);
});

test("a controlling-account replacement not bound to the verified result (wrong URL, or created before it) fails closed", async () => {
  let world = makeWorld();
  addResult(world);
  world.issues[900] = {
    number: 900,
    body: composeReplacementAuditBody(auditBody(), { predecessor: AUDIT, workIssue: WORK, mergeCommit: MERGE, resultUrl: commentUrl(WORK, 4242) }),
    state: "OPEN",
    created_at: ts(50),
    author: FOUNDER,
  };
  assert.equal((await evaluate(world)).status, Status.AMBIGUOUS);

  world = makeWorld();
  const { id } = addResult(world, {}, { created: ts(40) });
  world.issues[900] = {
    number: 900,
    body: composeReplacementAuditBody(auditBody(), { predecessor: AUDIT, workIssue: WORK, mergeCommit: MERGE, resultUrl: commentUrl(WORK, id) }),
    state: "OPEN",
    created_at: ts(39),
    author: FOUNDER,
  };
  assert.equal((await evaluate(world)).status, Status.AMBIGUOUS);
});

test("prepare: editing the predecessor between evaluation and cloning fails closed without creating anything", async () => {
  const world = makeWorld();
  addResult(world);
  const io = makeIo(world);
  const realGet = io.ghGet;
  let auditReads = 0;
  io.ghGet = async (path) => {
    const out = await realGet(path);
    // The evaluation reads the audit once; the clone read is the second. Edit before the second.
    if (path === `repos/${REPO}/issues/${AUDIT}` && ++auditReads === 1) world.issues[AUDIT].body = auditBody({ extraDisposition: " EDITED." });
    return out;
  };
  const result = await runPrepare({ repo: REPO, auditIssue: AUDIT }, io);
  assert.equal(result.exitCode, 2);
  assert.match(result.reason, /changed after the evidence correction was evaluated/);
  assert.equal(world.posts.length, 0);
});

test("prepare: a duplicate replacement appearing immediately before creation fails closed without a second create", async () => {
  const world = makeWorld();
  const { id } = addResult(world);
  const io = makeIo(world);
  const realList = io.listIssuesSince;
  let lists = 0;
  io.listIssuesSince = async (a) => {
    // Second listing is the pre-create recheck: a concurrent preparer has already created one.
    if (++lists === 2) {
      world.issues[880] = {
        number: 880,
        body: composeReplacementAuditBody(auditBody(), { predecessor: AUDIT, workIssue: WORK, mergeCommit: MERGE, resultUrl: commentUrl(WORK, id) }),
        state: "OPEN",
        created_at: ts(55),
        author: FOUNDER,
      };
    }
    return realList(a);
  };
  const result = await runPrepare({ repo: REPO, auditIssue: AUDIT }, io);
  assert.equal(result.exitCode, 2);
  assert.equal(world.posts.filter((p) => p.path === "repos/o/r/issues").length, 0);
});

test("configured non-github.com host: permalinks are accepted when repo/comment identity is valid; wrong host is rejected", async () => {
  const HOST = "ghe.example.com";
  const world = makeWorld();
  const io = makeIo(world);
  const toHost = (u) => u.replace("https://github.com/", `https://${HOST}/`);
  const realGet = io.ghGet;
  io.ghGet = async (path) => {
    const out = await realGet(path);
    if (path === `repos/${REPO}/issues/${AUDIT}`) return { ...out, html_url: `https://${HOST}/${REPO}/issues/${AUDIT}` };
    return out;
  };
  const realApi = io.ghApi;
  io.ghApi = async (path) => (await realApi(path)).map((c) => ({ ...c, html_url: toHost(c.html_url) }));
  const reportUrl = toHost(commentUrl(AUDIT, 2));
  const body = formatEvidenceCorrectionResult({
    auditIssue: AUDIT, workIssue: WORK, pr: PR, mergeCommit: MERGE, findingUrl: reportUrl, evidenceUrls: [toHost(commentUrl(WORK, 100))],
  });
  world.comments[WORK].push({ id: 4000, body, created_at: ts(40), user: { login: FOUNDER } });
  const ok = await evaluateEvidenceCorrection({ repo: REPO, auditIssue: AUDIT }, io);
  assert.equal(ok.status, Status.SATISFIED);
  // Wrong-host evidence on a GHE audit is rejected.
  world.comments[WORK].pop();
  world.comments[WORK].push({
    id: 4001,
    body: formatEvidenceCorrectionResult({ auditIssue: AUDIT, workIssue: WORK, pr: PR, mergeCommit: MERGE, findingUrl: reportUrl, evidenceUrls: [commentUrl(WORK, 100)] }),
    created_at: ts(41),
    user: { login: FOUNDER },
  });
  assert.equal((await evaluateEvidenceCorrection({ repo: REPO, auditIssue: AUDIT }, io)).status, Status.INCOMPLETE);
  assert.equal(parseEvidenceCorrectionResult(body, { host: HOST }).ok, true);
  assert.equal(parseEvidenceCorrectionResult(body).ok, false);
});

test("parseEvidenceCorrectionResult ignores a presentation suffix after the canonical block but not text inside it (#891)", () => {
  const good = formatEvidenceCorrectionResult({
    auditIssue: 2, workIssue: 3, pr: 4, mergeCommit: "a".repeat(40), findingUrl: commentUrl(2, 5), evidenceUrls: [commentUrl(3, 6)],
  });
  assert.equal(parseEvidenceCorrectionResult(good).ok, true);
  const footer = "\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_";
  const withFooter = parseEvidenceCorrectionResult(`${good}${footer}`);
  assert.equal(withFooter.ok, true);
  assert.deepEqual(withFooter.fields, parseEvidenceCorrectionResult(good).fields);
  // Lookalike fields in the suffix cannot override or duplicate canonical authority.
  const look = parseEvidenceCorrectionResult(`${good}\n- **PR:** #99\n- **Evidence:**\n  - https://example.com/x\n`);
  assert.equal(look.ok, true);
  assert.equal(look.fields.pr, 4);
  assert.deepEqual(look.fields.evidenceUrls, [commentUrl(3, 6)]);
  // Free-form text inside the block, a contradictory field, and a missing field still fail closed.
  assert.equal(parseEvidenceCorrectionResult(good.replace("- **Disposition:**", "note\n- **Disposition:**")).ok, false);
  assert.equal(parseEvidenceCorrectionResult(`${good}- **PR:** #99\n${footer}`).ok, false);
  assert.equal(parseEvidenceCorrectionResult(good.replace(/- \*\*Work issue:\*\*.*\n/, "") + footer).ok, false);
});
