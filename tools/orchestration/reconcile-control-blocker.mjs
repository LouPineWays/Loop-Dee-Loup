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
import { upsertControlBullet, resolveRepoIdentity, parseControlBullet, isNoneSentinel, classifyAuditIssue } from "./ready-dispatch-gate.mjs";
import { parseStage2Verdict } from "../review-watch/lifecycle-gate.mjs";
import { extractBlockedByIssueNumbers } from "./blocker-grammar.mjs";
import { checkWriteControlSnapshot } from "./write-control-snapshot.mjs";

function defaultGhIssueView({ repo, number }) {
  const raw = execFileSync("gh", ["issue", "view", String(number), "--repo", repo, "--json", "body,state"], {
    encoding: "utf8",
  });
  return JSON.parse(raw);
}

// Pure. Shared Contract design decision point 5: classifies one already-fetched
// prerequisite issue's terminal condition. A prerequisite whose GitHub `state` is not
// CLOSED never satisfies. A closed, ordinary (non-audit-shaped) issue satisfies on closure
// alone. A closed, audit-shaped issue (classifyAuditIssue) additionally requires its own
// recorded Verdict to read exactly "CLEAN" -- a closed audit Issue reading NOT CLEAN,
// PENDING, or malformed never silently passes merely because the Issue closed.
export function isPrerequisiteSatisfied({ state, body } = {}) {
  if (String(state ?? "").toUpperCase() !== "CLOSED") return false;
  if (classifyAuditIssue(body ?? "")) {
    return parseStage2Verdict(body ?? "") === "CLEAN";
  }
  return true;
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

// `ghIssueViewImpl`/`ghEditImpl` are injected so tests can drive this end-to-end without
// touching the real network or `gh` CLI. `ghEditImpl` is forwarded verbatim to
// write-control-snapshot.mjs's own `checkWriteControlSnapshot` (see below) -- when omitted
// here, that module's own default (a synchronous `gh issue edit --body-file -` via stdin)
// applies, exactly as it does for every other canonical control-body write.
export async function checkReconcileControlBlocker(args, { ghIssueViewImpl = defaultGhIssueView, ghEditImpl } = {}) {
  const { repo, "control-issue": controlIssue } = args;
  if (!repo || !controlIssue) {
    return { exitCode: 1, message: "Missing required args: --repo and --control-issue are both required." };
  }
  const controlIssueNumber = Number(controlIssue);

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

  const body = controlData.body ?? "";
  const blockerRaw = parseControlBullet(body, "Blocker");
  // Shared Contract design decision point 8 (Verification case 7): a missing bullet or an
  // already-"none" value means there is nothing to reconcile -- a safe, idempotent no-op.
  if (blockerRaw === null || isNoneSentinel(blockerRaw)) {
    return { exitCode: 0, state: "ALREADY_UNBLOCKED", controlIssue: controlIssueNumber };
  }

  const blockedByIssues = extractBlockedByIssueNumbers(blockerRaw);
  // Design decision point 3 (Verification case 5): a Blocker field that does not match the
  // recognized "Blocked by #N[, #N...]." clause at all -- including the real historical
  // #440 free-prose shape -- is never guessed at.
  if (blockedByIssues.length === 0) {
    return {
      exitCode: 4,
      state: "AMBIGUOUS_BLOCKER",
      controlIssue: controlIssueNumber,
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
      exitCode: 4,
      state: "AMBIGUOUS_BLOCKER",
      controlIssue: controlIssueNumber,
      reason:
        '"Blocked lifecycle" and "Blocked route" must both be present and non-empty before this control can be ' +
        `mechanically reconciled (Blocked lifecycle: ${JSON.stringify(blockedLifecycleRaw)}, Blocked route: ${JSON.stringify(blockedRouteRaw)})`,
    };
  }
  const blockedLifecycle = blockedLifecycleRaw.trim();
  const blockedRoute = blockedRouteRaw.trim();

  // Design decision point 5/6: every named prerequisite is fetched and independently
  // classified; a single unsatisfied or unreadable prerequisite fails the whole control --
  // never a partial clear.
  const pending = [];
  for (const issueNumber of blockedByIssues) {
    let prereqData;
    try {
      prereqData = await ghIssueViewImpl({ repo, number: issueNumber });
    } catch (err) {
      return {
        exitCode: 4,
        state: "AMBIGUOUS_BLOCKER",
        controlIssue: controlIssueNumber,
        reason: `named prerequisite ${repo}#${issueNumber} could not be read: ${err.message}`,
      };
    }
    if (!isPrerequisiteSatisfied(prereqData)) {
      pending.push(issueNumber);
    }
  }

  if (pending.length > 0) {
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

  const proposedBody = buildUnblockedControlBody(body, { blockedByIssues, blockedLifecycle, blockedRoute });

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

  return { exitCode: 0, state: "UNBLOCKED", controlIssue: controlIssueNumber, prerequisitesSatisfied: blockedByIssues };
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
