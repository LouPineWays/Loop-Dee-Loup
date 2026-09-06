#!/usr/bin/env node
// Deterministic post-PR transition gate for docs/operating-model.md § Watched lifecycle
// breakpoints, "Deterministic post-PR transition resolution" — worker unit 397-B under
// control Issue #397's own Shared Contract.
//
// #397's root-cause finding: a control Issue's own free-text "Next authorized transition"
// prose (e.g. #375's mid-cycle comment: "check PR #376 Stage 1 status ... verify/fix
// findings if any, then merge ... open the Stage 2 audit issue, trigger it, and end") reads
// as a correct-looking multi-step sequence, and nothing mechanically stopped a controller
// from executing all of it in one reasoning context — collapsing several of #374's watched
// lifecycle breakpoints into one. `tools/orchestration/ready-dispatch-gate.mjs` already
// closed the equivalent pre-PR gap for the initial READY dispatch; this script closes the
// same gap for a control Issue whose Lifecycle is already one of the five post-PR states
// (EXECUTING, VERIFYING, REVIEW, AUDIT, CORRECTION).
//
// This composes — it does not reimplement — three already-shipped checks:
//   - tools/review-watch/stage1-gate.mjs's `run` (Stage 1 trigger/response evidence)
//   - tools/review-watch/lifecycle-gate.mjs's `checkMergeReady` (closing-reference evidence)
//   - tools/review-watch/lifecycle-gate.mjs's `checkPostAudit` (Stage 2 verdict evidence)
// and derives exactly one verdict from their own already-computed states — never from a
// hand-authored control-Issue sub-state field, and never by re-parsing review/audit comment
// *content* for meaning (that would be re-deriving reviewer judgment, which stage1-gate.mjs
// and lifecycle-gate.mjs deliberately do not attempt either). This is a deliberate,
// documented exception to tools/orchestration's usual practice of not importing
// tools/review-watch internals (see ready-dispatch-gate.mjs's own parseHeadingField comment
// for that general boundary): #397's Shared Contract explicitly requires composing these
// exact exported functions rather than re-parsing their evidence a second way.
//
// Verdict derivation (every verdict below carries a literal `stopAfter: true` field):
//
//   Pre-merge phase (a settled "PR" reference, no settled "Stage 2"/Audit reference yet):
//     - stage1-gate NOT_REQUESTED or PENDING            -> NO_ACTION_YET, unless the control
//       Issue's own Stage 1 bullet is explicitly satisfied/exempt and merge-ready is already met
//     - stage1-gate EXEMPT, and
//         lifecycle-gate merge-ready MERGE_READY(*)      -> STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2
//         lifecycle-gate merge-ready BLOCKED_CLOSING_REFERENCE -> STAGE1_CORRECTION_REQUIRED
//     - stage1-gate RESPONSE_RECEIVED with a clean-pass response (consumer-sync-gate.mjs's
//       `isCleanStage1Response`), and lifecycle-gate merge-ready MERGE_READY(*) -> STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2
//     - stage1-gate RESPONSE_RECEIVED with findings or ambiguous response shape -> STAGE1_CORRECTION_REQUIRED
//     - anything else (operational error from either check, or a combination this gate does
//       not recognize)                                   -> AMBIGUOUS
//
//   Post-merge phase (a settled "Stage 2"/Audit reference):
//     - lifecycle-gate post-audit READY_TO_CLOSE or ACCEPTED_NO_WORK_ISSUE -> STAGE2_CLOSE_READY
//     - lifecycle-gate post-audit OK with rawVerdict "NOT CLEAN"           -> STAGE2_CORRECTION_REQUIRED
//     - lifecycle-gate post-audit OK with any other rawVerdict (no
//       completed report backing a verdict yet)                            -> NO_ACTION_YET
//     - anything else (PREMATURE_CLOSURE, an operational error, or a state
//       this gate does not recognize)                                      -> AMBIGUOUS
//
// `stage1-gate.mjs` signals whether a genuine response happened at the current head. Whether
// that response is a clean pass or a findings-bearing reply is resolved with
// consumer-sync-gate.mjs's `isCleanStage1Response` helper, which is deliberately anchored to
// Codex's own known fixed Stage 1 preambles (clean pass vs findings) and does not semantically
// adjudicate arbitrary findings.
//
// AMBIGUOUS is a founder-interrupt-eligible fail-closed stop (AGENTS.md § Founder interrupt
// conditions, "a failed safety/correctness gate with no authorized recovery path"), never
// license to fall back to free multi-step reasoning across the transition.
//
// Control-Issue mode (the normal path — repository identity derived from the checkout's own
// origin remote, matching ready-dispatch-gate.mjs's resolveRepoIdentity):
//   node tools/orchestration/next-review-transition-gate.mjs --control-issue 375
// reads the control Issue's own recorded bullets (ready-dispatch-gate.mjs's parsing
// convention): "- **Execution:**" (the gated work/execution Issue -- reused verbatim, never
// a second, separately-tracked work-issue field), "- **PR:**" (the PR number, or the "none"
// sentinel before a PR exists), and "- **Stage 2:**" (the Stage 2 Audit Issue number, or
// "none" before Stage 2 has started) to decide which phase applies and what to compose it
// against. The PR's current head is derived live (one more `gh pr view` read) unless --head
// is given explicitly -- this gate does not invent a new durable "frozen head" bullet; the
// live current head is correct except in the narrow case where a fix commit landed after a
// trigger without a fresh re-trigger, in which case stage1-gate.mjs's own head-scoped
// NOT_REQUESTED evidence at that new head is exactly the correct signal (a fresh Stage 1
// round is required), not a gap this gate needs to paper over.
//
// Direct-reference mode (skips the control-Issue read entirely; "the PR/Audit numbers
// directly" per the Shared Contract):
//   node tools/orchestration/next-review-transition-gate.mjs --pr 376 --head <sha> --issue 375
//   node tools/orchestration/next-review-transition-gate.mjs --audit-issue 378
//
// Tests: node --test tools/orchestration/next-review-transition-gate.test.mjs

