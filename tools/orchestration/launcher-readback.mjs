// Transition-specific durable read-backs for the launcher (issue #73, Stage 2 correction on #825).
//
// The launcher step (launcher-step.mjs) unlocks a successor only when `verifyPostcondition` is fed
// evidence proving the transition's EXACT durable effect and projection. Stage 2 (#825 finding 2)
// found the production binding treated "the gate's state changed" as that proof. This module is
// the production binding done correctly: one authoritative read per TRANSITIONS row, each checking
// the row's own effect, target identity, and expected successor, with wrong-target, wrong-successor,
// malformed, contradictory, or unreadable evidence reported as `readBackOk: false` (AMBIGUOUS ->
// fail closed) rather than as success.
//
// Composition only: it reads durable GitHub state through injected readers (REST-backed in
// production) and reuses parseControlBullet / verifyRoutedDispatchManifest / parseStage2Verdict.
// It never decides a lifecycle verdict and never acts; execute/finalize live in launcher-run.mjs.
//
// Tests: node --test tools/orchestration/launcher-readback.test.mjs

import { parseControlBullet, verifyRoutedDispatchManifest } from "./ready-dispatch-gate.mjs";
import { parseStage2Verdict } from "../review-watch/lifecycle-gate.mjs";
import { findExistingTrigger } from "../review-watch/trigger.mjs";
const NO_MANIFEST_POINTER = "Execution Plan Index has no settled Dispatch manifest pointer";

const MERGE_STATES = new Set(["STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", "STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2"]);

function bad(expectedTarget, target, reason) {
  return { expectedTarget, target, readBackOk: false, effect: "unknown", projected: null, reason };
}

function ev(target, effect, projected, extra = {}) {
  return { expectedTarget: target, target, readBackOk: true, effect, projected, ...extra };
}

