// Deterministic launcher step for issue #73 (unit 73-B).
//
// Composes the existing gates (session-entry-gate and the commands its verdicts already name);
// it adds no lifecycle engine and no verdict semantics. One step:
//   1. read the gate verdict (injected `runGate`),
//   2. for a mechanically decidable verdict, read back the durable effect BEFORE acting,
//      classify it (classifyExternalEffect), and replay only when definitely not completed,
//   3. independently verify the transition's postcondition from a read-back (verifyPostcondition),
//   4. make a successor eligible only when that postcondition is proved.
// An actor's exit status or self-report is never consulted for unlocking a successor.
//
// Open path (unit 73-C): semantic stages dispatch one fresh bounded worker BY REFERENCE using the
// route chosen by route-qualification. A correction (Stage 1 findings, Stage 2 NOT CLEAN) also
// needs exact-target Chat guidance (chat-guidance-gate); without it the step stops with the fixed
// handoff string and dispatches nothing. The supervisor never authors the correction.
//
// Tests: node --test tools/orchestration/launcher-step.test.mjs

import { verifyChatGuidance, guidanceTargetForVerdict } from "./chat-guidance-gate.mjs";
import { selectRoute } from "./route-qualification.mjs";
import { classifyExecutionAuthority } from "./execution-authority-gate.mjs";
import { getActionEnvelope, ENVELOPE_MODES } from "./action-envelope.mjs";
import { createHash } from "node:crypto";

const GUIDED_CORRECTION_STATES = new Set(["STAGE1_CORRECTION_REQUIRED", "STAGE2_CORRECTION_REQUIRED"]);

export const Outcome = Object.freeze({
  ADVANCED: "ADVANCED",
  WAITING: "WAITING",
  OPEN_PATH_REQUIRED: "OPEN_PATH_REQUIRED",
  FAIL_CLOSED: "FAIL_CLOSED",
});

export const EffectClass = Object.freeze({
  NOT_COMPLETED: "NOT_COMPLETED",
  COMPLETED_UNPROJECTED: "COMPLETED_UNPROJECTED",
  AMBIGUOUS: "AMBIGUOUS",
});

