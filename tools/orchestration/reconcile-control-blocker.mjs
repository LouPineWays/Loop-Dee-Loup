#!/usr/bin/env node
// Deterministic, idempotent completed-prerequisite Blocker-reconciliation primitive --
// issue #437 (unit 437-B), Shared Contract design decision point 2.
//
// Root cause this closes (the #440 live reproduction cited in #437's "Desired outcome"):
// `ready-dispatch-gate.mjs`'s fail-closed BLOCKED short-circuit is correct while a Blocker
// condition is genuinely unresolved, but nothing mechanically clears it once the named
// prerequisite(s) actually terminalize -- the founder had to manually rewrite `Lifecycle:
// BLOCKED` / `Blocker: <prose>` back to their true next state after #407/#408/#436 all
// closed. This script is the "new standalone, explicitly-invoked script" the Shared
// Contract's design decision point 2 requires -- never a change to
// `evaluateReadyDispatchGate`'s own heavily regression-tested BLOCKED logic (issues
// #368/#370/#432/#544), which stays byte-for-byte unchanged.
//
// This is a narrowly-scoped sibling of `close-control.mjs`'s own shape (injectable-impl
// default `gh` reader, a pure `checkReconcileControlBlocker` core, a thin CLI wrapper),
// reusing `upsertControlBullet`/`parseControlBullet`/`isNoneSentinel`/`resolveRepoIdentity`/
// `classifyAuditIssue` from `ready-dispatch-gate.mjs`, `checkWriteControlSnapshot` from
// `write-control-snapshot.mjs`, and the new `blocker-grammar.mjs` -- never a second,
// duplicated implementation of any of those primitives.
//
// `classifyAuditIssue`/`parseStage2Verdict` provenance: this unit's own Worker Unit
// Contract named `tools/review-watch/lifecycle-gate.mjs` as the source for both.
// `parseStage2Verdict` genuinely lives there and is imported directly below (the same
// deliberate, documented one-way `tools/orchestration` -> `tools/review-watch` import
// exception `ready-dispatch-gate.mjs`'s own module comment already establishes for this
// exact function). `classifyAuditIssue` does not -- it already exists in
// `ready-dispatch-gate.mjs` itself (built from lifecycle-gate.mjs's own
// `parseStage2Verdict`/`parseFormField`, per that function's own module comment), so it is
// imported from there instead of being re-derived here.
//
// Control identity: `--control-issue` names the exact control Issue to reconcile; `--repo`
// is optional and derived from the checkout's own configured `origin` remote
// (`resolveRepoIdentity`) when omitted, matching every other tools/orchestration script's
// convention. This script never searches for or guesses a control Issue, and never
// discovers its own prerequisite list except by parsing the control Issue's own durable
// Blocker field via `blocker-grammar.mjs`.
//
// Usage:
//   node tools/orchestration/reconcile-control-blocker.mjs --control-issue 440
//   node tools/orchestration/reconcile-control-blocker.mjs --repo OWNER/REPO --control-issue 440
//
// Exit codes (Shared Contract design decision point 9, mirroring close-control.mjs's own
// documented convention):
//   0 / UNBLOCKED             -- every named prerequisite is satisfied; the control body's
//                                 Blocker/Lifecycle/Route fields were rewritten and persisted.
//   0 / ALREADY_UNBLOCKED     -- the Blocker field already reads "none"/"none — ..." (or is
//                                 absent); nothing to reconcile, no mutation attempted.
//   0 / ALREADY_TERMINAL      -- the control Issue is already closed; mirrors
//                                 close-control.mjs's own ALREADY_TERMINAL precedent.
//   3 / INCOMPLETE_PREREQUISITE -- no mutation; at least one named prerequisite has not yet
//                                 reached its required terminal condition (open, or closed
//                                 but audit-shaped with a verdict other than CLEAN).
//   4 / AMBIGUOUS_BLOCKER     -- no mutation; the Blocker field does not match the
//                                 recognized "Blocked by #N[, #N...]." grammar, "Blocked
//                                 lifecycle"/"Blocked route" are missing or malformed, or a
//                                 named prerequisite issue itself could not be read.
//   2 / REJECTED              -- no mutation; the composed proposed body failed
//                                 write-control-snapshot.mjs's own field-local validation
//                                 (e.g. an unrelated pre-existing corrupted field) --
//                                 mirrors close-control.mjs's own REJECTED contract for the
//                                 same underlying write-before-validate guard.
//   1                         -- operational error (missing required args, unresolved
//                                 repository identity, or the control Issue's own `gh` read
//                                 failed/threw).
//
// Tests: node --test tools/orchestration/reconcile-control-blocker.test.mjs

