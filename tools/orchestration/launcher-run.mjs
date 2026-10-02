#!/usr/bin/env node
// Production runner for issue #73: binds launcher-step.mjs / launcher-supervisor.mjs injected deps
// to the real gate and action scripts so ONE claimed launch carries the authorized lifecycle
// through fresh workers until a genuine durable stopping boundary.
//
//   node tools/orchestration/launcher-run.mjs --control-issue <N> --execution-issue <M>
//
// Composition only: runGate = session-entry-gate.mjs; authority = authorizeLauncherVerdict (the
// verdict's own execution-authority envelope, never the launch comment); transitions execute the
// verdict's own named command/body and are verified by transition-specific read-backs
// (launcher-readback.mjs: the exact durable effect AND projection, never "the gate state changed");
// open-path verdicts dispatch one fresh bounded worker by reference (dispatchFreshWorker); founder
// resume and terminal return are wired through launcher-supervisor.mjs. Prints one JSON result
// line whose `outcome` is TERMINAL_CLEAN | WAITING | FAIL_CLOSED; exit 0 whenever a result exists.
//
// Tests: node --test tools/orchestration/launcher-run.test.mjs launcher-supervisor.test.mjs

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runLauncherStep, authorizeLauncherVerdict, parseDecisionSurface, resolveOpenPath, isWriterComment, extractVerdictReferences, DECISION_SURFACE_HEADING } from "./launcher-step.mjs";
import { runLauncherSupervisor } from "./launcher-supervisor.mjs";
import { buildReadEffect } from "./launcher-readback.mjs";
import { loadRouteEvidence } from "./route-qualification.mjs";
import { readGithubPr, readGithubIssue } from "./github-read.mjs";
import { parseControlBullet, upsertControlBullet, parseExecutionPointer, resolveRepoIdentity } from "./ready-dispatch-gate.mjs";
import { findExistingTrigger } from "../review-watch/trigger.mjs";
import { isGenuineResponse } from "../review-watch/genuine-response.mjs";
import { extractResponseVerdict } from "../review-watch/stage2-report.mjs";

const REVIEW_BOT = "chatgpt-codex-connector[bot]";

// Finding 1 (Stage 1 on PR #826): a normal STAGE2_CORRECTION_REQUIRED verdict carries no report
// identity, so the guidance target's evidence id is derived from the audit thread itself: the
// latest genuine post-trigger reviewer comment whose own stated verdict is NOT CLEAN. Reuses the
// canonical trigger/genuine-response/verdict primitives; null when no such comment exists (the
// guidance gate then reports a malformed target and the launcher stops, never guesses).
export function findStage2ReportCommentId(comments, { bot = REVIEW_BOT } = {}) {
  const list = Array.isArray(comments) ? comments : [];
  const trigger = findExistingTrigger(list, {});
  if (!trigger) return null;
  const since = new Date(trigger.created_at).getTime();
  const reports = list.filter(
    (c) =>
      c.login === bot &&
      new Date(c.created_at).getTime() >= since &&
      isGenuineResponse(c.body ?? "") &&
      extractResponseVerdict(c.body ?? "") === "NOT CLEAN",
  );
  return reports.length > 0 ? reports[reports.length - 1].id : null;
}

// Finding 5: founder answers are routed into the durable control snapshot before the interrupt
// clears. One "### Resolved founder decisions" section; lines for the same surface are replaced,
// other surfaces' lines are kept.
export const RESOLVED_DECISIONS_HEADING = "### Resolved founder decisions";

const parseControlRef = (body) => {
  const m = /^\s*[-*]\s+\*\*Control issue:\*\*\s*#(\d+)\s*$/m.exec(String(body ?? ""));
  return m ? Number(m[1]) : null;
};