// Per-transition table: {preState, action, verifier, postcondition, invalidation}.
// `preState` is the gate verdict state; `action` is the already-authorized mechanical command
// (taken from the verdict itself at run time); `verifier` names the read-back; `invalidation`
// lists the conditions under which a previously proved postcondition no longer unlocks.
export const TRANSITIONS = Object.freeze({
  READY_TO_PROJECT_PLAN_READY: {
    preState: "READY_TO_PROJECT_PLAN_READY",
    action: "write-control-snapshot",
    verifier: "control-lifecycle-readback",
    postcondition: "control Issue Lifecycle reads PLAN_READY and its Plan pointer names the canonical plan index",
    invalidation: ["control body changed since read-back", "plan comment superseded"],
  },
  READY_TO_PROJECT_ROUTED: {
    preState: "READY_TO_PROJECT_ROUTED",
    action: "write-control-snapshot",
    verifier: "control-lifecycle-readback",
    postcondition: "control Issue Lifecycle reads ROUTED",
    invalidation: ["control body changed since read-back", "manifest comment superseded"],
  },
  READY_TO_RUN_DISPATCH_MANIFEST: {
    preState: "READY_TO_RUN_DISPATCH_MANIFEST",
    action: "prepare-dispatch-manifest-and-project",
    verifier: "manifest-and-lifecycle-readback",
    postcondition: "verified manifest comment exists and Lifecycle reads ROUTED",
    invalidation: ["plan index pointer changed", "manifest comment edited after verification"],
  },
  STAGE2_REPORT_READY_TO_RECORD: {
    preState: "STAGE2_REPORT_READY_TO_RECORD",
    action: "record-verdict",
    verifier: "audit-verdict-field-readback",
    postcondition: "audit Issue Verdict field is promoted from the bound report comment",
    invalidation: ["report comment id differs from the bound one", "audit Issue reopened"],
  },
  STAGE2_TRIGGER_REQUIRED: {
    preState: "STAGE2_TRIGGER_REQUIRED",
    action: "post-stage2-reviewer-trigger",
    verifier: "trigger-comment-readback",
    postcondition: "exactly one valid reviewer trigger comment exists on the audit Issue",
    invalidation: ["audit Issue closed or superseded", "trigger comment deleted"],
  },
  // Normal midpoint after a Stage 2 preparation worker returns (and the pre-merge resume case):
  // the Audit Issue exists; finalize the control projection, then post the one idempotent trigger.
  STAGE2_AUDIT_ALREADY_PREPARED: {
    preState: "STAGE2_AUDIT_ALREADY_PREPARED",
    action: "finalize-audit-breakpoint-then-post-stage2-reviewer-trigger",
    verifier: "audit-projection-and-trigger-readback",
    postcondition: "control Issue reads Lifecycle AUDIT with Stage 2 naming this audit AND exactly the reviewer trigger exists on the audit thread",
    invalidation: ["audit Issue closed or superseded", "trigger comment deleted"],
  },
  STAGE2_CLOSE_READY: {
    preState: "STAGE2_CLOSE_READY",
    action: "close-audit",
    verifier: "issue-state-readback",
    postcondition: "audit Issue (and gated work Issue, when present) read CLOSED",
    invalidation: ["audit Issue reopened"],
  },
  // Normal clean Stage 1 continuation (Stage 1 satisfied, or correction-satisfied): the mechanical
  // part is finalize (ordinary variant only) + merge of the exact authorized head. Stage 2
  // preparation after the merge is semantic and surfaces on the next step as
  // STAGE2_PREPARATION_REQUIRED (open path), never as a launcher action.
  STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2: {
    preState: "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2",
    action: "finalize-stage1-satisfied-then-merge-pr",
    verifier: "pr-merged-readback",
    postcondition: "PR reads MERGED at the exact head the gate authorized",
    invalidation: ["PR head changed since the verdict", "PR closed without merge"],
  },
  STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2: {
    preState: "STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2",
    action: "merge-pr",
    verifier: "pr-merged-readback",
    postcondition: "PR reads MERGED at the exact corrected head the gate authorized",
    invalidation: ["PR head changed since the verdict", "PR closed without merge"],
  },
  // Issue #837 / PR #838: a provenance-verified corrected head whose canonical correction-satisfied
  // disposition was never projected. The only mechanical action is the verdict's own finalizer;
  // success is the exact disposition read back at the unchanged PR head, then the gate re-enters.
  STAGE1_CORRECTION_FINALIZATION_REQUIRED: {
    preState: "STAGE1_CORRECTION_FINALIZATION_REQUIRED",
    action: "finalize-correction-breakpoint",
    verifier: "control-correction-disposition-readback",
    postcondition: "control Issue Stage 1 reads the canonical correction-satisfied disposition for the exact reviewed/corrected heads while the PR head is still the corrected head",
    invalidation: ["PR head changed since the verdict", "PR closed or merged", "control Stage 1 bullet changed"],
  },
  STAGE2_CORRECTION_PR_NEEDS_FINALIZATION: {
    preState: "STAGE2_CORRECTION_PR_NEEDS_FINALIZATION",
    action: "finalize-pr-breakpoint",
    verifier: "control-pr-projection-readback",
    postcondition: "control Issue PR field points at the open correction PR with Stage 1 requested",
    invalidation: ["correction PR closed or head changed"],
  },
});

// Verdicts whose continuation is semantic work: a fresh bounded worker, never a launcher action.
export const OPEN_PATH_STATES = Object.freeze(
  new Set([
    "READY_TO_DISPATCH",
    "READY_TO_DISPATCH_PLANNING",
    "READY_TO_DISPATCH_UNITS",
    "READY_TO_DISPATCH_INTEGRATION",
    "REPLAN_REQUIRED",
    "STAGE1_CORRECTION_REQUIRED",
    "STAGE2_CORRECTION_REQUIRED",
    "STAGE2_PREPARATION_REQUIRED",
  ]),
);

