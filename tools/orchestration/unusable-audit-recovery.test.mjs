// Tests for tools/orchestration/unusable-audit-recovery.mjs and its next-review-transition-gate.mjs
// routing -- issue #985. Every GitHub interaction is an in-memory fake, never the network or `gh`.
//
// Run with:
//   node --test tools/orchestration/unusable-audit-recovery.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  Status,
  composeReplacementAuditBody,
  evaluateUnusableRecovery,
  runPrepare,
  runVerify,
} from "./unusable-audit-recovery.mjs";
import {
  checkPreAuditPendingState,
  findMatchingOpenAuditIssues,
  hasCanonicalAuditShape,
  parseCorrectsAuditRef,
  parseUnusableReplacementRef,
  parseMergeCommitRef,
  parseStage2Verdict,
  parseWorkIssueRef,
} from "../review-watch/lifecycle-gate.mjs";
import { triggerCommentBody } from "../review-watch/trigger.mjs";
import { runNextReviewTransitionGate } from "./next-review-transition-gate.mjs";

const REPO = "o/r";
const MERGE = "16a01b579e1d146f057cd02c1a122bcf568e2d1f";
const OTHER_MERGE = "0123456789abcdef0123456789abcdef01234567";
const FOUNDER = "founder";
const BOT = "chatgpt-codex-connector[bot]";
const AUDIT = 866;
const WORK = 860;
const PR = 865;

