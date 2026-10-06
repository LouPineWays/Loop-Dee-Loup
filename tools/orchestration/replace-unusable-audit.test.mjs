// Tests for issue #868: the bounded one-replacement recovery of a FIRST unusable Stage 2 response
// (live #859 / #860 / PR #865 / Audit #866 reproduction) -- both the gate-side transition in
// next-review-transition-gate.mjs and the idempotent mutating script replace-unusable-audit.mjs.
// Every GitHub read/write is injected; nothing here touches the network or the `gh` CLI.
//
// Run with:
//   node --test tools/orchestration/replace-unusable-audit.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { resolvePostMergeVerdict, runNextReviewTransitionGate } from "./next-review-transition-gate.mjs";
import { run as replaceRun } from "./replace-unusable-audit.mjs";
import { composeReplacementAuditBody, composeReplacementAuditTitle, parseSupersedesAuditRef, hasSupersedesAuditHeading } from "../review-watch/lifecycle-gate.mjs";
import { composeAuditFinalizedControlBody, parseStage2PointerIssue } from "./finalize-audit-breakpoint.mjs";
import { getActionEnvelope, classifyEnvelopeCompliance } from "./action-envelope.mjs";

const REPO = "o/r";
const MERGE = "16a01b579e1d146f057cd02c1a122bcf568e2d1f";
const PRED = 866;
const REPL = 867;
const T_PRED = "2026-10-02T09:00:00Z";
const T_REPL = "2026-10-02T10:00:00Z";

function auditBody({ work = 860, merge = MERGE, verdict = "PENDING", supersedes = null } = {}) {
  return [
    ...(supersedes === null ? [] : ["### Supersedes audit", "", supersedes, ""]),
    "### Merged PR", "", "https://github.com/o/r/pull/865", "",
    "### Work issue", "", `#${work}`, "",
    "### Exact merge commit", "", merge, "",
    "### Stage 1 inline review disposition", "", "Single inline round at frozen head `f1b59b5`.", "",
    "### Audit scope", "", "Complete files at the exact merge commit.", "",
    "### Verification checklist", "", "1. First check.", "2. Second check.", "",
    "### Findings", "", "Pending — awaiting Stage 2 audit response.", "",
    "### Verdict", "", verdict, "",
    "### Next authorized action", "", "Pending audit.", "",
  ].join("\n");
}

function controlBody({ stage2 = `#${PRED}`, lifecycle = "AUDIT", execution = "#860", pr = "#865" } = {}) {
  return [
    "## Current state", "",
    `- **Lifecycle:** ${lifecycle}`,
    `- **Execution:** ${execution}`,
    "- **Route:** implementation worker",
    `- **PR:** ${pr}`,
    "- **Stage 1:** satisfied at f1b59b54a248303d775953319222e3e36d675954",
    `- **Stage 2:** ${stage2}`,
    "- **Blocker:** none",
    "- **Founder decision:** none", "",
  ].join("\n");
}

const PRED_ISSUE = { number: PRED, title: "[Audit] PR #865 exact merge 16a01b5 (work #860)", body: auditBody(), state: "OPEN", createdAt: T_PRED };
const REPL_BODY = composeReplacementAuditBody(auditBody(), PRED);
const replIssue = (overrides = {}) => ({ number: REPL, title: composeReplacementAuditTitle(PRED_ISSUE.title, PRED), body: REPL_BODY, state: "OPEN", createdAt: T_REPL, ...overrides });

const UNUSABLE = (auditIssue) => ({
  exitCode: 2,
  state: "RESPONSE_UNUSABLE",
  workIssue: 860,
  auditIssue,
  rawVerdict: "PENDING",
  reportEvidence: { backed: false, hasGenuineResponse: true, hasUnusableGenuineResponse: true, hasTrigger: true },
});

// -- gate side -------------------------------------------------------------------------------

function gateImpls({ control = controlBody(), audits = [PRED_ISSUE], candidates = [], postAudit, pr = { headRefOid: "h", state: "MERGED", mergeCommit: { oid: MERGE } }, onScan } = {}) {
  const calls = { scans: 0, postAuditFor: [] };
  const byNumber = new Map(audits.map((a) => [a.number, a]));
  return {
    calls,
    impls: {
      ghIssueViewImpl: async ({ number }) => {
        if (Number(number) === 867 || Number(number) === PRED) {
          const found = byNumber.get(Number(number));
          if (!found) throw new Error(`unexpected view of #${number}`);
          return { body: found.body, state: found.state, createdAt: found.createdAt };
        }
        if (Number(number) === 859) return { body: control, state: "OPEN" };
        throw new Error(`unexpected ghIssueViewImpl call for #${number}`);
      },
      ghPrStateImpl: async () => pr,
      listAuditCandidatesImpl: async (args) => {
        calls.scans++;
        onScan?.(args);
        return candidates;
      },
      checkPostAuditImpl: async (args) => {
        calls.postAuditFor.push(Number(args["audit-issue"]));
        return typeof postAudit === "function" ? postAudit(Number(args["audit-issue"])) : postAudit;
      },
    },
  };
}