const WAITING_STATES = new Set(["NO_ACTION_YET"]);

// evidence: { expectedTarget, target, readBackOk, effect: 'absent'|'present'|'unknown',
//             projected: boolean|null }
// `target` is the identity the read-back actually observed; a mismatch (stale / wrong-target)
// or malformed evidence is AMBIGUOUS. Only an authoritative `absent` read-back is NOT_COMPLETED.
export function classifyExternalEffect(evidence) {
  if (!evidence || typeof evidence !== "object") return EffectClass.AMBIGUOUS;
  const { expectedTarget, target, readBackOk, effect, projected } = evidence;
  if (readBackOk !== true) return EffectClass.AMBIGUOUS;
  if (expectedTarget == null || target == null || expectedTarget !== target) return EffectClass.AMBIGUOUS;
  if (effect === "absent") return projected === true ? EffectClass.AMBIGUOUS : EffectClass.NOT_COMPLETED;
  if (effect === "present") {
    if (typeof projected !== "boolean") return EffectClass.AMBIGUOUS;
    return EffectClass.COMPLETED_UNPROJECTED; // when projected is already true, finalize is a no-op
  }
  return EffectClass.AMBIGUOUS;
}

// Independent postcondition: true only when well-formed, current, on-target read-back shows the
// effect present AND projected. Never reads any actor-reported result.
export function verifyPostcondition(evidence) {
  return (
    !!evidence &&
    evidence.readBackOk === true &&
    evidence.expectedTarget != null &&
    evidence.expectedTarget === evidence.target &&
    evidence.effect === "present" &&
    evidence.projected === true
  );
}

// By-reference targets/provenance the gate verdict already computed; a dispatched worker is built
// from exactly these, never reconstructed. Whitelisted so no bulky diagnostic text is carried.
export const VERDICT_REFERENCE_KEYS = Object.freeze([
  "repo", "controlIssue", "executionIssue", "route", "pr", "head", "issue", "workIssue", "auditIssue",
  "planIndexUrl", "manifestCommentId", "manifestUrl", "dispatchReadyUnitIds", "alreadyDoneUnitIds",
  "replanRequiredUnitIds", "correctionReason", "evidenceOnlyEligible",
]);

export function extractVerdictReferences(verdict) {
  const refs = {};
  for (const k of VERDICT_REFERENCE_KEYS) if (verdict && verdict[k] !== undefined && verdict[k] !== null) refs[k] = verdict[k];
  return refs;
}

// Pure. Mutation authority for a launcher step is NEVER a comment: it is the current
// execution-authority envelope derived from the gate verdict (the same shapes
// execution-authority-gate.mjs recognizes) or, for the mechanical transitions, the gate's own
// bounded action envelope. `authorization` ({controlIssue, executionIssue}) only names which
// launch was requested; the verdict must belong to that control/execution issue.
export function authorizeLauncherVerdict(verdict, authorization) {
  const no = (reason) => ({ authorized: false, reason });
  const state = verdict?.state;
  if (typeof state !== "string") return no("verdict has no state");
  if (!authorization || !Number.isInteger(authorization.controlIssue) || !Number.isInteger(authorization.executionIssue)) {
    return no("no launch request naming a control and execution issue");
  }
  if (verdict.controlIssue != null && Number(verdict.controlIssue) !== authorization.controlIssue) {
    return no("verdict belongs to a different control issue");
  }
  for (const k of ["executionIssue", "issue", "workIssue"]) {
    if (verdict[k] != null && Number(verdict[k]) !== authorization.executionIssue) {
      return no(`verdict ${k} does not match the requested execution issue`);
    }
  }
  const base = { controlIssue: verdict.controlIssue != null ? Number(verdict.controlIssue) : authorization.controlIssue, executionIssue: authorization.executionIssue };
  let trigger = null;
  if (state === "READY_TO_DISPATCH") trigger = { origin: "control_plane_dispatch", ...base, route: verdict.route };
  else if (state === "READY_TO_DISPATCH_PLANNING") trigger = { origin: "planning_dispatch", ...base };
  else if (state === "READY_TO_DISPATCH_INTEGRATION") trigger = { origin: "integration_dispatch", ...base };
  else if (GUIDED_CORRECTION_STATES.has(state)) {
    trigger = { origin: "correction_dispatch", controlIssue: base.controlIssue, pr: verdict.pr, auditIssue: verdict.auditIssue };
  }
  if (trigger) {
    const c = classifyExecutionAuthority(trigger);
    return c.authorized ? { authorized: true, reason: c.reason } : no(c.reason);
  }
  const env = getActionEnvelope(state, verdict);
  if (env?.mode === ENVELOPE_MODES.BOUNDED && Array.isArray(env.authorizedActions) && env.authorizedActions.length > 0) {
    return { authorized: true, reason: `gate action envelope authorizes: ${env.authorizedActions.join(", ")}` };
  }
  return no(`no execution-authority envelope for verdict state ${state}`);
}

