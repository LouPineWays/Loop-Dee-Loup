#!/usr/bin/env node
// Deterministic AUDIT breakpoint finalize step — issue #561 (control #560, live #559/#445/
// PR #558 reproduction).
//
// The #559 live failure: PR #558 merged, Stage 2 Audit Issue #559 was created, and
// `@codex review` was triggered against it — all before the thin control Issue #445 was
// ever rewritten to `Lifecycle: AUDIT` / `Stage 2: #559`. Codex started its independent
// audit while #445 still durably read `Lifecycle: REVIEW`, and returned BLOCKED. #445 was
// only projected to the correct AUDIT state afterward. `tools/orchestration/action-
// envelope.mjs`'s prior `STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2`/
// `STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2` envelopes authorized
// `["merge-pr", "trigger-stage2", "write-control-snapshot"]` in that order — the reviewer
// trigger was structurally allowed to race ahead of the durable control projection.
//
// This script is the mechanical ordering fix, mirroring `finalize-pr-breakpoint.mjs`'s own
// compose-write-verify pattern for the earlier PR/Stage-1 breakpoint (issue #456). Once a
// controller has (1) merged the PR and (2) created the Stage 2 Audit Issue (so its exact
// number is known — Stage 2 steps 2-3 of `docs/bounded-review-cycle.md`), it runs this
// script *before* ever posting the `@codex review` trigger (step 4). This script:
//
//   - verifies the control Issue's own Execution and PR bullets already name the given
//     `--execution-issue` (or the literal "none") and `--pr`, so a mismatched/stale pair of
//     arguments cannot finalize the wrong control Issue's audit breakpoint;
//   - verifies the control Issue's current Lifecycle is `REVIEW` (the normal pre-audit
//     state) or already `AUDIT` (a safe no-op rerun);
//   - independently re-derives that the PR is actually `MERGED` and reads its own real merge
//     commit — never trusting a caller's claim that the merge happened;
//   - independently reads the Stage 2 Audit Issue's own body and confirms its "Exact merge
//     commit" field names the same commit the PR actually merged as, and its "Work issue"
//     field names the same `--execution-issue` (or "none") — refusing to project the control
//     onto an Audit Issue that does not actually correspond to this PR/execution pairing;
//   - re-reads the control Issue immediately before composing/writing and re-runs the
//     Execution-pointer, PR-pointer, and Lifecycle authority checks against *that* fresher body
//     (and, when already `AUDIT`, additionally requires its existing Stage 2 pointer to already
//     match `--audit-issue`) — so a concurrent edit landing after the initial read (a Blocker,
//     a BLOCKED/CORRECTION lifecycle change, a different recorded audit issue) is refused
//     rather than silently overwritten (Stage 1 review finding, P1, on PR #562);
//   - composes and persists `- **Stage 2:** #<audit-issue>` and `- **Lifecycle:** AUDIT` via
//     `write-control-snapshot.mjs`'s validated write path;
//   - verifies the write with a fresh read-back before returning success — the actual
//     verification this Issue's acceptance criteria require, never the write call's own
//     return value alone.
//
// Only once this script reports `FINALIZED` may the controller post the `@codex review`
// trigger (`tools/review-watch/trigger.mjs --kind issue`). If it reports
// `AUDIT_BREAKPOINT_UNVERIFIED` instead, the reviewer trigger must not be posted — an
// untriggered Audit Issue is preferable to an auditor running against stale control state.
// This script never posts the reviewer trigger itself; it only gates whether doing so next
// is authorized. See `docs/bounded-review-cycle.md` Stage 2 steps 2-4 and
// `tools/orchestration/action-envelope.mjs`'s `create-stage2-audit-issue` /
// `write-control-snapshot` / `post-stage2-reviewer-trigger` ordering.
//
// Usage:
//   node tools/orchestration/finalize-audit-breakpoint.mjs --control-issue 445 \
//     --execution-issue 440 --pr 558 --audit-issue 559
//   node tools/orchestration/finalize-audit-breakpoint.mjs --control-issue 445 \
//     --execution-issue none --pr 558 --audit-issue 559
//
// Exit codes: 0 (FINALIZED), 1 (operational error — missing/invalid args, unresolved
// repository identity, or an underlying `gh` read that itself failed), 2
// (AUDIT_BREAKPOINT_UNVERIFIED — a fail-closed refusal; the durable control Issue body is
// never mutated on this path since `write-control-snapshot.mjs` is only ever reached after
// every prior check has already passed).
//
// Tests: node --test tools/orchestration/finalize-audit-breakpoint.test.mjs