import { execFileSync } from "node:child_process";
import {
  parseControlBullet,
  parseExecutionPointer,
  isNoneSentinel,
  resolveRepoIdentity,
  readExecutionBulletField,
} from "./ready-dispatch-gate.mjs";
import { run as stage1Run } from "../review-watch/stage1-gate.mjs";
import { checkMergeReady, checkPostAudit } from "../review-watch/lifecycle-gate.mjs";
import { isCleanStage1Response } from "../review-watch/consumer-sync-gate.mjs";

// Pure. Reads one optional "- **Label:** value" control-Issue bullet that is expected to
// hold either the explicit "none" sentinel or exactly one "#N" issue reference (the same
// shape ready-dispatch-gate.mjs's "Execution" bullet uses, reused here for "PR" and
// "Stage 2"). Returns one of:
//   { kind: "missing", reason }  -- the bullet itself was not found at all.
//   { kind: "none" }             -- the bullet is present and explicitly "none".
//   { kind: "issue", issue }     -- the bullet names exactly one "#N" reference.
//   { kind: "invalid", reason }  -- the bullet is present but neither "none" nor exactly
//                                   one "#N" reference (missing, malformed, or multi-valued).
export function parseOptionalIssueRef(raw, label) {
  if (raw === null) {
    return { kind: "missing", reason: `no "- **${label}:**" bullet found in the control Issue body` };
  }
  if (isNoneSentinel(raw)) {
    return { kind: "none" };
  }
  const parsed = parseExecutionPointer(raw);
  if (!parsed.ok) {
    return { kind: "invalid", reason: `"${label}" field ${JSON.stringify(raw)}: ${parsed.reason}` };
  }
  return { kind: "issue", issue: parsed.issue };
}

// Pure. True only for a result object this gate can trust as a genuine, fully-formed
// component result -- an object carrying a numeric exitCode. Mirrors merge-ready-gate.mjs's
// own hasTrustworthyExitCode guard: a component that returns malformed output (e.g. an
// injected test fake returning undefined, or a future bug in a composed script) must never
// be silently treated as a resolvable state.
function hasTrustworthyExitCode(result) {
  return result !== null && typeof result === "object" && typeof result.exitCode === "number";
}

