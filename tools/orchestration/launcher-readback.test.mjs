import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReadEffect, projectionExpectation, singlePointer } from "./launcher-readback.mjs";
import { TRANSITIONS, classifyExternalEffect, verifyPostcondition, EffectClass } from "./launcher-step.mjs";

const NO_POINTER = { ok: false, reason: "Execution Plan Index has no settled Dispatch manifest pointer (found: null)" };

function make({ control = "- **Lifecycle:** PLAN_READY\n", controlState = "OPEN", issues = {}, comments = {}, manifest = NO_POINTER, pr = null } = {}) {
  return buildReadEffect({
    repo: "o/r",
    controlIssue: 379,
    executionIssue: 73,
    readIssue: ({ number }) => (number === 379 ? { body: control, state: controlState } : issues[number]),
    readComments: (n) => comments[n] ?? [],
    readPr: () => pr,
    verifyManifest: async () => manifest,
  }).readEffect;
}
const cls = (e) => (verifyPostcondition(e) ? "PROVED" : classifyExternalEffect(e));

test("singlePointer names exactly one distinct pointer or none", () => {
  assert.equal(singlePointer("#824"), 824);
  assert.equal(singlePointer("#824 and #825"), null);
  assert.equal(singlePointer("none"), null);
});

test("projectionExpectation binds each projection to its own successor", () => {
  assert.deepEqual(projectionExpectation("READY_TO_PROJECT_ROUTED", {}).expected, { Lifecycle: "ROUTED" });
  assert.equal(projectionExpectation("READY_TO_PROJECT_PLAN_READY", {}), null);
  assert.deepEqual(projectionExpectation("READY_TO_PROJECT_PLAN_READY", { planIndexUrl: "u" }).expected, { Lifecycle: "PLAN_READY", Plan: "u" });
});

test("projection: wrong-successor proposal and stale body are not success; exact body is", async () => {
  const t = TRANSITIONS.READY_TO_PROJECT_ROUTED;
  const verdict = { proposedBody: "- **Lifecycle:** ROUTED\n" };
  assert.equal(cls(await make({ control: "- **Lifecycle:** PLAN_READY\n" })(t, verdict)), EffectClass.NOT_COMPLETED);
  assert.equal(cls(await make({ control: "- **Lifecycle:** ROUTED\n" })(t, verdict)), "PROVED");
  // a changed-but-wrong successor (BLOCKED) is absent, never present
  assert.equal(cls(await make({ control: "- **Lifecycle:** BLOCKED\n" })(t, verdict)), EffectClass.NOT_COMPLETED);
  // the gate proposing a different successor than the transition's own is ambiguous
  assert.equal(cls(await make()(t, { proposedBody: "- **Lifecycle:** EXECUTING\n" })), EffectClass.AMBIGUOUS);
});

test("PLAN_READY projection requires both Lifecycle and the canonical Plan pointer", async () => {
  const t = TRANSITIONS.READY_TO_PROJECT_PLAN_READY;
  const verdict = { planIndexUrl: "https://x/plan", proposedBody: "- **Lifecycle:** PLAN_READY\n- **Plan:** https://x/plan\n" };
  assert.equal(cls(await make({ control: "- **Lifecycle:** PLAN_READY\n- **Plan:** https://x/old\n" })(t, verdict)), EffectClass.NOT_COMPLETED);
  assert.equal(cls(await make({ control: verdict.proposedBody })(t, verdict)), "PROVED");
});