const gate = (fixture) => runNextReviewTransitionGate({ repo: REPO, controlIssue: "859" }, fixture.impls);

test("#868 check 1: the exact #866 evidence still evaluates as STAGE2_RESPONSE_UNUSABLE before recovery selection -- the parser/evidence verdict is not relaxed", () => {
  const v = resolvePostMergeVerdict({ postAudit: UNUSABLE(PRED) }, { repo: REPO, auditIssue: PRED, controlIssue: 859 });
  assert.equal(v.state, "STAGE2_RESPONSE_UNUSABLE");
  assert.equal(v.stopAfter, true);
  assert.deepEqual(getActionEnvelope(v.state), { mode: "none", authorizedActions: [] });
});

test("#868 check 2: an initial unusable audit with no replacement -> one deterministic STAGE2_REPLACEMENT_AUDIT_REQUIRED transition with a bounded envelope", async () => {
  const f = gateImpls({ postAudit: UNUSABLE(PRED) });
  const result = await gate(f);
  assert.equal(result.state, "STAGE2_REPLACEMENT_AUDIT_REQUIRED");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stopAfter, true);
  assert.equal(result.replacementAudit, null);
  assert.equal(result.auditIssue, PRED);
  assert.equal(result.controlIssue, 859);
  assert.equal(
    result.nextCommand,
    "node tools/orchestration/replace-unusable-audit.mjs --control-issue 859 --execution-issue 860 --pr 865 --audit-issue 866",
  );
  assert.deepEqual(result.actionEnvelope, { mode: "bounded", authorizedActions: ["run-replace-unusable-audit"] });
  // The recovery never touches the unusable thread: the only post-audit read is the one evidence read.
  assert.deepEqual(f.calls.postAuditFor, [PRED]);
  assert.equal(f.calls.scans, 1);
  // The scan lower bound is the superseded audit's own creation time (REST consistent scan).
});

test("#868 check 2b: the scan's lower bound is the unusable audit's own creation time", async () => {
  let seen;
  const f = gateImpls({ postAudit: UNUSABLE(PRED), onScan: (a) => (seen = a) });
  await gate(f);
  assert.deepEqual(seen, { repo: REPO, sinceIso: T_PRED });
});

test("#868 check 3: a replacement that already exists but is not yet projected resumes via the same command and reports it (never a duplicate)", async () => {
  const f = gateImpls({ postAudit: UNUSABLE(PRED), candidates: [replIssue()] });
  const result = await gate(f);
  assert.equal(result.state, "STAGE2_REPLACEMENT_AUDIT_REQUIRED");
  assert.equal(result.replacementAudit, REPL);
  assert.match(result.nextCommand, /replace-unusable-audit\.mjs/);
});

test("#868 check 4/5: once projected, the replacement is the current Stage 2 pointer -- untriggered -> exactly one STAGE2_TRIGGER_REQUIRED; triggered and waiting -> ordinary NO_ACTION_YET", async () => {
  const projected = controlBody({ stage2: `#${REPL}` });
  const f1 = gateImpls({
    control: projected,
    audits: [PRED_ISSUE, replIssue()],
    postAudit: (n) => {
      assert.equal(n, REPL, "only the current (replacement) audit is evaluated");
      return { exitCode: 0, state: "TRIGGER_REQUIRED", workIssue: 860, auditIssue: REPL, rawVerdict: "PENDING", reportEvidence: { hasTrigger: false } };
    },
  });
  const trigger = await gate(f1);
  assert.equal(trigger.state, "STAGE2_TRIGGER_REQUIRED");
  assert.equal(trigger.nextCommand, `node tools/review-watch/trigger.mjs --repo ${REPO} --kind issue --number ${REPL}`);
  assert.deepEqual(trigger.actionEnvelope, { mode: "bounded", authorizedActions: ["post-stage2-reviewer-trigger"] });
  assert.equal(f1.calls.scans, 0);

  const f2 = gateImpls({
    control: projected,
    audits: [PRED_ISSUE, replIssue()],
    postAudit: { exitCode: 0, state: "OK", workIssue: 860, auditIssue: REPL, rawVerdict: "PENDING", verdict: null, workIssueState: "OPEN", reportEvidence: { hasTrigger: true } },
  });
  const waiting = await gate(f2);
  assert.equal(waiting.state, "NO_ACTION_YET");
  assert.deepEqual(waiting.actionEnvelope, { mode: "none", authorizedActions: [] });
  assert.equal(f2.calls.scans, 0);
});