import { execFileSync } from "node:child_process";
import {
  upsertControlBullet,
  resolveRepoIdentity,
  parseControlBullet,
  parseHeadingField,
  isNoneSentinel,
  isAuditShapedBody,
  isKnownLifecycleValue,
  isRouteCompatibleWithLifecycle,
} from "./ready-dispatch-gate.mjs";
import { parseStage2Verdict } from "../review-watch/lifecycle-gate.mjs";
import { extractBlockedByIssueNumbers, hasUnrecognizedBlockerWording } from "./blocker-grammar.mjs";
import { checkWriteControlSnapshot } from "./write-control-snapshot.mjs";

function defaultGhIssueView({ repo, number }) {
  const raw = execFileSync("gh", ["issue", "view", String(number), "--repo", repo, "--json", "body,state"], {
    encoding: "utf8",
  });
  return JSON.parse(raw);
}

// Pure. Shared Contract design decision point 5, corrected by issue #437/#610 Stage 1 finding
// 2: classifies one already-fetched prerequisite issue's terminal condition. A prerequisite
// whose GitHub `state` is not CLOSED never satisfies. A closed, ordinary (non-audit-shaped)
// issue satisfies on closure alone. A closed, audit-shaped issue (`isAuditShapedBody` --
// deliberately NOT `classifyAuditIssue`, which additionally requires `parseStage2Verdict` to
// already parse non-null) additionally requires its own recorded Verdict to read exactly
// "CLEAN" -- a closed audit Issue reading NOT CLEAN, PENDING, missing, or malformed never
// silently passes merely because the Issue closed. Stage 1 finding: using `classifyAuditIssue`
// here let a closed prerequisite with the canonical audit headings but a missing/malformed
// "### Verdict" field fall through to the "ordinary closed issue" branch below (since
// `classifyAuditIssue` itself returned false the instant `parseStage2Verdict` failed to parse),
// satisfying on closure alone despite never having a valid recorded CLEAN verdict at all.
// `isAuditShapedBody` detects the audit shape independently of verdict validity, so a
// malformed/missing verdict on a genuinely audit-shaped body still requires the same exact
// "CLEAN" comparison as a validly-parsed one -- and still fails it.
export function isPrerequisiteSatisfied({ state, body } = {}) {
  if (String(state ?? "").toUpperCase() !== "CLOSED") return false;
  if (isAuditShapedBody(body ?? "")) {
    return parseStage2Verdict(body ?? "") === "CLEAN";
  }
  return true;
}