test("manifest transition: absent -> retry; manifest present but not ROUTED -> completed-unprojected; both -> proved", async () => {
  const t = TRANSITIONS.READY_TO_RUN_DISPATCH_MANIFEST;
  const v = { executionIssue: 73 };
  assert.equal(cls(await make()(t, v)), EffectClass.NOT_COMPLETED);
  assert.equal(cls(await make({ manifest: { ok: true } })(t, v)), EffectClass.COMPLETED_UNPROJECTED);
  assert.equal(cls(await make({ manifest: { ok: true }, control: "- **Lifecycle:** ROUTED\n" })(t, v)), "PROVED");
  // ROUTED without a verified manifest is contradictory; an unreadable/malformed manifest is ambiguous
  assert.equal(cls(await make({ control: "- **Lifecycle:** ROUTED\n" })(t, v)), EffectClass.AMBIGUOUS);
  assert.equal(cls(await make({ manifest: { ok: false, reason: "malformed" } })(t, v)), EffectClass.AMBIGUOUS);
  assert.equal(cls(await make({ manifest: { ok: false, operationalError: true, reason: "net" } })(t, v)), EffectClass.AMBIGUOUS);
  assert.equal(cls(await make()(t, { executionIssue: 99 })), EffectClass.AMBIGUOUS);
});

test("Stage 2 record: PENDING absent, recorded present, malformed ambiguous, missing identity ambiguous", async () => {
  const t = TRANSITIONS.STAGE2_REPORT_READY_TO_RECORD;
  const aud = (v) => ({ 825: { body: `### Verdict\n\n${v}\n`, state: "OPEN" } });
  const v = (verdict) => ({ auditIssue: 825, postAudit: { reportEvidence: { backed: true, verdict } } });
  assert.equal(cls(await make({ issues: aud("PENDING") })(t, v("CLEAN"))), EffectClass.NOT_COMPLETED);
  assert.equal(cls(await make({ issues: aud("NOT CLEAN") })(t, v("NOT CLEAN"))), "PROVED");
  assert.equal(cls(await make({ issues: aud("CLEAN") })(t, v("CLEAN"))), "PROVED");
  // a settled-but-different value (preparation-time NOT CLEAN placeholder over a CLEAN report) is not the promotion
  assert.equal(cls(await make({ issues: aud("NOT CLEAN") })(t, v("CLEAN"))), EffectClass.NOT_COMPLETED);
  assert.equal(cls(await make({ issues: aud("MAYBE") })(t, v("CLEAN"))), EffectClass.AMBIGUOUS);
  assert.equal(cls(await make({ issues: aud("CLEAN") })(t, { auditIssue: 825 })), EffectClass.AMBIGUOUS); // no report-backed verdict
  assert.equal(cls(await make({ issues: aud("CLEAN") })(t, {})), EffectClass.AMBIGUOUS);
});

test("Stage 2 trigger: trigger.mjs authority proves it (Actions bot included); none retries; closed audits fail closed", async () => {
  const t = TRANSITIONS.STAGE2_TRIGGER_REQUIRED;
  const trig = { id: 1, body: "@codex review", authorPermission: "write" };
  const open = { 825: { body: "", state: "OPEN" } };
  assert.equal(cls(await make({ issues: open })(t, { auditIssue: 825 })), EffectClass.NOT_COMPLETED);
  assert.equal(cls(await make({ issues: open, comments: { 825: [trig] } })(t, { auditIssue: 825 })), "PROVED");
  // the workflow posts as github-actions[bot], which has no collaborator permission
  const bot = { id: 3, body: "@codex review", authorPermission: "none", login: "github-actions[bot]", created_at: "2026-10-01T00:00:00Z" };
  assert.equal(cls(await make({ issues: open, comments: { 825: [bot] } })(t, { auditIssue: 825 })), "PROVED");
  assert.equal(cls(await make({ issues: open, comments: { 825: [{ id: 4, body: "unrelated" }] } })(t, { auditIssue: 825 })), EffectClass.NOT_COMPLETED);
  assert.equal(cls(await make({ issues: { 825: { body: "", state: "CLOSED" } } })(t, { auditIssue: 825 })), EffectClass.AMBIGUOUS);
});