import { execFileSync } from "node:child_process";
import {
  resolveRepoIdentity,
  parseControlBullet,
  parseHeadingField,
  upsertControlBullet,
  readExecutionBulletField,
  parseExecutionPointer,
  isNoneSentinel,
} from "./ready-dispatch-gate.mjs";
import { checkWriteControlSnapshot } from "./write-control-snapshot.mjs";
import { parseMergeCommitRef, parseWorkIssueRef } from "../review-watch/lifecycle-gate.mjs";

// Lifecycle values this script is authorized to transition *from*. `REVIEW` is the normal
// pre-audit state a `STAGE1_SATISFIED_MERGE_AND_TRIGGER_STAGE2`/
// `STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2` transition leaves behind once the PR
// merges. `AUDIT` is included so a repeated finalize against the same already-finalized PR/
// Audit-Issue pair (a retry after a partial failure, or an idempotent rerun) is a safe no-op
// rather than a fail-closed rejection.
const ALLOWED_PRE_FINALIZE_LIFECYCLE = new Set(["REVIEW", "AUDIT"]);

function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

// `executionIssue` is either a positive integer or the literal sentinel string "none" (the
// explicit no-work-issue state, mirroring lifecycle-gate.mjs's own `--issue none` convention
// for the same recurring consumer-sync-PR shape, issue #190).
function isValidExecutionIssueArg(value) {
  return isPositiveInteger(value) || value === "none";
}

// Pure. Verifies the control Issue's own recorded Execution pointer resolves to exactly
// `executionIssue` — or, when `executionIssue` is the "none" sentinel, that the control body
// itself declares no Execution pointer (absent, or an explicit "none" bullet). Mirrors
// `finalize-pr-breakpoint.mjs`'s `verifyExecutionMatches`, extended for the no-work-issue case
// this breakpoint must also support.
export function verifyExecutionMatchesAudit(body, executionIssue) {
  const field = readExecutionBulletField(body);
  if (field.conflict) {
    return { ok: false, reason: "control Issue's Execution pointer is ambiguous (conflicting bullet spellings/labels)" };
  }
  if (executionIssue === "none") {
    if (field.value === null || isNoneSentinel(field.value)) return { ok: true };
    return {
      ok: false,
      reason: `control Issue's Execution pointer is ${JSON.stringify(field.value)}, but --execution-issue was given as "none"`,
    };
  }
  if (field.value === null) {
    return { ok: false, reason: "control Issue has no Execution/Execution issue bullet to verify against" };
  }
  const parsed = parseExecutionPointer(field.value);
  if (!parsed.ok) {
    return { ok: false, reason: `control Issue's Execution pointer is malformed: ${parsed.reason}` };
  }
  if (parsed.issue !== executionIssue) {
    return {
      ok: false,
      reason: `control Issue's Execution pointer names #${parsed.issue}, not the given --execution-issue #${executionIssue}`,
    };
  }
  return { ok: true };
}

// Pure. Verifies the control Issue's own recorded "PR" bullet names exactly `--pr` — a
// mismatched/stale `--pr` argument must never finalize the audit breakpoint against the wrong
// PR's evidence.
export function verifyControlPrMatches(body, pr) {
  const raw = parseControlBullet(body, "PR");
  if (raw === null) {
    return { ok: false, reason: 'control Issue has no "- **PR:**" bullet to verify against' };
  }
  const parsed = parseExecutionPointer(raw);
  if (!parsed.ok) {
    return { ok: false, reason: `control Issue's PR pointer is malformed: ${parsed.reason}` };
  }
  if (parsed.issue !== pr) {
    return { ok: false, reason: `control Issue's PR pointer names #${parsed.issue}, not the given --pr #${pr}` };
  }
  return { ok: true };
}