// Pure, no network access. Issue #437/#610 Stage 1 findings 3-5: evaluates the Blocker
// condition recorded on a control body from already-available text alone, so the identical
// check can run twice against two independently fresh reads (see checkReconcileControlBlocker
// below) without maintaining two different implementations that could drift apart.
//
// Returns one of:
//   { kind: "ALREADY_UNBLOCKED" }                                    -- nothing to reconcile.
//   { kind: "AMBIGUOUS_BLOCKER", reason }                            -- fails closed, no mutation.
//   { kind: "RECONCILABLE", blockedByIssues, blockedLifecycle, blockedRoute }
//
// Stage 1 finding 5: reads "Blocker" the same way `ready-dispatch-gate.mjs`'s own
// `evaluateReadyDispatchGate` does -- the ad hoc "- **Blocker:**" bullet, falling back to the
// shipped `parent-execution.yml` template's own "### Current blocker" heading when the bullet
// is absent. Reading only the bullet (the pre-#610 shape) meant a template-created control
// with "Current blocker: Blocked by #9." produced BLOCKED at the gate and then
// ALREADY_UNBLOCKED here without ever fetching #9 -- reconciliation silently no-op'd forever on
// exactly the control shape it was built to also cover. `upsertControlBullet`'s own write side
// already updates that same heading in place when no ad hoc bullet coexists with it (see its
// `HEADING_FIELD_LABELS` table), so only the read side needed this fallback.
export function evaluateBlockerCondition(body) {
  const blockerRaw = parseControlBullet(body, "Blocker") ?? parseHeadingField(body, "Current blocker");
  // Shared Contract design decision point 8 (Verification case 7): a missing bullet/heading or
  // an already-"none" value means there is nothing to reconcile -- a safe, idempotent no-op.
  if (blockerRaw === null || isNoneSentinel(blockerRaw)) {
    return { kind: "ALREADY_UNBLOCKED" };
  }

  // Stage 1 finding 3: `hasUnrecognizedBlockerWording` is the fail-closed detector
  // `blocker-grammar.mjs` already exports for exactly this purpose -- checked BEFORE
  // extraction, not only via extraction's own "found nothing" case below, so a field naming an
  // issue reference outside the recognized clause (e.g. "Blocked by #407. Also waiting on
  // #408.") is treated as wholly ambiguous rather than partially resolved against only the
  // issue(s) the clause happened to capture. Without this check, that exact shape fetched only
  // #407 and cleared the entire blocker once it closed, even while #408 -- named elsewhere in
  // the same field but outside the recognized clause -- remained open.
  if (hasUnrecognizedBlockerWording(blockerRaw)) {
    return {
      kind: "AMBIGUOUS_BLOCKER",
      reason:
        `"Blocker" field ${JSON.stringify(blockerRaw)} contains issue reference(s) outside the recognized ` +
        `"Blocked by #N[, #N...]." clause -- refusing to partially resolve a mixed recognized/unrecognized blocker`,
    };
  }

  const blockedByIssues = extractBlockedByIssueNumbers(blockerRaw);
  // Design decision point 3 (Verification case 5): a Blocker field that does not match the
  // recognized "Blocked by #N[, #N...]." clause at all -- including the real historical
  // #440 free-prose shape -- is never guessed at. (In practice this is now also caught by
  // hasUnrecognizedBlockerWording above whenever the field names any "#N" at all; this check
  // remains as the fail-closed backstop for a non-none field naming no issue number whatsoever.)
  if (blockedByIssues.length === 0) {
    return {
      kind: "AMBIGUOUS_BLOCKER",
      reason: `"Blocker" field ${JSON.stringify(blockerRaw)} does not match the recognized "Blocked by #N[, #N...]." clause`,
    };
  }

  const blockedLifecycleRaw = parseControlBullet(body, "Blocked lifecycle");
  const blockedRouteRaw = parseControlBullet(body, "Blocked route");
  // Design decision point 4 (Verification case 6): both companion fields must be present
  // and non-empty before this control can be mechanically reconciled -- their absence is
  // itself an AMBIGUOUS_BLOCKER result, never a guess at the correct resume state.
  if (!blockedLifecycleRaw || !blockedLifecycleRaw.trim() || !blockedRouteRaw || !blockedRouteRaw.trim()) {
    return {
      kind: "AMBIGUOUS_BLOCKER",
      reason:
        '"Blocked lifecycle" and "Blocked route" must both be present and non-empty before this control can be ' +
        `mechanically reconciled (Blocked lifecycle: ${JSON.stringify(blockedLifecycleRaw)}, Blocked route: ${JSON.stringify(blockedRouteRaw)})`,
    };
  }
  const blockedLifecycle = blockedLifecycleRaw.trim();
  const blockedRoute = blockedRouteRaw.trim();

  // Stage 1 finding 4: before this, both companion fields were considered valid solely because
  // they were nonempty, so a typo such as "Blocked lifecycle: READY_FOR_PALN" was persisted as
  // the live Lifecycle and still produced UNBLOCKED -- the next ready-dispatch-gate.mjs
  // invocation would then treat that unknown value as ordinary NOT_READY fallthrough rather
  // than resuming the intended stage. Validate the saved Lifecycle vocabulary...
  if (!isKnownLifecycleValue(blockedLifecycle)) {
    return {
      kind: "AMBIGUOUS_BLOCKER",
      reason:
        `"Blocked lifecycle" value ${JSON.stringify(blockedLifecycle)} is not a recognized Lifecycle value -- ` +
        "refusing to persist an unknown resume state",
    };
  }
  // ...and Route/Lifecycle compatibility (e.g. READY_FOR_PLAN always requires Route "planning
  // worker" -- the same rule evaluateReadyDispatchGate itself enforces on every read) before
  // mutation. The literal sentinel "unchanged" is exempt: it writes nothing to Route at all
  // (buildUnblockedControlBody below skips it entirely), so there is no value here to validate
  // for compatibility.
  if (blockedRoute.toLowerCase() !== "unchanged" && !isRouteCompatibleWithLifecycle(blockedLifecycle, blockedRoute)) {
    return {
      kind: "AMBIGUOUS_BLOCKER",
      reason:
        `"Blocked lifecycle" is ${JSON.stringify(blockedLifecycle)} but "Blocked route" is ${JSON.stringify(blockedRoute)}, ` +
        "which is not a compatible Route for that Lifecycle",
    };
  }

  return { kind: "RECONCILABLE", blockedByIssues, blockedLifecycle, blockedRoute };
}

