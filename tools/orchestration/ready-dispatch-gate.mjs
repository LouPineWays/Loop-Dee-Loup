#!/usr/bin/env node
// Deterministic READY immediate-dispatch gate for AGENTS.md § Session execution /
// docs/operating-model.md § Two-plane Issue dispatch — issue #321.
//
// Both #310/#311's diagnostic-trace artifact and control Issue #322's own body record a
// live regression: a fresh controller session given a complete READY thin control Issue
// (every immediate-dispatch gate field already satisfied) still read the linked thick
// execution Issue — and, in the #310/#311 case, also queried unrelated PRs — before ever
// dispatching a worker. AGENTS.md's prose already states the gate outcome unambiguously
// ("dispatch the linked execution worker immediately by reference ... without first
// performing execution-Issue inspection, repository reconnaissance ... or implementation
// planning"); two independent live sessions violated it anyway. docs/operating-model.md
// already anticipated this: "A future genuine deterministic dispatch surface should carry
// the smallest reliable guard, proven against a real named exception as well as the
// forbidden transition; until one exists, live dispatch behavior is verified by #283's
// fresh-session proof, not a fabricated test." This script is that guard.
//
// It starts with exactly ONE control-plane read — `gh issue view <control-issue>` — and no
// freeform reconnaissance. For ROUTED only, it then performs deterministic durable-state
// verification reads (Execution Plan parse + referenced manifest comment read-back) before
// authorizing unit dispatch, so `Lifecycle: ROUTED` alone cannot advance work.
//
// Repository identity — issue #344: a live `work on #322` proving session hand-typed
// `--repo Wolfscairn-LouPine/Loop-Dee-Loup` (the wrong owner; the real remote is
// `LouPineWays/Loop-Dee-Loup`), and GitHub correctly rejected it. The repository slug is
// deterministic environment state, not a reasoning decision, so the normal path never
// requires a caller to supply `--repo` at all: `resolveRepoIdentity` below derives it from
// the current checkout's configured `origin` remote (`git remote get-url origin`, the same
// deterministic recovery that live session used by hand), which is local, offline
// repository-identity state — not a second GitHub read — so it does not add to the single
// control-Issue read this script performs. `--repo` remains accepted only as an explicit
// override for tests/exceptional invocation; the normal production path never passes it,
// so a model can no longer author (or mistype) the owner/repo slug that governs which
// repository the control-Issue read below targets.
//
// Parses the "- **Label:**" bullet convention real thin control Issues #311/#322 use in
// practice (see docs/operating-model.md § Parent snapshots):
//   - **Lifecycle:** READY
//   - **Execution:** #123
//   - **Route:** implementation worker
//   - **Blocker:** none
//   - **Founder decision:** none — <optional trailing explanation>
//
// Issue #397 corrective unit 397-E: live control Issues #398/#408 actually author this
// field as "- **Execution issue:** #123", not "- **Execution:** #123". 397-B's own
// regression fixture silently normalized the live spelling to the legacy one before ever
// exercising the gate, so it never proved the gate accepted the shape real thin controls
// use. Both spellings are read as one execution-pointer field (readExecutionBulletField
// below); when both are present and resolve to different issue numbers, that is a genuine
// authoring conflict and fails closed to NOT_READY rather than silently preferring either
// spelling.
//
// Stage 1 review finding on this PR: `.github/ISSUE_TEMPLATE/parent-execution.yml` — a
// coarser, whole-feature controller template, not specific to this two-plane thin
// control/execution pattern — never actually renders these bullets; it renders "###
// State" (dropdown), "### Current blocker", and "### Founder interrupt" instead, with no
// dedicated Execution or Route field at all. Lifecycle/Blocker/Founder-decision fall back
// to those "### Heading" fields when the bullet is absent (parseHeadingField); Execution
// additionally falls back to the template's "### Minimum authority" field, extracting
// only its labeled "Active execution Issue:" entry — never every "#N" reference that
// field happens to contain, since it may legitimately list other required issues too.
// Route has no template counterpart, so a control Issue relying on
// this gate must include an explicit "- **Route:**" bullet regardless of which template
// created it.
//
// Verdicts:
//   Every verdict that authorizes exactly one bounded next action for the pre-PR pipeline —
//   READY_TO_DISPATCH, READY_TO_DISPATCH_PLANNING, READY_TO_RUN_DISPATCH_MANIFEST,
//   READY_TO_DISPATCH_UNITS, READY_TO_DISPATCH_INTEGRATION, READY_TO_PROJECT_PLAN_READY, and
//   READY_TO_PROJECT_ROUTED — carries a literal `stopAfter: true` field (issue #498 unit
//   498-A), mirroring the convention `tools/orchestration/next-review-transition-gate.mjs`
//   already established. This is a mandatory, literal stop only after the authorized
//   transition's own durable output (and, for the two PROJECT verdicts, the required
//   thin-control projection) has already been verified by the gate itself — never license to
//   continue reasoning past the stop in the same invocation.
//   AUDIT_ISSUE_DETECTED — issue #407 unit 407-B (Shared Contract item 8), the #432 fix: the
//     directly-dispatched Issue is itself a canonical Stage 2 Audit Issue (a real
//     "audit-control-issue.yml"-rendered body — parseStage2Verdict, "### Merged PR", and
//     "### Work issue" all resolve non-null; see classifyAuditIssue), never inferred from the
//     issue title. Checked before every other classification below, so it never falls through
//     to generic NOT_READY reasoning merely because a Stage 2 Audit Issue has no Lifecycle/
//     Blocker/Founder-decision bullets at all. Stage 1 review finding on PR #435: checkReadyDispatch
//     classifies this shape from the fetched body *before* applying its own control-Issue
//     open-state guard, not after — a directly-dispatched audit Issue that is already closed
//     (e.g. a founder re-invoking `work on #N` against a Stage 2 Audit Issue `close-audit`
//     already closed) must still route through AUDIT_ISSUE_DETECTED to
//     next-review-transition-gate.mjs's own idempotent ALREADY_TERMINAL result, not fall into
//     the same ordinary "control Issue is CLOSED, not OPEN" NOT_READY that a closed *thin
//     control* Issue correctly reports. exit 9. Result carries { auditIssue,
//     nextCommand } — run `nextCommand` (tools/orchestration/next-review-transition-gate.mjs
//     --audit-issue <N>) and act on *its* verdict per AGENTS.md § Session execution:
//     STAGE2_CLOSE_READY invokes `lifecycle-gate.mjs close-audit` and stops;
//     STAGE2_CORRECTION_REQUIRED dispatches correction by reference and stops; NO_ACTION_YET/
//     AMBIGUOUS stop per their existing meaning. Never read the linked execution/work Issue,
//     inspect stage2-report.mjs's source, or write an ad hoc parser script to resolve this by
//     hand.
//   READY_TO_DISPATCH — every gate field satisfied. exit 0. Result carries
//     { controlIssue, executionIssue, route } — the exact reference-only triple to hand
//     the dispatched worker; nothing else belongs in that prompt (AGENTS.md § Subagent
//     dispatch).
//   READY_TO_PROJECT_PLAN_READY / READY_TO_PROJECT_ROUTED — issue #498 unit 498-A, the
//     2026-09-10 #500 live-trace fix: `Lifecycle` is READY_FOR_PLAN (respectively PLAN_READY)
//     but durable state shows the transition already happened — a valid Execution Plan Index
//     already exists (respectively a Dispatch Manifest already verifies), just never
//     projected into thin control state before the prior controller stopped. exit 10
//     (respectively 11). Result carries { controlIssue, executionIssue, planIndexUrl,
//     proposedBody } — `proposedBody` is the control Issue's current body with `Lifecycle`
//     already updated (to PLAN_READY plus a `Plan:` bullet, or to ROUTED) via
//     upsertControlBullet, ready to pipe into `write-control-snapshot.mjs --body-file -`
//     verbatim (AGENTS.md § Session execution). Every verdict in this pair carries a literal
//     `stopAfter: true` (mirroring next-review-transition-gate.mjs's own convention): persist
//     and stop, never also dispatch a (now-redundant) planning worker or manifest-prep run in
//     the same breath. See probeExistingPlan's own comment for why this recognition is
//     necessary rather than merely a nice-to-have.
//   BLOCKED — issue #368: the control Issue was read successfully and its own recorded
//     fields *explicitly* say the current invocation must not advance — a blocking
//     lifecycle value (the ad hoc bullet convention's `Lifecycle: BLOCKED`, or the shipped
//     template's `State: BLOCKED_FAILURE` / `State: BLOCKED_EXTERNAL` — issue #370), a
//     non-"none" Blocker, or an unresolved Founder decision. exit 4. This is a positive,
//     authoritative "do not advance" verdict, not merely "the immediate-dispatch shortcut
//     doesn't apply" — distinct from NOT_READY by construction so a controller cannot
//     collapse the two into the same "fall through and reason normally" handling.
//     Control #301's live reproduction (issue #368) is the incident this exists to close:
//     `Lifecycle: BLOCKED` plus an active Blocker both landed in the old broad NOT_READY
//     bucket, and the controller then treated that NOT_READY result as permission to fall
//     through into execution-Issue inspection and repository reconnaissance instead of
//     stopping. Result carries { reasons } — only the specific blocking field(s), not the
//     full unrelated NOT_READY diagnostic set — enough for a concise blocked/founder-
//     interrupt chat handoff without a second read.
//   NOT_READY — the immediate-dispatch shortcut genuinely does not apply, and no field
//     explicitly says to stop: wrong non-BLOCKED mid-cycle lifecycle state (EXECUTING,
//     VERIFYING, REVIEW, AUDIT, CORRECTION), a missing/malformed/multi-valued field, or a
//     control Issue shape the gate cannot classify at all (e.g. a legacy unsplit Issue).
//     exit 3. Falls through to normal Decomposition-boundary / Direct-inspection
//     reasoning — this script has no opinion on what to do next, only on whether the
//     immediate-dispatch shortcut applies. See BLOCKED above for the narrower case where
//     control state instead says to stop outright.
//   ERROR — the control Issue could not be read, --control-issue was missing/invalid, or
//     (issue #344) the current repository identity could not be established from the
//     checkout (no configured `origin` remote, or a remote URL that isn't a recognizable
//     GitHub owner/repo). Also returned (Stage 1 review finding on PR #420) when ROUTED's
//     own durable manifest verification hits an operational read/fetch failure — the
//     execution plan or Dispatch Manifest comment could not be read at all (network, `gh
//     api`, or unresolved repository identity), as opposed to being read and found
//     malformed. Distinct from NOT_READY and BLOCKED in every case: this means authoritative
//     control state was never reached at all, not that it was read and found unsatisfied
//     or blocking — it must never be treated as license to fall through to execution-Issue
//     inspection on the theory that "the gate said something." exit 1.
//
// Usage (normal path — repository identity is derived automatically, never hand-typed):
//   node tools/orchestration/ready-dispatch-gate.mjs --control-issue 322
//
// Usage (explicit override — tests/exceptional invocation only; never required or used on
// the normal production path):
//   node tools/orchestration/ready-dispatch-gate.mjs --repo OWNER/REPO --control-issue 322
//
// Tests: node --test tools/orchestration/ready-dispatch-gate.test.mjs

