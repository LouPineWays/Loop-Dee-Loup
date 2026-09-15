#!/usr/bin/env node
// Deterministic PR/Stage-1 breakpoint finalize step — issue #456 unit 456-A.
//
// #456's live #447/#448/#453 reproduction: a bounded implementation worker opened PR #453,
// requested Stage 1, and received a genuine Codex review — but stopped without ever
// projecting that transition into the thin control Issue (#448 stayed durably
// `Lifecycle: READY` / `PR: none` / `Stage 1: none`). A later fresh `work on #448`
// therefore re-dispatched implementation against a control Issue that only *looked*
// pre-PR. AGENTS.md's existing authority ("lifecycle workers persist authoritative
// GitHub/repository state before returning control", issue #286's durable-before-return
// contract) already required this; nothing mechanically enforced it on the direct
// bounded-implementation route.
//
// This script is that mechanical enforcement. Both authorized PR-opening routes —
// the direct implementation-worker route (`format-dispatch-prompt.mjs`'s
// formatDispatchPrompt template) and the Integration/PR-worker route (its
// formatIntegrationWorkerDispatchPrompt template; `docs/bounded-review-cycle.md`
// "Integration/PR worker" step 6) — invoke it once the PR exists and Stage 1 has been
// requested (or a Stage 1 exemption recorded), before reporting success or stopping.
//
// It composes existing tooling only, never reimplements it:
//   - `tools/review-watch/stage1-gate.mjs`'s `run` supplies the durable Stage 1 evidence
//     (EXEMPT / NOT_REQUESTED / PENDING / RESPONSE_RECEIVED) at the exact PR head given —
//     the same evidence Stage 1 step 9 itself trusts, never a second competing read of
//     "was Stage 1 requested."
//   - `tools/orchestration/write-control-snapshot.mjs`'s `checkWriteControlSnapshot`
//     performs the only write, validating the proposed body before it ever reaches `gh`
//     (control-field-validator.mjs's field-local pointer checks).
//   - `tools/orchestration/ready-dispatch-gate.mjs`'s `resolveRepoIdentity`,
//     `parseControlBullet`, `upsertControlBullet`, `readExecutionBulletField`,
//     `parseExecutionPointer`, and `referencesExecutionIssue` supply every read/compose
//     primitive on the control body and the PR-to-execution-Issue linkage check — the same
//     parser/convention every other control-plane script already trusts.
//
// What it persists, and why each piece is required (#456 Required behavior #1):
//   - `- **PR:** #<pr>` — the PR reference itself.
//   - `- **Stage 1:** requested` (or `exempt: <reason>`, read verbatim from the PR body's
//     own `Stage 1 exemption: <reason>` line via stage1-gate.mjs's findExemption) —
//     established from durable evidence, never from the caller's own claim.
//   - `- **Stage 2:** none` — issue #450: canonicalized from the one demonstrated legacy
//     pre-Stage-2 synonym ("not started") if that is what the control Issue's own Stage 2
//     bullet currently carries; left untouched otherwise (a real reference, an absent bullet,
//     or anything else `write-control-snapshot.mjs`'s own validator is the fail-closed
//     backstop for). See `canonicalizePreStage2Bullet`'s own comment below.
//   - `- **Lifecycle:** REVIEW` — the exact post-PR value `next-review-transition-gate.mjs`
//     (`docs/operating-model.md` § "Deterministic post-PR transition resolution") expects,
//     so a fresh controller resuming this control Issue routes through that gate instead
//     of falling back to the pre-PR immediate-dispatch gate. The current Lifecycle must
//     already be one of the two authorized pre-PR states this pipeline can transition
//     from (`READY` for the direct route, `EXECUTION_COMPLETE` for the Integration/PR
//     route) — or already `REVIEW` itself, so re-running this script against an
//     already-finalized PR/head is a safe no-op (Verification scenario 6) — never any
//     other Lifecycle value; this guards against a stale/out-of-order invocation
//     clobbering genuine mid-cycle or terminal state (e.g. `AUDIT`, `CORRECTION`,
//     `BLOCKED`) it does not understand.
//   - The PR head is deliberately never written into the control body: the exact current
//     PR head is re-derived live from the PR itself (`gh pr view --json headRefOid`)
//     whenever post-PR authority needs it — `next-review-transition-gate.mjs` already does
//     this — so persisting a second, staleness-prone copy here would only create a new
//     drift surface. The `--head` this script requires is instead the evidence key it
//     hands to `stage1-gate.mjs`, proving Stage 1 was genuinely requested/exempt at the
//     exact head that PR currently carries at finalize time.
// `- **Execution:**`/`- **Execution issue:**`, `- **Route:**`, `- **Blocker:**`, and
// `- **Founder decision:**` are left exactly as the control Issue already records them —
// #456 Required behavior #1's own "blocker/founder state unchanged unless this transition
// legitimately changes it."
//
// Fails closed (Shared Contract's `PR_BREAKPOINT_UNVERIFIED` shape) rather than reporting
// ordinary success whenever the durable transition cannot be established or verified:
//   - the control Issue's own Execution pointer does not resolve to `--execution-issue`
//     (wrong control Issue targeted for this PR — never silently finalize against it);
//   - `--pr` does not itself reference `--execution-issue` via the Shared Contract's own
//     PR-to-execution-Issue linkage convention (branch name / "Addresses #N"/"Implements #N"
//     body marker) — `verifyPrLinkage`, a Stage 1 review finding on PR #547: a coherent but
//     incorrect PR number must never be persisted onto the control Issue unverified;
//   - the given `--head` is not the PR's own live `headRefOid` — `verifyPrHeadIsCurrent`, a
//     Stage 1 review finding on PR #547: a stale head must never be finalized as reviewed;
//   - the control Issue's current Lifecycle is not one of the recognized pre-finalize
//     values described above;
//   - `stage1-gate.mjs` reports `NOT_REQUESTED` (the caller claims the PR crossed the
//     breakpoint, but no trigger exists at `--head` — the claim is false) or an
//     operational error (evidence could not even be read);
//   - `write-control-snapshot.mjs` does not report `WRITTEN` (a validation rejection or an
//     operational `gh` failure);
//   - a fresh read-back of the control Issue's body — never the write call's own return
//     value — does not show the exact PR/Stage-1/Lifecycle bullets just composed. This
//     read-back is the actual verification #456 Required behavior #1 asks for: a `gh issue
//     edit` that silently no-ops, or a concurrent edit that lands between the write and
//     this script's own return, must not be mistaken for a durable success.
//
// On success, prints `FINALIZED <controlIssue> <executionIssue> <pr>` to stdout (exit 0).
// On a fail-closed durable-handoff failure, prints
// `PR_BREAKPOINT_UNVERIFIED <controlIssue> <executionIssue> <pr>` to stdout (exit 2) —
// modeled on AGENTS.md/#286's existing compact `NEW_PR #N` worker-return convention, so a
// fresh controller (or #456-B's own reconciliation) recognizes and repairs this exact state
// without re-deriving it from prose. Full diagnostic detail (the specific reason) goes to
// stderr in both the exit-1 (missing/invalid argument, unresolved repository identity) and
// exit-2 cases.
//
// Usage:
//   node tools/orchestration/finalize-pr-breakpoint.mjs --control-issue 448 \
//     --execution-issue 447 --pr 453 --head <sha>
//
// Tests: node --test tools/orchestration/finalize-pr-breakpoint.test.mjs