test("Stage 2 close: audit+work closed but control open is completed-unprojected (reconcile, no replay)", async () => {
  const t = TRANSITIONS.STAGE2_CLOSE_READY;
  const v = { auditIssue: 825, postAudit: { workIssue: 73 } };
  const st = (a, w) => ({ 825: { body: "", state: a }, 73: { body: "", state: w } });
  assert.equal(cls(await make({ issues: st("OPEN", "OPEN") })(t, v)), EffectClass.NOT_COMPLETED);
  assert.equal(cls(await make({ issues: st("OPEN", "CLOSED") })(t, v)), EffectClass.NOT_COMPLETED); // audit-only resume shape
  assert.equal(cls(await make({ issues: st("CLOSED", "CLOSED") })(t, v)), EffectClass.COMPLETED_UNPROJECTED);
  assert.equal(cls(await make({ issues: st("CLOSED", "CLOSED"), controlState: "CLOSED" })(t, v)), "PROVED");
  assert.equal(cls(await make({ issues: st("CLOSED", "OPEN") })(t, v)), EffectClass.AMBIGUOUS);
  assert.equal(cls(await make({ issues: st("OPEN", "OPEN"), controlState: "CLOSED" })(t, v)), EffectClass.AMBIGUOUS);
});

test("correction PR finalization: PR open at the gate head; projected only when control points at it with Stage 1 requested", async () => {
  const t = TRANSITIONS.STAGE2_CORRECTION_PR_NEEDS_FINALIZATION;
  const v = { pr: 830, head: "h1", repo: "o/r" };
  const pr = { state: "OPEN", headRefOid: "h1" };
  const stale = "- **Lifecycle:** AUDIT\n- **PR:** #824\n- **Stage 1:** none\n";
  const done = "- **Lifecycle:** REVIEW\n- **PR:** #830\n- **Stage 1:** requested\n";
  assert.equal(cls(await make({ control: stale, pr })(t, v)), EffectClass.COMPLETED_UNPROJECTED);
  assert.equal(cls(await make({ control: done, pr })(t, v)), "PROVED");
  assert.equal(cls(await make({ control: done, pr: { state: "OPEN", headRefOid: "h2" } })(t, v)), EffectClass.AMBIGUOUS);
  assert.equal(cls(await make({ control: done, pr: { state: "CLOSED", headRefOid: "h1" } })(t, v)), EffectClass.AMBIGUOUS);
});

test("merge read-back requires the authorized head; a different merged head is ambiguous", async () => {
  const t = TRANSITIONS.STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2;
  const v = { pr: 824, head: "h1" };
  assert.equal(cls(await make({ pr: { state: "OPEN", headRefOid: "h1" } })(t, v)), EffectClass.NOT_COMPLETED);
  assert.equal(cls(await make({ pr: { state: "MERGED", headRefOid: "h1" } })(t, v)), "PROVED");
  assert.equal(cls(await make({ pr: { state: "MERGED", headRefOid: "h2" } })(t, v)), EffectClass.AMBIGUOUS);
});

test("a throwing reader is ambiguous, never success", async () => {
  const f = buildReadEffect({
    repo: "o/r", controlIssue: 379, executionIssue: 73,
    readIssue: () => { throw new Error("403"); }, readComments: () => [], readPr: () => null, verifyManifest: async () => ({ ok: true }),
  }).readEffect;
  assert.equal(cls(await f(TRANSITIONS.READY_TO_PROJECT_ROUTED, { proposedBody: "- **Lifecycle:** ROUTED\n" })), EffectClass.AMBIGUOUS);
});