function result(outcome, evidence, extra = {}) {
  return { outcome, successorEligible: outcome === Outcome.ADVANCED, evidence, ...extra };
}

// deps.readOpenPath(verdict) -> { comments, reportCommentId?, routeInput? } is optional; absent,
// the open path is reported without a dispatch (prior behavior). `routeInput` is
// { outcomeClass, assurance, candidates, evidence, availability } for selectRoute.
export async function resolveOpenPath(state, verdict, deps) {
  if (typeof deps.readOpenPath !== "function") return result(Outcome.OPEN_PATH_REQUIRED, { state });
  try {
    const input = await deps.readOpenPath(verdict);
    let guidance = null;
    if (GUIDED_CORRECTION_STATES.has(state)) {
      const target = guidanceTargetForVerdict(verdict, { reportCommentId: input?.reportCommentId });
      const g = verifyChatGuidance(input?.comments, target);
      if (g.status !== "VALID") {
        return result(Outcome.WAITING, { state, chatGuidanceRequired: true, guidanceStatus: g.status, handoff: g.handoff, reason: g.reason });
      }
      guidance = { commentId: g.guidance.commentId, target };
    }
    const route = selectRoute(input?.routeInput ?? {});
    if (route.failClosed) return result(Outcome.FAIL_CLOSED, { state, reason: `no qualified route: ${route.reason}` });
    const role = GUIDED_CORRECTION_STATES.has(state) ? "correction worker" : "implementation worker";
    return result(Outcome.OPEN_PATH_REQUIRED, {
      state,
      dispatch: {
        role,
        route: route.route,
        byReference: { state, guidance, ...extractVerdictReferences(verdict) },
        freshWorker: true,
        supervisorAuthors: false,
      },
    });
  } catch (e) {
    return result(Outcome.FAIL_CLOSED, { state, reason: `open path failed: ${e?.message ?? e}` });
  }
}