import { execFileSync } from "node:child_process";
// Deliberate, documented exception to this file's usual practice of not importing
// tools/review-watch internals (issue #407 unit 407-B, Shared Contract item 8) — the same
// exception next-review-transition-gate.mjs's own module comment already documents for its
// own imports from tools/review-watch. classifyAuditIssue below reuses lifecycle-gate.mjs's
// own field parsers rather than re-deriving a second, competing reading of the
// audit-control-issue template's rendered shape.
import { parseStage2Verdict, parseFormField } from "../review-watch/lifecycle-gate.mjs";

const KNOWN_LIFECYCLE_STATES = [
  "READY",
  "READY_FOR_PLAN",
  "PLAN_READY",
  "ROUTED",
  "EXECUTION_COMPLETE",
  "EXECUTING",
  "VERIFYING",
  "REVIEW",
  "AUDIT",
  "CORRECTION",
  "BLOCKED",
  "BLOCKED_FAILURE",
  "BLOCKED_EXTERNAL",
];

// #397's four new pre-PR Lifecycle values (docs/operating-model.md's "Execution-stage
// session boundaries" Plan/Route/Execute/Integrate pipeline), sitting between the existing
// READY (direct single-worker dispatch) and the existing post-PR states. Recognizing these
// here — rather than in a second, competing gate script — is #397's own explicit
// requirement: AGENTS.md's "first action" contract names this one script for any
// control-plane Issue, so a second script would leave that contract's own "run this one
// script first" instruction silently incomplete for a pipeline-using control Issue. Each
// value produces its own dispatch-ready verdict shape (see evaluateReadyDispatchGate below)
// rather than collapsing into READY_TO_DISPATCH, because each authorizes a genuinely
// different next action, not "dispatch one worker by the recorded route":
//   READY_FOR_PLAN      -> dispatch the planning worker reference-only (Route must be the
//                          literal value "planning worker" -- the one new state whose
//                          Route is a specific required value, not merely "settled").
//   PLAN_READY          -> run tools/orchestration/prepare-dispatch-manifest.mjs
//                          --execution-issue <N> (a deterministic script invocation, never a
//                          model-worker dispatch).
//   ROUTED              -> read the Dispatch Manifest (tools/orchestration/
//                          parse-execution-plan.mjs) and dispatch every currently
//                          dispatch_ready unit via
//                          tools/orchestration/format-unit-dispatch-prompt.mjs.
//   EXECUTION_COMPLETE  -> dispatch the Integration/PR worker reference-only.
// For ROUTED only, checkReadyDispatch performs an additional deterministic verification pass
// against durable execution-plan/manifest state before returning READY_TO_DISPATCH_UNITS.
const PRE_PR_DISPATCH_LIFECYCLE_VALUES = new Set(["READY_FOR_PLAN", "PLAN_READY", "ROUTED", "EXECUTION_COMPLETE"]);
const DISPATCH_MANIFEST_HEADING = /^## Dispatch Manifest \(v1\)$/;

// Issue #370 (Stage 1 finding on #368's PR): the ad hoc "- **Lifecycle:**" bullet
// convention uses the bare word "BLOCKED", but `.github/ISSUE_TEMPLATE/parent-execution.yml`'s
// own "State" dropdown never offers that bare value at all — its actual blocking options
// are "BLOCKED_FAILURE" and "BLOCKED_EXTERNAL". Matching only the literal string "BLOCKED"
// let a template-created control Issue with `State: BLOCKED_FAILURE` (or
// `BLOCKED_EXTERNAL`) fall through to ordinary NOT_READY — reproducing the exact
// NOT_READY/BLOCKED collapse issue #368 was written to close, just reachable via the
// template's own field values instead of the ad hoc bullet. All three values are treated
// identically as positive "do not advance" signals.
const BLOCKING_LIFECYCLE_VALUES = new Set(["BLOCKED", "BLOCKED_FAILURE", "BLOCKED_EXTERNAL"]);

// Pure. Reads one "- **Label:** value" bullet line from a control Issue's body — the
// "Current state" block's own rendering convention (not a GitHub issue-form field, so
// this is deliberately a different, simpler parser than lifecycle-gate.mjs's
// parseFormField/parseFormFieldBlock, which read "### Heading" form fields instead).
// Case-insensitive on the label so "**Lifecycle:**" and "**lifecycle:**" both match;
// returns the trimmed remainder of the line (which may include a trailing explanation
// after an em/en dash, e.g. "none — founder selected explicit opt-in diagnostic capture"),
// or null if the label's bullet is absent. When a label appears more than once, the last
// occurrence wins — mirroring lifecycle-gate.mjs's parseFormField precedent of preferring
// the field that actually governs current state over an earlier mention (e.g. inside a
// quoted historical excerpt higher in the body).
export function parseControlBullet(body, label) {
  const pattern = new RegExp(`^-\\s*\\*\\*${label}:\\*\\*\\s*(.*)$`, "im");
  let match = null;
  for (const line of (body ?? "").split("\n")) {
    const m = pattern.exec(line);
    if (m) match = m;
  }
  return match ? match[1].trim() : null;
}

// Pure. Replaces an existing "- **Label:** value" bullet line in `body` with a freshly
// composed one (every matching occurrence gets the same replacement line, mirroring
// prepare-dispatch-manifest.mjs's updateDispatchManifestPointer bullet-replace precedent),
// or — when no such bullet exists yet — inserts it immediately after the
// "- **Lifecycle:**" bullet (appending to the body instead, when even that anchor is
// absent). Issue #498 unit 498-A: the PLAN_READY/ROUTED thin-control projection this
// enables introduces a "- **Plan:**" bullet a genuine READY_FOR_PLAN control Issue does not
// yet carry at all, so a replace-only helper (like updateDispatchManifestPointer) cannot by
// itself converge that transition — this is that helper generalized to also handle the
// insert case. Case-insensitive on the label, matching parseControlBullet's own read-side
// convention.
// Pure. Finds the last "### <label>" heading in `lines` and replaces that field's first
// non-blank content line (or its "_No response_" placeholder) with `newLine` verbatim; a
// field with no content line at all gets `newLine` inserted right after the heading.
// Returns null when the heading isn't present at all. Mirrors parseHeadingField's own
// last-occurrence, first-non-blank-line convention so a write here is always visible to a
// subsequent read through that same function.
function replaceHeadingFieldValue(lines, label, newLine) {
  const heading = `### ${label}`;
  let headingIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === heading) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx === -1) return null;
  const next = [...lines];
  for (let i = headingIdx + 1; i < next.length; i++) {
    const trimmed = next[i].trim();
    if (trimmed.startsWith("### ")) {
      next.splice(i, 0, newLine);
      return next;
    }
    if (trimmed === "") continue;
    next[i] = newLine;
    return next;
  }
  next.push(newLine);
  return next;
}

// Pure. Finds the last "### <label>" heading in `lines` and appends `newLine` at the end
// of that field's own block (immediately before the next "### " heading, or end of body),
// replacing a lone "_No response_" placeholder outright rather than appending alongside
// it. Returns null when the heading isn't present. Used to place a new ad hoc "- **Label:**
// value" bullet inside the template's own intended control-state field instead of past
// every later template field.
function insertIntoHeadingBlock(lines, label, newLine) {
  const heading = `### ${label}`;
  let headingIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === heading) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx === -1) return null;
  const next = [...lines];
  let insertAt = next.length;
  for (let i = headingIdx + 1; i < next.length; i++) {
    if (next[i].trim().startsWith("### ")) {
      insertAt = i;
      break;
    }
  }
  if (insertAt > headingIdx + 1 && next[insertAt - 1].trim() === "_No response_") {
    next.splice(insertAt - 1, 1, newLine);
    return next;
  }
  next.splice(insertAt, 0, newLine);
  return next;
}