test("prepared-audit continuation: complete only with the control projection AND the trigger; each half reconciles alone", async () => {
  const t = TRANSITIONS.STAGE2_AUDIT_ALREADY_PREPARED;
  const open = { 825: { body: "", state: "OPEN" } };
  const trig = { id: 1, body: "@codex review", created_at: "2026-10-01T00:00:00Z" };
  const projected = "- **Lifecycle:** AUDIT\n- **Stage 2:** #825\n";
  const review = "- **Lifecycle:** REVIEW\n";
  const v = { auditIssue: 825 };
  assert.equal(cls(await make({ issues: open, comments: { 825: [trig] }, control: projected })(t, v)), "PROVED");
  // trigger posted, projection missing: only the finalize half re-runs
  assert.equal(cls(await make({ issues: open, comments: { 825: [trig] }, control: review })(t, v)), EffectClass.COMPLETED_UNPROJECTED);
  // nothing posted yet (or projection without trigger): the whole idempotent command re-runs
  assert.equal(cls(await make({ issues: open, control: review })(t, v)), EffectClass.NOT_COMPLETED);
  assert.equal(cls(await make({ issues: open, control: projected })(t, v)), EffectClass.NOT_COMPLETED);
  assert.equal(cls(await make({ issues: { 825: { body: "", state: "CLOSED" } }, comments: { 825: [trig] }, control: projected })(t, v)), EffectClass.AMBIGUOUS);
});

// -- Issue #883 Stage 1 correction: evidence re-audit states are first-class launcher transitions --

function makeEvidence({ evidence, issues = {}, comments = {}, control = "- **Lifecycle:** AUDIT\n- **Stage 2:** #381\n" } = {}) {
  return buildReadEffect({
    repo: "o/r",
    controlIssue: 379,
    executionIssue: 73,
    readIssue: ({ number }) => (number === 379 ? { body: control, state: "OPEN" } : issues[number]),
    readComments: (n) => comments[n] ?? [],
    readPr: () => null,
    verifyManifest: async () => ({ ok: true }),
    readEvidenceCorrection: async () => evidence,
  }).readEffect;
}

test("evidence re-audit preparation: no replacement -> NOT_COMPLETED (re-run prepare); one pending replacement -> PROVED; other states fail closed", async () => {
  const t = TRANSITIONS.STAGE2_EVIDENCE_REAUDIT_PREPARATION_REQUIRED;
  const v = { auditIssue: 381, predecessorAuditIssue: 381 };
  assert.equal(cls(await makeEvidence({ evidence: { status: "SATISFIED", replacement: null } })(t, v)), EffectClass.NOT_COMPLETED);
  assert.equal(
    cls(await makeEvidence({ evidence: { status: "SATISFIED", replacement: { number: 390, state: "OPEN", pending: true } } })(t, v)),
    "PROVED",
  );
  assert.equal(
    cls(await makeEvidence({ evidence: { status: "SATISFIED", replacement: { number: 390, state: "OPEN", pending: false } } })(t, v)),
    EffectClass.AMBIGUOUS,
  );
  assert.equal(cls(await makeEvidence({ evidence: { status: "AMBIGUOUS" } })(t, v)), EffectClass.AMBIGUOUS);
});

test("evidence re-audit ready: PROVED only with projection + trigger on the single evidence-bound replacement; halves reconcile alone; non-unique/unbound fails closed", async () => {
  const t = TRANSITIONS.STAGE2_EVIDENCE_REAUDIT_READY;
  const v = { auditIssue: 381, predecessorAuditIssue: 381, replacementAuditIssue: 390 };
  const open = { 390: { body: "", state: "OPEN" } };
  const trig = { id: 1, body: "@codex review", created_at: "2026-10-01T00:00:00Z" };
  const ok = { status: "SATISFIED", replacement: { number: 390, state: "OPEN", pending: true } };
  const projected = "- **Lifecycle:** AUDIT\n- **Stage 2:** #390\n";
  const review = "- **Lifecycle:** AUDIT\n- **Stage 2:** #381\n";
  assert.equal(cls(await makeEvidence({ evidence: ok, issues: open, comments: { 390: [trig] }, control: projected })(t, v)), "PROVED");
  assert.equal(cls(await makeEvidence({ evidence: ok, issues: open, comments: { 390: [trig] }, control: review })(t, v)), EffectClass.COMPLETED_UNPROJECTED);
  assert.equal(cls(await makeEvidence({ evidence: ok, issues: open, control: review })(t, v)), EffectClass.NOT_COMPLETED);
  const other = { status: "SATISFIED", replacement: { number: 391, state: "OPEN", pending: true } };
  assert.equal(cls(await makeEvidence({ evidence: other, issues: open, comments: { 390: [trig] }, control: projected })(t, v)), EffectClass.AMBIGUOUS);
  assert.equal(cls(await makeEvidence({ evidence: { status: "AMBIGUOUS" }, issues: open, comments: { 390: [trig] }, control: projected })(t, v)), EffectClass.AMBIGUOUS);
});