export function renderResolvedDecisionLines({ surfaceId, answers, generalComments }) {
  const lines = Object.entries(answers ?? {}).map(([q, a]) => `- **Surface ${surfaceId} Answer ${q}:** ${a}`);
  if (generalComments) lines.push(`- **Surface ${surfaceId} General comments:** ${generalComments}`);
  return lines;
}

export function upsertResolvedDecisions(body, { surfaceId, answers, generalComments }) {
  const lines = String(body ?? "").replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => l.trim() === RESOLVED_DECISIONS_HEADING);
  let before = lines;
  let kept = [];
  let after = [];
  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^#{1,6}\s/.test(lines[i])) {
        end = i;
        break;
      }
    }
    before = lines.slice(0, start);
    kept = lines.slice(start + 1, end).filter((l) => l.trim() !== "" && !l.startsWith(`- **Surface ${surfaceId} `));
    after = lines.slice(end);
  }
  const section = [RESOLVED_DECISIONS_HEADING, "", ...kept, ...renderResolvedDecisionLines({ surfaceId, answers, generalComments }), ""];
  const head = before.join("\n").replace(/\s+$/, "");
  const tail = after.join("\n");
  return `${`${head}\n\n${section.join("\n")}${tail ? `\n${tail}` : ""}`.replace(/\s+$/, "")}\n`;
}

// The authoritative application of a founder answer (stage 2 audit #832, finding 2): the decision a
// surface question declares it resolves becomes a keyed bullet in one "### Settled decisions"
// section of the parent snapshot (replacing any earlier value of the same key). The generic
// resolved-decisions record above is provenance only and never authorizes resume.
export const SETTLED_DECISIONS_HEADING = "### Settled decisions";

export function renderSettledDecisionLine({ key, answer }) {
  return `- **Decision ${key}:** ${answer}`;
}

export function upsertSettledDecisions(body, decisions) {
  const lines = String(body ?? "").replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => l.trim() === SETTLED_DECISIONS_HEADING);
  const keyOf = (l) => /^- \*\*Decision ([^*:]+):\*\*/.exec(l)?.[1];
  const incoming = new Set(decisions.map((d) => d.key));
  let before = lines;
  let kept = [];
  let after = [];
  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (/^#{1,6}\s/.test(lines[i])) {
        end = i;
        break;
      }
    }
    before = lines.slice(0, start);
    kept = lines.slice(start + 1, end).filter((l) => l.trim() !== "" && !incoming.has(keyOf(l)));
    after = lines.slice(end);
  }
  const section = [SETTLED_DECISIONS_HEADING, "", ...kept, ...decisions.map(renderSettledDecisionLine), ""];
  const head = before.join("\n").replace(/\s+$/, "");
  const tail = after.join("\n");
  return `${`${head}\n\n${section.join("\n")}${tail ? `\n${tail}` : ""}`.replace(/\s+$/, "")}\n`;
}