// Fetches and classifies every named prerequisite fresh -- a real network round trip per
// call, deliberately never cached or reused across the two evaluation passes
// checkReconcileControlBlocker below performs, so a prerequisite that regressed between passes
// is still detected. Returns `{ pending: [...] }` or `{ error: "..." }` (an unreadable named
// prerequisite fails the whole control closed, exactly as before).
async function fetchPrerequisiteStatus(blockedByIssues, { repo, ghIssueViewImpl }) {
  const pending = [];
  for (const issueNumber of blockedByIssues) {
    let prereqData;
    try {
      prereqData = await ghIssueViewImpl({ repo, number: issueNumber });
    } catch (err) {
      return { error: `named prerequisite ${repo}#${issueNumber} could not be read: ${err.message}` };
    }
    if (!isPrerequisiteSatisfied(prereqData)) {
      pending.push(issueNumber);
    }
  }
  return { pending };
}

// Pure. Shared Contract design decision point 7: composes the reconciled control body once
// every named prerequisite is satisfied. Blocker -> "none — <compact provenance note>"
// naming exactly the prerequisites that were satisfied; Lifecycle -> the recorded "Blocked
// lifecycle" value; Route -> the recorded "Blocked route" value, skipped entirely when it
// reads the literal sentinel "unchanged" (case-insensitive).
export function buildUnblockedControlBody(body, { blockedByIssues, blockedLifecycle, blockedRoute }) {
  const note = `none — ${blockedByIssues.map((n) => `#${n}`).join(", ")} closed`;
  let next = body ?? "";
  next = upsertControlBullet(next, "Blocker", note);
  next = upsertControlBullet(next, "Lifecycle", blockedLifecycle);
  if (blockedRoute.trim().toLowerCase() !== "unchanged") {
    next = upsertControlBullet(next, "Route", blockedRoute);
  }
  return next;
}

function incompletePrerequisiteResult({ repo, controlIssue, controlIssueNumber, pending }) {
  return {
    exitCode: 3,
    state: "INCOMPLETE_PREREQUISITE",
    controlIssue: controlIssueNumber,
    pending,
    message:
      `${repo}#${controlIssue} remains blocked: prerequisite(s) ${pending.map((n) => `#${n}`).join(", ")} have not yet ` +
      "reached their required terminal condition.",
  };
}