// Pure core of the pre-merge phase: derives one verdict from an already-computed
// stage1-gate result and lifecycle-gate `checkMergeReady` result. See the module comment's
// verdict-derivation table for the exact mapping and why "actionable finding" content is
// not, and cannot be, evaluated here.
function isMergeReadyState(state) {
  return state === "MERGE_READY" || state === "MERGE_READY_NO_WORK_ISSUE";
}

function stage1DispositionMarksSatisfied(raw) {
  if (typeof raw !== "string" || !raw.trim() || isNoneSentinel(raw)) return false;
  return /\bsatisfied\b/i.test(raw) || /\bexempt\b/i.test(raw);
}

export function resolvePreMergeVerdict({ stage1, mergeReady, stage1Disposition = null }, context = {}) {
  if (!hasTrustworthyExitCode(stage1) || !hasTrustworthyExitCode(mergeReady)) {
    return {
      state: "AMBIGUOUS",
      stopAfter: true,
      ...context,
      stage1,
      mergeReady,
      reason:
        "stage1-gate and/or lifecycle-gate merge-ready returned output without a trustworthy exitCode; " +
        "this gate fails closed rather than assuming a state.",
    };
  }

  if (stage1.exitCode === 1 || mergeReady.exitCode === 1) {
    return {
      state: "AMBIGUOUS",
      stopAfter: true,
      ...context,
      stage1,
      mergeReady,
      reason: [
        stage1.exitCode === 1 ? `stage1-gate operational error: ${stage1.message}` : null,
        mergeReady.exitCode === 1 ? `lifecycle-gate merge-ready operational error: ${mergeReady.message}` : null,
      ]
        .filter(Boolean)
        .join(" | "),
    };
  }

  const stage1DispositionSatisfied = stage1DispositionMarksSatisfied(stage1Disposition);
  if (stage1.state === "NOT_REQUESTED" || stage1.state === "PENDING") {
    if (stage1DispositionSatisfied) {
      if (isMergeReadyState(mergeReady.state)) {
        return { state: "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", stopAfter: true, ...context };
      }
      if (mergeReady.state === "BLOCKED_CLOSING_REFERENCE") {
        return { state: "STAGE1_CORRECTION_REQUIRED", stopAfter: true, ...context };
      }
    }
    return { state: "NO_ACTION_YET", stopAfter: true, ...context, stage1, mergeReady };
  }

  if (stage1.state === "EXEMPT") {
    if (isMergeReadyState(mergeReady.state)) {
      return { state: "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", stopAfter: true, ...context };
    }
    if (mergeReady.state === "BLOCKED_CLOSING_REFERENCE") {
      return { state: "STAGE1_CORRECTION_REQUIRED", stopAfter: true, ...context };
    }
  }

  if (stage1.state === "RESPONSE_RECEIVED") {
    if (!isCleanStage1Response(stage1)) {
      return { state: "STAGE1_CORRECTION_REQUIRED", stopAfter: true, ...context };
    }
    if (isMergeReadyState(mergeReady.state)) {
      return { state: "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", stopAfter: true, ...context };
    }
    if (mergeReady.state === "BLOCKED_CLOSING_REFERENCE") {
      return { state: "STAGE1_CORRECTION_REQUIRED", stopAfter: true, ...context };
    }
  }

  return {
    state: "AMBIGUOUS",
    stopAfter: true,
    ...context,
    stage1,
    mergeReady,
    reason:
      `stage1-gate state ${JSON.stringify(stage1.state)} combined with lifecycle-gate merge-ready state ` +
      `${JSON.stringify(mergeReady.state)} and Stage 1 disposition ${JSON.stringify(stage1Disposition)} ` +
      "does not resolve to exactly one known pre-merge transition",
  };
}