const SAFE_TOKEN = /^[A-Za-z0-9_.\/=:#@-]+$/;

// Pure. A verdict's `nextCommand` is composed by the gate itself; before executing it, require
// that every `&&`-chained segment is `node tools/<script> <plain tokens>` so it can be run without
// a shell. Returns [{ file, args }] or throws.
export function parseNextCommand(nextCommand) {
  if (typeof nextCommand !== "string" || nextCommand.trim() === "") throw new Error("verdict carries no nextCommand");
  return nextCommand.split(" && ").map((seg) => {
    const tokens = seg.trim().split(/\s+/);
    if (tokens[0] !== "node" || !/^tools\/[A-Za-z0-9_\/.-]+\.mjs$/.test(tokens[1] ?? "") || tokens[1].includes("..")) {
      throw new Error(`refusing non node-tools command segment: ${seg}`);
    }
    if (!tokens.every((t) => SAFE_TOKEN.test(t))) throw new Error(`refusing unsafe token in command segment: ${seg}`);
    return { file: tokens[1], args: tokens.slice(2) };
  });
}

const PROJECT_STATES = new Set(["READY_TO_PROJECT_PLAN_READY", "READY_TO_PROJECT_ROUTED"]);
const MERGE_STATES = new Set(["STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2", "STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2"]);
const NEXT_COMMAND_STATES = new Set([
  "STAGE2_REPORT_READY_TO_RECORD",
  "STAGE2_TRIGGER_REQUIRED",
  "STAGE2_AUDIT_ALREADY_PREPARED",
  "STAGE2_CLOSE_READY",
  "STAGE2_CORRECTION_PR_NEEDS_FINALIZATION",
]);

// io: { node(file, args, input?) -> stdout, gh(args, input?) -> stdout } (injectable for tests).
// readPr({ repo, number }) -> { state, headRefOid } and readIssue({ repo, number }) -> { body, state }
// are REST-backed by default and injectable for tests.
export function buildDeps({
  controlIssue,
  executionIssue,
  io,
  repo = null,
  readEvidence = loadRouteEvidence,
  readPr = ({ repo: r, number }) => readGithubPr({ repo: r, number, fields: ["state", "headRefOid"] }),
  readIssue = ({ repo: r, number }) => readGithubIssue({ repo: r, number, fields: ["body", "state"] }),
  verifyManifest,
}) {
  const gate = async () => {
    const out = io.node("tools/orchestration/session-entry-gate.mjs", ["--control-issue", String(controlIssue)]);
    return JSON.parse(out);
  };
  const prState = (verdict) => readPr({ repo: verdict.repo ?? repo, number: verdict.pr });
  const paged = (path) => io.gh(["api", "--paginate", "--slurp", path]);
  const permission = (login) => {
    try {
      return JSON.parse(io.gh(["api", `repos/{owner}/{repo}/collaborators/${login}/permission`])).permission;
    } catch {
      return "none";
    }
  };
  const readComments = (number) =>
    JSON.parse(paged(`repos/{owner}/{repo}/issues/${number}/comments`)).flat().map((c) => ({
      id: c.id, body: c.body, authorPermission: permission(c.user?.login), login: c.user?.login ?? null, created_at: c.created_at ?? null,
    }));
  const writeControlBody = (body) =>
    io.node("tools/orchestration/write-control-snapshot.mjs", ["--control-issue", String(controlIssue), "--body-file", "-"], body);

  const { readEffect } = buildReadEffect({ repo, controlIssue, executionIssue, readIssue, readComments, readPr, verifyManifest });

  // Project Lifecycle: ROUTED for the manifest transition from the gate's OWN verdict: only after
  // the gate re-verifies the manifest does it return READY_TO_PROJECT_ROUTED + proposedBody. Any
  // other verdict means the manifest effect is not provable and nothing is written.
  const projectRoutedFromFreshGate = async () => {
    const fresh = await gate();
    if (fresh?.state !== "READY_TO_PROJECT_ROUTED" || Number(fresh.controlIssue) !== controlIssue || Number(fresh.executionIssue) !== executionIssue) {
      throw new Error(`manifest not re-verified by the gate (fresh state ${fresh?.state ?? "none"})`);
    }
    if (typeof fresh.proposedBody !== "string" || fresh.proposedBody === "") throw new Error("fresh verdict carries no proposedBody");
    writeControlBody(fresh.proposedBody);
  };

  return {
    runGate: gate,
    authorizeVerdict: async (verdict) => authorizeLauncherVerdict(verdict, { controlIssue, executionIssue }),
    readEffect,
    execute: async (transition, verdict) => {
      const state = transition.preState;
      if (PROJECT_STATES.has(state)) {
        if (typeof verdict.proposedBody !== "string" || verdict.proposedBody === "") throw new Error("verdict carries no proposedBody");
        writeControlBody(verdict.proposedBody);
      } else if (state === "READY_TO_RUN_DISPATCH_MANIFEST") {
        // Both authorized effects: create the manifest, then project ROUTED. A failure between the
        // two leaves manifest-present/unprojected, which the next read-back reconciles (finalize).
        io.node("tools/orchestration/prepare-dispatch-manifest.mjs", ["--execution-issue", String(verdict.executionIssue ?? executionIssue), "--create"]);
        await projectRoutedFromFreshGate();
      } else if (NEXT_COMMAND_STATES.has(state)) {
        for (const c of parseNextCommand(verdict.nextCommand)) io.node(c.file, c.args);
      } else if (state === "STAGE1_CORRECTION_FINALIZATION_REQUIRED") {
        // Only the one canonical finalizer, with arguments that must equal the verdict's own
        // identity, and only while the PR head is still the verified corrected head.
        const { pr, reviewedHead, correctedHead } = verdict;
        if (!Number.isInteger(pr) || typeof reviewedHead !== "string" || typeof correctedHead !== "string") throw new Error("finalization verdict lacks pr/reviewed/corrected heads");
        if (String(prState(verdict).headRefOid).toLowerCase() !== correctedHead.toLowerCase()) throw new Error("PR head changed since the verdict");
        const segs = parseNextCommand(verdict.nextCommand);
        const want = ["--control-issue", String(controlIssue), "--execution-issue", String(executionIssue), "--pr", String(pr), "--reviewed-head", reviewedHead, "--corrected-head", correctedHead];
        if (segs.length !== 1 || segs[0].file !== "tools/orchestration/finalize-correction-breakpoint.mjs" || JSON.stringify(segs[0].args) !== JSON.stringify(want)) {
          throw new Error("finalization verdict nextCommand is not the canonical finalizer for this launch");
        }
        io.node(segs[0].file, segs[0].args);
      } else if (MERGE_STATES.has(state)) {
        const { pr, head } = verdict;
        if (!Number.isInteger(pr) || typeof head !== "string" || !head) throw new Error("merge verdict lacks pr/head");
        if (prState(verdict).headRefOid !== head) throw new Error("PR head changed since the verdict");
        if (state === "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2") {
          io.node("tools/orchestration/finalize-stage1-satisfied-breakpoint.mjs", [
            "--control-issue", String(controlIssue), "--execution-issue", String(executionIssue), "--pr", String(pr),
          ]);
        }
        io.node("tools/review-watch/merge-ready-gate.mjs", ["--repo", String(verdict.repo), "--pr", String(pr), "--head", head, "--issue", String(executionIssue)]);
        io.gh(["pr", "merge", String(pr), "--squash", "--match-head-commit", head, "--body", `Addresses #${executionIssue} (LDL launcher merge)`]);
      } else {
        throw new Error(`no executor for ${state}`);
      }
    },
    // COMPLETED_UNPROJECTED: perform and verify ONLY the missing projection; never replay the
    // completed external effect (no second manifest, no second close, no second trigger).
    finalize: async (transition, verdict) => {
      const state = transition.preState;
      if (state === "READY_TO_RUN_DISPATCH_MANIFEST") return projectRoutedFromFreshGate();
      if (state === "STAGE2_CLOSE_READY") {
        const segs = parseNextCommand(verdict.nextCommand);
        const control = segs.filter((c) => c.file === "tools/orchestration/close-control.mjs");
        if (control.length !== 1) throw new Error("close verdict has no single control-terminalization segment to finalize");
        return io.node(control[0].file, control[0].args);
      }
      if (state === "STAGE2_AUDIT_ALREADY_PREPARED") {
        // The trigger already exists (read-back); only the control projection is missing.
        const fin = parseNextCommand(verdict.nextCommand).filter((c) => c.file === "tools/orchestration/finalize-audit-breakpoint.mjs");
        if (fin.length !== 1) throw new Error("prepared-audit verdict has no single finalize-audit-breakpoint segment");
        return io.node(fin[0].file, fin[0].args);
      }
      if (state === "STAGE2_CORRECTION_PR_NEEDS_FINALIZATION") {
        for (const c of parseNextCommand(verdict.nextCommand)) io.node(c.file, c.args);
        return undefined;
      }
      throw new Error(`no reconciliation defined for ${state}`);
    },
    readOpenPath: async (verdict) => {
      const target = verdict.state === "STAGE2_CORRECTION_REQUIRED" ? verdict.auditIssue : verdict.pr;
      const comments = target ? readComments(target) : [];
      const guided = verdict.state === "STAGE1_CORRECTION_REQUIRED" || verdict.state === "STAGE2_CORRECTION_REQUIRED";
      const outcomeClass = guided ? "correction" : "bounded-implementation";
      const evidence = readEvidence();
      return {
        comments,
        reportCommentId:
          verdict.reportCommentId ??
          verdict.postAudit?.reportCommentId ??
          (verdict.state === "STAGE2_CORRECTION_REQUIRED" ? findStage2ReportCommentId(comments) : null),
        routeInput: {
          outcomeClass,
          assurance: {},
          candidates: [...new Set(evidence.filter((e) => e.outcomeClass === outcomeClass).map((e) => e.route))],
          evidence,
          availability: {},
        },
      };
    },
    // exposed for the supervisor bindings below
    _io: { gate, readComments, writeControlBody },
  };
}

// Dispatch ONE fresh bounded worker by reference. The prompt is rendered by the existing
// formatters from a FRESH gate verdict that must still be the dispatched state (a stale dispatch is
// refused). The worker command is repository configuration (LDL_WORKER_COMMAND: a JSON argv array,
// prompt on stdin, route in LDL_WORKER_ROUTE), never a secret added by the launcher; when none is
// configured this reports not-launched so the supervisor stops at a durable waiting boundary and a
// fresh `work on #<control>` remains the documented fallback. The worker's own exit/report never
// unlocks anything: the supervisor re-reads durable state afterwards.
export async function dispatchFreshWorker({ dispatch, io, controlIssue, executionIssue, authorize, reestablish, env = process.env, runWorker }) {
  const raw = env.LDL_WORKER_COMMAND;
  if (!raw) return { launched: false, reason: "no fresh-worker runner configured (LDL_WORKER_COMMAND); resume with a fresh `work on #<control>`" };
  let argv;
  try {
    argv = JSON.parse(raw);
  } catch {
    return { launched: false, reason: "LDL_WORKER_COMMAND is not a JSON argv array" };
  }
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === "string" && a !== "")) {
    return { launched: false, reason: "LDL_WORKER_COMMAND is not a non-empty string argv array" };
  }
  const freshRaw = io.node("tools/orchestration/session-entry-gate.mjs", ["--control-issue", String(controlIssue)]);
  const fresh = JSON.parse(freshRaw);
  const want = dispatch.byReference ?? {};
  if (fresh?.state !== want.state) throw new Error(`stale dispatch: gate now reports ${fresh?.state}, dispatch was for ${want.state}`);
  // Stage 2 #832 finding 1: the fresh verdict is independently authorized, and EVERY dispatch-defining
  // reference (control/execution identity, PR/audit target, head, units, plan/manifest identity,
  // route, ...) must match exactly. An expected value that became absent, newly present, or changed
  // is a mismatch; a changed target needs a newly authorized dispatch, never reused authority.
  if (typeof authorize !== "function") throw new Error("no execution-authority check supplied for the fresh verdict");
  const authority = authorize(fresh, { controlIssue, executionIssue });
  if (authority?.authorized !== true) throw new Error(`fresh verdict not authorized: ${authority?.reason ?? "unspecified"}`);
  const wantRefs = extractVerdictReferences(want);
  const freshRefs = extractVerdictReferences(fresh);
  for (const k of new Set([...Object.keys(wantRefs), ...Object.keys(freshRefs)])) {
    if (JSON.stringify(wantRefs[k] ?? null) !== JSON.stringify(freshRefs[k] ?? null)) throw new Error(`stale dispatch: ${k} changed`);
  }
  // Stage 2 #833 finding 1: the selected route and exact-target Chat guidance are part of the
  // dispatch too. Re-establish the complete open-path dispatch from the fresh verdict through the
  // same route selection and guidance verification, and require it to equal the dispatched one.
  if (typeof reestablish !== "function") throw new Error("no open-path re-establishment supplied for the fresh verdict");
  const redo = await reestablish(fresh);
  const freshDispatch = redo?.evidence?.dispatch;
  if (!freshDispatch) throw new Error(`stale dispatch: fresh open path no longer yields a dispatch (${redo?.evidence?.reason ?? redo?.outcome ?? "unspecified"})`);
  if (freshDispatch.route !== dispatch.route) throw new Error("stale dispatch: qualified route changed");
  if (JSON.stringify(freshDispatch.byReference?.guidance ?? null) !== JSON.stringify(want.guidance ?? null)) throw new Error("stale dispatch: Chat guidance changed");
  let prompts;
  let workerCwd;
  let binding = null;
  if (fresh.state === "READY_TO_DISPATCH_UNITS") {
    const units = Array.isArray(fresh.dispatchReadyUnitIds) ? fresh.dispatchReadyUnitIds : [];
    if (units.length === 0) throw new Error("units verdict names no dispatch-ready unit");
    // Sequential: one writer at a time, so no overlapping-writer directory conflict.
    prompts = units.map((u) => io.node("tools/orchestration/format-unit-dispatch-prompt.mjs", ["--execution-issue", String(fresh.executionIssue), "--unit", String(u)]));
  } else if (fresh.state === "STAGE1_CORRECTION_REQUIRED") {
    // Finding 2: a findings-bearing Stage 1 correction needs the pre-spawn PR-head checkout
    // reservation the formatter requires; the worker runs from that reserved path and the
    // reservation is released afterwards (idempotent; the worker normally releases it itself).
    const reservedRaw = io.node("tools/orchestration/pr-head-checkout-preflight.mjs", ["--reserve-from-gate"], freshRaw);
    const reserved = JSON.parse(reservedRaw);
    if (reserved?.state === "CHECKOUT_BINDING_UNVERIFIED") throw new Error(`PR-head checkout reservation failed: ${reserved.reason ?? reserved.verdict ?? "unverified"}`);
    if (fresh.correctionReason !== "closing-reference") {
      if (typeof reserved?.checkoutBinding?.path !== "string") throw new Error("reservation returned no checkoutBinding");
      workerCwd = reserved.checkoutBinding.path;
      binding = reserved.checkoutBinding;
    }
    prompts = [io.node("tools/orchestration/format-dispatch-prompt.mjs", [], reservedRaw)];
  } else {
    prompts = [io.node("tools/orchestration/format-dispatch-prompt.mjs", [], freshRaw)];
  }
  const run =
    runWorker ??
    ((prompt, { cwd } = {}) =>
      execFileSync(argv[0], argv.slice(1), { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "ignore", "inherit"], input: prompt, cwd, env: { ...env, LDL_WORKER_ROUTE: String(freshDispatch.route) } }));
  try {
    for (const p of prompts) run(p, { cwd: workerCwd });
  } finally {
    if (binding?.token) {
      try {
        io.node("tools/orchestration/pr-head-checkout-preflight.mjs", ["--release-binding", String(binding.token)]);
      } catch {
        // already released by the worker, or unreleasable: durable state is re-read either way
      }
    }
  }
  return { launched: true, count: prompts.length };
}