// Pure. Verifies the PR itself is genuinely `MERGED` and carries a real merge commit — the
// first ordering invariant issue #561 requires ("merge authority is satisfied and the PR is
// merged") before anything about the Audit Issue is trusted.
export function verifyPrMerged(prView) {
  if (!prView || prView.state !== "MERGED") {
    return {
      ok: false,
      reason: `PR is ${JSON.stringify(prView?.state ?? null)}, not "MERGED" — Stage 2 must not start until the PR actually merges`,
    };
  }
  const mergeCommitOid = prView.mergeCommit?.oid;
  if (typeof mergeCommitOid !== "string" || !mergeCommitOid.trim()) {
    return { ok: false, reason: "PR is MERGED but carries no mergeCommit.oid" };
  }
  return { ok: true, mergeCommitOid };
}

// Pure. Verifies the Stage 2 Audit Issue's own body genuinely corresponds to this PR/
// execution-Issue pairing — never trust the caller's `--audit-issue` argument as sufficient
// evidence on its own that this is the *correct* Audit Issue for this merge. Reuses
// `lifecycle-gate.mjs`'s own `parseMergeCommitRef`/`parseWorkIssueRef` (the same evidence
// `post-audit` itself trusts), never a second, competing parse of the template fields.
export function verifyAuditIssueMatches(auditView, { mergeCommitOid, executionIssue }) {
  if (!auditView || auditView.state !== "OPEN") {
    return {
      ok: false,
      reason: `Audit Issue is ${JSON.stringify(auditView?.state ?? null)}, not "OPEN" — expected a freshly created, not-yet-closed audit issue`,
    };
  }
  const body = auditView.body ?? "";
  const auditMergeCommit = parseMergeCommitRef(body);
  if (!auditMergeCommit || auditMergeCommit.toLowerCase() !== mergeCommitOid.toLowerCase()) {
    return {
      ok: false,
      reason:
        `Audit Issue's "Exact merge commit" field is ${JSON.stringify(auditMergeCommit)}, expected the PR's own ` +
        `merge commit ${JSON.stringify(mergeCommitOid)}`,
    };
  }
  const auditWorkIssue = parseWorkIssueRef(body);
  const expectedWorkIssue = executionIssue === "none" ? "none" : executionIssue;
  if (auditWorkIssue !== expectedWorkIssue) {
    return {
      ok: false,
      reason:
        `Audit Issue's "Work issue" field resolves to ${JSON.stringify(auditWorkIssue)}, expected ` +
        `${JSON.stringify(expectedWorkIssue)} (the given --execution-issue)`,
    };
  }
  return { ok: true };
}