// Pure core of the post-merge phase: derives one verdict from an already-computed
// lifecycle-gate `checkPostAudit` result. See the module comment's verdict-derivation table.
export function resolvePostMergeVerdict({ postAudit }, context = {}) {
  if (!hasTrustworthyExitCode(postAudit)) {
    return {
      state: "AMBIGUOUS",
      stopAfter: true,
      ...context,
      postAudit,
      reason:
        "lifecycle-gate post-audit returned output without a trustworthy exitCode; this gate fails closed " +
        "rather than assuming a state.",
    };
  }

  if (postAudit.exitCode === 1) {
    return {
      state: "AMBIGUOUS",
      stopAfter: true,
      ...context,
      postAudit,
      reason: `lifecycle-gate post-audit operational error: ${postAudit.message}`,
    };
  }

  if (postAudit.state === "READY_TO_CLOSE" || postAudit.state === "ACCEPTED_NO_WORK_ISSUE") {
    return { state: "STAGE2_CLOSE_READY", stopAfter: true, ...context, postAudit };
  }

  if (postAudit.state === "OK") {
    if (postAudit.rawVerdict === "NOT CLEAN") {
      return { state: "STAGE2_CORRECTION_REQUIRED", stopAfter: true, ...context };
    }
    // rawVerdict is null/PENDING, or CLEAN-but-not-yet-backed-by-a-completed-report (verdict
    // nulled out by checkPostAudit itself in that case) -- either way, no completed Stage 2
    // report exists yet to act on.
    return { state: "NO_ACTION_YET", stopAfter: true, ...context, postAudit };
  }

  // PREMATURE_CLOSURE (a work issue closed without a backing CLEAN verdict) is itself a
  // recoverable-but-abnormal state (lifecycle-gate.mjs's own `--recover true`), and any other
  // state this gate does not recognize falls here too: neither is safely resolvable into one
  // of the six fixed dispatch verdicts without a mutating recovery step this read-only gate
  // does not perform on its own.
  return {
    state: "AMBIGUOUS",
    stopAfter: true,
    ...context,
    postAudit,
    reason:
      `lifecycle-gate post-audit state ${JSON.stringify(postAudit.state)} (rawVerdict ` +
      `${JSON.stringify(postAudit.rawVerdict ?? null)}) does not resolve to exactly one known post-merge transition`,
  };
}

// Exit-code scheme (this script's own; no prior convention already fixed it, so it mirrors
// ready-dispatch-gate.mjs's READY/BLOCKED/NOT_READY/ERROR split as closely as this verdict
// set allows): 0 for a verdict that authorizes proceeding or explicitly says "wait, nothing
// to do" (NO_ACTION_YET, STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2, STAGE2_CLOSE_READY); 3
// for a verdict that names a concrete, non-blocking corrective action required before the
// happy path can proceed (STAGE1_CORRECTION_REQUIRED, STAGE2_CORRECTION_REQUIRED); 4 for
// AMBIGUOUS (mirrors BLOCKED's exit 4 -- a positive "stop, do not improvise" signal); 1 for
// a genuine operational error (missing/invalid arguments, or an underlying `gh` read that
// itself failed before any verdict could be computed at all).
function exitCodeFor(state) {
  switch (state) {
    case "NO_ACTION_YET":
    case "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2":
    case "STAGE2_CLOSE_READY":
      return 0;
    case "STAGE1_CORRECTION_REQUIRED":
    case "STAGE2_CORRECTION_REQUIRED":
      return 3;
    case "AMBIGUOUS":
      return 4;
    default:
      return 4;
  }
}

async function resolvePreMerge({ repo, pr, head, issue, stage1Disposition = null, controlIssue }, { stage1RunImpl, checkMergeReadyImpl }) {
  let stage1;
  try {
    stage1 = await stage1RunImpl({ repo, number: pr, head });
  } catch (err) {
    stage1 = { exitCode: 1, message: `stage1-gate threw: ${err.message}` };
  }

  let mergeReady;
  try {
    mergeReady = await checkMergeReadyImpl({ repo, pr, issue });
  } catch (err) {
    mergeReady = { exitCode: 1, message: `lifecycle-gate merge-ready threw: ${err.message}` };
  }

  const context = { repo, pr, head, issue, ...(controlIssue != null ? { controlIssue } : {}) };
  const verdict = resolvePreMergeVerdict({ stage1, mergeReady, stage1Disposition }, context);
  return { exitCode: exitCodeFor(verdict.state), ...verdict };
}