function issueNumberOf(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// The single distinct issue/PR number a control bullet value names, or null when it names none or
// several (ambiguous pointers never count as a match).
export function singlePointer(value) {
  const nums = [...new Set([...String(value ?? "").matchAll(/#(\d+)/g)].map((m) => Number(m[1])))];
  return nums.length === 1 ? nums[0] : null;
}

const isNone = (v) => v == null || /^(none|n\/a|-)?$/i.test(String(v).trim());

// Expected control-body fields for the two thin-control projection transitions. The expected
// values come from the verdict's own identity fields and the transition itself, never from
// "anything the gate happened to propose": a proposedBody whose Lifecycle is some other successor
// is a wrong-successor proposal and reads back as ambiguous.
export function projectionExpectation(state, verdict) {
  if (state === "READY_TO_PROJECT_ROUTED") {
    return { expected: { Lifecycle: "ROUTED" }, proposalLifecycle: "ROUTED" };
  }
  if (state === "READY_TO_PROJECT_PLAN_READY") {
    if (typeof verdict?.planIndexUrl !== "string" || verdict.planIndexUrl === "") return null;
    return { expected: { Lifecycle: "PLAN_READY", Plan: verdict.planIndexUrl }, proposalLifecycle: "PLAN_READY" };
  }
  return null;
}

// deps: { repo, controlIssue, executionIssue,
//         readIssue({repo, number}) -> { body, state },
//         readComments(number) -> [{ id, body, authorPermission }],
//         readPr({repo, number}) -> { state, headRefOid },
//         verifyManifest?({repo, executionIssue}) -> verifyRoutedDispatchManifest result }
export function buildReadEffect(deps) {
  const { repo, controlIssue, executionIssue, readIssue, readComments, readPr } = deps;
  const verifyManifest = deps.verifyManifest ?? ((a) => verifyRoutedDispatchManifest(a));

  async function readControl() {
    return readIssue({ repo, number: controlIssue });
  }

  async function controlProjection(state, verdict) {
    const target = String(controlIssue);
    const exp = projectionExpectation(state, verdict);
    if (!exp) return bad(target, target, `no projection expectation for ${state}`);
    if (parseControlBullet(verdict?.proposedBody ?? "", "Lifecycle") !== exp.proposalLifecycle) {
      return bad(target, target, `verdict proposes a successor other than ${exp.proposalLifecycle}`);
    }
    const { body } = await readControl();
    const matches = Object.entries(exp.expected).every(([label, value]) => parseControlBullet(body, label) === value);
    return ev(target, matches ? "present" : "absent", matches);
  }

  async function manifestAndRouted(verdict) {
    const target = String(controlIssue);
    const exec = issueNumberOf(verdict?.executionIssue ?? executionIssue);
    if (exec !== executionIssue) return bad(target, target, "manifest transition names a different execution issue");
    const probe = await verifyManifest({ repo, executionIssue: exec });
    let manifest;
    if (probe?.ok === true) manifest = "present";
    else if (probe?.operationalError !== true && typeof probe?.reason === "string" && probe.reason.startsWith(NO_MANIFEST_POINTER)) {
      manifest = "absent";
    } else {
      return bad(target, target, `manifest read-back not authoritative: ${probe?.reason ?? "unreadable"}`);
    }
    const { body } = await readControl();
    const routed = parseControlBullet(body, "Lifecycle") === "ROUTED";
    // effect = the manifest itself; projected = the control Lifecycle reads ROUTED. A ROUTED
    // control without a verified manifest is contradictory (classify -> AMBIGUOUS).
    return ev(target, manifest, routed, { manifest, routed });
  }

  async function stage2Record(verdict) {
    const audit = issueNumberOf(verdict?.auditIssue);
    if (!audit) return bad("audit:none", "audit:none", "verdict names no audit issue");
    const target = `audit#${audit}`;
    const { body } = await readIssue({ repo, number: audit });
    const v = parseStage2Verdict(body);
    if (v === null) return bad(target, target, "audit Verdict field is malformed");
    // The durable value must equal the verdict the completed report itself backs. A settled but
    // different value (e.g. a preparation-time NOT CLEAN placeholder over a CLEAN report) is NOT
    // the promoted verdict: it reads as absent so record-verdict runs, never as proof.
    const expected = verdict?.postAudit?.reportEvidence?.verdict;
    if (expected !== "CLEAN" && expected !== "NOT CLEAN") return bad(target, target, "verdict carries no report-backed verdict to record");
    const recorded = v === expected;
    return ev(target, recorded ? "present" : "absent", recorded, { verdict: v, expectedVerdict: expected });
  }

  async function stage2Trigger(verdict) {
    const audit = issueNumberOf(verdict?.auditIssue);
    if (!audit) return bad("audit:none", "audit:none", "verdict names no audit issue");
    const target = `audit#${audit}`;
    const issue = await readIssue({ repo, number: audit });
    if (issue.state !== "OPEN") return bad(target, target, "audit issue is not open");
    // trigger.mjs's own existing-trigger authority (the workflow posts as github-actions[bot],
    // which has no collaborator permission): never a second, permission-filtered detector.
    const comments = await readComments(audit);
    const present = findExistingTrigger(comments, {}) !== null;
    return ev(target, present ? "present" : "absent", present);
  }

  // Prepared-audit continuation (finalize-audit-breakpoint then the idempotent trigger): complete
  // only when the control projection names this audit AND the reviewer trigger exists. A missing
  // trigger reads as absent/unprojected so the whole (idempotent) command re-runs; a posted
  // trigger without the projection is completed-unprojected and only the finalize step re-runs.
  async function stage2Prepared(verdict) {
    const audit = issueNumberOf(verdict?.auditIssue);
    if (!audit) return bad("audit:none", "audit:none", "verdict names no audit issue");
    const target = `audit#${audit}`;
    const issue = await readIssue({ repo, number: audit });
    if (issue.state !== "OPEN") return bad(target, target, "audit issue is not open");
    const trigger = findExistingTrigger(await readComments(audit), {}) !== null;
    const { body } = await readControl();
    const projected = singlePointer(parseControlBullet(body, "Stage 2")) === audit && parseControlBullet(body, "Lifecycle") === "AUDIT";
    if (!trigger) return ev(target, "absent", false);
    return ev(target, "present", projected);
  }

  async function stage2Close(verdict) {
    const audit = issueNumberOf(verdict?.auditIssue);
    if (!audit) return bad("audit:none", "audit:none", "verdict names no audit issue");
    const target = `audit#${audit}`;
    const work = issueNumberOf(verdict?.postAudit?.workIssue);
    const auditState = (await readIssue({ repo, number: audit })).state;
    const workState = work ? (await readIssue({ repo, number: work })).state : null;
    const controlState = (await readControl()).state;
    const auditClosed = auditState === "CLOSED";
    const workClosed = work ? workState === "CLOSED" : true;
    const controlClosed = controlState === "CLOSED";
    // Neither the audit nor the control is closed yet: the chain has not completed (the work issue
    // may already be closed -- the gate's audit-only resume shape -- and its close is idempotent).
    if (!auditClosed && !controlClosed) return ev(target, "absent", false);
    if (auditClosed && workClosed && controlClosed) return ev(target, "present", true);
    // Audit (and its gated work issue) closed, control not yet terminalized: the effect is complete
    // and only the control projection is missing -> reconcile without replaying the closes.
    if (auditClosed && workClosed && !controlClosed) return ev(target, "present", false, { missing: "control-terminalization" });
    return bad(target, target, `partially closed in an unexpected order (audit ${auditState}, work ${workState}, control ${controlState})`);
  }

  async function correctionPrFinalization(verdict) {
    const pr = issueNumberOf(verdict?.pr);
    const head = verdict?.head;
    if (!pr || typeof head !== "string" || !head) return bad("pr:none", "pr:none", "verdict lacks pr/head");
    const target = `PR#${pr}`;
    const live = readPr({ repo: verdict.repo ?? repo, number: pr });
    if (live?.state !== "OPEN" || live?.headRefOid !== head) return bad(target, target, "correction PR is not open at the gate's head");
    const { body } = await readControl();
    const prBullet = parseControlBullet(body, "PR");
    const stage1 = parseControlBullet(body, "Stage 1");
    const lifecycle = parseControlBullet(body, "Lifecycle");
    const projected = singlePointer(prBullet) === pr && !isNone(stage1) && lifecycle === "REVIEW";
    return ev(target, "present", projected);
  }

  function mergeReadback(verdict) {
    const pr = issueNumberOf(verdict?.pr);
    if (!pr) return bad("pr:none", "pr:none", "verdict names no PR");
    const target = `PR#${pr}`;
    const live = readPr({ repo: verdict.repo ?? repo, number: pr });
    if (live?.state === "MERGED") {
      // Merged at some OTHER head is not the authorized effect.
      if (typeof verdict.head === "string" && live.headRefOid !== verdict.head) return bad(target, target, "PR merged at a head other than the authorized one");
      return ev(target, "present", true);
    }
    if (live?.state === "OPEN") return ev(target, "absent", false);
    return bad(target, target, `PR is ${live?.state ?? "unreadable"}`);
  }

  return {
    readEffect: async (transition, verdict) => {
      const state = transition.preState;
      try {
        if (MERGE_STATES.has(state)) return mergeReadback(verdict);
        switch (state) {
          case "READY_TO_PROJECT_PLAN_READY":
          case "READY_TO_PROJECT_ROUTED":
            return await controlProjection(state, verdict);
          case "READY_TO_RUN_DISPATCH_MANIFEST":
            return await manifestAndRouted(verdict);
          case "STAGE2_REPORT_READY_TO_RECORD":
            return await stage2Record(verdict);
          case "STAGE2_TRIGGER_REQUIRED":
            return await stage2Trigger(verdict);
          case "STAGE2_AUDIT_ALREADY_PREPARED":
            return await stage2Prepared(verdict);
          case "STAGE2_CLOSE_READY":
            return await stage2Close(verdict);
          case "STAGE2_CORRECTION_PR_NEEDS_FINALIZATION":
            return await correctionPrFinalization(verdict);
          default:
            return bad("unknown", "unknown", `no read-back for ${state}`);
        }
      } catch (e) {
        return bad("unknown", "unknown", `read-back failed: ${e?.message ?? e}`);
      }
    },
  };
}