// Production supervisor bindings over buildDeps (all durable reads/writes go through the same
// scripts and REST readers as the step itself).
export function buildSupervisorDeps({ controlIssue, executionIssue, stepDeps, io, repo = null, readIssue, env = process.env, sleep, now, runWorker }) {
  const rIssue = readIssue ?? (({ repo: r, number }) => readGithubIssue({ repo: r, number, fields: ["body", "state"] }));
  const { readComments, writeControlBody } = stepDeps._io;
  const controlBody = () => rIssue({ repo, number: controlIssue }).body ?? "";
  const isNone = (v) => v == null || /^(none|n\/a|-)?$/i.test(String(v).trim());

  return {
    step: () => runLauncherStep({ controlIssue, deps: stepDeps }),
    dispatchWorker: async (dispatch) =>
      dispatchFreshWorker({ dispatch, io, controlIssue, executionIssue, authorize: (v, a) => authorizeLauncherVerdict(v, a), reestablish: (fresh) => resolveOpenPath(fresh.state, fresh, stepDeps), env, runWorker }),
    now,
    sleep,
    // Canonical poller (tools/review-watch/poll.mjs) for the bounded reviewer wait: since = the
    // existing trigger's own timestamp (trigger.mjs authority). Exit 0 = matched, 2 = timed out
    // (still waiting); anything else is an operational failure.
    waitForReviewer: async (wait, budgetMs) => {
      const triggerAt = findExistingTrigger(readComments(wait.number), {})?.created_at;
      if (!triggerAt) return { matched: false, reason: "no reviewer trigger on the thread to poll since" };
      const timeoutSec = Math.max(1, Math.floor(budgetMs / 1000));
      const args = ["--repo", String(wait.repo ?? repo), "--kind", wait.kind, "--number", String(wait.number), "--since", triggerAt, "--timeout", String(timeoutSec), "--interval", String(Math.min(150, timeoutSec))];
      try {
        io.node("tools/review-watch/poll.mjs", args);
        return { matched: true };
      } catch (e) {
        if (e?.status === 2) return { matched: false, reason: "timeout" };
        throw e;
      }
    },
    // A pending Founder decision on the control issue blocks stepping until its durable surface is
    // fully answered by writers and exactly one authorized continuation remains.
    readFounderSurface: async () => {
      const body = controlBody();
      if (isNone(parseControlBullet(body, "Founder decision"))) return null;
      const comments = readComments(controlIssue);
      // The surface is execution-relevant input: only a repository writer's comment bound to THIS
      // control issue counts; a non-writer or other-control lookalike never replaces it. The latest
      // trusted surface must itself parse unambiguously (unique question ids, no reserved option).
      const surfaces = comments.filter((c) => isWriterComment(c) && String(c.body ?? "").trimStart().startsWith(DECISION_SURFACE_HEADING) && parseControlRef(c.body) === controlIssue);
      const latest = surfaces[surfaces.length - 1];
      const parsed = latest ? parseDecisionSurface(latest.body, { controlIssue }) : null;
      if (!parsed) return { noSurface: true };
      // Exactly one authorized continuation: the control's single current execution pointer is
      // the very execution issue this launch authorizes; anything else is zero continuations.
      const ptr = parseExecutionPointer(parseControlBullet(body, "Execution") ?? parseControlBullet(body, "Execution issue"));
      const continuations = ptr?.ok && ptr.issue === executionIssue ? [`execution#${executionIssue}`] : [];
      return { surfaceId: parsed.surfaceId, questionIds: parsed.questionIds, questions: parsed.questions, comments, continuations };
    },
    // Apply the answers by meaning FIRST: the decisions the surface declares each answer resolves
    // are written to the authoritative settled-decisions state (with generic provenance) and proved
    // by exact read-back; only then is the interrupt cleared as a separate, final, read-back-proved
    // projection. An answer with no deterministic projection never reaches here (resolveFounderResume
    // keeps it pending); an unprovable application never clears the decision.
    resumeFounder: async (resolution) => {
      const { surfaceId, answers, generalComments, decisions } = resolution ?? {};
      if (!surfaceId || !answers || Object.keys(answers).length === 0) throw new Error("resolution carries no surface id or answers to persist");
      if (!Array.isArray(decisions) || decisions.length === 0) throw new Error("resolution carries no deterministic decision projection");
      const applied = upsertSettledDecisions(upsertResolvedDecisions(controlBody(), { surfaceId, answers, generalComments }), decisions);
      writeControlBody(applied);
      const mid = controlBody().split(/\r?\n/).map((l) => l.trim());
      for (const d of decisions) {
        if (!mid.includes(renderSettledDecisionLine(d))) throw new Error(`resolved founder decision not applied to authoritative state: ${d.key}`);
      }
      writeControlBody(upsertControlBullet(controlBody(), "Founder decision", "none"));
      const after = controlBody();
      if (!isNone(parseControlBullet(after, "Founder decision"))) throw new Error("cleared founder decision not provable on read-back");
      const lines = after.split(/\r?\n/).map((l) => l.trim());
      for (const d of decisions) if (!lines.includes(renderSettledDecisionLine(d))) throw new Error(`settled decision lost on read-back: ${d.key}`);
    },
    terminalInput: async (r) => {
      const body = controlBody();
      const heading = /###\s*Accepted outcome\s*\n+([^\n]+)/i.exec(body);
      const pointers = [];
      for (const label of ["PR", "Stage 1", "Stage 2"]) {
        const v = parseControlBullet(body, label);
        if (!isNone(v)) pointers.push(`${label}: ${v}`);
      }
      const audit = r?.evidence?.after?.expectedTarget ?? r?.evidence?.before?.expectedTarget;
      if (audit) pointers.push(String(audit));
      return {
        objective: heading ? heading[1].trim() : `Execution #${executionIssue} under control #${controlIssue}`,
        terminalResult: "CLEAN",
        evidencePointers: pointers,
        residualLimitation: "",
        founderDecision: "none",
      };
    },
    // The terminal return is appended as one contiguous block (replacing any earlier copy of its
    // five labels) so the read-back can prove the exact block.
    writeControl: async (block) => {
      const labels = ["Objective", "Terminal result", "Evidence", "Residual limitation", "Founder decision"];
      const kept = controlBody().split("\n").filter((l) => !labels.some((lab) => new RegExp(`^-\\s*\\*\\*${lab}:\\*\\*`, "i").test(l)));
      writeControlBody(`${kept.join("\n").replace(/\s+$/, "")}\n\n${block}\n`);
    },
    readControl: async () => controlBody(),
  };
}