async function resolvePostMerge({ repo, auditIssue, controlIssue }, { checkPostAuditImpl }) {
  let postAudit;
  try {
    postAudit = await checkPostAuditImpl({ repo, "audit-issue": auditIssue });
  } catch (err) {
    postAudit = { exitCode: 1, message: `lifecycle-gate post-audit threw: ${err.message}` };
  }

  const context = { repo, auditIssue, ...(controlIssue != null ? { controlIssue } : {}) };
  const verdict = resolvePostMergeVerdict({ postAudit }, context);
  return { exitCode: exitCodeFor(verdict.state), ...verdict };
}

function defaultGhIssueView({ repo, number }) {
  const raw = execFileSync("gh", ["issue", "view", String(number), "--repo", repo, "--json", "body,state"], {
    encoding: "utf8",
  });
  return JSON.parse(raw);
}

function defaultGhPrHead({ repo, number }) {
  const raw = execFileSync("gh", ["pr", "view", String(number), "--repo", repo, "--json", "headRefOid"], {
    encoding: "utf8",
  });
  return JSON.parse(raw).headRefOid;
}

// The whole composed gate, wired for tests: every I/O dependency (control-Issue read, PR
// head read, and the three composed check functions themselves) is injectable, defaulting
// to the real `gh` CLI / real stage1-gate.mjs / real lifecycle-gate.mjs in main(). Direct-
// reference mode (`auditIssue`, or `pr`+`head`) takes precedence over control-Issue mode when
// both are supplied, mirroring format-unit-dispatch-prompt.mjs's own explicit-fields-first
// convention.
export async function runNextReviewTransitionGate(
  args,
  {
    resolveRepoIdentityImpl = resolveRepoIdentity,
    ghIssueViewImpl = defaultGhIssueView,
    ghPrHeadImpl = defaultGhPrHead,
    stage1RunImpl = stage1Run,
    checkMergeReadyImpl = checkMergeReady,
    checkPostAuditImpl = checkPostAudit,
  } = {},
) {
  let repo = args.repo;
  if (!repo) {
    const identity = resolveRepoIdentityImpl();
    if (!identity.ok) {
      return {
        exitCode: 1,
        message: `Could not determine the current repository identity (--repo was not supplied): ${identity.reason}`,
      };
    }
    repo = identity.repo;
  }

  // Direct-reference mode: skips the control-Issue read entirely. Checked before
  // --control-issue so an explicit direct reference always wins if both happen to be given.
  if (args.auditIssue) {
    return resolvePostMerge({ repo, auditIssue: args.auditIssue, controlIssue: null }, { checkPostAuditImpl });
  }
  if (args.pr) {
    if (!args.head) {
      return {
        exitCode: 1,
        message: "Missing required arg: --head is required alongside --pr in direct-reference mode.",
      };
    }
    if (args.issue === undefined) {
      return {
        exitCode: 1,
        message:
          "Missing required arg: --issue is required alongside --pr and --head in direct-reference mode " +
          '(use "--issue none" only for the explicit no-work-issue path).',
      };
    }
    return resolvePreMerge(
      { repo, pr: args.pr, head: args.head, issue: args.issue, controlIssue: null },
      { stage1RunImpl, checkMergeReadyImpl },
    );
  }

  if (!args.controlIssue) {
    return {
      exitCode: 1,
      message:
        "Missing required arg: supply --control-issue, or a direct reference (--audit-issue, or --pr with --head).",
    };
  }

  let controlData;
  try {
    controlData = await ghIssueViewImpl({ repo, number: args.controlIssue });
  } catch (err) {
    return { exitCode: 1, message: `gh issue view failed for ${repo}#${args.controlIssue}: ${err.message}` };
  }
  const body = controlData.body ?? "";
  const controlIssueNumber = Number(args.controlIssue);
  if (controlData.state !== "OPEN") {
    return {
      exitCode: 4,
      state: "AMBIGUOUS",
      stopAfter: true,
      repo,
      controlIssue: controlIssueNumber,
      reason: `control Issue ${repo}#${controlIssueNumber} is ${controlData.state}, not OPEN`,
    };
  }

  const auditRef = parseOptionalIssueRef(parseControlBullet(body, "Stage 2"), "Stage 2");
  if (auditRef.kind === "issue") {
    return resolvePostMerge({ repo, auditIssue: auditRef.issue, controlIssue: controlIssueNumber }, { checkPostAuditImpl });
  }
  if (auditRef.kind === "invalid") {
    return {
      exitCode: 4,
      state: "AMBIGUOUS",
      stopAfter: true,
      repo,
      controlIssue: controlIssueNumber,
      reason: `Stage 2 (Audit) reference is malformed: ${auditRef.reason}`,
    };
  }

  const prRef = parseOptionalIssueRef(parseControlBullet(body, "PR"), "PR");
  if (prRef.kind === "issue") {
    const executionField = readExecutionBulletField(body);
    const executionRef = executionField.conflict
      ? {
          ok: false,
          reason:
            `Execution pointer is ambiguous: "- **Execution:**" names ${JSON.stringify(executionField.legacy)} ` +
            `while "- **Execution issue:**" names ${JSON.stringify(executionField.liveSpelling)} — these must resolve to the same execution Issue`,
        }
      : parseExecutionPointer(executionField.value);
    if (!executionRef.ok) {
      return {
        exitCode: 4,
        state: "AMBIGUOUS",
        stopAfter: true,
        repo,
        controlIssue: controlIssueNumber,
        reason:
          `Execution reference required to resolve the gated work issue for the pre-merge check is malformed: ` +
          `${executionRef.reason}`,
      };
    }

    let head = args.head;
    if (!head) {
      try {
        head = await ghPrHeadImpl({ repo, number: prRef.issue });
      } catch (err) {
        return { exitCode: 1, message: `gh pr view failed for ${repo}#${prRef.issue}: ${err.message}` };
      }
    }
    const stage1Disposition = parseControlBullet(body, "Stage 1");

    return resolvePreMerge(
      { repo, pr: prRef.issue, head, issue: executionRef.issue, stage1Disposition, controlIssue: controlIssueNumber },
      { stage1RunImpl, checkMergeReadyImpl },
    );
  }
  if (prRef.kind === "invalid") {
    return {
      exitCode: 4,
      state: "AMBIGUOUS",
      stopAfter: true,
      repo,
      controlIssue: controlIssueNumber,
      reason: `PR reference is malformed: ${prRef.reason}`,
    };
  }

  // Neither "Stage 2" nor "PR" names a settled issue reference: a post-PR-lifecycle control
  // Issue with no PR and no Audit recorded at all is exactly the "conflicting/unrecognized
  // evidence shape" case AMBIGUOUS exists for.
  return {
    exitCode: 4,
    state: "AMBIGUOUS",
    stopAfter: true,
    repo,
    controlIssue: controlIssueNumber,
    reason:
      `control Issue #${controlIssueNumber} has neither a settled "PR" nor "Stage 2" reference ` +
      `(PR: ${JSON.stringify(parseControlBullet(body, "PR"))}, Stage 2: ${JSON.stringify(parseControlBullet(body, "Stage 2"))}) ` +
      "-- this gate only applies once at least one of them is settled",
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    args[a.slice(2)] = argv[++i];
  }
  return args;
}

async function main() {
  const raw = parseArgs(process.argv.slice(2));
  const result = await runNextReviewTransitionGate({
    repo: raw.repo,
    controlIssue: raw["control-issue"],
    pr: raw.pr,
    head: raw.head,
    issue: raw.issue,
    auditIssue: raw["audit-issue"],
  });
  if (result.exitCode === 1) {
    console.error(result.message);
    process.exit(1);
    return;
  }
  console.log(JSON.stringify(result));
  process.exit(result.exitCode);
}

if (process.argv[1] && process.argv[1].endsWith("next-review-transition-gate.mjs")) {
  main();
}