test("#868 check 6/7: a valid replacement CLEAN report flows through ordinary record/close; a NOT CLEAN one through the ordinary correction path", async () => {
  const projected = controlBody({ stage2: `#${REPL}` });
  const base = { control: projected, audits: [PRED_ISSUE, replIssue()] };
  const record = await gate(gateImpls({ ...base, postAudit: { exitCode: 0, state: "REPORT_READY_TO_RECORD", workIssue: 860, auditIssue: REPL, rawVerdict: "PENDING", reportEvidence: { backed: true } } }));
  assert.equal(record.state, "STAGE2_REPORT_READY_TO_RECORD");
  assert.match(record.nextCommand, new RegExp(`record-verdict --repo ${REPO} --audit-issue ${REPL}$`));

  const close = await gate(gateImpls({ ...base, postAudit: { exitCode: 0, state: "READY_TO_CLOSE", workIssue: 860, auditIssue: REPL, verdict: "CLEAN" } }));
  assert.equal(close.state, "STAGE2_CLOSE_READY");
  assert.match(close.nextCommand, new RegExp(`close-audit --repo ${REPO} --audit-issue ${REPL}`));

  const notClean = gateImpls({
    ...base,
    postAudit: { exitCode: 0, state: "OK", workIssue: 860, auditIssue: REPL, rawVerdict: "NOT CLEAN", verdict: "NOT CLEAN", workIssueState: "OPEN" },
  });
  notClean.impls.reconcileStage2CorrectionPrImpl = async () => ({ crossed: false });
  const correction = await gate(notClean);
  assert.equal(correction.state, "STAGE2_CORRECTION_REQUIRED");
  assert.equal(correction.auditIssue, REPL);
  assert.equal(notClean.calls.scans, 0);
});

test("#868 check 8: a replacement that is itself unusable is a compact founder interrupt naming BOTH audits -- no scan, no third audit, mode none", async () => {
  const f = gateImpls({
    control: controlBody({ stage2: `#${REPL}` }),
    audits: [PRED_ISSUE, replIssue()],
    postAudit: UNUSABLE(REPL),
  });
  const result = await gate(f);
  assert.equal(result.state, "STAGE2_RESPONSE_UNUSABLE");
  assert.equal(result.exitCode, 4);
  assert.equal(result.recovery.status, "EXHAUSTED");
  assert.equal(result.recovery.supersededAudit, PRED);
  assert.equal(result.recovery.replacementAudit, REPL);
  assert.equal(result.auditIssue, REPL);
  assert.equal(f.calls.scans, 0, "never searches for or authorizes another replacement");
  assert.equal(result.nextCommand, undefined);
  assert.deepEqual(result.actionEnvelope, { mode: "none", authorizedActions: [] });
});