import { execFileSync } from "node:child_process";
import {
  resolveRepoIdentity,
  parseControlBullet,
  parseHeadingField,
  upsertControlBullet,
  readExecutionBulletField,
  parseExecutionPointer,
  referencesExecutionIssue,
  isLegacyStage2NotStartedSentinel,
} from "./ready-dispatch-gate.mjs";
import { checkWriteControlSnapshot } from "./write-control-snapshot.mjs";
import { run as stage1GateRun } from "../review-watch/stage1-gate.mjs";

// Lifecycle values this script is authorized to transition *from*. `READY` is the direct
// implementation-worker route's pre-PR value; `EXECUTION_COMPLETE` is the Integration/PR
// worker route's (docs/operating-model.md § "Execution-stage session boundaries" stage 4).
// `REVIEW` is included so a repeated finalize against the same already-finalized PR/head
// (Verification scenario 6) is a safe no-op rather than a fail-closed rejection.
const ALLOWED_PRE_FINALIZE_LIFECYCLE = new Set(["READY", "EXECUTION_COMPLETE", "REVIEW"]);

function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

// Pure. Verifies the control Issue's own recorded Execution pointer resolves to exactly
// `executionIssue` — never finalize a PR's breakpoint against the wrong control Issue just
// because a caller passed a mismatched pair of numbers.
export function verifyExecutionMatches(body, executionIssue) {
  const field = readExecutionBulletField(body);
  if (field.conflict) {
    return { ok: false, reason: "control Issue's Execution pointer is ambiguous (conflicting bullet spellings/labels)" };
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

// Pure. Stage 1 review finding on PR #547 (P2): a coherent-but-incorrect `--pr`/`--head` pair
// — a typo, a stale value from an earlier step, or a caller pointed at an unrelated PR that
// happens to also carry a Stage 1 trigger — previously reached `write-control-snapshot.mjs`
// unverified: only the control-to-execution pointer was checked, never the PR-to-execution
// linkage the Shared Contract actually requires ("Every PR an authorized worker opens for an
// execution Issue must reference that execution Issue in its own PR body ... and use a branch
// name containing issue-<executionIssue>- ... 456-A's finalize step must ensure this linkage
// is present/discoverable before it reports success"). Reuses
// `referencesExecutionIssue` — the exact same linkage convention `reconcileReadyPrBreakpoint`
// already trusts — rather than a second, competing definition of "belongs to this execution
// Issue".
export function verifyPrLinkage({ headRefName, body }, executionIssue) {
  if (!referencesExecutionIssue({ headRefName, body }, executionIssue)) {
    return {
      ok: false,
      reason:
        `PR does not reference execution Issue #${executionIssue} via the required linkage convention ` +
        `(a branch name containing "issue-${executionIssue}-", or a PR body carrying "Addresses #${executionIssue}"/` +
        `"Implements #${executionIssue}") — refusing to persist an unlinked PR onto the control Issue`,
    };
  }
  return { ok: true };
}

// Pure. Stage 1 review finding on PR #547 (P2): `--head` was previously trusted as given and
// only handed to `stage1-gate.mjs` as an evidence key, never compared against the PR's own
// live `headRefOid`. A stale `--head` (e.g. a late push landed after Stage 1 was requested,
// before this script ran) could still carry a genuine trigger/response at that older head,
// letting this script persist `Stage 1: requested` / `Lifecycle: REVIEW` even though the PR's
// actual current head was never reviewed at all.
export function verifyPrHeadIsCurrent(prView, head) {
  const liveHead = prView?.headRefOid;
  if (typeof liveHead !== "string" || !liveHead || liveHead !== head) {
    return {
      ok: false,
      reason: `the given --head (${JSON.stringify(head)}) does not match the PR's live head (${JSON.stringify(liveHead ?? null)}) — refusing to finalize Stage 1 evidence gathered at a stale head`,
    };
  }
  return { ok: true };
}

// Pure. Derives the durable Stage 1 field value ("requested" or "exempt: <reason>") from a
// `stage1-gate.mjs` `run` result — never from the caller's own unverified claim.
// `NOT_REQUESTED` and any non-zero-exit operational failure both fail closed: the caller
// asserted the PR crossed the Stage 1 breakpoint, and durable evidence does not back that.
export function determineStage1Value(stage1GateResult) {
  if (!stage1GateResult || typeof stage1GateResult !== "object") {
    return { ok: false, reason: "stage1-gate.mjs produced no usable result" };
  }
  if (stage1GateResult.state === "EXEMPT") {
    return { ok: true, value: `exempt: ${stage1GateResult.reason}` };
  }
  if (stage1GateResult.state === "PENDING" || stage1GateResult.state === "RESPONSE_RECEIVED") {
    return { ok: true, value: "requested" };
  }
  if (stage1GateResult.state === "NOT_REQUESTED") {
    return { ok: false, reason: "stage1-gate.mjs reports NOT_REQUESTED at the given --head: no Stage 1 trigger exists yet" };
  }
  return {
    ok: false,
    reason: `stage1-gate.mjs did not resolve a usable Stage 1 state (exitCode ${stage1GateResult.exitCode}: ${stage1GateResult.message ?? "unknown error"})`,
  };
}

// Pure. Issue #450 (the #428 live reproduction): canonicalizes the control body's own
// "Stage 2" bullet to the canonical "none" sentinel `next-review-transition-gate.mjs`'s
// "Stage 2" bullet parsing (parseOptionalIssueRef) expects, when it currently carries the one
// demonstrated legacy pre-Stage-2 synonym ("Stage 2: not started" — #428's own live control
// Issue). This is Required Behavior #1's authoring-boundary half of the fix: the exact moment
// Lifecycle enters REVIEW is the earliest point at which the Stage 2 field's value first
// becomes load-bearing for the post-PR transition gate, so it is the correction point per
// AGENTS.md's "correction at the earliest deterministic state-authoring boundary."
//
// Every Lifecycle value this script is authorized to transition from (READY,
// EXECUTION_COMPLETE, or an idempotent re-run of REVIEW itself) genuinely precedes Stage 2,
// so normalizing an already-present legacy sentinel here can never clobber a real Stage 2
// reference. Any other existing value (a real #N/URL reference, an absent bullet — already
// tolerated as equivalent to "none" by every reader — or something genuinely malformed) is
// left exactly as this function found it: `write-control-snapshot.mjs`'s own field-local
// validator (control-field-validator.mjs) remains the fail-closed backstop for a value that is
// neither the canonical sentinel nor a valid pointer, per Required Behavior #2's "reject at
// the state-authoring boundary" branch — it already rejects "not started" and any other
// unsupported synonym outright, so this function's narrow normalization is strictly additive.
export function canonicalizePreStage2Bullet(body) {
  const raw = parseControlBullet(body, "Stage 2");
  if (raw !== null && isLegacyStage2NotStartedSentinel(raw)) {
    return upsertControlBullet(body, "Stage 2", "none");
  }
  return body;
}

// Pure. Composes the proposed control body: verifies the current Lifecycle is one this
// script is authorized to transition from, then applies PR/Stage 1/Stage 2/Lifecycle via
// `upsertControlBullet`/`canonicalizePreStage2Bullet` — every other field (Execution, Route,
// Blocker, Founder decision) is left exactly as-is.
export function composeFinalizedControlBody(body, { pr, stage1Value }) {
  // Issue #563: a control Issue authored from the shipped template
  // (`.github/ISSUE_TEMPLATE/parent-execution.yml`) never emits an ad hoc `- **Lifecycle:**`
  // bullet at all -- its Lifecycle-equivalent is the `### State` heading. `evaluateReadyDispatchGate`
  // in ready-dispatch-gate.mjs already reads Lifecycle with this same fallback; without it here,
  // this script always read `currentLifecycle` as null for a template-shaped body and failed
  // closed with `PR_BREAKPOINT_UNVERIFIED` even though the gate itself recognized the Issue as
  // dispatch-ready (discovered live blocking #560's PR #562 finalize).
  const currentLifecycle = parseControlBullet(body, "Lifecycle") ?? parseHeadingField(body, "State");
  if (currentLifecycle === null || !ALLOWED_PRE_FINALIZE_LIFECYCLE.has(currentLifecycle.trim())) {
    return {
      ok: false,
      reason:
        `control Issue's current Lifecycle (${JSON.stringify(currentLifecycle)}) is not one of the recognized ` +
        `pre-finalize values (${[...ALLOWED_PRE_FINALIZE_LIFECYCLE].join(", ")}) — refusing to overwrite Lifecycle/PR/Stage 1 ` +
        "state this script was not authorized to transition",
    };
  }
  let next = upsertControlBullet(body, "PR", `#${pr}`);
  next = upsertControlBullet(next, "Stage 1", stage1Value);
  next = canonicalizePreStage2Bullet(next);
  next = upsertControlBullet(next, "Lifecycle", "REVIEW");
  return { ok: true, body: next };
}

// Pure. Re-parses a freshly-read control body and confirms it actually carries the exact
// PR/Stage 1/Lifecycle bullets just composed — the read-back verification #456 Required
// behavior #1 requires, distinct from trusting `write-control-snapshot.mjs`'s own return
// value.
export function verifyFinalizedBody(freshBody, { pr, stage1Value }) {
  const prField = parseControlBullet(freshBody, "PR");
  if (prField === null || prField.trim() !== `#${pr}`) {
    return { ok: false, reason: `fresh read-back's PR bullet is ${JSON.stringify(prField)}, expected "#${pr}"` };
  }
  const stage1Field = parseControlBullet(freshBody, "Stage 1");
  if (stage1Field === null || stage1Field.trim() !== stage1Value) {
    return { ok: false, reason: `fresh read-back's Stage 1 bullet is ${JSON.stringify(stage1Field)}, expected ${JSON.stringify(stage1Value)}` };
  }
  // Issue #450: a fresh read-back must never still carry the legacy pre-Stage-2 synonym this
  // same write was supposed to canonicalize (canonicalizePreStage2Bullet) — a silent no-op
  // write, or a concurrent edit reintroducing it, must not be mistaken for durable success.
  const stage2Field = parseControlBullet(freshBody, "Stage 2");
  if (stage2Field !== null && isLegacyStage2NotStartedSentinel(stage2Field)) {
    return {
      ok: false,
      reason: `fresh read-back's Stage 2 bullet still carries the legacy pre-start sentinel ${JSON.stringify(stage2Field)}, expected it canonicalized to "none"`,
    };
  }
  // Issue #563: `upsertControlBullet` updates the `### State` heading in place (rather than
  // inserting a new ad hoc bullet) when the control Issue never had a `- **Lifecycle:**`
  // bullet to begin with -- see its own comment block around line 383-401. The read-back must
  // recognize that same shape, or a template-authored control Issue's genuinely successful
  // write would still fail verification here.
  const lifecycleField = parseControlBullet(freshBody, "Lifecycle") ?? parseHeadingField(freshBody, "State");
  if (lifecycleField === null || lifecycleField.trim() !== "REVIEW") {
    return { ok: false, reason: `fresh read-back's Lifecycle bullet is ${JSON.stringify(lifecycleField)}, expected "REVIEW"` };
  }
  return { ok: true };
}

function unverified({ controlIssue, executionIssue, pr, reason }) {
  return {
    exitCode: 2,
    state: "PR_BREAKPOINT_UNVERIFIED",
    controlIssue,
    executionIssue,
    pr,
    reason,
    message: `PR_BREAKPOINT_UNVERIFIED ${controlIssue} ${executionIssue} ${pr}`,
  };
}

// `ghIssueViewImpl`, `ghPrViewImpl`, `stage1GateRunImpl`, and `writeControlSnapshotImpl` are
// injected so tests can drive `run` end-to-end without touching the real network, `gh` CLI, or
// the full stage1-gate.mjs `run` (which itself needs its own network injection) — see this
// script's own test file for the fixture shapes.
export async function run(
  { repo, controlIssue, executionIssue, pr, head },
  {
    ghIssueViewImpl = defaultGhIssueView,
    ghPrViewImpl = defaultGhPrView,
    stage1GateRunImpl = stage1GateRun,
    writeControlSnapshotImpl = checkWriteControlSnapshot,
  } = {},
) {
  if (!isPositiveInteger(controlIssue) || !isPositiveInteger(executionIssue) || !isPositiveInteger(pr)) {
    return { exitCode: 1, message: "Missing/invalid required args: --control-issue, --execution-issue, and --pr must all be positive integers." };
  }
  if (typeof head !== "string" || !head.trim()) {
    return { exitCode: 1, message: "Missing required arg: --head is required (the exact PR head Stage 1 was requested/exempt at)." };
  }

  let body;
  try {
    body = await ghIssueViewImpl({ repo, controlIssue });
  } catch (err) {
    return { exitCode: 1, message: `gh issue view failed for ${repo ?? "<repo>"}#${controlIssue}: ${err.message}` };
  }

  const executionCheck = verifyExecutionMatches(body, executionIssue);
  if (!executionCheck.ok) {
    return unverified({ controlIssue, executionIssue, pr, reason: executionCheck.reason });
  }

  // Stage 1 review findings on PR #547 (both P2): verify the PR itself, before ever trusting
  // it as evidence — that it actually belongs to `executionIssue` per the Shared Contract's own
  // linkage convention, and that the caller's `--head` is still the PR's live head. One fetch
  // covers both; `stage1-gate.mjs` below is never treated as this identity/freshness check
  // (it only knows the PR body, not headRefName/headRefOid, and its own job is Stage 1
  // evidence, not PR identity).
  let prView;
  try {
    prView = await ghPrViewImpl({ repo, pr });
  } catch (err) {
    return unverified({ controlIssue, executionIssue, pr, reason: `gh pr view failed for PR #${pr}: ${err.message}` });
  }
  const linkageCheck = verifyPrLinkage(prView ?? {}, executionIssue);
  if (!linkageCheck.ok) {
    return unverified({ controlIssue, executionIssue, pr, reason: linkageCheck.reason });
  }
  const headCheck = verifyPrHeadIsCurrent(prView, head);
  if (!headCheck.ok) {
    return unverified({ controlIssue, executionIssue, pr, reason: headCheck.reason });
  }

  let stage1Result;
  try {
    stage1Result = await stage1GateRunImpl({ repo, number: pr, head });
  } catch (err) {
    return unverified({ controlIssue, executionIssue, pr, reason: `stage1-gate.mjs threw: ${err.message}` });
  }
  const stage1Determination = determineStage1Value(stage1Result);
  if (!stage1Determination.ok) {
    return unverified({ controlIssue, executionIssue, pr, reason: stage1Determination.reason });
  }
  const { value: stage1Value } = stage1Determination;

  // Stage 1 review finding on PR #547 (P1): re-read the control Issue immediately before
  // composing/writing rather than reusing the body fetched above, before the `gh pr view` and
  // `stage1-gate.mjs` calls just above ran. Those calls narrow but do not eliminate a window
  // in which a concurrent session could add a Blocker/Founder-decision note or otherwise edit
  // the control Issue; `composeFinalizedControlBody`/`upsertControlBullet` only ever touch the
  // PR/Stage 1/Lifecycle bullets and leave everything else in whatever body they're given
  // untouched, so composing against the freshest available read (rather than the stale
  // pre-fetch one) means an intervening edit to any other field survives into this write
  // instead of being silently clobbered. This narrows the race window to
  // `write-control-snapshot.mjs`'s own call latency; it is not a full optimistic-concurrency
  // mechanism (no such primitive exists yet anywhere in this control-plane) — see this
  // finding's own text for the residual gap.
  let latestBody;
  try {
    latestBody = await ghIssueViewImpl({ repo, controlIssue });
  } catch (err) {
    return unverified({ controlIssue, executionIssue, pr, reason: `pre-write control re-read failed: ${err.message}` });
  }

  const composed = composeFinalizedControlBody(latestBody, { pr, stage1Value });
  if (!composed.ok) {
    return unverified({ controlIssue, executionIssue, pr, reason: composed.reason });
  }

  let writeResult;
  try {
    writeResult = await writeControlSnapshotImpl({ repo, controlIssue, proposedBody: composed.body });
  } catch (err) {
    return unverified({ controlIssue, executionIssue, pr, reason: `write-control-snapshot.mjs threw: ${err.message}` });
  }
  if (writeResult.exitCode !== 0 || writeResult.state !== "WRITTEN") {
    return unverified({
      controlIssue,
      executionIssue,
      pr,
      reason: `write-control-snapshot.mjs did not report WRITTEN (${JSON.stringify(writeResult)})`,
    });
  }

  let freshBody;
  try {
    freshBody = await ghIssueViewImpl({ repo, controlIssue });
  } catch (err) {
    return unverified({ controlIssue, executionIssue, pr, reason: `post-write read-back failed: ${err.message}` });
  }
  const verification = verifyFinalizedBody(freshBody, { pr, stage1Value });
  if (!verification.ok) {
    return unverified({ controlIssue, executionIssue, pr, reason: verification.reason });
  }

  return {
    exitCode: 0,
    state: "FINALIZED",
    controlIssue,
    executionIssue,
    pr,
    stage1: stage1Value,
    message: `FINALIZED ${controlIssue} ${executionIssue} ${pr}`,
  };
}

function defaultGhIssueView({ repo, controlIssue }) {
  const args = ["issue", "view", String(controlIssue), "--json", "body"];
  if (repo) args.push("--repo", repo);
  const raw = execFileSync("gh", args, { encoding: "utf8" });
  return JSON.parse(raw).body ?? "";
}

// Stage 1 review findings on PR #547: the PR-identity/head-freshness evidence source for
// `verifyPrLinkage`/`verifyPrHeadIsCurrent` above — distinct from `stage1-gate.mjs`'s own
// `gh pr view` call, which only ever reads `body` (Stage 1 evidence, not PR identity).
function defaultGhPrView({ repo, pr }) {
  const args = ["pr", "view", String(pr), "--json", "headRefName,headRefOid,body,state"];
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
  const executionIssue = args["execution-issue"] != null ? Number(args["execution-issue"]) : null;
  const pr = args.pr != null ? Number(args.pr) : null;
  const head = args.head ?? null;

  const result = await run({ repo: resolvedRepo, controlIssue, executionIssue, pr, head });

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

if (process.argv[1] && process.argv[1].endsWith("finalize-pr-breakpoint.mjs")) {
  main();
}
