// Control-plane continuation binding — issue #901 (control #780; follow-up to #877 / PR #880).
//
// Live recurrence (#877 comment #6001879290): a stale subject checkout correctly ran
// `control-plane-bootstrap.mjs session-entry-gate` from authenticated default-branch code, the
// current gate returned `STAGE2_EVIDENCE_REAUDIT_PREPARATION_REQUIRED`, and its machine-authored
// `nextCommand` named a checkout-relative `node tools/orchestration/evidence-correction.mjs
// prepare ...`. Running that command from the subject checkout executed the STALE parser and
// reproduced an already-fixed (#891) footer rejection. The runner-authority handoff was lost at
// the continuation boundary.
//
// Boundary fix: when a gate/router runs from a bootstrap-exported runner (the bootstrap sets
// LDL_CONTROL_PLANE_RUNNER and the runner root carries the commit marker), every control-plane
// segment of a machine-authored `nextCommand` is rewritten to
//
//   node <runner-root>/tools/orchestration/control-plane-bootstrap.mjs <tools/(orchestration|review-watch)/x.mjs> args...
//
// i.e. the continuation re-enters through the canonical bootstrap/freshness boundary, executed
// from the authenticated runner's own bootstrap copy (never the subject's). The bootstrap
// re-verifies the remote tip + byte-identical tree and re-exports if needed, sets the subject-
// scoped state dir, and fails closed (exit 1) when authority cannot be established. A relative
// string can therefore never silently regain stale authority.
//
// Not bound (unchanged, relative): a checkout that is already current/local or explicitly
// authorized with `--control-plane-source checkout` (no runner env) -- the checkout IS the
// authorized control plane. Action-envelope authority is derived from the canonical segments
// (`unwrapBoundSegment` is understood by action-envelope.mjs / launcher-run.mjs), so binding never
// widens, narrows, or reorders the authorized actions or bypasses `stopAfter`.
//
// Tests: node --test tools/orchestration/control-plane-continuation.test.mjs

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const RUNNER_ENV = "LDL_CONTROL_PLANE_RUNNER";
export const RUNNER_MARKER = ".ldl-control-plane-runner";
export const BOOTSTRAP_REL = "tools/orchestration/control-plane-bootstrap.mjs";
export const CONTROL_PLANE_SCRIPT = /^tools\/(?:orchestration|review-watch)\/[A-Za-z0-9_.-]+\.mjs$/;
const SAFE_ROOT = /^[A-Za-z0-9_.\/:@+-]+$/;
const DEFAULT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Returns {script, rest} when `tokens` (a segment already split on whitespace) is a
// bootstrap-bound control-plane continuation, else null. Accepts the bound form only
// (`node <...>/control-plane-bootstrap.mjs tools/<dir>/<x>.mjs args...`).
export function unwrapBoundSegment(tokens) {
  const nodeIdx = tokens.indexOf("node");
  if (nodeIdx === -1) return null;
  const boot = tokens[nodeIdx + 1] ?? "";
  if (!/(?:^|[\\/])control-plane-bootstrap\.mjs$/.test(boot)) return null;
  const script = tokens[nodeIdx + 2] ?? "";
  if (!CONTROL_PLANE_SCRIPT.test(script) || script.includes("..")) return null;
  return { script, rest: tokens.slice(nodeIdx + 3) };
}

// Pure + synchronous. Returns {ok:true, bound:false, command} when no runner is in effect,
// {ok:true, bound:true, command} when rewritten, {ok:false, reason} (fail closed) when a runner is
// claimed but cannot be proven here.
export function bindContinuationCommand(command, { env = process.env, root = DEFAULT_ROOT, readMarker } = {}) {
  if (typeof command !== "string" || command.trim() === "") return { ok: true, bound: false, command };
  const raw = env[RUNNER_ENV];
  if (!raw) return { ok: true, bound: false, command };

  let witness;
  try {
    witness = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `${RUNNER_ENV} is not valid JSON` };
  }
  const read = readMarker ?? ((r) => (existsSync(join(r, RUNNER_MARKER)) ? readFileSync(join(r, RUNNER_MARKER), "utf8").trim() : null));
  let marker;
  try {
    marker = read(root);
  } catch {
    marker = null;
  }
  if (!marker || marker !== witness?.runnerCommit) {
    return { ok: false, reason: "running control-plane root is not the authenticated runner named by the bootstrap witness" };
  }
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!SAFE_ROOT.test(base)) {
    return { ok: false, reason: "runner path contains characters that cannot be carried safely in a machine-authored command" };
  }
  const bootstrap = `${base}/${BOOTSTRAP_REL}`;

  const segments = command.split(" && ").map((seg) => {
    const tokens = seg.trim().split(/\s+/);
    if (unwrapBoundSegment(tokens)) return seg.trim(); // already bound (idempotent)
    if (tokens[0] !== "node" || !CONTROL_PLANE_SCRIPT.test(tokens[1] ?? "") || tokens[1].includes("..")) return null;
    return `node ${bootstrap} ${tokens.slice(1).join(" ")}`;
  });
  if (segments.includes(null)) {
    return { ok: false, reason: "continuation contains a segment that is not a control-plane script invocation; refusing to emit it unbound" };
  }
  return { ok: true, bound: true, command: segments.join(" && ") };
}

// Applies the binding to a verdict object about to be printed. On failure the executable command
// is withheld (fail closed) and the reason is carried explicitly; `actionEnvelope` is never touched.
export function bindVerdictContinuation(verdict, opts = {}) {
  if (!verdict || typeof verdict.nextCommand !== "string") return verdict;
  const res = bindContinuationCommand(verdict.nextCommand, opts);
  if (!res.ok) {
    const { nextCommand: _dropped, ...rest } = verdict;
    return { ...rest, nextCommand: null, continuationBindingError: res.reason };
  }
  if (!res.bound) return verdict;
  return { ...verdict, nextCommand: res.command, continuationBound: true };
}