// Pure. Re-validates the execution pointer, PR pointer, and lifecycle against `body` — the
// exact same three authority checks `run()` performs against its *initial* control-Issue
// read — and then composes the proposed body applying Stage 2/Lifecycle via
// `upsertControlBullet`; every other field (Execution, PR, Stage 1, Route, Blocker, Founder
// decision) is left exactly as-is.
//
// Stage 1 review finding (P1) on PR #562: the initial-read validation alone left a window, up
// to and including the pre-write re-read itself, in which a concurrent controller could change
// the control Issue's Lifecycle (e.g. to BLOCKED/CORRECTION), its Execution/PR pointer, or
// (when already AUDIT) record a *different* Stage 2 audit issue — and this function would still
// unconditionally overwrite Stage 2/Lifecycle from whatever `body` it was given, silently
// clobbering that newer state and reporting `FINALIZED`. `run()` now calls this against
// `latestBody` (the re-read taken immediately before compose/write) rather than trusting the
// original pre-fetch body's already-passed checks, so an intervening edit is caught here
// instead of surviving into the write.
export function composeAuditFinalizedControlBody(body, { auditIssue, executionIssue, pr }) {
  const executionCheck = verifyExecutionMatchesAudit(body, executionIssue);
  if (!executionCheck.ok) {
    return { ok: false, reason: `pre-write re-check: ${executionCheck.reason}` };
  }
  const prPointerCheck = verifyControlPrMatches(body, pr);
  if (!prPointerCheck.ok) {
    return { ok: false, reason: `pre-write re-check: ${prPointerCheck.reason}` };
  }
  const currentLifecycle = parseControlBullet(body, "Lifecycle") ?? parseHeadingField(body, "State");
  if (currentLifecycle === null || !ALLOWED_PRE_FINALIZE_LIFECYCLE.has(currentLifecycle.trim())) {
    return {
      ok: false,
      reason:
        `pre-write re-check: control Issue's current Lifecycle (${JSON.stringify(currentLifecycle)}) is not one of ` +
        `the recognized pre-finalize values (${[...ALLOWED_PRE_FINALIZE_LIFECYCLE].join(", ")}) — refusing to ` +
        "overwrite Stage 2/Lifecycle state this script was not authorized to transition",
    };
  }
  if (currentLifecycle.trim() === "AUDIT") {
    const stage2Field = parseControlBullet(body, "Stage 2");
    if (stage2Field === null || stage2Field.trim() !== `#${auditIssue}`) {
      return {
        ok: false,
        reason:
          `pre-write re-check: control Issue is already Lifecycle: AUDIT but its Stage 2 pointer is ` +
          `${JSON.stringify(stage2Field)}, not the given --audit-issue #${auditIssue} — refusing to overwrite a ` +
          "different already-recorded audit issue's breakpoint",
      };
    }
  }
  let next = upsertControlBullet(body, "Stage 2", `#${auditIssue}`);
  next = upsertControlBullet(next, "Lifecycle", "AUDIT");
  return { ok: true, body: next };
}

// Pure. Re-parses a freshly-read control body and confirms it actually carries the exact
// Stage 2/Lifecycle bullets just composed — the read-back verification issue #561 requires
// ("that snapshot write is re-read/verified"), distinct from trusting
// `write-control-snapshot.mjs`'s own return value.
export function verifyAuditFinalizedBody(freshBody, { auditIssue }) {
  const stage2Field = parseControlBullet(freshBody, "Stage 2");
  if (stage2Field === null || stage2Field.trim() !== `#${auditIssue}`) {
    return { ok: false, reason: `fresh read-back's Stage 2 bullet is ${JSON.stringify(stage2Field)}, expected "#${auditIssue}"` };
  }
  const lifecycleField = parseControlBullet(freshBody, "Lifecycle") ?? parseHeadingField(freshBody, "State");
  if (lifecycleField === null || lifecycleField.trim() !== "AUDIT") {
    return { ok: false, reason: `fresh read-back's Lifecycle bullet is ${JSON.stringify(lifecycleField)}, expected "AUDIT"` };
  }
  return { ok: true };
}

function unverified({ controlIssue, executionIssue, pr, auditIssue, reason }) {
  return {
    exitCode: 2,
    state: "AUDIT_BREAKPOINT_UNVERIFIED",
    controlIssue,
    executionIssue,
    pr,
    auditIssue,
    reason,
    message: `AUDIT_BREAKPOINT_UNVERIFIED ${controlIssue} ${pr} ${auditIssue}`,
  };
}