// -- Issue #985 Stage 1 correction: unusable-response replacement states are first-class launcher transitions --

function makeUnusable({ recovery, issues = {}, comments = {}, control = "- **Lifecycle:** AUDIT\n- **Stage 2:** #381\n" } = {}) {
  return buildReadEffect({
    repo: "o/r",
    controlIssue: 379,
    executionIssue: 73,
    readIssue: ({ number }) => (number === 379 ? { body: control, state: "OPEN" } : issues[number]),
    readComments: (n) => comments[n] ?? [],
    readPr: () => null,
    verifyManifest: async () => ({ ok: true }),
    readUnusableRecovery: async () => recovery,
  }).readEffect;
}

test("unusable replacement preparation: eligible -> NOT_COMPLETED; one pending replacement -> PROVED; other states fail closed", async () => {
  const t = TRANSITIONS.STAGE2_UNUSABLE_REPLACEMENT_PREPARATION_REQUIRED;
  const v = { auditIssue: 381, predecessorAuditIssue: 381 };
  assert.equal(cls(await makeUnusable({ recovery: { status: "ELIGIBLE", replacement: null } })(t, v)), EffectClass.NOT_COMPLETED);
  assert.equal(
    cls(await makeUnusable({ recovery: { status: "REPLACEMENT_EXISTS", replacement: { number: 390, state: "OPEN", pending: true } } })(t, v)),
    "PROVED",
  );
  assert.equal(
    cls(await makeUnusable({ recovery: { status: "REPLACEMENT_EXISTS", replacement: { number: 390, state: "OPEN", pending: false } } })(t, v)),
    EffectClass.AMBIGUOUS,
  );
  assert.equal(cls(await makeUnusable({ recovery: { status: "AMBIGUOUS" } })(t, v)), EffectClass.AMBIGUOUS);
});

test("unusable replacement ready: PROVED only with projection + trigger on the single bound replacement; halves reconcile alone; unbound fails closed", async () => {
  const t = TRANSITIONS.STAGE2_UNUSABLE_REPLACEMENT_READY;
  const v = { auditIssue: 381, predecessorAuditIssue: 381, replacementAuditIssue: 390 };
  const open = { 390: { body: "", state: "OPEN" } };
  const trig = { id: 1, body: "@codex review", created_at: "2026-10-01T00:00:00Z" };
  const ok = { status: "REPLACEMENT_EXISTS", replacement: { number: 390, state: "OPEN", pending: true } };
  const projected = "- **Lifecycle:** AUDIT\n- **Stage 2:** #390\n";
  const review = "- **Lifecycle:** AUDIT\n- **Stage 2:** #381\n";
  assert.equal(cls(await makeUnusable({ recovery: ok, issues: open, comments: { 390: [trig] }, control: projected })(t, v)), "PROVED");
  assert.equal(cls(await makeUnusable({ recovery: ok, issues: open, comments: { 390: [trig] }, control: review })(t, v)), EffectClass.COMPLETED_UNPROJECTED);
  assert.equal(cls(await makeUnusable({ recovery: ok, issues: open, control: review })(t, v)), EffectClass.NOT_COMPLETED);
  const other = { status: "REPLACEMENT_EXISTS", replacement: { number: 391, state: "OPEN", pending: true } };
  assert.equal(cls(await makeUnusable({ recovery: other, issues: open, comments: { 390: [trig] }, control: projected })(t, v)), EffectClass.AMBIGUOUS);
});