// deps: { runGate(controlIssue) -> verdict, authorizeVerdict(verdict) -> { authorized, reason } (required;
//         production binds authorizeLauncherVerdict to the launch request), readEffect(transition, verdict) -> evidence,
//         execute(transition, verdict) -> any (result ignored for unlocking),
//         finalize(transition, verdict) -> any (project an already-completed effect; no replay) }
export async function runLauncherStep({ controlIssue, deps } = {}) {
  if (controlIssue == null || !deps) {
    return result(Outcome.FAIL_CLOSED, { reason: "missing controlIssue or deps" });
  }
  let verdict;
  try {
    verdict = await deps.runGate(controlIssue);
  } catch (e) {
    return result(Outcome.FAIL_CLOSED, { reason: `gate failed: ${e?.message ?? e}` });
  }
  const state = verdict?.state;
  if (typeof state !== "string") return result(Outcome.FAIL_CLOSED, { reason: "verdict has no state" });
  if (WAITING_STATES.has(state)) {
    // Name the external thread a reviewer wait would poll (canonical poll.mjs target), when the
    // verdict identifies one: a Stage 2 audit issue, else the Stage 1 PR.
    const audit = verdict.auditIssue ?? verdict.postAudit?.auditIssue;
    let wait = null;
    if (Number.isInteger(Number(audit)) && Number(audit) > 0) wait = { kind: "issue", number: Number(audit), repo: verdict.repo ?? null };
    else if (Number.isInteger(Number(verdict.pr)) && Number(verdict.pr) > 0) wait = { kind: "pr", number: Number(verdict.pr), repo: verdict.repo ?? null };
    return result(Outcome.WAITING, { state, ...(wait ? { wait } : {}) });
  }
  // Authority is established before any read-for-action, dispatch, or mutation. A missing check
  // fails closed; a comment alone is never authority.
  if (typeof deps.authorizeVerdict !== "function") {
    return result(Outcome.FAIL_CLOSED, { state, reason: "no execution-authority check supplied" });
  }
  let authority;
  try {
    authority = await deps.authorizeVerdict(verdict);
  } catch (e) {
    return result(Outcome.FAIL_CLOSED, { state, reason: `authority check failed: ${e?.message ?? e}` });
  }
  if (authority?.authorized !== true) {
    return result(Outcome.FAIL_CLOSED, { state, reason: `no execution authority: ${authority?.reason ?? "unspecified"}` });
  }
  if (OPEN_PATH_STATES.has(state)) return resolveOpenPath(state, verdict, deps);

  const transition = TRANSITIONS[state];
  if (!transition) return result(Outcome.FAIL_CLOSED, { state, reason: "unrecognized verdict state" });

  try {
    const before = await deps.readEffect(transition, verdict);
    if (verifyPostcondition(before)) return result(Outcome.ADVANCED, { state, before, replayed: false });

    const cls = classifyExternalEffect(before);
    if (cls === EffectClass.AMBIGUOUS) {
      return result(Outcome.FAIL_CLOSED, { state, effectClass: cls, before, reason: "ambiguous external effect" });
    }
    if (cls === EffectClass.NOT_COMPLETED) await deps.execute(transition, verdict);
    else await deps.finalize(transition, verdict); // COMPLETED_UNPROJECTED: never replay

    const after = await deps.readEffect(transition, verdict);
    if (!verifyPostcondition(after)) {
      return result(Outcome.FAIL_CLOSED, {
        state,
        effectClass: cls,
        after,
        reason: "postcondition not independently proved",
      });
    }
    return result(Outcome.ADVANCED, { state, effectClass: cls, after, replayed: cls === EffectClass.NOT_COMPLETED });
  } catch (e) {
    return result(Outcome.FAIL_CLOSED, { state, reason: `step failed: ${e?.message ?? e}` });
  }
}

// ---------------------------------------------------------------------------------------------
// Founder interrupt/resume, terminal return, environment resume (issue #73, unit 73-E).
// Pure helpers; durable writes go through injected deps (write-control-snapshot.mjs in production).
// ---------------------------------------------------------------------------------------------

export const DECISION_SURFACE_HEADING = "## Launcher Decision Surface (v1)";
export const FOUNDER_DECISION_STATES = Object.freeze({ NONE: "none", PENDING: "pending" });
const WRITER_PERMISSIONS = ["admin", "maintain", "write"];
export const isWriterComment = (c) => WRITER_PERMISSIONS.includes(String(c?.authorPermission ?? "").toLowerCase());
// The literal token `open` in an options field means "open-ended"; a real option spelled `open`
// would be indistinguishable from it, so it is reserved (rejected on render and parse).
const OPEN_ENDED_TOKEN = "open";

// One durable surface batching every currently known founder question on the active path.
// questions: [{ id, question, blocking, options?: string[], recommended?: string, resolves?: string }]
// `resolves` (a decision key) declares the authoritative settled-decision field the answer
// deterministically projects to (see planFounderProjection); a question without it cannot resume
// autonomous execution because its effect on governing state is not deterministic.
// surfaceId: unique identity of THIS surface (see newSurfaceId); answers bind to it so a later
// surface that reuses an id such as Q1 never inherits an earlier answer.
const SURFACE_ID = /^[A-Za-z0-9._-]{4,64}$/;
export const DECISION_KEY = /^[A-Za-z0-9._-]{1,64}$/;