// `ghIssueViewImpl`, `ghPrViewImpl`, `ghAuditIssueViewImpl`, and `writeControlSnapshotImpl` are
// injected so tests can drive `run` end-to-end without touching the real network or `gh` CLI —
// see this script's own test file for the fixture shapes.
export async function run(
  { repo, controlIssue, executionIssue, pr, auditIssue },
  {
    ghIssueViewImpl = defaultGhIssueView,
    ghPrViewImpl = defaultGhPrView,
    ghAuditIssueViewImpl = defaultGhAuditIssueView,
    writeControlSnapshotImpl = checkWriteControlSnapshot,
  } = {},
) {
  if (!isPositiveInteger(controlIssue) || !isPositiveInteger(pr) || !isPositiveInteger(auditIssue)) {
    return {
      exitCode: 1,
      message: "Missing/invalid required args: --control-issue, --pr, and --audit-issue must all be positive integers.",
    };
  }
  if (!isValidExecutionIssueArg(executionIssue)) {
    return {
      exitCode: 1,
      message: 'Missing/invalid required arg: --execution-issue must be a positive integer, or the literal "none".',
    };
  }

  let body;
  try {
    body = await ghIssueViewImpl({ repo, controlIssue });
  } catch (err) {
    return { exitCode: 1, message: `gh issue view failed for ${repo ?? "<repo>"}#${controlIssue}: ${err.message}` };
  }

  const executionCheck = verifyExecutionMatchesAudit(body, executionIssue);
  if (!executionCheck.ok) {
    return unverified({ controlIssue, executionIssue, pr, auditIssue, reason: executionCheck.reason });
  }

  const prPointerCheck = verifyControlPrMatches(body, pr);
  if (!prPointerCheck.ok) {
    return unverified({ controlIssue, executionIssue, pr, auditIssue, reason: prPointerCheck.reason });
  }

  const currentLifecycle = parseControlBullet(body, "Lifecycle") ?? parseHeadingField(body, "State");
  if (currentLifecycle === null || !ALLOWED_PRE_FINALIZE_LIFECYCLE.has(currentLifecycle.trim())) {
    return unverified({
      controlIssue,
      executionIssue,
      pr,
      auditIssue,
      reason:
        `control Issue's current Lifecycle (${JSON.stringify(currentLifecycle)}) is not one of the recognized ` +
        `pre-finalize values (${[...ALLOWED_PRE_FINALIZE_LIFECYCLE].join(", ")}) — refusing to overwrite Stage 2/` +
        "Lifecycle state this script was not authorized to transition",
    });
  }

  // Ordering invariant 1 (issue #561): merge authority is satisfied and the PR is merged.
  // Independently re-derived from the PR's own live state, never trusted from a caller claim
  // or the control body's own "PR" bullet (which only proves a PR reference was recorded, not
  // that it merged).
  let prView;
  try {
    prView = await ghPrViewImpl({ repo, pr });
  } catch (err) {
    return unverified({ controlIssue, executionIssue, pr, auditIssue, reason: `gh pr view failed for PR #${pr}: ${err.message}` });
  }
  const mergedCheck = verifyPrMerged(prView);
  if (!mergedCheck.ok) {
    return unverified({ controlIssue, executionIssue, pr, auditIssue, reason: mergedCheck.reason });
  }

  // Ordering invariant 2: the Stage 2 Audit Issue exists and its own recorded evidence
  // (merge commit, work issue) genuinely corresponds to this PR/execution pairing.
  let auditView;
  try {
    auditView = await ghAuditIssueViewImpl({ repo, auditIssue });
  } catch (err) {
    return unverified({
      controlIssue,
      executionIssue,
      pr,
      auditIssue,
      reason: `gh issue view failed for Audit Issue #${auditIssue}: ${err.message}`,
    });
  }
  const auditMatchCheck = verifyAuditIssueMatches(auditView, { mergeCommitOid: mergedCheck.mergeCommitOid, executionIssue });
  if (!auditMatchCheck.ok) {
    return unverified({ controlIssue, executionIssue, pr, auditIssue, reason: auditMatchCheck.reason });
  }

  // Re-read the control Issue immediately before composing/writing, then re-validate the
  // execution-pointer, PR-pointer, and lifecycle authority checks against *this* fresher body
  // inside `composeAuditFinalizedControlBody` itself (Stage 1 review finding, P1, on PR #562) —
  // not merely against the stale pre-fetch `body` read above. `composeAuditFinalizedControlBody`
  // only ever touches the Stage 2/Lifecycle bullets it composes, so an intervening edit to any
  // other field survives into this write instead of being clobbered, while an intervening edit
  // to Lifecycle/Execution/PR/Stage 2 itself is now caught and refused here rather than
  // silently overwritten.
  let latestBody;
  try {
    latestBody = await ghIssueViewImpl({ repo, controlIssue });
  } catch (err) {
    return unverified({ controlIssue, executionIssue, pr, auditIssue, reason: `pre-write control re-read failed: ${err.message}` });
  }

  const composed = composeAuditFinalizedControlBody(latestBody, { auditIssue, executionIssue, pr });
  if (!composed.ok) {
    return unverified({ controlIssue, executionIssue, pr, auditIssue, reason: composed.reason });
  }

  let writeResult;
  try {
    writeResult = await writeControlSnapshotImpl({ repo, controlIssue, proposedBody: composed.body });
  } catch (err) {
    return unverified({ controlIssue, executionIssue, pr, auditIssue, reason: `write-control-snapshot.mjs threw: ${err.message}` });
  }
  if (writeResult.exitCode !== 0 || writeResult.state !== "WRITTEN") {
    return unverified({
      controlIssue,
      executionIssue,
      pr,
      auditIssue,
      reason: `write-control-snapshot.mjs did not report WRITTEN (${JSON.stringify(writeResult)})`,
    });
  }

  let freshBody;
  try {
    freshBody = await ghIssueViewImpl({ repo, controlIssue });
  } catch (err) {
    return unverified({ controlIssue, executionIssue, pr, auditIssue, reason: `post-write read-back failed: ${err.message}` });
  }
  const verification = verifyAuditFinalizedBody(freshBody, { auditIssue });
  if (!verification.ok) {
    return unverified({ controlIssue, executionIssue, pr, auditIssue, reason: verification.reason });
  }

  return {
    exitCode: 0,
    state: "FINALIZED",
    controlIssue,
    executionIssue,
    pr,
    auditIssue,
    message: `FINALIZED ${controlIssue} ${pr} ${auditIssue}`,
  };
}

