#!/usr/bin/env node
// Production runner for issue #73: binds launcher-step.mjs's injected deps to the real gate and
// action scripts so a claimed launch actually advances the authorized control issue.
//
//   node tools/orchestration/launcher-run.mjs --control-issue <N> --execution-issue <M>
//
// Composition only: runGate = session-entry-gate.mjs; authority = authorizeLauncherVerdict (the
// verdict's own execution-authority envelope, never the launch comment); transitions execute the
// verdict's own named command/body and are verified by a fresh read-back (a fresh gate verdict
// that no longer names the pre-state, or the PR reading MERGED). Open-path verdicts return a
// by-reference dispatch description (see launcher-step.mjs) and nothing is dispatched or authored
// here. Prints one JSON result line; exit 0 whenever a step result was produced.
//
// Tests: node --test tools/orchestration/launcher-run.test.mjs

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runLauncherStep, authorizeLauncherVerdict } from "./launcher-step.mjs";
import { loadRouteEvidence } from "./route-qualification.mjs";
import { readGithubPr } from "./github-read.mjs";

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
// readPr({ repo, number }) -> { state, headRefOid } (REST-backed by default; injectable for tests).
export function buildDeps({
  controlIssue,
  executionIssue,
  io,
  readEvidence = loadRouteEvidence,
  readPr = ({ repo, number }) => readGithubPr({ repo, number, fields: ["state", "headRefOid"] }),
}) {
  const gate = async () => {
    const out = io.node("tools/orchestration/session-entry-gate.mjs", ["--control-issue", String(controlIssue)]);
    return JSON.parse(out);
  };
  const prState = (verdict) => readPr({ repo: verdict.repo, number: verdict.pr });
  const paged = (path) => io.gh(["api", "--paginate", "--slurp", path]);
  const permission = (login) => {
    try {
      return JSON.parse(io.gh(["api", `repos/{owner}/{repo}/collaborators/${login}/permission`])).permission;
    } catch {
      return "none";
    }
  };

  return {
    runGate: gate,
    authorizeVerdict: async (verdict) => authorizeLauncherVerdict(verdict, { controlIssue, executionIssue }),
    readEffect: async (transition, verdict) => {
      if (MERGE_STATES.has(transition.preState)) {
        const pr = prState(verdict);
        const merged = pr.state === "MERGED";
        return { expectedTarget: `PR#${verdict.pr}`, target: `PR#${verdict.pr}`, readBackOk: true, effect: merged ? "present" : "absent", projected: merged };
      }
      const fresh = await gate();
      const advanced = typeof fresh?.state === "string" && fresh.state !== transition.preState;
      return { expectedTarget: String(controlIssue), target: String(controlIssue), readBackOk: true, effect: advanced ? "present" : "absent", projected: advanced };
    },
    execute: async (transition, verdict) => {
      const state = transition.preState;
      if (PROJECT_STATES.has(state)) {
        if (typeof verdict.proposedBody !== "string" || verdict.proposedBody === "") throw new Error("verdict carries no proposedBody");
        io.node("tools/orchestration/write-control-snapshot.mjs", ["--control-issue", String(controlIssue), "--body-file", "-"], verdict.proposedBody);
      } else if (state === "READY_TO_RUN_DISPATCH_MANIFEST") {
        io.node("tools/orchestration/prepare-dispatch-manifest.mjs", ["--execution-issue", String(verdict.executionIssue ?? executionIssue), "--create"]);
      } else if (NEXT_COMMAND_STATES.has(state)) {
        for (const c of parseNextCommand(verdict.nextCommand)) io.node(c.file, c.args);
      } else if (MERGE_STATES.has(state)) {
        const { pr, head, repo } = verdict;
        if (!Number.isInteger(pr) || typeof head !== "string" || !head) throw new Error("merge verdict lacks pr/head");
        if (prState(verdict).headRefOid !== head) throw new Error("PR head changed since the verdict");
        if (state === "STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2") {
          io.node("tools/orchestration/finalize-stage1-satisfied-breakpoint.mjs", [
            "--control-issue", String(controlIssue), "--execution-issue", String(executionIssue), "--pr", String(pr),
          ]);
        }
        io.node("tools/review-watch/merge-ready-gate.mjs", ["--repo", String(repo), "--pr", String(pr), "--head", head, "--issue", String(executionIssue)]);
        io.gh(["pr", "merge", String(pr), "--squash", "--match-head-commit", head, "--body", `Addresses #${executionIssue} (LDL launcher merge)`]);
      } else {
        throw new Error(`no executor for ${state}`);
      }
    },
    finalize: async () => {}, // readEffect never reports completed-but-unprojected for these transitions
    readOpenPath: async (verdict) => {
      const target = verdict.state === "STAGE2_CORRECTION_REQUIRED" ? verdict.auditIssue : verdict.pr;
      const comments = target
        ? JSON.parse(paged(`repos/{owner}/{repo}/issues/${target}/comments`)).flat().map((c) => ({
            id: c.id, body: c.body, authorPermission: permission(c.user?.login),
          }))
        : [];
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
  };
}

const realIo = {
  node: (file, args, input) => execFileSync("node", [file, ...args], { encoding: "utf8", input }),
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
  const r = await runLauncherStep({ controlIssue, deps: buildDeps({ controlIssue, executionIssue, io: realIo }) });
  console.log(JSON.stringify(r));
}