export function newSurfaceId(controlIssue, questions, round = 1) {
  const h = createHash("sha256").update(JSON.stringify({ controlIssue, round, questions })).digest("hex").slice(0, 10);
  return `${controlIssue}-r${round}-${h}`;
}

export function renderDecisionSurface({ controlIssue, questions, surfaceId } = {}) {
  if (!Number.isInteger(controlIssue) || !Array.isArray(questions) || questions.length === 0) return null;
  if (!SURFACE_ID.test(String(surfaceId ?? ""))) return null;
  const seenIds = new Set();
  const lines = [DECISION_SURFACE_HEADING, "", `- **Surface id:** ${surfaceId}`, `- **Control issue:** #${controlIssue}`];
  for (const q of questions) {
    if (!q?.id || !q?.question || !q?.blocking) return null;
    if (q.resolves != null && !DECISION_KEY.test(String(q.resolves))) return null;
    if ((q.options ?? []).some((o) => String(o).trim() === "" || String(o).trim() === OPEN_ENDED_TOKEN || String(o).includes("|"))) return null;
    if (seenIds.has(String(q.id))) return null;
    seenIds.add(String(q.id));
    lines.push(
      `- **Question ${q.id}:** ${q.question} (blocks: ${q.blocking}; options: ${(q.options ?? []).join(" | ") || "open"}; recommended: ${q.recommended ?? "none"}${q.resolves ? `; resolves: ${q.resolves}` : ""})`,
    );
  }
  lines.push(
    "- **General comments:** (optional) reply with a `- **General comments:** <text>` bullet for any other founder input",
    "",
    `Resolve by replying (repository writer) with \`- **Surface id:** ${surfaceId}\` and one \`- **Answer <id>:** <choice>\` bullet per question.`,
  );
  return lines.join("\n");
}

// Inverse of renderDecisionSurface for the production resume path: the surface id and question ids
// a durable surface comment declares, or null when the body is not a well-formed surface.
// With { controlIssue }, a surface naming a different (or no) control issue is rejected. A surface
// that repeats a question id or reserves-token option is ambiguous and rejected (null).
export function parseDecisionSurface(body, { controlIssue } = {}) {
  const text = String(body ?? "");
  if (!text.trimStart().startsWith(DECISION_SURFACE_HEADING)) return null;
  let surfaceId = null;
  let surfaceControl = null;
  const questionIds = [];
  const questions = [];
  for (const line of text.split(/\r?\n/)) {
    const s = /^\s*[-*]\s+\*\*Surface id:\*\*\s*(\S+)\s*$/.exec(line);
    if (s && surfaceId === null) surfaceId = s[1];
    const cm = /^\s*[-*]\s+\*\*Control issue:\*\*\s*#(\d+)\s*$/.exec(line);
    if (cm && surfaceControl === null) surfaceControl = Number(cm[1]);
    const q = /^\s*[-*]\s+\*\*Question ([^*:]+):\*\*(.*)$/.exec(line);
    if (q) {
      const id = q[1].trim();
      if (questionIds.includes(id)) return null;
      questionIds.push(id);
      const meta = /\(blocks: [^;]*; options: ([^;]*); recommended: [^;)]*(?:; resolves: ([A-Za-z0-9._-]{1,64}))?\)\s*$/.exec(q[2]);
      const optRaw = meta ? meta[1].trim() : "";
      const options = !meta || optRaw === OPEN_ENDED_TOKEN || optRaw === "" ? [] : optRaw.split(" | ").map((o) => o.trim());
      if (options.length > 1 && options.includes(OPEN_ENDED_TOKEN)) return null;
      questions.push({ id, options, resolves: meta?.[2] ?? null });
    }
  }
  if (!SURFACE_ID.test(String(surfaceId ?? "")) || questionIds.length === 0) return null;
  if (controlIssue !== undefined && surfaceControl !== Number(controlIssue)) return null;
  return { surfaceId, questionIds, questions, controlIssue: surfaceControl };
}