function auditBody({ verdict = "PENDING", workIssue = WORK, commit = MERGE, extraDisposition = "", pr = PR } = {}) {
  return [
    "This issue is a read-only control boundary.",
    "",
    "### Merged PR",
    "",
    `https://github.com/${REPO}/pull/${pr}`,
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
    `Single inline Stage 1 round on PR #${pr}.${extraDisposition}`,
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
    "3. Confirm C.",
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

// The #866 shape: names the exact merge and declares CLEAN, but carries no canonical
// checklist walk-through -> a genuine, substantive, non-completed response.
function unusableResponse(commit = MERGE) {
  return [
    "Audit of the exact merge target.",
    "",
    `Exact merge commit \`${commit}\` was reviewed against main.`,
    "",
    "Verdict: CLEAN",
  ].join("\n");
}

function completedCleanReport(commit = MERGE) {
  return [
    "# Stage 2 Audit Report",
    "",
    `Exact merge commit: \`${commit}\``,
    "",
    "## Verification",
    "",
    "1. Confirm A — CONFIRMED (`git show` output checked)",
    "2. Confirm B — CONFIRMED (tests run: pass)",
    "3. Confirm C — CONFIRMED (grep verified)",
    "",
    "Verdict: CLEAN",
  ].join("\n");
}

function makeWorld(overrides = {}) {
  return {
    issues: {
      [AUDIT]: { number: AUDIT, body: auditBody(), state: "OPEN", created_at: ts(0), author: FOUNDER },
      [WORK]: { number: WORK, body: "work", state: "OPEN", created_at: ts(-100), author: FOUNDER },
    },
    comments: {
      [AUDIT]: [
        { id: 1, body: triggerCommentBody(), created_at: ts(1), user: { login: FOUNDER } },
        { id: 2, body: unusableResponse(), created_at: ts(5), user: { login: BOT } },
      ],
    },
    pr: { state: "MERGED", mergeCommit: { oid: MERGE }, mergedAt: ts(-1) },
    openPrs: [],
    nextNumber: 900,
    posts: [],
    ...overrides,
  };
}

const withHtmlUrls = (comments, issue) =>
  comments.map((c) => ({ ...c, html_url: commentUrl(issue, c.id), issue_url: `https://api.github.com/repos/${REPO}/issues/${issue}` }));

function makeIo(world) {
  return {
    ghApi: async (path) => {
      const m = /^repos\/o\/r\/issues\/(\d+)\/comments$/.exec(path);
      if (!m) throw new Error(`unexpected ghApi path ${path}`);
      return withHtmlUrls(world.comments[m[1]] ?? [], m[1]);
    },
    ghGet: async (path) => {
      const m = /^repos\/o\/r\/issues\/(\d+)$/.exec(path);
      if (!m) throw new Error(`unexpected ghGet path ${path}`);
      const i = world.issues[m[1]];
      if (!i) throw new Error("404");
      return { number: i.number, body: i.body, state: i.state.toLowerCase(), created_at: i.created_at, user: { login: i.author } };
    },
    ghPost: async (path, payload) => {
      world.posts.push({ path, payload });
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
      Object.values(world.issues).map((i) => ({ number: i.number, title: i.title ?? "", body: i.body, state: i.state, createdAt: i.created_at, author: i.author })),
  };
}

const ELIGIBLE_URL = commentUrl(AUDIT, 2);

// -- parsers / body composition --------------------------------------------------------------

test("composeReplacementAuditBody: canonical, PENDING, provenance-marked, retires predecessor via the correction chain", () => {
  const body = composeReplacementAuditBody(auditBody(), { predecessor: AUDIT, workIssue: WORK, mergeCommit: MERGE, responseUrl: ELIGIBLE_URL });
  assert.ok(hasCanonicalAuditShape(body));
  assert.ok(checkPreAuditPendingState(body).ok);
  assert.equal(parseStage2Verdict(body), "PENDING");
  assert.equal(parseUnusableReplacementRef(body), AUDIT);
  assert.equal(parseCorrectsAuditRef(body), AUDIT);
  assert.equal(parseMergeCommitRef(body), MERGE);
  assert.equal(parseWorkIssueRef(body), WORK);
  assert.ok(body.includes(ELIGIBLE_URL));
  // never coaches the reviewer about reply shape
  assert.ok(!/heading|format|reply with/i.test(body.split("### Stage 1 inline review disposition")[1].split("### Audit scope")[0].replace(/Single inline[^\n]*/, "")));
});

test("parseUnusableReplacementRef: absent -> null; ordinary audits are unaffected", () => {
  assert.equal(parseUnusableReplacementRef(auditBody()), null);
});

test("findMatchingOpenAuditIssues: a canonical unusable-replacement supersedes its preserved predecessor", () => {
  const replacement = composeReplacementAuditBody(auditBody(), { predecessor: AUDIT, workIssue: WORK, mergeCommit: MERGE, responseUrl: ELIGIBLE_URL });
  const candidates = [
    { number: AUDIT, state: "OPEN", body: auditBody() },
    { number: 900, state: "OPEN", body: replacement },
  ];
  const matches = findMatchingOpenAuditIssues(candidates, { mergeCommitOid: MERGE, executionIssue: WORK });
  assert.deepEqual(matches.map((c) => c.number), [900]);
});

// -- evaluate ---------------------------------------------------------------------------------

test("evaluate: exact #866-shaped unusable response with no replacement -> ELIGIBLE (parser verdict unchanged)", async () => {
  const world = makeWorld();
  const r = await evaluateUnusableRecovery({ repo: REPO, auditIssue: AUDIT }, makeIo(world));
  assert.equal(r.status, Status.ELIGIBLE);
  assert.equal(r.responseUrl, ELIGIBLE_URL);
  assert.equal(r.workIssue, WORK);
  assert.equal(r.pr, PR);
});

test("evaluate: a completed report (#230 evidence threshold preserved) is NOT_ELIGIBLE -- recovery never rehabilitates", async () => {
  const world = makeWorld();
  world.comments[AUDIT][1].body = completedCleanReport();
  const r = await evaluateUnusableRecovery({ repo: REPO, auditIssue: AUDIT }, makeIo(world));
  assert.equal(r.status, Status.NOT_ELIGIBLE);
});

test("evaluate: waiting (no response) and untriggered audits are NOT_ELIGIBLE", async () => {
  const waiting = makeWorld();
  waiting.comments[AUDIT] = [waiting.comments[AUDIT][0]];
  assert.equal((await evaluateUnusableRecovery({ repo: REPO, auditIssue: AUDIT }, makeIo(waiting))).status, Status.NOT_ELIGIBLE);
  const untriggered = makeWorld();
  untriggered.comments[AUDIT] = [];
  assert.equal((await evaluateUnusableRecovery({ repo: REPO, auditIssue: AUDIT }, makeIo(untriggered))).status, Status.NOT_ELIGIBLE);
});

test("evaluate: progress-only response is not unusable (stays ordinary waiting)", async () => {
  const world = makeWorld();
  world.comments[AUDIT][1].body = "Starting #866.";
  assert.equal((await evaluateUnusableRecovery({ repo: REPO, auditIssue: AUDIT }, makeIo(world))).status, Status.NOT_ELIGIBLE);
});

test("evaluate: recorded verdict, closed audit, open correction PR, unmerged PR are all NOT_ELIGIBLE", async () => {
  const recorded = makeWorld();
  recorded.issues[AUDIT].body = auditBody({ verdict: "NOT CLEAN" });
  assert.equal((await evaluateUnusableRecovery({ repo: REPO, auditIssue: AUDIT }, makeIo(recorded))).status, Status.NOT_ELIGIBLE);
  const closed = makeWorld();
  closed.issues[AUDIT].state = "CLOSED";
  assert.equal((await evaluateUnusableRecovery({ repo: REPO, auditIssue: AUDIT }, makeIo(closed))).status, Status.NOT_ELIGIBLE);
  const wrongMerge = makeWorld({ pr: { state: "MERGED", mergeCommit: { oid: OTHER_MERGE }, mergedAt: ts(-1) } });
  assert.equal((await evaluateUnusableRecovery({ repo: REPO, auditIssue: AUDIT }, makeIo(wrongMerge))).status, Status.NOT_ELIGIBLE);
  const unmerged = makeWorld({ pr: { state: "OPEN", mergeCommit: null } });
  assert.equal((await evaluateUnusableRecovery({ repo: REPO, auditIssue: AUDIT }, makeIo(unmerged))).status, Status.NOT_ELIGIBLE);
});

test("evaluate: an audit that is itself a replacement is NOT_ELIGIBLE and names its predecessor (second unusable -> founder)", async () => {
  const world = makeWorld();
  world.issues[AUDIT].body = composeReplacementAuditBody(auditBody(), { predecessor: 700, workIssue: WORK, mergeCommit: MERGE, responseUrl: commentUrl(700, 2) });
  const r = await evaluateUnusableRecovery({ repo: REPO, auditIssue: AUDIT }, makeIo(world));
  assert.equal(r.status, Status.NOT_ELIGIBLE);
  assert.equal(r.predecessorAuditIssue, 700);
});

test("evaluate: a lineage already holding a replacement of a different predecessor is NOT_ELIGIBLE (bound exhausted)", async () => {
  const world = makeWorld();
  world.issues[950] = {
    number: 950,
    state: "OPEN",
    created_at: ts(80),
    author: FOUNDER,
    body: composeReplacementAuditBody(auditBody(), { predecessor: 123, workIssue: WORK, mergeCommit: MERGE, responseUrl: commentUrl(123, 2) }),
  };
  assert.equal((await evaluateUnusableRecovery({ repo: REPO, auditIssue: AUDIT }, makeIo(world))).status, Status.NOT_ELIGIBLE);
});

test("evaluate: another unrelated canonical audit of the same target is AMBIGUOUS, never a guess", async () => {
  const world = makeWorld();
  world.issues[951] = { number: 951, state: "OPEN", created_at: ts(80), author: FOUNDER, body: auditBody() };
  assert.equal((await evaluateUnusableRecovery({ repo: REPO, auditIssue: AUDIT }, makeIo(world))).status, Status.AMBIGUOUS);
});

test("evaluate: an untrusted-author copy of the canonical headings is ignored as lineage authority", async () => {
  const world = makeWorld();
  world.issues[951] = { number: 951, state: "OPEN", created_at: ts(80), author: "someone-else", body: auditBody() };
  assert.equal((await evaluateUnusableRecovery({ repo: REPO, auditIssue: AUDIT }, makeIo(world))).status, Status.ELIGIBLE);
});

// -- prepare: idempotence across every interruption boundary ----------------------------------

test("prepare: creates exactly one replacement, bound to the unusable response; re-entry is idempotent and creates no duplicate", async () => {
  const world = makeWorld();
  const io = makeIo(world);
  const first = await runPrepare({ repo: REPO, auditIssue: AUDIT }, io);
  assert.equal(first.state, "REPLACEMENT_PREPARED");
  assert.equal(first.replacementAuditIssue, 900);
  const created = world.issues[900];
  assert.ok(created.title.startsWith("[Audit] "));
  assert.ok(hasCanonicalAuditShape(created.body));
  assert.equal(parseUnusableReplacementRef(created.body), AUDIT);
  assert.ok(created.body.includes(ELIGIBLE_URL));

  const again = await runPrepare({ repo: REPO, auditIssue: AUDIT }, io);
  assert.equal(again.state, "REPLACEMENT_ALREADY_PREPARED");
  assert.equal(again.replacementAuditIssue, 900);
  assert.equal(world.posts.length, 1, "no second Issue created");
  // The predecessor, its trigger and its response are never touched.
  assert.equal(world.issues[AUDIT].body, auditBody());
  assert.equal(world.comments[AUDIT].length, 2);
  assert.equal(world.posts.some((p) => /comments$/.test(p.path)), false);
});

test("prepare: dry run composes without mutating", async () => {
  const world = makeWorld();
  const r = await runPrepare({ repo: REPO, auditIssue: AUDIT, dryRun: true }, makeIo(world));
  assert.equal(r.state, "REPLACEMENT_DRY_RUN");
  assert.equal(world.posts.length, 0);
});

test("prepare: refuses (exit 2) when not eligible and when the predecessor body changes between evaluation and cloning", async () => {
  const world = makeWorld();
  world.comments[AUDIT][1].body = completedCleanReport();
  const refused = await runPrepare({ repo: REPO, auditIssue: AUDIT }, makeIo(world));
  assert.equal(refused.exitCode, 2);
  assert.equal(world.posts.length, 0);

  const raced = makeWorld();
  const io = makeIo(raced);
  let reads = 0;
  const baseGet = io.ghGet;
  io.ghGet = async (path) => {
    const out = await baseGet(path);
    if (path.endsWith(`/issues/${AUDIT}`) && ++reads === 2) out.body += "\nedited";
    return out;
  };
  const r = await runPrepare({ repo: REPO, auditIssue: AUDIT }, io);
  assert.equal(r.exitCode, 2);
  assert.equal(raced.posts.length, 0);
});

test("verify: reports ELIGIBLE then REPLACEMENT_EXISTS after prepare", async () => {
  const world = makeWorld();
  const io = makeIo(world);
  assert.equal((await runVerify({ repo: REPO, auditIssue: AUDIT }, io)).state, "UNUSABLE_RECOVERY_ELIGIBLE");
  await runPrepare({ repo: REPO, auditIssue: AUDIT }, io);
  const after = await runVerify({ repo: REPO, auditIssue: AUDIT }, io);
  assert.equal(after.state, "UNUSABLE_RECOVERY_REPLACEMENT_EXISTS");
  assert.equal(after.replacement.number, 900);
  assert.equal(after.replacement.pending, true);
});

test("provenance mismatch: a replacement not citing / predating the unusable response, a closed replacement, or two replacements all fail closed", async () => {
  const mkReplacement = (overrides = {}) => ({
    number: 900,
    state: "OPEN",
    created_at: ts(80),
    author: FOUNDER,
    body: composeReplacementAuditBody(auditBody(), { predecessor: AUDIT, workIssue: WORK, mergeCommit: MERGE, responseUrl: ELIGIBLE_URL }),
    ...overrides,
  });
  const uncited = makeWorld();
  uncited.issues[900] = mkReplacement({ body: composeReplacementAuditBody(auditBody(), { predecessor: AUDIT, workIssue: WORK, mergeCommit: MERGE, responseUrl: commentUrl(AUDIT, 999) }) });
  assert.equal((await evaluateUnusableRecovery({ repo: REPO, auditIssue: AUDIT }, makeIo(uncited))).status, Status.AMBIGUOUS);
  const predating = makeWorld();
  predating.issues[900] = mkReplacement({ created_at: ts(2) });
  assert.equal((await evaluateUnusableRecovery({ repo: REPO, auditIssue: AUDIT }, makeIo(predating))).status, Status.AMBIGUOUS);
  const closed = makeWorld();
  closed.issues[900] = mkReplacement({ state: "CLOSED" });
  assert.equal((await evaluateUnusableRecovery({ repo: REPO, auditIssue: AUDIT }, makeIo(closed))).status, Status.AMBIGUOUS);
  const two = makeWorld();
  two.issues[900] = mkReplacement();
  two.issues[901] = mkReplacement({ number: 901 });
  assert.equal((await evaluateUnusableRecovery({ repo: REPO, auditIssue: AUDIT }, makeIo(two))).status, Status.AMBIGUOUS);
  const wrongMerge = makeWorld();
  wrongMerge.issues[900] = mkReplacement({
    body: composeReplacementAuditBody(auditBody({ commit: OTHER_MERGE }), { predecessor: AUDIT, workIssue: WORK, mergeCommit: OTHER_MERGE, responseUrl: ELIGIBLE_URL }),
  });
  // different merge identity is not even same-target lineage -> ignored, still ELIGIBLE (never adopted)
  assert.equal((await evaluateUnusableRecovery({ repo: REPO, auditIssue: AUDIT }, makeIo(wrongMerge))).status, Status.ELIGIBLE);
});

// -- gate routing -----------------------------------------------------------------------------

const CONTROL_BODY = [
  "- **Lifecycle:** AUDIT",
  "- **Execution:** #860",
  "- **PR:** #865",
  "- **Stage 1:** requested",
  "- **Stage 2:** #866",
  "- **Blocker:** none",
].join("\n");

const GATE_BASE = {
  ghIssueViewImpl: async (args) => ({ body: Number(args.number ?? args.controlIssue) === AUDIT ? auditBody() : CONTROL_BODY, state: "OPEN" }),
  ghPrStateImpl: async () => ({ headRefOid: "mergedhead", state: "MERGED", mergeCommit: { oid: MERGE } }),
  checkPostAuditImpl: async () => ({
    exitCode: 2,
    state: "RESPONSE_UNUSABLE",
    rawVerdict: "PENDING",
    workIssue: WORK,
    auditIssue: AUDIT,
    reportEvidence: { backed: false, hasGenuineResponse: true, hasUnusableGenuineResponse: true, genuineResponses: [{ id: 2, url: ELIGIBLE_URL }] },
  }),
};
const eligible = { status: "ELIGIBLE", workIssue: WORK, pr: PR, mergeCommit: MERGE, responseUrl: ELIGIBLE_URL, replacement: null };

test("gate: first unusable response with no replacement -> exactly one prepare command, bounded envelope", async () => {
  const result = await runNextReviewTransitionGate({ repo: REPO, auditIssue: String(AUDIT) }, { ...GATE_BASE, evaluateUnusableRecoveryImpl: async () => eligible });
  assert.equal(result.state, "STAGE2_UNUSABLE_REPLACEMENT_PREPARATION_REQUIRED");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stopAfter, true);
  assert.equal(result.nextCommand, `node tools/orchestration/unusable-audit-recovery.mjs prepare --repo ${REPO} --audit-issue ${AUDIT}`);
  assert.equal(result.actionEnvelope.mode, "bounded");
  assert.deepEqual(result.actionEnvelope.authorizedActions, ["run-unusable-audit-recovery-prepare"]);
});

test("gate: replacement created but not projected -> finalize with --stale-audit-issue then exactly one trigger", async () => {
  const result = await runNextReviewTransitionGate(
    { repo: REPO, controlIssue: "867" },
    { ...GATE_BASE, evaluateUnusableRecoveryImpl: async () => ({ ...eligible, status: "REPLACEMENT_EXISTS", replacement: { number: 900, state: "OPEN", pending: true } }) },
  );
  assert.equal(result.state, "STAGE2_UNUSABLE_REPLACEMENT_READY");
  assert.equal(result.replacementAuditIssue, 900);
  assert.equal(
    result.nextCommand,
    `node tools/orchestration/finalize-audit-breakpoint.mjs --control-issue 867 --execution-issue ${WORK} --pr ${PR} --audit-issue 900 ` +
      `--stale-audit-issue ${AUDIT} --revalidate-uniqueness true && node tools/review-watch/trigger.mjs --repo ${REPO} --kind issue --number 900`,
  );
  assert.deepEqual(result.actionEnvelope.authorizedActions, ["write-control-snapshot", "post-stage2-reviewer-trigger"]);
});

test("gate: direct-reference mode verifies then triggers the replacement, no control write", async () => {
  const result = await runNextReviewTransitionGate(
    { repo: REPO, auditIssue: String(AUDIT) },
    { ...GATE_BASE, evaluateUnusableRecoveryImpl: async () => ({ ...eligible, status: "REPLACEMENT_EXISTS", replacement: { number: 900, state: "OPEN", pending: true } }) },
  );
  assert.equal(result.state, "STAGE2_UNUSABLE_REPLACEMENT_READY");
  assert.deepEqual(result.actionEnvelope.authorizedActions, ["verify-direct-reference-audit", "post-stage2-reviewer-trigger"]);
});

test("gate: second unusable (replacement itself unusable) keeps STAGE2_RESPONSE_UNUSABLE, mode none, names the predecessor, no third audit", async () => {
  const result = await runNextReviewTransitionGate(
    { repo: REPO, auditIssue: "900" },
    {
      ...GATE_BASE,
      checkPostAuditImpl: async () => ({ ...(await GATE_BASE.checkPostAuditImpl()), auditIssue: 900 }),
      evaluateUnusableRecoveryImpl: async () => ({ status: "NOT_ELIGIBLE", reason: "this audit is itself a replacement audit", predecessorAuditIssue: AUDIT }),
    },
  );
  assert.equal(result.state, "STAGE2_RESPONSE_UNUSABLE");
  assert.equal(result.exitCode, 4);
  assert.deepEqual(result.unusableRecovery, { status: "NOT_ELIGIBLE", reason: "this audit is itself a replacement audit", predecessorAuditIssue: AUDIT });
  assert.deepEqual(result.actionEnvelope, { mode: "none", authorizedActions: [] });
});

test("gate: a non-pending replacement, ambiguous provenance, or an evaluator crash all fail closed to AMBIGUOUS", async () => {
  const cases = [
    async () => ({ ...eligible, status: "REPLACEMENT_EXISTS", replacement: { number: 900, state: "OPEN", pending: false } }),
    async () => ({ status: "AMBIGUOUS", reason: "replacement not bound" }),
    async () => {
      throw new Error("gh exploded");
    },
    async () => ({ status: "SOMETHING_NEW" }),
  ];
  for (const evaluateUnusableRecoveryImpl of cases) {
    const result = await runNextReviewTransitionGate({ repo: REPO, auditIssue: String(AUDIT) }, { ...GATE_BASE, evaluateUnusableRecoveryImpl });
    assert.equal(result.state, "AMBIGUOUS");
    assert.equal(result.exitCode, 4);
    assert.equal(result.nextCommand, undefined);
  }
});

test("gate: ordinary waiting, backed CLEAN and report-ready paths never consult the recovery evaluator", async () => {
  const boom = async () => {
    throw new Error("evaluator must not run");
  };
  const waiting = await runNextReviewTransitionGate(
    { repo: REPO, auditIssue: String(AUDIT) },
    { ...GATE_BASE, checkPostAuditImpl: async () => ({ exitCode: 0, state: "OK", rawVerdict: "PENDING", workIssue: WORK, auditIssue: AUDIT, reportEvidence: { hasTrigger: true } }), evaluateUnusableRecoveryImpl: boom },
  );
  assert.equal(waiting.state, "NO_ACTION_YET");
  const ready = await runNextReviewTransitionGate(
    { repo: REPO, auditIssue: String(AUDIT) },
    { ...GATE_BASE, checkPostAuditImpl: async () => ({ exitCode: 0, state: "REPORT_READY_TO_RECORD", workIssue: WORK, auditIssue: AUDIT }), evaluateUnusableRecoveryImpl: boom },
  );
  assert.equal(ready.state, "STAGE2_REPORT_READY_TO_RECORD");
});

// -- end-to-end over the in-memory world: every interruption boundary -------------------------

test("end-to-end: gate -> prepare -> gate (READY) is idempotent, and the replacement is the sole current candidate", async () => {
  const world = makeWorld();
  const io = makeIo(world);
  const evaluateUnusableRecoveryImpl = (args) => evaluateUnusableRecovery(args, io);
  const gate = () => runNextReviewTransitionGate({ repo: REPO, auditIssue: String(AUDIT) }, { ...GATE_BASE, evaluateUnusableRecoveryImpl });

  assert.equal((await gate()).state, "STAGE2_UNUSABLE_REPLACEMENT_PREPARATION_REQUIRED");
  assert.equal((await runPrepare({ repo: REPO, auditIssue: AUDIT }, io)).state, "REPLACEMENT_PREPARED");
  const ready = await gate();
  assert.equal(ready.state, "STAGE2_UNUSABLE_REPLACEMENT_READY");
  assert.equal(ready.replacementAuditIssue, 900);
  // re-entering before projection never creates a second replacement
  assert.equal((await runPrepare({ repo: REPO, auditIssue: AUDIT }, io)).state, "REPLACEMENT_ALREADY_PREPARED");
  assert.equal(Object.keys(world.issues).filter((n) => Number(n) >= 900).length, 1);
  // sole-candidate supersession: only the replacement is current for the exact merge/work identity
  const candidates = Object.values(world.issues).map((i) => ({ number: i.number, state: i.state, body: i.body }));
  assert.deepEqual(findMatchingOpenAuditIssues(candidates, { mergeCommitOid: MERGE, executionIssue: WORK }).map((c) => c.number), [900]);
});