export function upsertControlBullet(body, label, value) {
  const lines = (body ?? "").split("\n");
  const pattern = new RegExp(`^-\\s*\\*\\*${label}:\\*\\*`, "i");
  let replaced = false;
  const next = lines.map((line) => {
    if (pattern.test(line)) {
      replaced = true;
      return `- **${label}:** ${value}`;
    }
    return line;
  });
  if (replaced) return next.join("\n");

  const lifecycleIdx = lines.findIndex((line) => /^-\s*\*\*Lifecycle:\*\*/i.test(line));
  if (lifecycleIdx !== -1) {
    const inserted = [...lines];
    inserted.splice(lifecycleIdx + 1, 0, `- **${label}:** ${value}`);
    return inserted.join("\n");
  }

  // Stage 1 review finding on PR #521: no ad hoc "- **Lifecycle:**" bullet exists at all --
  // the shape `.github/ISSUE_TEMPLATE/parent-execution.yml` actually renders, whose
  // Lifecycle-equivalent is the "### State" dropdown heading, not a bullet
  // (readExecutionBulletField's own Lifecycle read already falls back to
  // parseHeadingField(body, "State") for exactly this case). Updating "Lifecycle" here used
  // to always append a brand-new bullet past every template field instead, leaving "### State"
  // stale and contradictory. For the Lifecycle label, update "### State" in place; for any
  // other ad hoc label (e.g. "Plan"), the template's own "### Current state" field
  // description names itself as where such bullets belong for a thin control Issue.
  if (/^lifecycle$/i.test(label)) {
    const headingUpdated = replaceHeadingFieldValue(lines, "State", value);
    if (headingUpdated) return headingUpdated.join("\n");
  } else {
    const blockInserted = insertIntoHeadingBlock(lines, "Current state", `- **${label}:** ${value}`);
    if (blockInserted) return blockInserted.join("\n");
  }

  const trimmedBody = (body ?? "").replace(/\n+$/, "");
  return trimmedBody ? `${trimmedBody}\n- **${label}:** ${value}\n` : `- **${label}:** ${value}\n`;
}

// Pure. Reads one GitHub issue-form field's rendered value by its "### Label" heading —
// the shape `.github/ISSUE_TEMPLATE/parent-execution.yml`'s "State" dropdown and
// "Current blocker"/"Founder interrupt" textareas actually render as, distinct from the
// separate ad hoc "- **Label:**" bullet convention (parseControlBullet) that real control
// Issues #311/#322 use in practice. Stage 1 review finding on this PR: without this, a
// control Issue created from the repository's own shipped template — which has never
// emitted `- **Lifecycle:**`-style bullets — always read as NOT_READY, leaving the gate
// this script exists to provide unusable for template-created issues. Kept as a small,
// independent copy of tools/review-watch/lifecycle-gate.mjs's parseFormField rather than
// a cross-directory import, since tools/orchestration and tools/review-watch are
// separate consumer-distributed units that should not depend on each other's internals.
export function parseHeadingField(body, label) {
  const lines = (body ?? "").split("\n");
  const heading = `### ${label}`;
  let headingIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === heading) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx === -1) return null;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("### ")) break;
    if (line === "") continue;
    return line === "_No response_" ? null : line;
  }
  return null;
}

// Pure. Like parseHeadingField, but returns the field's *entire* rendered block (every
// line under the heading up to the next "### " heading or end of body, trimmed) rather
// than only the first non-blank line. Stage 2 audit finding on this PR: "Minimum
// authority" is a multiline textarea (see parent-execution.yml), so a genuine execution
// pointer such as "Active execution Issue:" on one line followed by "- #77" on the next
// was invisible to parseHeadingField's first-line-only read, silently falling through to
// NOT_READY — exactly the false negative this gate exists to prevent. Used only for
// "Minimum authority" below; Lifecycle/Blocker/Founder-decision stay single-line reads
// via parseHeadingField, since those fields' whole rendered meaning is their first
// substantive line, not a block to scan for an embedded reference.
export function parseHeadingBlock(body, label) {
  const lines = (body ?? "").split("\n");
  const heading = `### ${label}`;
  let headingIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === heading) {
      headingIdx = i;
      break;
    }
  }
  if (headingIdx === -1) return null;
  const collected = [];
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith("### ")) break;
    collected.push(lines[i]);
  }
  const text = collected.join("\n").trim();
  return text === "" || text === "_No response_" ? null : text;
}

// Pure. Extracts only the labeled "Active execution Issue:" entry from a "Minimum
// authority" block — never every "#N" reference the block happens to contain. Stage 1
// review finding on PR #325: `parent-execution.yml`'s "Minimum authority" field
// description explicitly permits listing *multiple* required issues/files ("List only
// the issue bodies and repository files required for the next transition"), so scanning
// the whole block for "exactly one #N" (parseExecutionPointer's contract) falsely
// rejected a genuinely settled control Issue the moment it named a second, unrelated
// required issue anywhere in the same field — e.g. "Active execution Issue: #77" plus a
// separately listed "#50" for background reading.
//
// Only the label's own line, or — when that line carries no "#N" itself — exactly the
// single line immediately following it, is ever considered. Stage 2 audit finding on
// PR #325: an earlier revision of this function kept scanning every subsequent
// non-blank line until a blank line, not just the one immediate continuation line, so a
// label with no reference on its own line ("Active execution Issue:\nPending
// founder-selected routing details\nAlso required for context: #50") returned the
// unrelated later "#50" as if it were the active pointer — worse than the original
// false negative, since it actively selects the wrong dispatch target. When neither the
// label line nor its exact next line carries a reference, this returns null rather than
// searching further.
//
// The label match is anchored to the start of each line (after stripping a leading list
// marker like "- " and Markdown bold emphasis), not merely present anywhere in it. Stage
// 2 audit finding on PR #327: an unanchored `test()` matched the label substring inside
// unrelated prose too — a line like "Previous active execution Issue: #50" (a
// historical/superseded entry) or "Do not use #50 as the active execution Issue:"
// (negated prose) both contain the phrase and were being read as the authoritative
// entry, picking up the wrong reference ahead of a genuine later "Active execution
// Issue: #77" line. Anchoring to line-start means only a line that actually *is* the
// label entry — not one that merely mentions the phrase — can supply the pointer.
//
// Stage 1 review finding on PR #329: this repository's own "- **Label:**" bold-bullet
// convention (parseControlBullet) is a natural way to author this entry too — e.g.
// "- **Active execution Issue:** #77" — and the anchor alone rejected it, since the line
// starts with "**" rather than "active" after only the list marker was stripped.
// Bold emphasis ("**") is stripped globally before the list marker, not the other way
// around: stripping the list-marker character class (which also includes "*") first
// would consume only one asterisk of a leading "**" pair, leaving a stray "*" the anchor
// still wouldn't match.
const ACTIVE_EXECUTION_LABEL = /^active\s+execution\s+issue\s*:?/i;

function normalizeLabelLine(line) {
  return line.replace(/\*\*/g, "").trim().replace(/^[-*•]\s*/, "").trim();
}

export function extractActiveExecutionRef(block) {
  if (typeof block !== "string") return null;
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const normalized = normalizeLabelLine(lines[i]);
    if (!ACTIVE_EXECUTION_LABEL.test(normalized)) continue;
    const sameLine = normalized.match(/#(\d+)/);
    if (sameLine) return `#${sameLine[1]}`;
    const nextLine = lines[i + 1] !== undefined ? lines[i + 1].trim() : "";
    const nextMatch = nextLine.match(/#(\d+)/);
    return nextMatch ? `#${nextMatch[1]}` : null;
  }
  return null;
}

// Pure. True when `value` is the explicit "none" sentinel this repository's control
// template uses for an empty Blocker/Founder-decision field, tolerating a trailing
// explanation after the word itself (e.g. "none — founder selected ..."). A value that is
// merely absent (null) is not the same as a present, explicit "none" — callers distinguish
// the two.
export function isNoneSentinel(value) {
  return typeof value === "string" && /^none\b/i.test(value.trim());
}

function extractCommentIdFromUrl(url) {
  if (typeof url !== "string") return null;
  const m = url.match(/#issuecomment-(\d+)$/);
  return m ? Number(m[1]) : null;
}

function parseIssueNumberFromIssueUrl(issueUrl) {
  if (typeof issueUrl !== "string") return null;
  const m = issueUrl.match(/\/issues\/(\d+)$/);
  return m ? Number(m[1]) : null;
}

// Pure. Extracts a Dispatch Manifest comment's own "- **Plan index:**" backlink. Uses the
// same last-occurrence-wins convention as `parseControlBullet` above, rather than the first
// match a bare `.match()` would return: a malformed or concurrently-edited manifest body
// containing more than one such bullet must not have its first (possibly stale/incorrect)
// occurrence silently accepted as authoritative while a later, conflicting bullet is
// ignored (Stage 1 review finding on PR #420). A manifest with zero such bullets still
// returns null, exactly as before.
function parseManifestPlanIndexUrl(body) {
  if (typeof body !== "string") return null;
  const pattern = /^-\s*\*\*Plan index:\*\*\s*(\S+)\s*$/i;
  let match = null;
  for (const line of body.split("\n")) {
    const m = pattern.exec(line);
    if (m) match = m;
  }
  return match ? match[1] : null;
}

// Pure. Extracts every "- <UnitID>: route=<route> dispatch_ready=<true|false> note=<note>"
// entry from a Dispatch Manifest comment body — the exact line shape
// prepare-dispatch-manifest.mjs's own `renderDispatchManifest` writes (see its "- ${unitId}:
// route=${route} dispatch_ready=${dispatchReady} note=${note}" template). Returns a Map
// keyed by unitId; a manifest with a duplicate unitId keeps only the last occurrence in the
// map but the caller (verifyRoutedDispatchManifest) counts raw matches separately so a
// duplicate is still detected rather than silently collapsed.
function parseManifestUnitEntries(body) {
  // `route` is a non-greedy match up to the next " dispatch_ready=" token, not `\S+` --
  // prepare-dispatch-manifest.mjs's own resolved route values can contain a space (e.g.
  // "stronger/general worker", the real #498 manifest's own shape), which `\S+` would
  // truncate at, making every real manifest line fail to match at all.
  const pattern = /^-\s*(\S+):\s*route=(.*?)\s+dispatch_ready=(true|false)\s+note=(.*)$/i;
  const entries = new Map();
  const unitIdsSeen = [];
  for (const rawLine of (body ?? "").split("\n")) {
    const m = pattern.exec(rawLine.trim());
    if (!m) continue;
    const [, unitId, route, dispatchReady, note] = m;
    unitIdsSeen.push(unitId);
    entries.set(unitId, { route, dispatchReady: dispatchReady === "true", note: note.trim() });
  }
  return { entries, unitIdsSeen };
}

// Pure. Extracts a comment permalink's identity: origin (scheme+host), owner/repo, issue
// number, and comment id. Stage 1 review finding on this PR: a foreign permalink such as
// `https://attacker.example/owner/repo/issues/407#issuecomment-123` shares its path and
// fragment with a real GitHub comment, so omitting scheme+host from identity let it compare
// equal to the genuine comment returned by the API. `origin` is included precisely so every
// caller below compares it alongside repo/issue/commentId — never hardcoded to one host, so
// a GitHub Enterprise origin still compares correctly as long as both sides of a comparison
// resolve to the same origin (e.g. the pointer parsed from durable state vs. the canonical
// URL the API itself returned).
function parseCommentPermalinkIdentity(url) {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    const m = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/);
    const commentId = extractCommentIdFromUrl(parsed.hash);
    if (!m || !commentId) return null;
    return { origin: parsed.origin.toLowerCase(), repo: `${m[1]}/${m[2]}`.toLowerCase(), issue: Number(m[3]), commentId };
  } catch {
    return null;
  }
}