test("#868 check 9: wrong PR/work/merge identity or ambiguous supersession fails closed and never authorizes a mutation", async () => {
  const mismatchedCases = {
    "control Lifecycle is not AUDIT": gateImpls({ postAudit: UNUSABLE(PRED), control: controlBody({ lifecycle: "CORRECTION" }) }),
    "malformed Supersedes audit marker": gateImpls({ postAudit: UNUSABLE(PRED), audits: [{ ...PRED_ISSUE, body: auditBody({ supersedes: "junk" }) }] }),
    "audit is not in the canonical pending state": gateImpls({ postAudit: UNUSABLE(PRED), audits: [{ ...PRED_ISSUE, body: auditBody({ verdict: "NOT CLEAN" }) }] }),
    "unreadable replacement scan": (() => {
      const f = gateImpls({ postAudit: UNUSABLE(PRED) });
      f.impls.listAuditCandidatesImpl = async () => {
        throw new Error("scan truncated");
      };
      return f;
    })(),
  };
  for (const [name, f] of Object.entries(mismatchedCases)) {
    const result = await gate(f);
    assert.equal(result.state, "STAGE2_RESPONSE_UNUSABLE", name);
    assert.equal(result.recovery?.status, "UNAVAILABLE", name);
    assert.equal(result.nextCommand, undefined, name);
    assert.equal(result.actionEnvelope.mode, "none", name);
  }

  // A PR whose merge commit differs from the settled pointer's, or that is not merged, is caught even
  // earlier by the existing #747 stale-pointer / pre-merge phase selection: never this transition.
  // The same holds for an audit naming a different work issue than the control Execution pointer.
  for (const variant of [
    { pr: { headRefOid: "h", state: "MERGED", mergeCommit: { oid: "b".repeat(40) } } },
    { pr: { headRefOid: "h", state: "OPEN", mergeCommit: null } },
    { audits: [{ ...PRED_ISSUE, body: auditBody({ work: 861 }) }] },
  ]) {
    const f = gateImpls({ postAudit: UNUSABLE(PRED), ...variant });
    f.impls.stage1RunImpl = async () => ({ exitCode: 0, state: "PENDING" });
    f.impls.checkMergeReadyImpl = async () => ({ exitCode: 0, state: "BLOCKED" });
    const result = await gate(f);
    assert.notEqual(result.state, "STAGE2_REPLACEMENT_AUDIT_REQUIRED");
    assert.equal(result.nextCommand === undefined || !String(result.nextCommand).includes("replace-unusable-audit"), true);
  }

  for (const [name, candidates] of Object.entries({
    "two competing replacements": [replIssue(), replIssue({ number: 868 })],
    "a replacement naming a different predecessor": [replIssue({ body: composeReplacementAuditBody(auditBody(), 700) })],
    "a closed replacement consumed the bound": [replIssue({ state: "CLOSED" })],
  })) {
    const result = await gate(gateImpls({ postAudit: UNUSABLE(PRED), candidates }));
    assert.equal(result.state, "AMBIGUOUS", name);
    assert.equal(result.exitCode, 4, name);
    assert.equal(result.actionEnvelope.mode, "none", name);
    assert.match(result.reason, /#866/, name);
  }
});

test("#868 regression: direct --audit-issue mode (no control Issue to project onto) keeps the existing founder-interrupt verdict and reads nothing extra", async () => {
  const result = await runNextReviewTransitionGate(
    { repo: REPO, auditIssue: "866" },
    {
      ghIssueViewImpl: async () => {
        throw new Error("direct mode must not read issues for recovery");
      },
      checkPostAuditImpl: async () => UNUSABLE(PRED),
    },
  );
  assert.equal(result.state, "STAGE2_RESPONSE_UNUSABLE");
  assert.equal(result.exitCode, 4);
  assert.equal(result.recovery, undefined);
});

test("#868 regression: no genuine response -> ordinary waiting; progress-only -> ordinary waiting; unaffected by the recovery transition", async () => {
  for (const reportEvidence of [{ hasTrigger: true, hasGenuineResponse: false }, { hasTrigger: true, hasGenuineResponse: true, hasUnusableGenuineResponse: false }]) {
    const f = gateImpls({ postAudit: { exitCode: 0, state: "OK", workIssue: 860, auditIssue: PRED, rawVerdict: "PENDING", verdict: null, workIssueState: "OPEN", reportEvidence } });
    const result = await gate(f);
    assert.equal(result.state, "NO_ACTION_YET");
    assert.equal(f.calls.scans, 0);
  }
});

test("#868 action envelope: the one bounded action is compliant; a reviewer trigger, same-thread retrigger, or gate re-run in the same context is a violation", () => {
  assert.equal(classifyEnvelopeCompliance("STAGE2_REPLACEMENT_AUDIT_REQUIRED", ["run-replace-unusable-audit"]).status, "compliant");
  assert.equal(classifyEnvelopeCompliance("STAGE2_REPLACEMENT_AUDIT_REQUIRED", []).status, "violation");
  assert.equal(classifyEnvelopeCompliance("STAGE2_REPLACEMENT_AUDIT_REQUIRED", ["run-replace-unusable-audit", "post-stage2-reviewer-trigger"]).status, "violation");
  assert.equal(classifyEnvelopeCompliance("STAGE2_REPLACEMENT_AUDIT_REQUIRED", ["run-replace-unusable-audit", "rerun-gate"]).status, "violation");
  // A second unusable verdict authorizes nothing at all.
  assert.equal(classifyEnvelopeCompliance("STAGE2_RESPONSE_UNUSABLE", ["run-replace-unusable-audit"]).status, "violation");
});

// -- script side ------------------------------------------------------------------------------

function scriptWorld({ control = controlBody(), pred = PRED_ISSUE, existing = [], postAudit = UNUSABLE(PRED), failFinalize = false, rescanHides = false, createFails = false } = {}) {
  const w = { control, created: [], finalized: [], closed: [], store: [...existing], scans: 0, onCreate: null };
  w.deps = {
    ghControlViewImpl: async () => ({ body: w.control }),
    ghPrViewImpl: async () => ({ state: "MERGED", mergeCommit: { oid: MERGE } }),
    ghAuditViewImpl: async () => pred,
    checkPostAuditImpl: async () => postAudit,
    listCandidatesImpl: async () => {
      w.scans++;
      return rescanHides && w.created.length > 0 ? [] : w.store;
    },
    createIssueImpl: async ({ title, body }) => {
      if (createFails) throw new Error("boom");
      const number = 900 + w.created.length;
      w.created.push({ number, title, body });
      w.store.push({ number, title, body, state: "OPEN", createdAt: T_REPL });
      // Race hook: another controller's creation becomes visible between this create and its rescan.
      w.onCreate?.(w, number);
      return { number };
    },
    closeIssueImpl: async ({ issue }) => {
      w.closed.push(issue);
      const found = w.store.find((c) => c.number === issue);
      if (found) found.state = "CLOSED";
    },
    finalizeImpl: async (args) => {
      w.finalized.push(args);
      if (failFinalize) return { exitCode: 2, state: "AUDIT_BREAKPOINT_UNVERIFIED", reason: "x" };
      w.control = controlBody({ stage2: `#${args.auditIssue}` });
      return { exitCode: 0, state: "FINALIZED" };
    },
  };
  return w;
}
const ARGS = { repo: REPO, controlIssue: 859, executionIssue: 860, pr: 865, auditIssue: PRED };

test("#868 script: initial unusable -> creates exactly one replacement (preserved body behind provenance), projects it with the stale-pointer authorization, never touches the predecessor", async () => {
  const w = scriptWorld();
  const result = await replaceRun(ARGS, w.deps);
  assert.equal(result.state, "REPLACEMENT_FINALIZED");
  assert.equal(result.exitCode, 0);
  assert.equal(result.created, true);
  assert.equal(result.supersededAudit, PRED);
  assert.equal(w.created.length, 1);
  assert.equal(w.created[0].body, REPL_BODY);
  assert.equal(w.created[0].title, "[Audit] PR #865 exact merge 16a01b5 (work #860) (replaces #866)");
  assert.equal(parseSupersedesAuditRef(w.created[0].body), PRED);
  assert.equal(w.finalized.length, 1);
  assert.deepEqual(w.finalized[0], {
    repo: REPO, controlIssue: 859, executionIssue: 860, pr: 865, auditIssue: result.replacementAudit,
    revalidateUniqueness: false, staleAuditIssue: PRED,
  });
  // The injected dependency surface has no comment/edit/trigger operation at all, and its only close
  // is of an issue THIS run created (the race-duplicate path below) -- the superseded audit thread is
  // structurally untouchable from this script, and nothing was closed on the happy path.
  assert.deepEqual(Object.keys(w.deps).sort(), ["checkPostAuditImpl", "closeIssueImpl", "createIssueImpl", "finalizeImpl", "ghAuditViewImpl", "ghControlViewImpl", "ghPrViewImpl", "listCandidatesImpl"]);
  assert.deepEqual(w.closed, []);
});

test("#868 script: repeated runs are idempotent at every interruption boundary (before creation, after creation before projection, after projection)", async () => {
  // Before creation -> creates; a full second run afterward reuses and creates nothing.
  const w = scriptWorld();
  await replaceRun(ARGS, w.deps);
  const again = await replaceRun(ARGS, w.deps);
  assert.equal(again.state, "REPLACEMENT_FINALIZED");
  assert.equal(again.created, false);
  assert.equal(w.created.length, 1, "no duplicate replacement");

  // After creation but before projection: finalize failed once; the retry reuses the same issue.
  const w2 = scriptWorld({ failFinalize: true });
  const first = await replaceRun(ARGS, w2.deps);
  assert.equal(first.state, "REPLACEMENT_UNVERIFIED");
  assert.equal(first.replacementAudit, 900, "the created replacement is reported, never silently abandoned");
  assert.equal(w2.created.length, 1);
  assert.equal(w2.control, controlBody(), "control Stage 2 authority is unchanged on a failed projection");
  w2.deps.finalizeImpl = async (args) => {
    w2.finalized.push(args);
    w2.control = controlBody({ stage2: `#${args.auditIssue}` });
    return { exitCode: 0, state: "FINALIZED" };
  };
  const retry = await replaceRun(ARGS, w2.deps);
  assert.equal(retry.state, "REPLACEMENT_FINALIZED");
  assert.equal(retry.replacementAudit, 900);
  assert.equal(retry.created, false);
  assert.equal(w2.created.length, 1);

  // After projection: control already names the replacement; a re-run is a no-op re-finalize.
  const w3 = scriptWorld({ control: controlBody({ stage2: `#${REPL}` }), existing: [replIssue()] });
  const done = await replaceRun(ARGS, w3.deps);
  assert.equal(done.state, "REPLACEMENT_FINALIZED");
  assert.equal(done.created, false);
  assert.equal(w3.created.length, 0);
  assert.equal(w3.finalized[0].auditIssue, REPL);
});

test("#868 script: second-unusable bound -- a superseded audit that is itself a replacement, a competing/closed/wrong-predecessor claimant, never creates another audit", async () => {
  const replacementAsPred = { ...replIssue(), number: REPL };
  const w = scriptWorld({ pred: replacementAsPred, postAudit: UNUSABLE(REPL) });
  const second = await replaceRun({ ...ARGS, auditIssue: REPL }, w.deps);
  assert.equal(second.state, "REPLACEMENT_UNVERIFIED");
  assert.match(second.reason, /exhausted/);
  assert.equal(w.created.length, 0);
  assert.equal(w.finalized.length, 0);

  for (const existing of [[replIssue(), replIssue({ number: 868 })], [replIssue({ state: "CLOSED" })], [replIssue({ body: composeReplacementAuditBody(auditBody(), 700) })]]) {
    const wi = scriptWorld({ existing });
    const result = await replaceRun(ARGS, wi.deps);
    assert.equal(result.state, "REPLACEMENT_UNVERIFIED");
    assert.equal(result.exitCode, 2);
    assert.equal(wi.created.length, 0);
    assert.equal(wi.finalized.length, 0);
  }
});

test("#868 script: provenance mismatches and unproven unusability fail closed with zero mutation", async () => {
  const cases = {
    "audit is not RESPONSE_UNUSABLE": scriptWorld({ postAudit: { exitCode: 0, state: "OK", auditIssue: PRED } }),
    "post-audit evaluated a different audit": scriptWorld({ postAudit: UNUSABLE(999) }),
    "control Stage 2 names neither audit": scriptWorld({ control: controlBody({ stage2: "#123" }) }),
    "control Lifecycle not AUDIT": scriptWorld({ control: controlBody({ lifecycle: "REVIEW" }) }),
    "control Execution mismatch": scriptWorld({ control: controlBody({ execution: "#861" }) }),
    "control PR mismatch": scriptWorld({ control: controlBody({ pr: "#864" }) }),
    "predecessor wrong merge commit": scriptWorld({ pred: { ...PRED_ISSUE, body: auditBody({ merge: "c".repeat(40) }) } }),
    "predecessor wrong work issue": scriptWorld({ pred: { ...PRED_ISSUE, body: auditBody({ work: 861 }) } }),
    "predecessor closed": scriptWorld({ pred: { ...PRED_ISSUE, state: "CLOSED" } }),
    "predecessor verdict not pending": scriptWorld({ pred: { ...PRED_ISSUE, body: auditBody({ verdict: "CLEAN" }) } }),
  };
  for (const [name, w] of Object.entries(cases)) {
    const result = await replaceRun(ARGS, w.deps);
    assert.equal(result.state, "REPLACEMENT_UNVERIFIED", name);
    assert.equal(result.exitCode, 2, name);
    assert.equal(w.created.length, 0, name);
    assert.equal(w.finalized.length, 0, name);
  }
});

test("#868 script: a creation failure or a post-create rescan that cannot prove uniqueness never projects; argument errors are operational (exit 1)", async () => {
  const failed = scriptWorld({ createFails: true });
  const a = await replaceRun(ARGS, failed.deps);
  assert.equal(a.state, "REPLACEMENT_UNVERIFIED");
  assert.equal(failed.finalized.length, 0);

  const hidden = scriptWorld({ rescanHides: true });
  const b = await replaceRun(ARGS, hidden.deps);
  assert.equal(b.state, "REPLACEMENT_UNVERIFIED");
  assert.equal(b.replacementAudit, 900);
  assert.equal(hidden.finalized.length, 0, "an unproven replacement is never projected onto the control Issue");

  assert.equal((await replaceRun({ ...ARGS, controlIssue: null }, {})).exitCode, 1);
  assert.equal((await replaceRun({ ...ARGS, executionIssue: "x" }, {})).exitCode, 1);
});

test("#868 script: Execution 'none' (no-work-issue audits) survives the same path", async () => {
  const noneAudit = { ...PRED_ISSUE, body: auditBody({ work: "none" }).replace("#none", "none") };
  const w = scriptWorld({ control: controlBody({ execution: "none" }), pred: noneAudit });
  const result = await replaceRun({ ...ARGS, executionIssue: "none" }, w.deps);
  assert.equal(result.state, "REPLACEMENT_FINALIZED");
  assert.equal(w.finalized[0].executionIssue, "none");
});

test("#868 live-shape regression: control #859 carries Lifecycle only as the parent-execution template's '### State' heading field (no Lifecycle bullet) -- both the gate and the script accept it", async () => {
  const headingControl = controlBody().replace("- **Lifecycle:** AUDIT\n", "").replace("## Current state", "### State\n\nAUDIT\n\n### Current state");
  assert.ok(!headingControl.includes("**Lifecycle:**"));
  const result = await gate(gateImpls({ control: headingControl, postAudit: UNUSABLE(PRED) }));
  assert.equal(result.state, "STAGE2_REPLACEMENT_AUDIT_REQUIRED");

  const w = scriptWorld({ control: headingControl });
  const done = await replaceRun(ARGS, w.deps);
  assert.equal(done.state, "REPLACEMENT_FINALIZED");

  const notAudit = headingControl.replace("AUDIT", "CORRECTION");
  const blocked = await gate(gateImpls({ control: notAudit, postAudit: UNUSABLE(PRED) }));
  assert.equal(blocked.recovery?.status, "UNAVAILABLE");
});

// -- Stage 1 correction (#868) -----------------------------------------------------------------

test("#868 correction: the control's Stage 2 pointer is read through ONE canonical parser -- a URL-form pointer works identically in the planner, the command, and the finalizer", async () => {
  const urlPointer = `https://github.com/o/r/issues/${PRED}`;
  const urlControl = controlBody({ stage2: urlPointer });

  const planned = await gate(gateImpls({ control: urlControl, postAudit: UNUSABLE(PRED) }));
  assert.equal(planned.state, "STAGE2_REPLACEMENT_AUDIT_REQUIRED");

  const w = scriptWorld({ control: urlControl });
  const result = await replaceRun(ARGS, w.deps);
  assert.equal(result.state, "REPLACEMENT_FINALIZED");
  assert.equal(w.created.length, 1);

  // The real finalizer accepts the same representation as the authorized stale pointer, and refuses
  // an unrelated one exactly as before.
  const composed = composeAuditFinalizedControlBody(urlControl, { auditIssue: 900, executionIssue: 860, pr: 865, staleAuditIssue: PRED });
  assert.equal(composed.ok, true);
  assert.equal(parseStage2PointerIssue(composed.body), 900);
  assert.equal(composeAuditFinalizedControlBody(urlControl, { auditIssue: 900, executionIssue: 860, pr: 865, staleAuditIssue: 123 }).ok, false);
  assert.equal(parseStage2PointerIssue(controlBody({ stage2: "#866 and #123" })), null);
});

test("#868 correction: a present-but-blank Supersedes audit heading is malformed provenance -- never 'not a replacement' (planner, script, classifier)", async () => {
  const blankBody = auditBody().replace("### Merged PR", "### Supersedes audit\n\n### Merged PR");
  assert.equal(parseSupersedesAuditRef(blankBody), null);
  assert.equal(hasSupersedesAuditHeading(blankBody), true);

  const planned = await gate(gateImpls({ postAudit: UNUSABLE(PRED), audits: [{ ...PRED_ISSUE, body: blankBody }] }));
  assert.equal(planned.state, "STAGE2_RESPONSE_UNUSABLE");
  assert.equal(planned.recovery?.status, "UNAVAILABLE");
  assert.equal(planned.nextCommand, undefined);

  const asPred = scriptWorld({ pred: { ...PRED_ISSUE, body: blankBody } });
  const refused = await replaceRun(ARGS, asPred.deps);
  assert.equal(refused.state, "REPLACEMENT_UNVERIFIED");
  assert.equal(asPred.created.length, 0);

  // A blank-heading claimant for the same exact target consumes the bound: no creation.
  const asClaimant = scriptWorld({ existing: [replIssue({ body: blankBody })] });
  const blocked = await replaceRun(ARGS, asClaimant.deps);
  assert.equal(blocked.state, "REPLACEMENT_UNVERIFIED");
  assert.equal(asClaimant.created.length, 0);
  assert.equal(asClaimant.finalized.length, 0);
});

test("#868 correction: a CLOSED source audit is never authorized for replacement by the planner (matches the command's own OPEN precondition)", async () => {
  const result = await gate(gateImpls({ postAudit: UNUSABLE(PRED), audits: [{ ...PRED_ISSUE, state: "CLOSED" }] }));
  assert.equal(result.state, "STAGE2_RESPONSE_UNUSABLE");
  assert.equal(result.recovery?.status, "UNAVAILABLE");
  assert.equal(result.nextCommand, undefined);
  assert.equal(result.actionEnvelope.mode, "none");
});

test("#868 correction: controller race -- the run that created the HIGHER-numbered duplicate closes only its own issue, never projects, and a re-run converges on the lowest-numbered winner", async () => {
  const w = scriptWorld();
  // Another controller scanned NONE too and its lower-numbered replacement (899) is now visible.
  w.onCreate = (world) => world.store.push({ number: 899, title: "t", body: REPL_BODY, state: "OPEN", createdAt: T_REPL });
  const lost = await replaceRun(ARGS, w.deps);
  assert.equal(lost.state, "REPLACEMENT_UNVERIFIED");
  assert.equal(lost.replacementAudit, 899);
  assert.deepEqual(w.closed, [900], "only the issue THIS run created is closed");
  assert.equal(w.finalized.length, 0, "a lost race never projects current Stage 2 authority");
  assert.equal(w.control, controlBody(), "control pointer untouched");

  w.onCreate = null;
  const again = await replaceRun(ARGS, w.deps);
  assert.equal(again.state, "REPLACEMENT_FINALIZED");
  assert.equal(again.replacementAudit, 899, "converges on the one canonical replacement");
  assert.equal(again.created, false);
  assert.equal(w.created.length, 1, "no third audit is ever created");
  assert.deepEqual(w.closed, [900]);
});

test("#868 correction: controller race -- the run that created the LOWEST-numbered replacement refuses to project while a live competing duplicate exists, then proceeds once it retires; no path creates a third audit", async () => {
  const w = scriptWorld();
  w.onCreate = (world) => world.store.push({ number: 901, title: "t", body: REPL_BODY, state: "OPEN", createdAt: T_REPL });
  const first = await replaceRun(ARGS, w.deps);
  assert.equal(first.state, "REPLACEMENT_UNVERIFIED");
  assert.equal(w.finalized.length, 0);
  assert.deepEqual(w.closed, [], "the winner never closes the other controller's issue");

  // The other controller's own run retires its duplicate; the winner's re-run now reuses and projects.
  w.store.find((c) => c.number === 901).state = "CLOSED";
  w.onCreate = null;
  const second = await replaceRun(ARGS, w.deps);
  assert.equal(second.state, "REPLACEMENT_FINALIZED");
  assert.equal(second.replacementAudit, 900);
  assert.equal(second.created, false);
  assert.equal(w.created.length, 1);
});

test("#868 correction: an unreconcilable extra claimant (different predecessor, or advanced past pending) still fails closed instead of being treated as a race duplicate", async () => {
  for (const extra of [
    { number: 901, body: composeReplacementAuditBody(auditBody(), 700), state: "CLOSED" },
    { number: 901, body: composeReplacementAuditBody(auditBody({ verdict: "CLEAN" }), PRED), state: "CLOSED" },
    { number: 901, body: REPL_BODY, state: "OPEN" },
  ]) {
    const w = scriptWorld({ existing: [replIssue({ number: 900 }), { title: "t", createdAt: T_REPL, ...extra }] });
    const result = await replaceRun(ARGS, w.deps);
    assert.equal(result.state, "REPLACEMENT_UNVERIFIED");
    assert.equal(w.created.length, 0);
    assert.equal(w.finalized.length, 0);
    assert.deepEqual(w.closed, []);
  }
  // A CLOSED pristine race duplicate above an OPEN canonical replacement is ignorable (the loser of an earlier race).
  const settled = scriptWorld({ existing: [replIssue({ number: 900 }), replIssue({ number: 901, state: "CLOSED" })] });
  const ok = await replaceRun(ARGS, settled.deps);
  assert.equal(ok.state, "REPLACEMENT_FINALIZED");
  assert.equal(ok.replacementAudit, 900);
});
