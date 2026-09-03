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
// It performs exactly ONE read — `gh issue view <control-issue>` — and nothing else: no
// execution-Issue read, no PR query, no comment fetch. That is deliberate, not an
// oversight: bundling a second read into the same investigative step is exactly how both
// prior regressions happened, so the gate itself must be structurally incapable of
// reconnaissance. AGENTS.md's corrected Session execution text requires this script to be
// the orchestrating session's first tool call for a dispatched control-plane Issue,
// followed immediately by acting on its verdict — never a second freeform
// `gh issue view` on the same Issue number first.
//
// Parses the "- **Label:**" bullet convention real thin control Issues #311/#322 use in
// practice (see docs/operating-model.md § Parent snapshots):
//   - **Lifecycle:** READY
//   - **Execution:** #123
//   - **Route:** implementation worker
//   - **Blocker:** none
//   - **Founder decision:** none — <optional trailing explanation>
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
//   READY_TO_DISPATCH — every gate field satisfied. exit 0. Result carries
//     { controlIssue, executionIssue, route } — the exact reference-only triple to hand
//     the dispatched worker; nothing else belongs in that prompt (AGENTS.md § Subagent
//     dispatch).
//   NOT_READY — the control Issue does not currently satisfy the gate (wrong lifecycle
//     state, a blocker, a pending founder decision, a missing/malformed/multi-valued
//     field). exit 3. Falls through to normal Decomposition-boundary / Direct-inspection
//     reasoning — this script has no opinion on what to do next, only on whether the
//     immediate-dispatch shortcut applies.
//   ERROR — the control Issue could not be read, or --control-issue was missing/invalid.
//     exit 1.
//
// Usage:
//   node tools/orchestration/ready-dispatch-gate.mjs --repo OWNER/REPO --control-issue 322
//
// Tests: node --test tools/orchestration/ready-dispatch-gate.test.mjs

import { execFileSync } from "node:child_process";

const KNOWN_LIFECYCLE_STATES = ["READY", "EXECUTING", "VERIFYING", "REVIEW", "AUDIT", "CORRECTION", "BLOCKED"];

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

// Pure. Extracts the single execution-Issue number a control Issue's "Execution" bullet
// points at. Returns { ok: true, issue } for exactly one distinct "#N" reference, or
// { ok: false, reason } for zero or more than one — a control Issue naming more than one
// execution pointer is not "one current execution pointer" (AGENTS.md's immediate-dispatch
// gate requirement) and must not be treated as dispatch-ready.
export function parseExecutionPointer(value) {
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, reason: "Execution field is missing or empty" };
  }
  const refs = [...new Set([...value.matchAll(/#(\d+)/g)].map((m) => Number(m[1])))];
  if (refs.length === 0) return { ok: false, reason: `Execution field "${value}" names no #N issue reference` };
  if (refs.length > 1) {
    return { ok: false, reason: `Execution field names more than one execution pointer (${refs.map((n) => `#${n}`).join(", ")}), not "one current execution pointer"` };
  }
  return { ok: true, issue: refs[0] };
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
  const lifecycleRaw = parseControlBullet(body, "Lifecycle") ?? parseHeadingField(body, "State");
  const executionRaw = parseControlBullet(body, "Execution") ?? extractActiveExecutionRef(parseHeadingBlock(body, "Minimum authority"));
  const routeRaw = parseControlBullet(body, "Route");
  const blockerRaw = parseControlBullet(body, "Blocker") ?? parseHeadingField(body, "Current blocker");
  const founderDecisionRaw = parseControlBullet(body, "Founder decision") ?? parseHeadingField(body, "Founder interrupt");

  const reasons = [];

  if (lifecycleRaw === null) {
    reasons.push('no "- **Lifecycle:**" bullet or "### State" heading found in the control Issue body');
  } else if (lifecycleRaw.toUpperCase() !== "READY") {
    reasons.push(
      `lifecycle is "${lifecycleRaw}", not READY` +
        (KNOWN_LIFECYCLE_STATES.includes(lifecycleRaw.toUpperCase())
          ? " — this control Issue is already mid-cycle and should continue its own current step, not receive a fresh immediate dispatch"
          : ""),
    );
  }

  const execution = parseExecutionPointer(executionRaw);
  if (!execution.ok) {
    reasons.push(execution.reason);
  } else if (controlIssueNumber != null && execution.issue === Number(controlIssueNumber)) {
    reasons.push(
      `Execution field points back at the control Issue itself (#${execution.issue}) — a control Issue is never its own execution Issue`,
    );
  }

  if (routeRaw === null || routeRaw === "" || isNoneSentinel(routeRaw)) {
    reasons.push(`Route is not settled (found: ${JSON.stringify(routeRaw)})`);
  }

  if (blockerRaw === null) {
    reasons.push('no "- **Blocker:**" bullet or "### Current blocker" heading found in the control Issue body');
  } else if (!isNoneSentinel(blockerRaw)) {
    reasons.push(`Blocker is not "none" (found: "${blockerRaw}")`);
  }

  if (founderDecisionRaw === null) {
    reasons.push('no "- **Founder decision:**" bullet or "### Founder interrupt" heading found in the control Issue body');
  } else if (!isNoneSentinel(founderDecisionRaw)) {
    reasons.push(`Founder decision is not "none" (found: "${founderDecisionRaw}")`);
  }

  if (reasons.length > 0) {
    return { status: "NOT_READY", reasons };
  }

  return {
    status: "READY_TO_DISPATCH",
    executionIssue: execution.issue,
    route: routeRaw,
  };
}

function defaultGhIssueView({ repo, number }) {
  const raw = execFileSync("gh", ["issue", "view", String(number), "--repo", repo, "--json", "body,state"], {
    encoding: "utf8",
  });
  return JSON.parse(raw);
}

// `ghIssueViewImpl` is injected so tests can drive this end-to-end without touching the
// real network or `gh` CLI. This function makes exactly one read of the control Issue —
// no execution-Issue read, no PR query — by construction: there is no code path here that
// could reach for anything else.
export async function checkReadyDispatch({ repo, controlIssue }, { ghIssueViewImpl = defaultGhIssueView } = {}) {
  if (!repo || !controlIssue) {
    return { exitCode: 1, message: "Missing required args: --repo and --control-issue are both required." };
  }

  let data;
  try {
    data = await ghIssueViewImpl({ repo, number: controlIssue });
  } catch (err) {
    return { exitCode: 1, message: `gh issue view failed for ${repo}#${controlIssue}: ${err.message}` };
  }

  if (data.state !== "OPEN") {
    return {
      exitCode: 3,
      state: "NOT_READY",
      controlIssue: Number(controlIssue),
      reasons: [`control Issue ${repo}#${controlIssue} is ${data.state}, not OPEN`],
    };
  }

  const result = evaluateReadyDispatchGate(data.body ?? "", controlIssue);
  if (result.status === "NOT_READY") {
    return { exitCode: 3, state: "NOT_READY", controlIssue: Number(controlIssue), reasons: result.reasons };
  }

  return {
    exitCode: 0,
    state: "READY_TO_DISPATCH",
    controlIssue: Number(controlIssue),
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