// Pure. The deterministic projection of founder answers onto authoritative state: each question
// must declare the decision key it resolves (`resolves`) and its answer must be one of the declared
// options (any nonempty answer when options are open). Returns { ok, decisions:[{key,answer}] } or
// { ok:false, reason }; never guesses a mapping for prose it cannot place.
export function planFounderProjection({ questions, answers } = {}) {
  const list = Array.isArray(questions) ? questions : [];
  if (list.length === 0) return { ok: false, reason: "decision surface declares no questions to project" };
  const decisions = [];
  const keys = new Set();
  for (const q of list) {
    if (!q?.resolves || !DECISION_KEY.test(String(q.resolves))) {
      return { ok: false, reason: `question ${q?.id} declares no decision it resolves; its answer cannot be deterministically applied` };
    }
    if (keys.has(q.resolves)) return { ok: false, reason: `decision ${q.resolves} is resolved by more than one question` };
    keys.add(q.resolves);
    const a = answers?.[q.id];
    if (typeof a !== "string" || a.trim() === "") return { ok: false, reason: `question ${q.id} has no answer` };
    if (Array.isArray(q.options) && q.options.length > 0 && !q.options.includes(a.trim())) {
      return { ok: false, reason: `answer to ${q.id} is not one of the declared options` };
    }
    decisions.push({ key: q.resolves, answer: a.trim() });
  }
  return { ok: true, decisions };
}

// comments: [{ id, body, authorPermission }] in chronological order. Answers count only from
// write/maintain/admin authors, only from comments carrying this exact `- **Surface id:**` bullet,
// and the LATEST answer per question wins (a corrected answer replaces an earlier one).
export function parseDecisionResolution(comments, questionIds, { surfaceId } = {}) {
  const answers = new Map();
  let generalComments = null;
  if (!SURFACE_ID.test(String(surfaceId ?? ""))) {
    return { resolved: false, missing: [...questionIds], answers, generalComments, reason: "no surface id" };
  }
  for (const c of Array.isArray(comments) ? comments : []) {
    if (!isWriterComment(c)) continue;
    const lines = String(c.body ?? "").split(/\r?\n/);
    const bound = lines.some((l) => {
      const m = /^\s*[-*]\s+\*\*Surface id:\*\*\s*(\S+)\s*$/.exec(l);
      return m && m[1] === surfaceId;
    });
    if (!bound) continue;
    for (const line of lines) {
      const m = /^\s*[-*]\s+\*\*Answer ([^*:]+):\*\*\s*(\S.*?)\s*$/.exec(line);
      if (m) answers.set(m[1].trim(), m[2].trim());
      const g = /^\s*[-*]\s+\*\*General comments:\*\*\s*(\S.*?)\s*$/.exec(line);
      if (g) generalComments = g[1];
    }
  }
  const missing = questionIds.filter((id) => !answers.has(id));
  return { resolved: missing.length === 0, missing, answers, generalComments };
}

// Resume automatically only when the decision surface is fully resolved AND exactly one authorized
// continuation remains; zero or several is itself a founder-level stop.
export function resolveFounderResume({ questionIds, surfaceId, comments, continuations, questions } = {}) {
  const ids = Array.isArray(questionIds) ? questionIds : [];
  if (ids.length === 0) return { outcome: Outcome.FAIL_CLOSED, resume: false, reason: "no decision surface" };
  if (!SURFACE_ID.test(String(surfaceId ?? ""))) {
    return { outcome: Outcome.FAIL_CLOSED, resume: false, reason: "no surface id: answers cannot be bound to a decision surface" };
  }
  const r = parseDecisionResolution(comments, ids, { surfaceId });
  if (!r.resolved) {
    return { outcome: Outcome.WAITING, resume: false, founderDecision: FOUNDER_DECISION_STATES.PENDING, missing: r.missing };
  }
  const list = Array.isArray(continuations) ? continuations : [];
  // Generically recorded answers are not an applied decision: resume requires a deterministic
  // projection onto authoritative state, otherwise the interrupt stays pending.
  const plan = planFounderProjection({ questions, answers: Object.fromEntries(r.answers) });
  if (!plan.ok) {
    return { outcome: Outcome.WAITING, resume: false, founderDecision: FOUNDER_DECISION_STATES.PENDING, reason: `founder answers not deterministically applicable: ${plan.reason}` };
  }
  if (list.length === 1) {
    return {
      outcome: Outcome.ADVANCED,
      resume: true,
      continuation: list[0],
      founderDecision: FOUNDER_DECISION_STATES.NONE,
      answers: Object.fromEntries(r.answers),
      generalComments: r.generalComments,
      decisions: plan.decisions,
    };
  }
  return {
    outcome: Outcome.WAITING,
    resume: false,
    founderDecision: FOUNDER_DECISION_STATES.PENDING,
    reason: list.length === 0 ? "no authorized continuation remains" : "multiple equally authorized continuations",
  };
}