const realIo = {
  node: (file, args, input) => execFileSync("node", [file, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, input }),
  gh: (args, input) => execFileSync("gh", args, { encoding: "utf8", input }),
};

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const controlIssue = Number(arg("control-issue"));
  const executionIssue = Number(arg("execution-issue"));
  if (!Number.isInteger(controlIssue) || controlIssue <= 0 || !Number.isInteger(executionIssue) || executionIssue <= 0) {
    console.error("usage: launcher-run.mjs --control-issue <N> --execution-issue <M>");
    process.exit(2);
  }
  const id = resolveRepoIdentity();
  if (!id.ok) {
    console.error(`repository identity unresolved: ${id.reason}`);
    process.exit(1);
  }
  const stepDeps = buildDeps({ controlIssue, executionIssue, io: realIo, repo: id.repo });
  const deps = buildSupervisorDeps({
    controlIssue, executionIssue, stepDeps, io: realIo, repo: id.repo,
  });
  const waitBudgetMs = Number(process.env.LDL_WAIT_BUDGET_MS ?? 0) || 0;
  const r = await runLauncherSupervisor({ deps, maxSteps: Number(process.env.LDL_MAX_STEPS ?? 25) || 25, waitBudgetMs });
  console.log(JSON.stringify({ outcome: r.outcome, evidence: { reason: r.reason ?? null, trail: r.trail } }));
}