// Pure. Extracts the single execution-Issue number a control Issue's "Execution" bullet
// points at. Returns { ok: true, issue } for exactly one distinct reference — either a
// literal "#N" or a full GitHub issue/PR URL (".../issues/N" or ".../pull/N", an optional
// "#issuecomment-..." anchor ignored) — or { ok: false, reason } for zero or more than one.
// Issue #398's live control-Issue body used a full PR URL in its "PR:" bullet where every
// other reference field used "#N"; next-review-transition-gate.mjs's shared use of this
// function for the "PR" and "Stage 2" bullets (not just "Execution") means both authored
// shapes must resolve the same way rather than forcing control Issues to be rewritten to
// match one narrower convention. A control Issue naming more than one distinct pointer is
// not "one current execution pointer" (AGENTS.md's immediate-dispatch gate requirement) and
// must not be treated as dispatch-ready.
export function parseExecutionPointer(value) {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, reason: "Execution field is missing or empty" };
  }
  const hashRefs = [...value.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
  const urlRefs = [...value.matchAll(/\/(?:pull|issues)\/(\d+)/g)].map((m) => Number(m[1]));
  const refs = [...new Set([...hashRefs, ...urlRefs])];
  if (refs.length === 0) return { ok: false, reason: `Execution field "${value}" names no #N issue reference or GitHub issue/PR URL` };
  if (refs.length > 1) {
    return { ok: false, reason: `Execution field names more than one execution pointer (${refs.map((n) => `#${n}`).join(", ")}), not "one current execution pointer"` };
  }
  return { ok: true, issue: refs[0] };
}

// Pure. Extracts every bold-bullet label appearing in the body as "- **Label:** value" (the
// same line shape parseControlBullet reads), returning { label, raw } for each matching
// line regardless of what label text it carries. Originally used only to scan for
// near-duplicate labels of one specific parser-sensitive field below; also exported for
// control-field-validator.mjs's exact-duplicate-label detection (Stage 1 review finding on
// PR #519, issue #510) — never to interpret arbitrary body prose, and never applied to plain
// paragraphs or "### Heading" template fields (issue #493 is scoped to the ad hoc bold-bullet
// convention only, the shape #440's own reproduction used).
export function extractBoldBulletLabels(body) {
  const pattern = /^-\s*\*\*(.+?):\*\*\s*(.*)$/;
  const result = [];
  for (const line of (body ?? "").split("\n")) {
    const m = pattern.exec(line);
    if (m) result.push({ label: m[1].trim(), raw: m[2].trim() });
  }
  return result;
}

// Pure. True when `label` is a near-duplicate of `canonical`: it begins with the canonical
// label text (case-insensitive) followed by a non-word boundary and additional non-empty
// qualifier content before the colon — a parenthetical like "(current)"/"(updated)", a bare
// trailing word like "note", or a punctuation-delimited qualifier like "-current"/"/current"/
// "[current]"/an em-dash form — while not itself being an exact (case-insensitive) match for
// `canonical`. Issue #493's #440 regression: "Stage 2 (current):" and "Stage 2 (updated):"
// both take this shape relative to canonical "Stage 2". Stage 1 review finding on this PR:
// the original boundary recognized only whitespace/"(" and missed punctuation-delimited
// qualifiers such as "Stage 2-current" or "Stage 2/current", which could still leave a stale
// canonical field authoritative. Deliberately a structural prefix-plus-leftover-content rule,
// not a fixed whitelist of qualifier words or separator spellings — the issue explicitly
// rejects special-casing only the literal observed spellings, so any future lookalike
// qualifier is caught the same way. The boundary requirement (the character immediately after
// the canonical prefix must be a non-word character — i.e. not a letter, digit, or
// underscore) keeps an unrelated label that merely shares a character prefix — e.g. canonical
// "PR" against a hypothetical "Precondition", or canonical "Stage 2" against a hypothetical
// "Stage 20" — from being misread as a near-duplicate, while still catching any punctuation or
// whitespace separator as a genuine qualifier boundary.
function isNearDuplicateLabel(label, canonical) {
  const normalizedLabel = label.trim().toLowerCase();
  const normalizedCanonical = canonical.trim().toLowerCase();
  if (normalizedLabel === normalizedCanonical) return false;
  if (!normalizedLabel.startsWith(normalizedCanonical)) return false;
  const remainder = normalizedLabel.slice(normalizedCanonical.length);
  if (!/^\W/.test(remainder)) return false;
  return remainder.trim().length > 0;
}

// Pure. Scans the body for every bold-bullet label that is a near-duplicate (per
// isNearDuplicateLabel) of `canonical` or of any of `allowedAliases`, while not itself being
// an exact match for `canonical` or any allowed alias — the recognized/unrecognized-label
// split issue #493 requires. `allowedAliases` preserves intentionally supported alternate
// spellings (e.g. "Execution issue" alongside "Execution") as recognized fields in their own
// right, never themselves flagged as near-duplicates. Returns the list of near-duplicate
// labels found (each with its own raw value), or [] when none exist.
export function findNearDuplicateBulletLabels(body, canonical, allowedAliases = []) {
  const recognized = new Set([canonical, ...allowedAliases].map((s) => s.trim().toLowerCase()));
  const seen = new Set();
  const conflicts = [];
  for (const { label, raw } of extractBoldBulletLabels(body)) {
    const normalized = label.trim().toLowerCase();
    if (recognized.has(normalized)) continue;
    const isNearDup = [canonical, ...allowedAliases].some((c) => isNearDuplicateLabel(label, c));
    if (!isNearDup) continue;
    const key = `${normalized}::${raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    conflicts.push({ label, raw });
  }
  return conflicts;
}

// Pure. Composes a human-readable ambiguity reason from a `readExecutionBulletField`
// conflict result — shared by both callers (evaluateReadyDispatchGate below, and
// next-review-transition-gate.mjs's own Execution-pointer resolution) so the two reason
// strings can never silently drift apart.
export function describeExecutionConflict(executionField) {
  if (executionField.nearDuplicate) {
    return (
      "Execution reference is ambiguous: a recognized Execution bullet coexists with unrecognized near-duplicate " +
      `label(s) ${executionField.matches.map((m) => `"- **${m.label}:**" (${JSON.stringify(m.raw)})`).join(", ")} that ` +
      "could represent the same live field — refusing to select the canonical value as authoritative"
    );
  }
  return (
    `Execution pointer is ambiguous: "- **Execution:**" names ${JSON.stringify(executionField.legacy)} ` +
    `while "- **Execution issue:**" names ${JSON.stringify(executionField.liveSpelling)} — these must resolve to the same execution Issue`
  );
}

// Pure. Reads the control Issue's execution-pointer bullet under either observed spelling
// as one field: the legacy ad hoc "- **Execution:**" bullet (control Issues #311/#322) and
// the live "- **Execution issue:**" spelling real thin controls #398/#408 actually use.
// Issue #397 corrective unit 397-E — see the module comment above for why this alias
// exists. When only one spelling is present, its value is used verbatim (existing
// legacy-only control Issues keep working unchanged). When both are present and each
// resolves to exactly one execution pointer, differing issue numbers are a genuine
// authoring conflict: returns { conflict: true } rather than silently preferring either
// spelling, so the caller can fail closed to NOT_READY with an explicit reason instead of
// dispatching against a guess. Malformed values on one side (e.g. "none") do not by
// themselves trigger a conflict — parseExecutionPointer's own missing/multi-valued
// handling still applies to whichever value is selected.
//
// Issue #493 (the #440 regression): when a recognized "Execution"/"Execution issue" bullet
// is present at all, an unrecognized near-duplicate label that could represent the same
// live field (e.g. "- **Execution (current):**") also produces { conflict: true } —
// `nearDuplicate: true` plus the offending `matches` — before the recognized value, possibly
// stale, is ever selected. This is a distinct conflict shape from the alias-mismatch one
// above (kept separate rather than merged, so existing callers/tests that destructure the
// alias-mismatch shape verbatim are unaffected).
export function readExecutionBulletField(body) {
  const legacy = parseControlBullet(body, "Execution");
  const liveSpelling = parseControlBullet(body, "Execution issue");
  if (legacy !== null && liveSpelling !== null) {
    const legacyPointer = parseExecutionPointer(legacy);
    const livePointer = parseExecutionPointer(liveSpelling);
    if (legacyPointer.ok && livePointer.ok && legacyPointer.issue !== livePointer.issue) {
      return { conflict: true, legacy, liveSpelling };
    }
  }
  if (legacy !== null || liveSpelling !== null) {
    const nearDuplicates = findNearDuplicateBulletLabels(body, "Execution", ["Execution issue"]);
    if (nearDuplicates.length > 0) {
      return { conflict: true, nearDuplicate: true, matches: nearDuplicates };
    }
  }
  return { conflict: false, value: liveSpelling ?? legacy };
}

// Pure. Issue #407 unit 407-B (Shared Contract item 8) — the #432 fix: recognizes a
// directly-dispatched Issue as a canonical Stage 2 Audit Issue via positive multi-field
// classification, never inferred from the issue title (compare defaultGhIssueList's own
// "[Audit]" title-prefix caveat in lifecycle-gate.mjs — a title is candidate-discovery only,
// never closure/classification evidence). True only when every one of these independently
// resolves non-null against the body: `parseStage2Verdict` (a real PENDING/CLEAN/NOT CLEAN
// dropdown reading — lifecycle-gate.mjs's own audit-control-issue.yml parser, reused rather
// than re-derived), the "### Merged PR" heading, and the "### Work issue" heading. A thin
// control Issue using the ad hoc "- **Label:**" bullet convention (parseControlBullet) never
// has a "### Verdict"-shaped dropdown field at all, so this never misfires against an
// ordinary control Issue — only a real audit-control-issue.yml-rendered body can satisfy all
// three simultaneously.
export function classifyAuditIssue(body) {
  return (
    parseStage2Verdict(body ?? "") !== null &&
    parseFormField(body ?? "", "Merged PR") !== null &&
    parseFormField(body ?? "", "Work issue") !== null
  );
}

// Pure core: evaluates AGENTS.md's immediate-dispatch gate against an already-fetched
// control Issue body. `controlIssueNumber`, when given, rejects a self-referential
// Execution pointer (Stage 1 review finding on this PR: a malformed control Issue #42
// whose own "Execution" field names "#42" must never read as dispatch-ready — that would
// hand a worker the thin control record itself instead of a separate, self-sufficient
// execution Issue). Exported separately from the `gh` call so tests exercise it without
// touching the network, matching this repository's existing gate-script convention
// (lifecycle-gate.mjs, stage1-gate.mjs).
//
// Issue #368: unsatisfied gate fields are classified into two disjoint buckets rather
// than one broad NOT_READY. A "blocking" field is one whose own parsed value positively
// asserts that the invocation must not advance — a blocking lifecycle value specifically
// (issue #370: `BLOCKED`, `BLOCKED_FAILURE`, or `BLOCKED_EXTERNAL` — see
// BLOCKING_LIFECYCLE_VALUES; not any other non-READY lifecycle state), a Blocker field
// that was found and is not the "none" sentinel, or a Founder-decision field that was
// found and is not the "none" sentinel. Every other unsatisfied condition (a missing
// field, an unrecognized lifecycle value, a mid-cycle lifecycle state other than a
// blocking one, an unsettled Route, a malformed or self-referential Execution pointer)
// stays ordinary NOT_READY: the shortcut doesn't apply, but nothing read here asserts
// that work must stop. A control Issue that trips any blocking condition returns status
// "BLOCKED" with only the blocking reason(s) — never the full NOT_READY diagnostic set —
// since the point is a concise, authoritative stop signal, not a complete field-by-field
// report.
//
// Each field is read from the ad hoc "- **Label:**" bullet convention first (the shape
// real control Issues #311/#322 use), falling back to the shipped
// `parent-execution.yml` template's own "### Heading" fields where one exists: "State"
// for Lifecycle, "Current blocker" for Blocker, "Founder interrupt" for Founder
// decision. The template has no dedicated Execution or Route field; Execution also
// falls back to "Minimum authority" (the template's field for pointing at the active
// execution Issue), reading only its labeled "Active execution Issue:" entry
// (extractActiveExecutionRef) — that field may legitimately list other required issues
// too, so every "#N" it contains is never treated as a candidate pointer. Route has no template
// counterpart at all — a control Issue relying on the two-plane READY dispatch pattern
// must include an explicit "- **Route:**" bullet somewhere in its body regardless of
// which template created it.
export function evaluateReadyDispatchGate(body, controlIssueNumber = null) {
  // Issue #407 unit 407-B: evaluated first, before any of the generic Lifecycle-bullet
  // parsing below — a directly-dispatched canonical Stage 2 Audit Issue is a disjoint
  // classification, never a variant of NOT_READY the caller could fall through from (the
  // #432 regression this exists to close). `nextCommand` names the exact next deterministic
  // step (AGENTS.md § Session execution): the composed post-PR transition gate, never a
  // freeform re-derivation of Stage 2 evidence.
  if (classifyAuditIssue(body)) {
    return {
      status: "AUDIT_ISSUE_DETECTED",
      auditIssue: controlIssueNumber != null ? Number(controlIssueNumber) : null,
      nextCommand:
        controlIssueNumber != null
          ? `node tools/orchestration/next-review-transition-gate.mjs --audit-issue ${Number(controlIssueNumber)}`
          : null,
    };
  }

  const lifecycleRaw = parseControlBullet(body, "Lifecycle") ?? parseHeadingField(body, "State");
  const executionField = readExecutionBulletField(body);
  const executionRaw = executionField.conflict
    ? null
    : executionField.value ?? extractActiveExecutionRef(parseHeadingBlock(body, "Minimum authority"));
  const routeRaw = parseControlBullet(body, "Route");
  const blockerRaw = parseControlBullet(body, "Blocker") ?? parseHeadingField(body, "Current blocker");
  const founderDecisionRaw = parseControlBullet(body, "Founder decision") ?? parseHeadingField(body, "Founder interrupt");

  const reasons = [];
  // Issue #368: reasons that positively assert "stop" rather than merely "shortcut
  // doesn't apply". Populated as a subset of `reasons`, never a separate parse.
  const blockingReasons = [];

  // Which of the dispatch-eligible Lifecycle values (existing READY, or #397's four new
  // pre-PR pipeline values) this control Issue currently records — null when Lifecycle is
  // missing, a blocking value, or an unrecognized/mid-cycle value that stays ordinary
  // NOT_READY. Populated here, acted on only after every other field below has also been
  // validated, exactly mirroring how the pre-existing READY path already defers its own
  // verdict construction to the end of this function.
  let dispatchLifecycle = null;

  if (lifecycleRaw === null) {
    reasons.push('no "- **Lifecycle:**" bullet or "### State" heading found in the control Issue body');
  } else if (BLOCKING_LIFECYCLE_VALUES.has(lifecycleRaw.toUpperCase())) {
    const msg =
      `lifecycle is "${lifecycleRaw}" — this control Issue has an explicit blocking lifecycle state and must not receive a fresh immediate dispatch`;
    reasons.push(msg);
    blockingReasons.push(msg);
  } else if (lifecycleRaw.toUpperCase() === "READY") {
    dispatchLifecycle = "READY";
  } else if (PRE_PR_DISPATCH_LIFECYCLE_VALUES.has(lifecycleRaw.toUpperCase())) {
    dispatchLifecycle = lifecycleRaw.toUpperCase();
  } else {
    reasons.push(
      `lifecycle is "${lifecycleRaw}", not READY` +
        (KNOWN_LIFECYCLE_STATES.includes(lifecycleRaw.toUpperCase())
          ? " — this control Issue is already mid-cycle and should continue its own current step, not receive a fresh immediate dispatch"
          : ""),
    );
  }

  const execution = executionField.conflict
    ? { ok: false, reason: describeExecutionConflict(executionField) }
    : parseExecutionPointer(executionRaw);
  if (!execution.ok) {
    reasons.push(execution.reason);
  } else if (controlIssueNumber != null && execution.issue === Number(controlIssueNumber)) {
    reasons.push(
      `Execution field points back at the control Issue itself (#${execution.issue}) — a control Issue is never its own execution Issue`,
    );
  }

  if (routeRaw === null || routeRaw === "" || isNoneSentinel(routeRaw)) {
    reasons.push(`Route is not settled (found: ${JSON.stringify(routeRaw)})`);
  } else if (dispatchLifecycle === "READY_FOR_PLAN" && routeRaw.trim().toLowerCase() !== "planning worker") {
    // READY_FOR_PLAN is the one new pre-PR value whose Route must be a specific literal
    // value, not merely "settled" — it always dispatches the planning worker specifically
    // (#397's Shared Contract: "Route: must be planning worker").
    reasons.push(
      `lifecycle is READY_FOR_PLAN but Route is "${routeRaw}", not "planning worker" — READY_FOR_PLAN always dispatches the planning worker`,
    );
  }

  if (blockerRaw === null) {
    reasons.push('no "- **Blocker:**" bullet or "### Current blocker" heading found in the control Issue body');
  } else if (!isNoneSentinel(blockerRaw)) {
    const msg = `Blocker is not "none" (found: "${blockerRaw}") — an active blocker must not be reinterpreted as authorization to advance`;
    reasons.push(msg);
    blockingReasons.push(msg);
  }

  if (founderDecisionRaw === null) {
    reasons.push('no "- **Founder decision:**" bullet or "### Founder interrupt" heading found in the control Issue body');
  } else if (!isNoneSentinel(founderDecisionRaw)) {
    const msg = `Founder decision is not "none" (found: "${founderDecisionRaw}") — an unresolved founder decision must stop the invocation, not authorize execution reasoning`;
    reasons.push(msg);
    blockingReasons.push(msg);
  }

  if (blockingReasons.length > 0) {
    return { status: "BLOCKED", reasons: blockingReasons };
  }

  if (reasons.length > 0) {
    return { status: "NOT_READY", reasons };
  }

  // Every field required for dispatchLifecycle's own path has already been validated above
  // (reasons.length === 0), so dispatchLifecycle is guaranteed to be non-null here — a null
  // value would already have produced a `reasons` entry (missing/blocking/unrecognized
  // Lifecycle) and returned NOT_READY/BLOCKED above instead of reaching this point.
  switch (dispatchLifecycle) {
    case "READY":
      return { status: "READY_TO_DISPATCH", executionIssue: execution.issue, route: routeRaw };
    // #397's four new pre-PR pipeline values — see PRE_PR_DISPATCH_LIFECYCLE_VALUES's own
    // comment above for why each gets its own status rather than collapsing into
    // READY_TO_DISPATCH: each authorizes a genuinely different next action for the caller
    // to perform (a different already-shipped script, not "dispatch one worker by route").
    case "READY_FOR_PLAN":
      return { status: "READY_TO_DISPATCH_PLANNING", executionIssue: execution.issue, route: routeRaw };
    case "PLAN_READY":
      return { status: "READY_TO_RUN_DISPATCH_MANIFEST", executionIssue: execution.issue };
    case "ROUTED":
      return { status: "READY_TO_VERIFY_DISPATCH_MANIFEST", executionIssue: execution.issue };
    case "EXECUTION_COMPLETE":
      return { status: "READY_TO_DISPATCH_INTEGRATION", executionIssue: execution.issue, route: routeRaw };
    /* c8 ignore next 2 -- unreachable: dispatchLifecycle is always one of the above once reasons is empty */
    default:
      throw new Error(`unreachable: dispatchLifecycle "${dispatchLifecycle}" with no unsatisfied reasons`);
  }
}

// Pure. Parses a `git remote get-url origin` value into an "owner/repo" slug. Accepts the
// two shapes a GitHub (or GitHub Enterprise) remote actually takes — the scp-like SSH form
// (`git@host:owner/repo.git`) and any URL-with-scheme form (`https://host/owner/repo.git`,
// `ssh://git@host/owner/repo.git`) — with or without a trailing ".git" or slash. Returns
// null for anything that doesn't resolve to exactly two path segments, rather than
// guessing: a malformed or unexpected remote must fail closed (ERROR), never silently
// produce a wrong owner/repo the way the hand-typed slug in issue #344 did.
export function parseOwnerRepoFromRemoteUrl(url) {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed) return null;

  const schemeForm = /^[A-Za-z][\w+.-]*:\/\/(?:[^@/]*@)?[^/]+\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
  const scpForm = /^(?:[\w.-]+@)?[\w.-]+:([^/]+)\/([^/]+?)(?:\.git)?\/?$/;

  const match = schemeForm.exec(trimmed) ?? scpForm.exec(trimmed);
  if (!match) return null;
  const [, owner, repo] = match;
  if (!owner || !repo) return null;
  return `${owner}/${repo}`;
}