// Compact founder-evaluation result persisted to the thin control Issue on terminal CLEAN.
export function renderTerminalReturn({ objective, terminalResult, evidencePointers, residualLimitation, founderDecision } = {}) {
  const fd = founderDecision ?? FOUNDER_DECISION_STATES.NONE;
  if (!objective || !terminalResult || !Array.isArray(evidencePointers) || evidencePointers.length === 0) return null;
  if (!Object.values(FOUNDER_DECISION_STATES).includes(fd)) return null;
  return [
    `- **Objective:** ${objective}`,
    `- **Terminal result:** ${terminalResult}`,
    `- **Evidence:** ${evidencePointers.join("; ")}`,
    `- **Residual limitation:** ${residualLimitation || "none"}`,
    `- **Founder decision:** ${fd}`,
  ].join("\n");
}

// deps.writeControl(block) persists via write-control-snapshot; deps.readControl() reads back.
// ADVANCED only when the read-back contains the exact block; never selects follow-on work
// (autonomy ends at the authorized objective boundary).
export async function projectTerminalReturn(input, deps) {
  const block = renderTerminalReturn(input);
  if (!block) return result(Outcome.FAIL_CLOSED, { reason: "terminal return fields incomplete" });
  try {
    await deps.writeControl(block);
    const back = await deps.readControl();
    if (typeof back !== "string" || !back.includes(block)) {
      return result(Outcome.FAIL_CLOSED, { reason: "terminal return not provable on read-back" });
    }
    return result(Outcome.ADVANCED, { terminal: true, block, selectsNextObjective: false });
  } catch (e) {
    return result(Outcome.FAIL_CLOSED, { reason: `terminal projection failed: ${e?.message ?? e}` });
  }
}

// Replacement-environment resume: derived only from durable state passed in (authorization,
// attempt-claim plan, recorded environment requirements); runner/provider memory is never read.
// Untrusted triggers gain nothing; an environment mismatch fails durably, never silently.
export function resumeFromDurableState({ durable, trigger, environment } = {}) {
  if (!trigger?.trusted) return result(Outcome.FAIL_CLOSED, { reason: `untrusted trigger: ${trigger?.reason ?? "none"}` });
  if (!durable?.authorization) return result(Outcome.FAIL_CLOSED, { reason: "no durable authorization" });
  const required = durable.requiredEnvironment ?? {};
  const mismatched = Object.keys(required).filter((k) => environment?.[k] !== required[k]);
  if (mismatched.length) {
    return result(Outcome.FAIL_CLOSED, { reason: "environment mismatch", mismatched, durableHold: true });
  }
  const action = durable.claimsPlan?.action;
  // Only actions that start or reconcile an attempt resume work. A consumed nonce (REPLAY) is
  // terminal; BLOCK / ALREADY_CLAIMED / missing mean this trigger must not start another attempt.
  if (action === "REPLAY") return result(Outcome.FAIL_CLOSED, { reason: "authorization nonce already consumed", action });
  if (action !== "CLAIM" && action !== "RECONCILE_THEN_CLAIM") {
    return result(Outcome.WAITING, { reason: "attempt claim does not authorize starting or reconciling an attempt", action });
  }
  return result(Outcome.ADVANCED, { resume: true, action, authorization: durable.authorization.commentId ?? null });
}
