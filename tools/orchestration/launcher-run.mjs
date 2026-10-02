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
import { runLauncherStep, authorizeLauncherVerdict, parseDecisionSurface, DECISION_SURFACE_HEADING } from "./launcher-step.mjs";
import { runLauncherSupervisor } from "./launcher-supervisor.mjs";
import { buildReadEffect } from "./launcher-readback.mjs";
import { loadRouteEvidence } from "./route-qualification.mjs";
import { readGithubPr, readGithubIssue } from "./github-read.mjs";
import { parseControlBullet, upsertControlBullet, parseExecutionPointer, resolveRepoIdentity } from "./ready-dispatch-gate.mjs";

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
      id: c.id, body: c.body, authorPermission: permission(c.user?.login),
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
        reportCommentId: verdict.reportCommentId ?? verdict.postAudit?.reportCommentId ?? null,
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
export function dispatchFreshWorker({ dispatch, io, controlIssue, env = process.env, runWorker }) {
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
  for (const k of ["pr", "auditIssue", "executionIssue", "issue"]) {
    if (want[k] != null && fresh[k] != null && String(want[k]) !== String(fresh[k])) throw new Error(`stale dispatch: ${k} changed`);
  }
  let prompts;
  if (fresh.state === "READY_TO_DISPATCH_UNITS") {
    const units = Array.isArray(fresh.dispatchReadyUnitIds) ? fresh.dispatchReadyUnitIds : [];
    if (units.length === 0) throw new Error("units verdict names no dispatch-ready unit");
    // Sequential: one writer at a time, so no overlapping-writer directory conflict.
    prompts = units.map((u) => io.node("tools/orchestration/format-unit-dispatch-prompt.mjs", ["--execution-issue", String(fresh.executionIssue), "--unit", String(u)]));
  } else {
    prompts = [io.node("tools/orchestration/format-dispatch-prompt.mjs", [], freshRaw)];
  }
  const run = runWorker ?? ((prompt) => execFileSync(argv[0], argv.slice(1), { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "ignore", "inherit"], input: prompt, env: { ...env, LDL_WORKER_ROUTE: String(dispatch.route) } }));
  for (const p of prompts) run(p);
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
    dispatchWorker: async (dispatch) => dispatchFreshWorker({ dispatch, io, controlIssue, env, runWorker }),
    now,
    sleep,
    // A pending Founder decision on the control issue blocks stepping until its durable surface is
    // fully answered by writers and exactly one authorized continuation remains.
    readFounderSurface: async () => {
      const body = controlBody();
      if (isNone(parseControlBullet(body, "Founder decision"))) return null;
      const comments = readComments(controlIssue);
      const surfaces = comments.filter((c) => String(c.body ?? "").trimStart().startsWith(DECISION_SURFACE_HEADING));
      const latest = surfaces[surfaces.length - 1];
      const parsed = latest ? parseDecisionSurface(latest.body) : null;
      if (!parsed) return { noSurface: true };
      // Exactly one authorized continuation: the control's single current execution pointer is
      // the very execution issue this launch authorizes; anything else is zero continuations.
      const ptr = parseExecutionPointer(parseControlBullet(body, "Execution") ?? parseControlBullet(body, "Execution issue"));
      const continuations = ptr?.ok && ptr.issue === executionIssue ? [`execution#${executionIssue}`] : [];
      return { surfaceId: parsed.surfaceId, questionIds: parsed.questionIds, comments, continuations };
    },
    resumeFounder: async () => {
      writeControlBody(upsertControlBullet(controlBody(), "Founder decision", "none"));
      if (!isNone(parseControlBullet(controlBody(), "Founder decision"))) throw new Error("cleared founder decision not provable on read-back");
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
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  const waitBudgetMs = Number(process.env.LDL_WAIT_BUDGET_MS ?? 0) || 0;
  const r = await runLauncherSupervisor({ deps, maxSteps: Number(process.env.LDL_MAX_STEPS ?? 25) || 25, waitBudgetMs });
  console.log(JSON.stringify({ outcome: r.outcome, evidence: { reason: r.reason ?? null, trail: r.trail } }));
}