function defaultGitRemoteUrl() {
  return execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
}

// Resolves the current checkout's canonical `owner/repo` identity from authoritative local
// repository state — never a controller-composed value. `gitRemoteUrlImpl` is injected so
// tests can drive both the real LDL checkout shape and a consumer-repository shape without
// touching the real `git` binary (matching this file's existing `ghIssueViewImpl`
// injection convention). Returns { ok: true, repo } or { ok: false, reason } — a failure
// here is a genuine ERROR (ambiguous/missing local identity), never a NOT_READY verdict
// about control-Issue content that was never even reached.
export function resolveRepoIdentity({ gitRemoteUrlImpl = defaultGitRemoteUrl } = {}) {
  let url;
  try {
    url = gitRemoteUrlImpl();
  } catch (err) {
    // Stage 2 audit finding on issue #348: JavaScript permits throwing any value, not only an
    // `Error`. `err.message` unconditionally would itself throw (a TypeError) when a caller's
    // injected `gitRemoteUrlImpl` throws `null`/`undefined`/a bare string/etc., letting this
    // function violate its own documented "never throws, always returns { ok, reason }"
    // contract at the exact moment it's supposed to be reporting a failure.
    //
    // Stage 1 review finding on PR #349: the normalization itself — `err instanceof Error ?
    // err.message : String(err)` — was not itself guaranteed non-throwing. `instanceof` can
    // invoke a custom `Symbol.hasInstance`, `err.message` can be a throwing getter on an
    // Error-like object, and `String(err)` invokes `err[Symbol.toPrimitive]`/`toString`, any of
    // which can itself throw for a sufficiently adversarial thrown value. A second, inner
    // try/catch with a fixed fallback string keeps the "never throws" contract true even then.
    //
    // Stage 2 audit finding on issue #350: that inner try/catch protected reading and coercing
    // `err`, but not a *further* coercion still waiting outside it — a genuine `Error` whose
    // `message` property holds a non-string, coercion-throwing value (e.g. an object with a
    // throwing `Symbol.toPrimitive`) passed the inner try/catch with `reasonDetail` still holding
    // that live adversarial value, only to blow up when the outer template literal below
    // implicitly coerced it to a string. The fix is to force the final string conversion
    // (`String(...)`) itself inside the protected block, so nothing capable of throwing during
    // string coercion survives past this catch clause — there is no remaining step downstream
    // that still touches the original `err` or its properties.
    let reasonDetail;
    try {
      reasonDetail = String(err instanceof Error ? err.message : err);
    } catch {
      reasonDetail = "a thrown value that could not safely be inspected";
    }
    return {
      ok: false,
      reason: `could not read the current checkout's "origin" remote via "git remote get-url origin": ${reasonDetail}`,
    };
  }

  const repo = parseOwnerRepoFromRemoteUrl(url);
  if (!repo) {
    return {
      ok: false,
      reason: `the checkout's "origin" remote ("${url}") is not a recognizable GitHub owner/repo URL`,
    };
  }
  return { ok: true, repo };
}