function defaultGhIssueView({ repo, controlIssue }) {
  const args = ["issue", "view", String(controlIssue), "--json", "body"];
  if (repo) args.push("--repo", repo);
  const raw = execFileSync("gh", args, { encoding: "utf8" });
  return JSON.parse(raw).body ?? "";
}

function defaultGhPrView({ repo, pr }) {
  const args = ["pr", "view", String(pr), "--json", "state,mergeCommit"];
  if (repo) args.push("--repo", repo);
  const raw = execFileSync("gh", args, { encoding: "utf8" });
  return JSON.parse(raw);
}

function defaultGhAuditIssueView({ repo, auditIssue }) {
  const args = ["issue", "view", String(auditIssue), "--json", "body,state"];
  if (repo) args.push("--repo", repo);
  const raw = execFileSync("gh", args, { encoding: "utf8" });
  return JSON.parse(raw);
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
  const args = parseArgs(process.argv.slice(2));

  let resolvedRepo = args.repo;
  if (!resolvedRepo) {
    const identity = resolveRepoIdentity();
    if (!identity.ok) {
      console.error(`Could not determine the current repository identity (--repo was not supplied): ${identity.reason}`);
      process.exit(1);
      return;
    }
    resolvedRepo = identity.repo;
  }

  const controlIssue = args["control-issue"] != null ? Number(args["control-issue"]) : null;
  const pr = args.pr != null ? Number(args.pr) : null;
  const auditIssue = args["audit-issue"] != null ? Number(args["audit-issue"]) : null;
  const rawExecutionIssue = args["execution-issue"];
  const executionIssue = rawExecutionIssue === "none" ? "none" : rawExecutionIssue != null ? Number(rawExecutionIssue) : null;

  const result = await run({ repo: resolvedRepo, controlIssue, executionIssue, pr, auditIssue });

  if (result.exitCode === 1) {
    console.error(result.message);
    process.exit(1);
    return;
  }
  if (result.exitCode === 2) {
    console.error(JSON.stringify(result));
    console.log(result.message);
    process.exit(2);
    return;
  }
  console.error(JSON.stringify(result));
  console.log(result.message);
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith("finalize-audit-breakpoint.mjs")) {
  main();
}