// `ghIssueViewImpl`/`ghEditImpl` are injected so tests can drive this end-to-end without
// touching the real network or `gh` CLI. `ghEditImpl` is forwarded verbatim to
// write-control-snapshot.mjs's own `checkWriteControlSnapshot` (see below) -- when omitted
// here, that module's own default (a synchronous `gh issue edit --body-file -` via stdin)
// applies, exactly as it does for every other canonical control-body write.
//
// Issue #437/#610 Stage 1 finding 6 (the TOCTOU window): the proposed body used to be derived
// from one initial read, then written only after one or more prerequisite network reads --
// during that window, another lifecycle transition could edit the control (or a "Blocked by"
// clause could stop describing the currently-open prerequisite set), and the write-before-
// validate helper below has no way to know the body it is asked to persist is already stale.
// This function closes that window the same way this repository's existing finalize-*-
// breakpoint.mjs scripts and transition-guard.mjs's own `commitControlBodyTransition` do it for
// their own transitions: read fresh, validate, THEN immediately before the one durable effect
// re-read fresh and re-validate against that latest snapshot -- never the initial one -- and
// only then perform the write. `evaluateBlockerCondition`/`fetchPrerequisiteStatus` are the
// single, side-effect-free implementations run for both passes, so there is no second,
// independently-drifting copy of this logic to keep in sync. (This control-Issue-body
// transition's authorization set is itself derived fresh from the body each pass -- the exact
// "Blocked by ..." issue list to re-check -- which does not fit `commitControlBodyTransition`'s
// own fixed-external-witness shape cleanly; this bespoke sequence applies the identical
// discipline instead of forcing an ill-fitting reuse, per that finding's own accepted
// alternative.)
export async function checkReconcileControlBlocker(args, { ghIssueViewImpl = defaultGhIssueView, ghEditImpl } = {}) {
  const { repo, "control-issue": controlIssue } = args;
  if (!repo || !controlIssue) {
    return { exitCode: 1, message: "Missing required args: --repo and --control-issue are both required." };
  }
  const controlIssueNumber = Number(controlIssue);

  // Pass 1: fresh read, evaluate, gather prerequisites. Establishes whether reconciliation is
  // even a candidate at all. None of ALREADY_TERMINAL/ALREADY_UNBLOCKED/AMBIGUOUS_BLOCKER/
  // INCOMPLETE_PREREQUISITE ever mutates anything, so no TOCTOU protection is needed for them --
  // there is no durable effect at stake yet if this pass's answer turns out to be stale by the
  // time it is reported.
  let controlData;
  try {
    controlData = await ghIssueViewImpl({ repo, number: controlIssue });
  } catch (err) {
    return { exitCode: 1, message: `gh issue view failed for ${repo}#${controlIssue}: ${err.message}` };
  }
  // Mirrors close-control.mjs's own ALREADY_TERMINAL precedent exactly: an already-closed
  // control Issue is trusted as terminal in full, never re-read past this point or re-edited.
  if (controlData.state === "CLOSED") {
    return { exitCode: 0, state: "ALREADY_TERMINAL", controlIssue: controlIssueNumber };
  }

  const initialCondition = evaluateBlockerCondition(controlData.body ?? "");
  if (initialCondition.kind === "ALREADY_UNBLOCKED") {
    return { exitCode: 0, state: "ALREADY_UNBLOCKED", controlIssue: controlIssueNumber };
  }
  if (initialCondition.kind === "AMBIGUOUS_BLOCKER") {
    return { exitCode: 4, state: "AMBIGUOUS_BLOCKER", controlIssue: controlIssueNumber, reason: initialCondition.reason };
  }

  const initialPrereqs = await fetchPrerequisiteStatus(initialCondition.blockedByIssues, { repo, ghIssueViewImpl });
  if (initialPrereqs.error) {
    return { exitCode: 4, state: "AMBIGUOUS_BLOCKER", controlIssue: controlIssueNumber, reason: initialPrereqs.error };
  }
  if (initialPrereqs.pending.length > 0) {
    return incompletePrerequisiteResult({ repo, controlIssue, controlIssueNumber, pending: initialPrereqs.pending });
  }

  // Pass 2, immediately before the one durable effect: re-read the control Issue fresh and
  // re-run the identical evaluation/prerequisite checks against THAT fresh snapshot -- never
  // the pass-1 one -- so a concurrent edit made while pass 1's own network calls were in flight
  // is detected and reflected rather than silently overwritten by a now-stale proposed body.
  let latestControlData;
  try {
    latestControlData = await ghIssueViewImpl({ repo, number: controlIssue });
  } catch (err) {
    return { exitCode: 1, message: `pre-write control re-read failed for ${repo}#${controlIssue}: ${err.message}` };
  }
  if (latestControlData.state === "CLOSED") {
    return { exitCode: 0, state: "ALREADY_TERMINAL", controlIssue: controlIssueNumber };
  }
  const latestCondition = evaluateBlockerCondition(latestControlData.body ?? "");
  if (latestCondition.kind === "ALREADY_UNBLOCKED") {
    return { exitCode: 0, state: "ALREADY_UNBLOCKED", controlIssue: controlIssueNumber };
  }
  if (latestCondition.kind === "AMBIGUOUS_BLOCKER") {
    return { exitCode: 4, state: "AMBIGUOUS_BLOCKER", controlIssue: controlIssueNumber, reason: latestCondition.reason };
  }
  const latestPrereqs = await fetchPrerequisiteStatus(latestCondition.blockedByIssues, { repo, ghIssueViewImpl });
  if (latestPrereqs.error) {
    return { exitCode: 4, state: "AMBIGUOUS_BLOCKER", controlIssue: controlIssueNumber, reason: latestPrereqs.error };
  }
  if (latestPrereqs.pending.length > 0) {
    return incompletePrerequisiteResult({ repo, controlIssue, controlIssueNumber, pending: latestPrereqs.pending });
  }

  // The proposed body is composed from `latestControlData.body` -- never the pass-1 body -- so
  // any unrelated concurrent edit to the same control Issue survives into the write instead of
  // being silently clobbered by a stale copy.
  const proposedBody = buildUnblockedControlBody(latestControlData.body, latestCondition);

  // Design decision point 7: route the composed body through the canonical
  // write-before-validate helper (issue #510) exactly like close-control.mjs already does --
  // never a second, duplicated validate-then-`gh issue edit` mutation path.
  const writeResult = checkWriteControlSnapshot({ repo, controlIssue: controlIssueNumber, proposedBody }, { ghEditImpl });
  if (writeResult.exitCode === 2) {
    return {
      exitCode: 2,
      state: "REJECTED",
      controlIssue: controlIssueNumber,
      errors: writeResult.errors,
      message: writeResult.message,
    };
  }
  if (writeResult.exitCode !== 0) {
    return { exitCode: 1, message: writeResult.message };
  }

  return {
    exitCode: 0,
    state: "UNBLOCKED",
    controlIssue: controlIssueNumber,
    prerequisitesSatisfied: latestCondition.blockedByIssues,
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
  const args = parseArgs(process.argv.slice(2));

  let repo = args.repo;
  if (!repo) {
    const identity = resolveRepoIdentity();
    if (!identity.ok) {
      console.error(`Could not determine the current repository identity (--repo was not supplied): ${identity.reason}`);
      process.exit(1);
      return;
    }
    repo = identity.repo;
  }

  const result = await checkReconcileControlBlocker({ ...args, repo });
  if (result.exitCode === 1) {
    console.error(result.message);
    process.exit(1);
    return;
  }
  if (result.exitCode === 2) {
    console.error(result.message);
    process.exit(2);
    return;
  }
  console.log(JSON.stringify(result));
  process.exit(result.exitCode);
}

if (process.argv[1] && process.argv[1].endsWith("reconcile-control-blocker.mjs")) {
  main();
}