function defaultGhIssueView({ repo, number }) {
  const raw = execFileSync("gh", ["issue", "view", String(number), "--repo", repo, "--json", "body,state"], {
    encoding: "utf8",
  });
  return JSON.parse(raw);
}

function defaultGhCommentView({ repo, commentId }) {
  const raw = execFileSync("gh", ["api", `repos/${repo}/issues/comments/${commentId}`], {
    encoding: "utf8",
  });
  return JSON.parse(raw);
}

async function defaultParseExecutionPlanImpl({ repo, executionIssue }) {
  const { runParseExecutionPlan } = await import("./parse-execution-plan.mjs");
  return runParseExecutionPlan({ repo, executionIssue });
}

export async function verifyRoutedDispatchManifest(
  { repo, executionIssue },
  { parseExecutionPlanImpl = defaultParseExecutionPlanImpl, ghCommentViewImpl = defaultGhCommentView } = {},
) {
  const parsed = await parseExecutionPlanImpl({ repo, executionIssue });
  // Stage 1 review finding on this PR: parse-execution-plan.mjs itself already distinguishes
  // an operational failure (exitCode 1 — missing arg, unresolved repo identity, or a `gh
  // api` call that threw, e.g. network/permission failure) from malformed/unparseable
  // durable state (exitCode 2 — the plan comments were read fine but do not parse as a
  // valid Execution Plan). Collapsing both into the same `{ ok: false }` shape here erased
  // that distinction by the time it reached `checkReadyDispatch`, which then converted every
  // case to NOT_READY — and AGENTS.md's controller contract treats NOT_READY as permission
  // to fall through to normal issue reasoning, which is correct for malformed state but
  // wrong for an unreadable authoritative source that must instead stop as a gate error.
  if (!parsed || parsed.exitCode === 1) {
    return {
      ok: false,
      operationalError: true,
      reason:
        "operational failure reading execution plan while verifying ROUTED Dispatch Manifest: " +
        (parsed?.message ?? "unknown operational failure"),
    };
  }
  if (parsed.exitCode !== 0) {
    return {
      ok: false,
      reason:
        "could not parse execution plan while verifying ROUTED Dispatch Manifest: " +
        ((parsed.errors ?? []).join(" | ") || "unknown parse failure"),
    };
  }

  const manifestUrl = parsed.plan?.planIndex?.dispatchManifest;
  if (manifestUrl === null || manifestUrl === undefined || manifestUrl === "" || isNoneSentinel(manifestUrl)) {
    return { ok: false, reason: `Execution Plan Index has no settled Dispatch manifest pointer (found: ${JSON.stringify(manifestUrl)})` };
  }
  if (typeof parsed.plan?.planIndex?.url !== "string" || !parsed.plan.planIndex.url.trim()) {
    return { ok: false, reason: "Execution Plan Index has no canonical URL to verify manifest backlinks against." };
  }
  const manifestCommentId = extractCommentIdFromUrl(manifestUrl);
  if (!manifestCommentId) {
    return { ok: false, reason: `Dispatch manifest pointer is not a comment permalink: ${JSON.stringify(manifestUrl)}` };
  }

  let manifestComment;
  try {
    manifestComment = await ghCommentViewImpl({ repo, commentId: manifestCommentId });
  } catch (err) {
    // A thrown read here is a `gh api` / network / permission failure — the manifest's
    // existence and content were never actually observed, so this is an operational
    // failure, not evidence the manifest itself is malformed or missing.
    return {
      ok: false,
      operationalError: true,
      reason: `operational failure reading Dispatch manifest comment #${manifestCommentId}: ${err.message}`,
    };
  }
  const manifestIssue = parseIssueNumberFromIssueUrl(manifestComment?.issue_url);
  if (manifestIssue !== Number(executionIssue)) {
    return {
      ok: false,
      reason:
        `Dispatch manifest comment #${manifestCommentId} belongs to issue #${manifestIssue}, expected #${executionIssue}.`,
    };
  }
  const manifestPointerIdentity = parseCommentPermalinkIdentity(manifestUrl);
  const manifestCanonicalIdentity = parseCommentPermalinkIdentity(manifestComment?.html_url ?? "");
  const expectedRepo = String(repo ?? "").toLowerCase();
  if (
    !manifestPointerIdentity ||
    !manifestCanonicalIdentity ||
    manifestPointerIdentity.repo !== expectedRepo ||
    manifestCanonicalIdentity.repo !== expectedRepo ||
    manifestPointerIdentity.origin !== manifestCanonicalIdentity.origin ||
    manifestPointerIdentity.repo !== manifestCanonicalIdentity.repo ||
    manifestPointerIdentity.issue !== manifestCanonicalIdentity.issue ||
    manifestPointerIdentity.commentId !== manifestCanonicalIdentity.commentId
  ) {
    return {
      ok: false,
      reason:
        `Dispatch manifest pointer mismatch: Plan Index references ${manifestUrl}, but comment #${manifestCommentId} canonical URL is ${manifestComment?.html_url}.`,
    };
  }
  const lines = (manifestComment?.body ?? "").split("\n").map((line) => line.trim());
  if (!lines.some((line) => DISPATCH_MANIFEST_HEADING.test(line))) {
    return {
      ok: false,
      reason: `Dispatch manifest comment #${manifestCommentId} does not contain required heading "## Dispatch Manifest (v1)".`,
    };
  }
  const manifestPlanIndexUrl = parseManifestPlanIndexUrl(manifestComment?.body ?? "");
  const manifestPlanIndexIdentity = parseCommentPermalinkIdentity(manifestPlanIndexUrl);
  const canonicalPlanIndexIdentity = parseCommentPermalinkIdentity(parsed.plan.planIndex.url);
  if (
    !manifestPlanIndexIdentity ||
    !canonicalPlanIndexIdentity ||
    manifestPlanIndexIdentity.origin !== canonicalPlanIndexIdentity.origin ||
    manifestPlanIndexIdentity.repo !== canonicalPlanIndexIdentity.repo ||
    manifestPlanIndexIdentity.issue !== canonicalPlanIndexIdentity.issue ||
    manifestPlanIndexIdentity.commentId !== canonicalPlanIndexIdentity.commentId
  ) {
    return {
      ok: false,
      reason:
        `Dispatch manifest comment #${manifestCommentId} Plan index backlink is ${JSON.stringify(manifestPlanIndexUrl)}, ` +
        `expected canonical URL ${JSON.stringify(parsed.plan.planIndex.url)}.`,
    };
  }

  // Stage 1 review finding on PR #521 (ready-dispatch-gate.mjs P2): the checks above only
  // confirm the manifest comment has the required heading and correctly backlinks the Plan
  // Index — a manifest carrying zero (or incomplete/duplicated) per-unit `route=`/
  // `dispatch_ready=` entries used to pass this probe anyway, letting checkReadyDispatch
  // project `Lifecycle: ROUTED` with no authoritative unit routes for the Execute stage to
  // dispatch from. Every unit id the Plan Index's own Units list names (parsed.plan.units,
  // including a REPLAN_REQUIRED one — prepare-dispatch-manifest.mjs still emits an entry
  // for those, just with route=REPLAN_REQUIRED) must appear in the manifest exactly once.
  const planUnitIds = Object.keys(parsed.plan.units ?? {});
  const { entries: manifestEntries, unitIdsSeen } = parseManifestUnitEntries(manifestComment?.body ?? "");
  const missingUnitIds = planUnitIds.filter((unitId) => !manifestEntries.has(unitId));
  const duplicateUnitIds = [...new Set(unitIdsSeen.filter((unitId) => unitIdsSeen.filter((id) => id === unitId).length > 1))];
  const unknownUnitIds = [...manifestEntries.keys()].filter((unitId) => !planUnitIds.includes(unitId));
  if (missingUnitIds.length > 0 || duplicateUnitIds.length > 0 || unknownUnitIds.length > 0) {
    const problems = [];
    if (missingUnitIds.length > 0) problems.push(`missing entries for unit(s): ${missingUnitIds.join(", ")}`);
    if (duplicateUnitIds.length > 0) problems.push(`duplicate entries for unit(s): ${duplicateUnitIds.join(", ")}`);
    if (unknownUnitIds.length > 0) problems.push(`entries for unit(s) not in the Plan Index: ${unknownUnitIds.join(", ")}`);
    return {
      ok: false,
      reason: `Dispatch manifest comment #${manifestCommentId} does not have exactly one route/dispatch_ready entry per Plan Index unit -- ${problems.join("; ")}.`,
    };
  }

  return {
    ok: true,
    executionIssue: Number(executionIssue),
    planIndexUrl: parsed.plan.planIndex.url,
    manifestCommentId,
    manifestUrl,
  };
}

// Pure async (given injected `parseExecutionPlanImpl`). Issue #498 unit 498-A, the 2026-09-10
// #500 live-trace fix: probes whether a valid Execution Plan Index already exists for
// `executionIssue` before authorizing a fresh planning-worker dispatch off a control Issue
// still recording `Lifecycle: READY_FOR_PLAN`. Returns { alreadyPlanned: true, planIndexUrl }
// when parse-execution-plan.mjs resolves a valid plan (exitCode 0) — the #500 shape, where a
// planning worker already persisted and correctly returned `PLAN_READY <ref>`, but the prior
// controller stopped without projecting that result into thin control state, leaving
// `Lifecycle: READY_FOR_PLAN` / `Plan: none` durable and licensing a second, duplicate
// planning dispatch on the next invocation. Returns { alreadyPlanned: false } for the
// ordinary "no plan yet" case (exitCode 2 — comments were read but no valid Plan Index
// parses, the expected shape for a genuine fresh READY_FOR_PLAN control Issue), so the
// caller falls through to dispatching planning exactly as before this fix. Returns
// { alreadyPlanned: false, operationalError: true, reason } for exitCode 1 (a real
// read/network/repository-identity failure) — mirroring verifyRoutedDispatchManifest's own
// operational-vs-malformed distinction above: authoritative state was never actually
// reached, so this must never be silently read as "no plan yet" and used to license a
// possibly-duplicate planning dispatch.
export async function probeExistingPlan({ repo, executionIssue }, { parseExecutionPlanImpl = defaultParseExecutionPlanImpl } = {}) {
  const parsed = await parseExecutionPlanImpl({ repo, executionIssue });
  if (!parsed || parsed.exitCode === 1) {
    return {
      alreadyPlanned: false,
      operationalError: true,
      reason:
        "operational failure probing for an already-existing Execution Plan Index while evaluating READY_FOR_PLAN: " +
        (parsed?.message ?? "unknown operational failure"),
    };
  }
  if (parsed.exitCode !== 0) {
    return { alreadyPlanned: false };
  }
  const planIndexUrl = parsed.plan?.planIndex?.url;
  if (typeof planIndexUrl !== "string" || !planIndexUrl.trim()) {
    return { alreadyPlanned: false };
  }
  return { alreadyPlanned: true, planIndexUrl };
}

// `ghIssueViewImpl` is injected so tests can drive this end-to-end without touching the
// real network or `gh` CLI. This function always starts from one control-Issue read; when
// lifecycle is ROUTED it then performs deterministic durable manifest verification reads
// through verifyRoutedDispatchManifest before authorizing unit dispatch.
export async function checkReadyDispatch(
  { repo, controlIssue },
  {
    ghIssueViewImpl = defaultGhIssueView,
    resolveRepoIdentityImpl = resolveRepoIdentity,
    parseExecutionPlanImpl = defaultParseExecutionPlanImpl,
    ghCommentViewImpl = defaultGhCommentView,
  } = {},
) {
  if (!controlIssue) {
    return { exitCode: 1, message: "Missing required arg: --control-issue is required." };
  }

  // Repository identity resolution (issue #344): an explicit `repo` is accepted verbatim
  // only as the documented tests/exceptional-invocation override. The normal production
  // path never supplies one, so `resolveRepoIdentityImpl` — never a controller-typed
  // value — determines which repository the single control-Issue read below targets. This
  // is deterministic local checkout state, not a second GitHub read, so it does not add to
  // the one-Issue-read budget this gate is built to guarantee.
  let resolvedRepo = repo;
  if (!resolvedRepo) {
    const identity = resolveRepoIdentityImpl();
    if (!identity.ok) {
      return {
        exitCode: 1,
        message: `Could not determine the current repository identity (--repo was not supplied): ${identity.reason}`,
      };
    }
    resolvedRepo = identity.repo;
  }

  let data;
  try {
    data = await ghIssueViewImpl({ repo: resolvedRepo, number: controlIssue });
  } catch (err) {
    return { exitCode: 1, message: `gh issue view failed for ${resolvedRepo}#${controlIssue}: ${err.message}` };
  }

  const result = evaluateReadyDispatchGate(data.body ?? "", controlIssue);
  // Issue #407 unit 407-B: AUDIT_ISSUE_DETECTED is disjoint from every other verdict below —
  // checked first, before even the open-state guard, so a directly-dispatched Stage 2 Audit
  // Issue never falls into BLOCKED/NOT_READY handling merely because it has no Lifecycle/
  // Blocker/Founder-decision bullets at all (the #432 regression), and an *already-closed*
  // directly-dispatched Audit Issue still reaches next-review-transition-gate.mjs's own
  // idempotent ALREADY_TERMINAL result instead of the generic "is CLOSED, not OPEN" NOT_READY
  // below (Stage 1 review finding on PR #435: the open-state guard used to run first, so a
  // closed canonical Audit Issue could never reach this classification at all). exit 9 is the
  // next unused integer after this file's existing 0/1/3/4/5/6/7/8.
  if (result.status === "AUDIT_ISSUE_DETECTED") {
    return {
      exitCode: 9,
      state: "AUDIT_ISSUE_DETECTED",
      controlIssue: Number(controlIssue),
      repo: resolvedRepo,
      auditIssue: result.auditIssue,
      nextCommand: result.nextCommand,
    };
  }

  if (data.state !== "OPEN") {
    return {
      exitCode: 3,
      state: "NOT_READY",
      controlIssue: Number(controlIssue),
      repo: resolvedRepo,
      reasons: [`control Issue ${resolvedRepo}#${controlIssue} is ${data.state}, not OPEN`],
    };
  }

  if (result.status === "BLOCKED") {
    return { exitCode: 4, state: "BLOCKED", controlIssue: Number(controlIssue), repo: resolvedRepo, reasons: result.reasons };
  }
  if (result.status === "NOT_READY") {
    return { exitCode: 3, state: "NOT_READY", controlIssue: Number(controlIssue), repo: resolvedRepo, reasons: result.reasons };
  }

  // #397's four new pre-PR pipeline verdicts each get their own exit code, distinct from
  // READY_TO_DISPATCH's 0 and from each other, so a caller (or a test) can never mistake one
  // for another purely from the exit code alone. Chosen to avoid every exit code already
  // fixed above (0, 1, 3, 4) and below (none currently used past 4), documented together
  // here since there is no established prior convention this had to match. Issue #498 unit
  // 498-A adds READY_TO_PROJECT_PLAN_READY (10) and READY_TO_PROJECT_ROUTED (11) — the next
  // unused integers after 9 (AUDIT_ISSUE_DETECTED) — for the idempotent-recovery verdicts
  // below.
  const EXIT_CODES_BY_STATUS = {
    READY_TO_DISPATCH_PLANNING: 5,
    READY_TO_RUN_DISPATCH_MANIFEST: 6,
    READY_TO_DISPATCH_UNITS: 7,
    READY_TO_DISPATCH_INTEGRATION: 8,
    READY_TO_PROJECT_PLAN_READY: 10,
    READY_TO_PROJECT_ROUTED: 11,
  };

  // Issue #498 unit 498-A, the 2026-09-10 #500 live-trace fix: before authorizing a fresh
  // planning-worker dispatch off `Lifecycle: READY_FOR_PLAN`, check whether a valid
  // Execution Plan Index already exists (probeExistingPlan's own comment above has the full
  // rationale — this is the #500 stranded-state shape). A hit converges thin control state
  // in one step: it returns the exact `proposedBody` (current body with Lifecycle replaced
  // to PLAN_READY and a Plan bullet upserted with the canonical Plan Index permalink) ready
  // to pipe into write-control-snapshot.mjs verbatim, so the controller never composes this
  // edit by hand. A miss (exitCode 2 — no plan yet) falls through to the ordinary
  // READY_TO_DISPATCH_PLANNING verdict below, unchanged from before this fix.
  if (result.status === "READY_TO_DISPATCH_PLANNING") {
    const probe = await probeExistingPlan({ repo: resolvedRepo, executionIssue: result.executionIssue }, { parseExecutionPlanImpl });
    if (probe.operationalError) {
      return {
        exitCode: 1,
        message:
          `Operational failure probing for an already-existing Execution Plan Index for ${resolvedRepo}#${result.executionIssue} ` +
          `while evaluating READY_FOR_PLAN: ${probe.reason}`,
      };
    }
    if (probe.alreadyPlanned) {
      const proposedBody = upsertControlBullet(upsertControlBullet(data.body ?? "", "Lifecycle", "PLAN_READY"), "Plan", probe.planIndexUrl);
      return {
        exitCode: EXIT_CODES_BY_STATUS.READY_TO_PROJECT_PLAN_READY,
        state: "READY_TO_PROJECT_PLAN_READY",
        stopAfter: true,
        controlIssue: Number(controlIssue),
        repo: resolvedRepo,
        executionIssue: result.executionIssue,
        planIndexUrl: probe.planIndexUrl,
        proposedBody,
      };
    }
  }

  // The analogous PLAN_READY -> ROUTED case (#498 Live reproduction C, #497/#499): before
  // running prepare-dispatch-manifest.mjs to create a first Dispatch Manifest, check whether
  // one already exists and verifies — reusing verifyRoutedDispatchManifest itself, the exact
  // check the ROUTED path below already performs, rather than a second competing check. A
  // hit means a prior Route/Prepare session already persisted and verified the manifest but
  // the controller stopped before projecting `Lifecycle: ROUTED`; a miss (no settled
  // Dispatch manifest pointer yet — the ordinary case for a genuine fresh PLAN_READY control
  // Issue) falls through to READY_TO_RUN_DISPATCH_MANIFEST below, unchanged.
  if (result.status === "READY_TO_RUN_DISPATCH_MANIFEST") {
    const manifestProbe = await verifyRoutedDispatchManifest(
      { repo: resolvedRepo, executionIssue: result.executionIssue },
      { parseExecutionPlanImpl, ghCommentViewImpl },
    );
    if (manifestProbe.operationalError) {
      return {
        exitCode: 1,
        message:
          `Operational failure probing for an already-verified Dispatch Manifest for ${resolvedRepo}#${result.executionIssue} ` +
          `while evaluating PLAN_READY: ${manifestProbe.reason}`,
      };
    }
    if (manifestProbe.ok) {
      const proposedBody = upsertControlBullet(data.body ?? "", "Lifecycle", "ROUTED");
      return {
        exitCode: EXIT_CODES_BY_STATUS.READY_TO_PROJECT_ROUTED,
        state: "READY_TO_PROJECT_ROUTED",
        stopAfter: true,
        controlIssue: Number(controlIssue),
        repo: resolvedRepo,
        executionIssue: result.executionIssue,
        planIndexUrl: manifestProbe.planIndexUrl,
        manifestCommentId: manifestProbe.manifestCommentId,
        manifestUrl: manifestProbe.manifestUrl,
        proposedBody,
      };
    }
  }

  if (result.status === "READY_TO_VERIFY_DISPATCH_MANIFEST") {
    const manifestCheck = await verifyRoutedDispatchManifest(
      { repo: resolvedRepo, executionIssue: result.executionIssue },
      { parseExecutionPlanImpl, ghCommentViewImpl },
    );
    if (!manifestCheck.ok) {
      // Stage 1 review finding on this PR: an operational read/fetch failure (network, `gh
      // api`, or unresolved repository identity) means authoritative durable state was
      // never actually reached, not that it was read and found malformed. Reporting that as
      // NOT_READY would license the controller to fall through to normal issue reasoning
      // (AGENTS.md's own NOT_READY contract) over a control-plane read that simply never
      // completed; this is instead an ERROR the caller must stop and repair, same as the
      // top-level `gh issue view` failure above.
      if (manifestCheck.operationalError) {
        return {
          exitCode: 1,
          message: `Operational failure verifying ROUTED Dispatch Manifest for ${resolvedRepo}#${result.executionIssue}: ${manifestCheck.reason}`,
        };
      }
      return {
        exitCode: 3,
        state: "NOT_READY",
        controlIssue: Number(controlIssue),
        repo: resolvedRepo,
        reasons: [manifestCheck.reason],
      };
    }
    return {
      exitCode: EXIT_CODES_BY_STATUS.READY_TO_DISPATCH_UNITS,
      state: "READY_TO_DISPATCH_UNITS",
      stopAfter: true,
      controlIssue: Number(controlIssue),
      repo: resolvedRepo,
      executionIssue: result.executionIssue,
      planIndexUrl: manifestCheck.planIndexUrl,
      manifestCommentId: manifestCheck.manifestCommentId,
      manifestUrl: manifestCheck.manifestUrl,
    };
  }
  if (result.status in EXIT_CODES_BY_STATUS) {
    return {
      exitCode: EXIT_CODES_BY_STATUS[result.status],
      state: result.status,
      stopAfter: true,
      controlIssue: Number(controlIssue),
      repo: resolvedRepo,
      executionIssue: result.executionIssue,
      ...(result.route !== undefined ? { route: result.route } : {}),
    };
  }

  return {
    exitCode: 0,
    state: "READY_TO_DISPATCH",
    stopAfter: true,
    controlIssue: Number(controlIssue),
    repo: resolvedRepo,
    executionIssue: result.executionIssue,
    route: result.route,
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
  const result = await checkReadyDispatch({ repo: args.repo, controlIssue: args["control-issue"] });
  if (result.exitCode === 1) {
    console.error(result.message);
    process.exit(1);
    return;
  }
  console.log(JSON.stringify(result));
  process.exit(result.exitCode);
}

if (process.argv[1] && process.argv[1].endsWith("ready-dispatch-gate.mjs")) {
  main();
}
