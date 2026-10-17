#!/usr/bin/env node
// Single-Issue conversion coordinator: one founder-authorized, eligible existing Issue becomes a
// verified thin-control / thick-execution pair through ONE documented operation -- issue #1244
// (control #1211, campaign #1155). First-user path: docs/convert-issue-pair.md.
//
// Invocation choice (recorded per #1244 layer 1): a CLI under tools/orchestration/, because every
// canonical writer and gate this composes (write-control-snapshot, activate-control-pair,
// session-entry-gate via control-plane-bootstrap, write-thick-grant) is already a CLI there and
// the repository has no other user-facing LDL entry surface that is lighter. No new state store,
// service, lifecycle engine, or batch/recursive creation: this file only sequences existing pieces.
//
// What it does, in order, failing closed at the first unproven step:
//   1. Pre-mutation checks on the live repository: the source Issue is the exact named, explicitly
//      authorized, OPEN Issue (not a PR); its class (an unbound intake/legacy body, or an already
//      bound pair for idempotent re-entry); no PR/review/audit linkage and no in-flight lifecycle;
//      every existing child / current-or-historical execution pointer is classified.
//   2. Creates EXACTLY ONE thick execution Issue (work-packet shape, exact `### Parent loop`, a
//      provenance marker used for re-entry) and reads it back.
//   3. Binds the sole `Execution: #<thick>` pointer on the ORIGINAL Issue (its number is the thin
//      control; its original body is preserved verbatim under `### Source item`) ONLY through
//      checkWriteControlSnapshot (the canonical writer), then independently reads both back.
//   4. Unless --bind-only: activates ONLY through activate-control-pair.mjs and its fresh
//      session-entry gate. It reports a verified `work on #<original>` or the precise outstanding
//      grant/writer/gate blocker; it never infers a grant and never reports READY without the gate.
//
// Replay is idempotent: an already-bound pair re-verifies and (re)activates without writing twice;
// an interrupted run (thick created, control unbound) recovers only a uniquely attributable
// child (provenance marker + exact Parent loop); anything ambiguous (several/similar children,
// duplicate current packet, wrong parent/repo, stale source) fails closed with an exact diagnosis.
// A pair whose control has `Execution: none` is never reported as converted.
//
// An in-flight (PR / Stage 1 / Stage 2 / audit-linked / mid-cycle lifecycle) or completed
// (CLOSED / DONE) source is refused as unsupported and left unchanged.
//
// Usage:
//   node tools/orchestration/convert-issue-pair.mjs --source-issue N --founder-authorized
//        [--proposed-grant-file grant.json] [--route "implementation worker"] [--bind-only] [--dry-run]
//   --founder-authorized  asserts the founder explicitly named THIS Issue for conversion (#555);
//                         neither a label, an Issue's existence, nor a comment authorizes creation.
//   --proposed-grant-file optional {"executorSubstrate":[...]} recorded ONLY as a PROPOSED section;
//                         conversion then reports a truthful pending-grant state (never ACTIVE).
//
// Exit codes: 0 converted (executable or truthfully pending/bound/dry-run); 1 operational failure
// or partial state (named in the report); 2 refused (source/children unchanged).
//
// Tests: node --test tools/orchestration/convert-issue-pair.test.mjs

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { readGithubIssue } from "./github-read.mjs";
import {
  resolveRepoIdentity,
  parseControlBullet,
  parseHeadingField,
  isNoneSentinel,
  readExecutionBulletField,
  parseExecutionPointer,
  extractBoldBulletLabels,
  isAuditShapedBody,
  defaultGhPrList,
} from "./ready-dispatch-gate.mjs";
import { validateControlSnapshot } from "./control-field-validator.mjs";
import { checkWriteControlSnapshot } from "./write-control-snapshot.mjs";
import { activateControlPair, controlAdvertisesPendingState, parentLoopIdentifiesControl } from "./activate-control-pair.mjs";
import { parseAuthority } from "./executor-substrate-authority.mjs";
import { isKnownAttributionDecoration } from "../review-watch/lifecycle-gate.mjs";

const DEFAULT_ROUTE = "implementation worker";
const MID_CYCLE_OR_TERMINAL = new Set(["EXECUTING", "VERIFYING", "REVIEW", "AUDIT", "CORRECTION", "EXECUTION_COMPLETE", "ROUTED", "DONE", "DECOMPOSED"]);
const RESERVED_BULLETS = ["execution", "execution issue", "route", "lifecycle", "pr", "stage 1", "stage 2", "blocker", "founder decision"];
const CONTROL_HEADINGS = ["State", "Current state", "Current blocker", "Founder interrupt"];
const PACKET_HEADINGS = ["Parent loop", "Observable outcome"];
const FENCE = "```";

const norm = (s) => String(s ?? "").replace(/\r\n/g, "\n").trimEnd();
const refuse = (state, message, extra = {}) => ({ exitCode: 2, state, executable: false, message, ...extra });
const failure = (state, message, extra = {}) => ({ exitCode: 1, state, executable: false, message, ...extra });

export function markerFor(repo, sourceIssue) {
  return `<!-- ldl:convert-issue-pair source=${String(repo).toLowerCase()}#${sourceIssue} -->`;
}

// ---------------------------------------------------------------------------------------------
// Pure parsing / classification
// ---------------------------------------------------------------------------------------------

// Pure. Splits a body into `### Heading` sections (text before the first heading is "").
export function splitSections(body) {
  const lines = String(body ?? "").replace(/\r\n/g, "\n").split("\n");
  const sections = new Map();
  let current = "";
  let buf = [];
  const flush = () => {
    if (current !== "" || buf.some((l) => l.trim() !== "")) sections.set(current, buf.join("\n").trim());
  };
  for (const line of lines) {
    const m = line.match(/^###\s+(.+?)\s*$/);
    if (m) {
      flush();
      current = m[1];
      buf = [];
    } else buf.push(line);
  }
  flush();
  return sections;
}

const sectionByName = (sections, name) => {
  for (const [k, v] of sections) if (k.toLowerCase() === name.toLowerCase()) return v;
  return null;
};

// Pure. Classifies the source Issue body.
//   INTAKE        -- unbound idea-intake / legacy body with no control or packet fields: convertible.
//   BOUND         -- control-shaped with exactly one parseable Execution pointer (idempotent re-entry).
//   IN_FLIGHT     -- control-shaped and showing PR / Stage 1 / Stage 2 / mid-cycle or terminal lifecycle.
//   NOT_INTAKE    -- an execution packet, an unbound control-shaped body, an ambiguous pointer, or empty.
export function classifySourceBody(body) {
  const text = String(body ?? "");
  if (text.trim() === "") return { kind: "NOT_INTAKE", reason: "source Issue body is empty; there is nothing to translate faithfully" };
  const sections = splitSections(text);
  const packetHeadings = PACKET_HEADINGS.filter((h) => sectionByName(sections, h) !== null);
  if (packetHeadings.length > 0) {
    return { kind: "NOT_INTAKE", reason: `source Issue already carries execution-packet heading(s) ${packetHeadings.map((h) => JSON.stringify(h)).join(", ")}; it is a thick packet, not an intake` };
  }
  const labels = extractBoldBulletLabels(text).map((l) => String(l.label).toLowerCase());
  const reservedBullets = RESERVED_BULLETS.filter((l) => labels.includes(l));
  const controlHeadings = CONTROL_HEADINGS.filter((h) => sectionByName(sections, h) !== null);
  if (reservedBullets.length === 0 && controlHeadings.length === 0) return { kind: "INTAKE" };

  const lifecycle = parseControlBullet(text, "Lifecycle") ?? parseHeadingField(text, "State");
  const live = [];
  for (const label of ["PR", "Stage 1", "Stage 2"]) {
    const v = parseControlBullet(text, label);
    if (v !== null && !isNoneSentinel(v)) live.push(`${label}: ${v}`);
  }
  const lifecycleWord = lifecycle ? lifecycle.trim().split(/[\s—-]/)[0].toUpperCase() : null;
  if (lifecycleWord && MID_CYCLE_OR_TERMINAL.has(lifecycleWord)) live.push(`lifecycle ${lifecycleWord}`);
  if (live.length > 0) return { kind: "IN_FLIGHT", reason: `control-shaped source shows in-flight or completed state (${live.join("; ")})` };

  const field = readExecutionBulletField(text);
  if (field.conflict) return { kind: "NOT_INTAKE", reason: "source Execution pointer is ambiguous or has a near-duplicate label" };
  if (field.value === null || field.value === undefined || isNoneSentinel(field.value)) {
    return { kind: "NOT_INTAKE", reason: "source is an existing thin control with no current Execution packet (`Execution: none`); it is not an intake and is never reported as converted" };
  }
  const pointer = parseExecutionPointer(field.value);
  if (!pointer.ok) return { kind: "NOT_INTAKE", reason: `source Execution pointer is not a single current packet: ${pointer.reason}` };
  return { kind: "BOUND", executionIssue: pointer.issue };
}

// Pure. Every Issue reference of a thick body's `### Parent loop` section, repo-aware.
export function parentLoopRefs(body, repo) {
  const sections = splitSections(body);
  const section = sectionByName(sections, "Parent loop");
  if (section === null) return null;
  const refs = [];
  const consumed = [];
  for (const m of section.matchAll(/https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/gi)) {
    refs.push({ repo: m[1].toLowerCase(), number: Number(m[2]) });
    consumed.push(m[0]);
  }
  let rest = section;
  for (const c of consumed) rest = rest.replace(c, " ");
  for (const m of rest.matchAll(/(?<![\w/])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g)) {
    refs.push({ repo: (m[1] ?? repo).toLowerCase(), number: Number(m[2]) });
  }
  return refs;
}

const parentIs = (body, repo, number) => {
  const refs = parentLoopRefs(body, repo);
  return refs !== null && refs.length === 1 && refs[0].number === Number(number) && refs[0].repo === String(repo).toLowerCase();
};

// Pure. Classifies the repository's other Issues relative to the source. `issues` rows are
// { number, title, body, state } with PRs already excluded.
//   attributable -- OPEN, exact Parent loop, this source's provenance marker: the uniquely
//                   recoverable child.
//   conflicts    -- anything else that touches the source: unmarked/closed/other-state children whose
//                   Parent loop names the source, a marker for this source with a different parent,
//                   an identically titled Issue, or an audit-shaped Issue naming the source.
export function classifyChildren(issues, { repo, sourceIssue, expectedTitle, boundExecution = null }) {
  const marker = markerFor(repo, sourceIssue).toLowerCase();
  const attributable = [];
  const conflicts = [];
  for (const issue of issues) {
    if (Number(issue.number) === Number(sourceIssue)) continue;
    const body = String(issue.body ?? "");
    const exactParent = parentIs(body, repo, sourceIssue);
    const refs = parentLoopRefs(body, repo);
    const namesSource = refs !== null && refs.some((r) => r.number === Number(sourceIssue) && r.repo === String(repo).toLowerCase());
    const marked = body.toLowerCase().includes(marker);
    const sameTitle = expectedTitle && String(issue.title ?? "").trim().toLowerCase() === expectedTitle.toLowerCase();
    const auditNamesSource = isAuditShapedBody(body) && new RegExp(`(?<![\\w/])#${sourceIssue}\\b`).test(body);
    const open = String(issue.state ?? "").toUpperCase() === "OPEN";
    if (boundExecution !== null && Number(issue.number) === Number(boundExecution)) continue;
    if (exactParent && marked && open) attributable.push(issue.number);
    else if (namesSource || marked || sameTitle || auditNamesSource) {
      const why = [];
      if (exactParent) why.push("exact Parent loop");
      else if (namesSource) why.push("Parent loop names the source with other references");
      if (marked) why.push("provenance marker");
      if (sameTitle) why.push("identical title");
      if (auditNamesSource) why.push("audit-shaped, names the source");
      if (!open) why.push("not OPEN");
      if (marked && !exactParent) why.push("marker with a different parent");
      if (exactParent && !marked) why.push("no provenance marker");
      conflicts.push({ number: issue.number, why: why.join(", ") });
    }
  }
  return { attributable, conflicts };
}

// Pure. Source priority label / horizon -> "Now"/"Soon"/"Later"/"Wishes" or null.
export function derivePriority({ labels = [], sections }) {
  const fromLabel = labels.map((l) => String(l).match(/^priority:(now|soon|later|wishes)$/i)).find(Boolean);
  if (fromLabel) return fromLabel[1][0].toUpperCase() + fromLabel[1].slice(1).toLowerCase();
  const horizon = sectionByName(sections, "Priority horizon");
  const m = horizon && horizon.trim().match(/^(now|soon|later|wishes)\b/i);
  return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : null;
}

const stripIdeaPrefix = (title) => String(title ?? "").replace(/^\s*\[(?:idea|loop|slice)\]\s*/i, "").trim();

export function expectedThickTitle(sourceTitle) {
  return `[Slice] ${stripIdeaPrefix(sourceTitle)}`;
}

function firstParagraph(text, limit = 1200) {
  const quote = text.split("\n").find((l) => /^>\s*\S/.test(l));
  const base = quote ? quote.replace(/^>\s*/, "") : (text.split(/\n\s*\n/).find((p) => p.trim() !== "") ?? "").trim();
  return base.length > limit ? `${base.slice(0, limit - 1).trimEnd()}…` : base;
}

// Pure. Validates and renders an optional proposed grant record.
export function renderProposedGrant(record) {
  if (record === null || record === undefined) return { ok: true, section: "" };
  const { grants, problems } = parseAuthority(record);
  if (problems.length > 0 || grants.size === 0) {
    return { ok: false, reason: `proposed grant record is invalid: ${problems.join("; ") || "no grants"}` };
  }
  const components = [...grants.keys()];
  const json = JSON.stringify(record, null, 2);
  return {
    ok: true,
    components,
    section:
      `### PROPOSED executor-substrate grant — not in force until the founder approves it and write-thick-grant.mjs promotes it\n\n` +
      `${FENCE}json\n${json}\n${FENCE}\n\n`,
  };
}

// Pure. The thick execution Issue body (work-packet shape) translated from the source sections.
export function composeThickBody({ repo, sourceIssue, sourceTitle, sourceBody, grantSection = "" }) {
  const sections = splitSections(sourceBody);
  const idea = sectionByName(sections, "What do you want added or changed?");
  const why = sectionByName(sections, "Why does it matter?");
  const evidence = sectionByName(sections, "Evidence or example");
  const outcome = idea ?? String(sourceBody ?? "").trim();
  const ctx = [
    `- Source Issue #${sourceIssue} is the sole governing thin control; its original body is preserved there verbatim under \`### Source item\`. This packet is a faithful translation, not a new decision.`,
    "- Reuse the repository's existing writers, gates and validators named in the Observable outcome; do not duplicate them.",
  ];
  if (why) ctx.push("", "**Why it matters (from the source):**", "", why);
  if (evidence) ctx.push("", "**Evidence or example (from the source):**", "", evidence);
  return (
    `### Parent loop\n\n#${sourceIssue}\n\n` +
    `### Observable outcome\n\n${outcome}\n\n` +
    `### Minimum required context\n\n${ctx.join("\n")}\n\n` +
    `### Required layers and activities\n\n` +
    `Every code, test, documentation and configuration layer needed to deliver the Observable outcome and satisfy its stated acceptance, exactly as the source Issue states them. The source Issue's own scope and safety text (reproduced under Observable outcome) is binding; no layer or decision beyond it is implied by this conversion.\n\n` +
    `### Non-goals\n\nNone added by the conversion. Whatever scope, safety and boundary text the source Issue states under Observable outcome is the binding non-goal set; do not expand scope.\n\n` +
    `### Integrated acceptance criteria\n\nThe acceptance and verification criteria stated in the source text under Observable outcome. If the source states none, the stated minimum useful success demonstrated end to end.\n\n` +
    `### Required checks\n\nThe checks the source Issue names, plus the repository's standard verification for every touched component.\n\n` +
    `### Interrupt conditions\n\nAGENTS.md founder interrupt conditions only. An ambiguity in what the source Issue authorizes is a fail-closed stop, not a technical choice for the worker.\n\n` +
    `### Session stopping condition\n\nThe slice is complete only when its outcome is integrated and verified, or an interrupt condition blocks it. For review-worthy work, stop with the PR opened, Stage 1 requested and the durable PR breakpoint recorded by the canonical finalizer.\n\n` +
    `### Durable completion handoff\n\nSTATUS, OUTCOME, CHANGED, VERIFIED, DECISIONS, NEW RISKS, NEXT, PR (1,000-1,500 tokens) on the PR and the control.\n\n` +
    (grantSection ? grantSection : "") +
    `### Execution gate and current disposition\n\n` +
    `Created from source Issue #${sourceIssue} by convert-issue-pair.mjs. Dispatchable only when the control's fresh session-entry gate returns READY_TO_DISPATCH for this Issue. No executor-substrate grant is in force unless a section headed \`ACTIVE\` above says so.\n\n` +
    `${markerFor(repo, sourceIssue)}\n`
  );
}

// Pure. The thin-control body: the ORIGINAL body is preserved verbatim, then the parser-sensitive
// control fields. State is PROPOSED (or NEEDS_FOUNDER with one grant statement); READY is written
// only by activate-control-pair.mjs after its proof and a fresh gate.
export function composeControlBody({ sourceIssue, sourceTitle, sourceBody, executionIssue, route = DEFAULT_ROUTE, priority = null, pendingGrantComponents = null }) {
  const sections = splitSections(sourceBody);
  const idea = sectionByName(sections, "What do you want added or changed?") ?? String(sourceBody ?? "");
  const outcome = firstParagraph(idea) || stripIdeaPrefix(sourceTitle);
  const pending = Array.isArray(pendingGrantComponents) && pendingGrantComponents.length > 0;
  const decision = pending
    ? `Approve or decline the exact executor-substrate component grant proposed on the bound thick packet (${pendingGrantComponents.join(", ")}); no grant is inferred from an Issue, label or comment.`
    : "none";
  return (
    `### Source item\n\n` +
    `This Issue is the founder-facing thin control for the outcome originally filed as "${stripIdeaPrefix(sourceTitle)}". The original text is preserved below verbatim; the governing contract is now this snapshot plus the sole thick packet #${executionIssue}.\n\n` +
    `<details><summary>Original body (verbatim)</summary>\n\n${String(sourceBody ?? "").replace(/\s+$/, "")}\n\n</details>\n\n` +
    `### State\n\n${pending ? "NEEDS_FOUNDER" : "PROPOSED"}\n\n` +
    `### Accepted outcome\n\n${outcome}\n\n` +
    `### Current state\n\n` +
    `- **Execution:** #${executionIssue}\n` +
    `- **Route:** ${route}\n` +
    `- **PR:** none\n` +
    `- **Stage 2:** none\n` +
    `- **Founder decision:** ${decision}\n` +
    (priority ? `- **Priority:** ${priority}\n` : "") +
    `- **Activation status:** Created by convert-issue-pair.mjs. Executable only after activate-control-pair.mjs binds and reads back the pair and a fresh session-entry gate returns READY_TO_DISPATCH.\n\n` +
    `### Settled decisions\n\n- Converted without adding decisions: the source text above is the authority for what is wanted.\n\n` +
    `### Scope and non-goals\n\nAs stated in the source text above and the sole thick packet #${executionIssue}.\n\n` +
    `### Minimum authority\n\nThick execution packet #${executionIssue}; the source text above.\n\n` +
    `### Completed packets\n\nNone.\n\n` +
    `### Current blocker\n\nNone\n\n` +
    `### Founder interrupt\n\n${decision === "none" ? "None" : decision}\n\n` +
    `### Next slice / resulting slices\n\nExactly one thick packet: #${executionIssue}.\n`
  );
}

// ---------------------------------------------------------------------------------------------
// Default I/O (all injectable)
// ---------------------------------------------------------------------------------------------

function ghJson(args, { input, execFileImpl = execFileSync } = {}) {
  const raw = execFileImpl("gh", args, { encoding: "utf8", maxBuffer: 50 * 1024 * 1024, ...(input !== undefined ? { input } : {}) });
  return JSON.parse(raw);
}

export function defaultReadSource({ repo, number, execFileImpl }) {
  const res = ghJson(["api", `repos/${repo}/issues/${number}`], { execFileImpl });
  if (Number(res.number) !== Number(number)) throw new Error(`REST response identifies #${res.number}, expected #${number}`);
  return {
    number: Number(res.number),
    title: String(res.title ?? ""),
    body: String(res.body ?? ""),
    state: String(res.state ?? "").toUpperCase(),
    labels: (res.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
    isPr: Boolean(res.pull_request),
  };
}

export function defaultListAllIssues({ repo, execFileImpl }) {
  const out = [];
  for (let page = 1; ; page++) {
    const rows = ghJson(["api", `repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=100&page=${page}`], { execFileImpl });
    if (!Array.isArray(rows)) throw new Error("Issue listing is not a JSON array");
    for (const row of rows) {
      if (!row.pull_request) out.push({ number: Number(row.number), title: String(row.title ?? ""), body: String(row.body ?? ""), state: String(row.state ?? "").toUpperCase() });
    }
    if (rows.length < 100) break;
  }
  return out;
}

export function defaultCreateIssue({ repo, title, body, execFileImpl }) {
  const res = ghJson(["api", "-X", "POST", `repos/${repo}/issues`, "--input", "-"], { input: JSON.stringify({ title, body }), execFileImpl });
  if (!res || typeof res !== "object" || res.pull_request) throw new Error("create response is not an Issue");
  const n = Number(res.number);
  if (!Number.isInteger(n) || n <= 0) throw new Error("create response carries no Issue number");
  if (!String(res.html_url ?? "").toLowerCase().endsWith(`/${repo}/issues/${n}`.toLowerCase())) {
    throw new Error(`create response identity does not match ${repo}`);
  }
  return { number: n };
}

const defaultListLinkedPrs = ({ repo, issue }) => defaultGhPrList({ repo, executionIssue: issue });

// ---------------------------------------------------------------------------------------------
// Coordinator (all I/O injected)
// ---------------------------------------------------------------------------------------------

export function convertIssuePair(
  { repo, sourceIssue, founderAuthorized = false, proposedGrant = null, route = DEFAULT_ROUTE, bindOnly = false, dryRun = false },
  deps = {},
) {
  const {
    readSource = (a) => defaultReadSource(a),
    listIssues = (a) => defaultListAllIssues(a),
    listLinkedPrs = defaultListLinkedPrs,
    createIssue = (a) => defaultCreateIssue(a),
    readIssue = readGithubIssue,
    writeSnapshot = checkWriteControlSnapshot,
    activate = activateControlPair,
    activateDeps = {},
  } = deps;

  const n = Number(sourceIssue);
  const steps = [];
  if (!repo) return failure("NO_REPO", "Could not determine the repository identity.");
  if (!Number.isInteger(n) || n <= 0) return refuse("BAD_SOURCE", "--source-issue must be one exact Issue number.");
  if (!founderAuthorized) {
    return refuse(
      "NOT_AUTHORIZED",
      `Refusing to convert ${repo}#${n}: conversion needs the founder to have explicitly named THIS Issue (pass --founder-authorized). A label, the Issue's existence, a comment or a model-generated proposal never authorizes creating an Issue; nothing was created or changed.`,
    );
  }

  let grantRender = { ok: true, section: "" };
  if (proposedGrant !== null) {
    grantRender = renderProposedGrant(proposedGrant);
    if (!grantRender.ok) return refuse("BAD_GRANT_PROPOSAL", `${grantRender.reason}; nothing was created or changed.`);
  }

  // ---- 1. pre-mutation checks ------------------------------------------------------------
  let source;
  try {
    source = readSource({ repo, number: n });
  } catch (err) {
    return failure("READ_FAILED", `read of ${repo}#${n} failed: ${err.message}; nothing was created or changed.`);
  }
  if (source.isPr) return refuse("NOT_AN_ISSUE", `${repo}#${n} is a pull request, not an Issue; nothing was created or changed.`);
  if (source.state !== "OPEN") {
    return refuse("UNSUPPORTED_COMPLETED", `${repo}#${n} is ${source.state}; a completed Issue is not converted. Left unchanged.`);
  }
  const cls = classifySourceBody(source.body);
  if (cls.kind === "IN_FLIGHT") return refuse("UNSUPPORTED_IN_FLIGHT", `${cls.reason}. Unsupported; ${repo}#${n} left unchanged.`);
  if (cls.kind === "NOT_INTAKE") return refuse("UNSUPPORTED_CLASS", `${cls.reason}. Unsupported; ${repo}#${n} left unchanged.`);

  let issues;
  try {
    issues = listIssues({ repo });
  } catch (err) {
    return failure("READ_FAILED", `listing ${repo} Issues failed: ${err.message}; nothing was created or changed.`);
  }
  const expectedTitle = expectedThickTitle(source.title);
  const children = classifyChildren(issues, { repo, sourceIssue: n, expectedTitle, boundExecution: cls.kind === "BOUND" ? cls.executionIssue : null });

  let linkedPrs;
  try {
    linkedPrs = listLinkedPrs({ repo, issue: n });
    if (cls.kind === "BOUND") linkedPrs = [...linkedPrs, ...listLinkedPrs({ repo, issue: cls.executionIssue })];
  } catch (err) {
    return failure("READ_FAILED", `PR linkage check for ${repo}#${n} failed: ${err.message}; nothing was created or changed.`);
  }
  if (linkedPrs.length > 0) {
    return refuse(
      "UNSUPPORTED_IN_FLIGHT",
      `${repo}#${n} (or its packet) is linked to PR ${linkedPrs.map((p) => "#" + p.number).join(", ")}; in-flight or completed review work is unsupported. Left unchanged.`,
    );
  }
  steps.push("pre-mutation checks passed");

  let executionIssue;
  let created = false;
  let recovered = false;

  if (cls.kind === "BOUND") {
    executionIssue = cls.executionIssue;
    if (children.conflicts.length > 0 || children.attributable.length > 0) {
      const all = [...children.conflicts, ...children.attributable.map((x) => ({ number: x, why: "second current packet" }))];
      return refuse("AMBIGUOUS_CHILDREN", `${repo}#${n} is bound to #${executionIssue} but other Issue(s) also claim it as parent: ${all.map((c) => `#${c.number} (${c.why})`).join("; ")}. Duplicate/ambiguous current packet; nothing was changed.`);
    }
    let thick;
    try {
      thick = readIssue({ repo, number: executionIssue, fields: ["body", "state"] });
    } catch (err) {
      return failure("READ_FAILED", `read of bound packet ${repo}#${executionIssue} failed: ${err.message}; nothing was changed.`);
    }
    if (thick.state !== "OPEN") return refuse("UNSUPPORTED_COMPLETED", `bound packet ${repo}#${executionIssue} is ${thick.state}; completed packets are unsupported. Left unchanged.`);
    if (!parentIs(thick.body, repo, n)) {
      return refuse("WRONG_PARENT", `bound packet ${repo}#${executionIssue} does not name exactly ${repo}#${n} as its Parent loop; nothing was changed.`);
    }
    const valid = validateControlSnapshot(source.body, { controlIssue: n });
    if (!valid.ok) return refuse("UNSUPPORTED_CLASS", `bound control ${repo}#${n} fails snapshot validation: ${valid.errors.join("; ")}. Left unchanged.`);
    steps.push(`already bound to #${executionIssue}; re-verified`);
  } else {
    if (children.conflicts.length > 0 || children.attributable.length > 1) {
      const all = [...children.conflicts, ...children.attributable.map((x) => ({ number: x, why: "attributable duplicate" }))];
      return refuse("AMBIGUOUS_CHILDREN", `Cannot attribute a unique child of ${repo}#${n}: ${all.map((c) => `#${c.number} (${c.why})`).join("; ")}. Failing closed; nothing was created or changed.`);
    }
    if (children.attributable.length === 1) {
      executionIssue = children.attributable[0];
      recovered = true;
      steps.push(`recovered uniquely attributable child #${executionIssue} (provenance marker + exact Parent loop)`);
    }
  }

  const thickBody = composeThickBody({ repo, sourceIssue: n, sourceTitle: source.title, sourceBody: source.body, grantSection: grantRender.section });

  if (dryRun) {
    return {
      exitCode: 0,
      state: "DRY_RUN",
      executable: false,
      sourceIssue: n,
      executionIssue: executionIssue ?? null,
      plan: executionIssue
        ? `would reuse existing packet #${executionIssue} (${cls.kind === "BOUND" ? "already bound" : "recovered"}) and continue`
        : `would create exactly one thick Issue titled ${JSON.stringify(expectedTitle)} and bind it to ${repo}#${n}`,
      thickBody,
      message: "Dry run: nothing was created or changed.",
      steps,
    };
  }

  // ---- 2. create the single thick Issue ----------------------------------------------------
  if (executionIssue === undefined) {
    try {
      executionIssue = createIssue({ repo, title: expectedTitle, body: thickBody }).number;
      created = true;
    } catch (err) {
      return failure(
        "CREATE_FAILED",
        `creating the thick Issue failed: ${err.message}. It may or may not exist; re-run the same command (idempotent: a uniquely attributable child is recovered, otherwise it fails closed). ${repo}#${n} was not changed.`,
      );
    }
    steps.push(`created thick Issue #${executionIssue}`);
  }

  // ---- 3. independent readback of the thick Issue ---------------------------------------------
  let thickBack;
  try {
    thickBack = readIssue({ repo, number: executionIssue, fields: ["body", "state"] });
  } catch (err) {
    return failure("PARTIAL_THICK_CREATED", `thick Issue #${executionIssue} exists but its readback failed: ${err.message}. ${repo}#${n} is unbound; re-run the same command to recover.`, { sourceIssue: n, executionIssue });
  }
  const thickOk = thickBack.state === "OPEN" && parentIs(thickBack.body, repo, n) && thickBack.body.toLowerCase().includes(markerFor(repo, n).toLowerCase()) && (cls.kind === "BOUND" || !created || norm(thickBack.body) === norm(thickBody) || isKnownAttributionDecoration(thickBody, thickBack.body));
  if (cls.kind !== "BOUND" && !thickOk) {
    return failure("PARTIAL_THICK_CREATED", `thick Issue #${executionIssue} did not read back as the exact translated packet (OPEN, exact Parent loop, provenance marker). ${repo}#${n} is unbound; inspect #${executionIssue} before re-running.`, { sourceIssue: n, executionIssue });
  }

  // ---- 4. bind the sole Execution pointer through the canonical writer ------------------------------
  if (cls.kind !== "BOUND") {
    let fresh;
    try {
      fresh = readSource({ repo, number: n });
    } catch (err) {
      return failure("PARTIAL_THICK_CREATED", `thick Issue #${executionIssue} exists but re-reading ${repo}#${n} before binding failed: ${err.message}. Re-run the same command.`, { sourceIssue: n, executionIssue });
    }
    if (fresh.state !== "OPEN" || norm(fresh.body) !== norm(source.body)) {
      return refuse(
        "STALE_SOURCE",
        `${repo}#${n} changed (or closed) after it was read; refusing to overwrite it. Thick Issue #${executionIssue} exists unbound; re-run the same command to recover it against the current source. Nothing was written to ${repo}#${n}.`,
        { sourceIssue: n, executionIssue },
      );
    }
    const proposed = composeControlBody({
      sourceIssue: n,
      sourceTitle: source.title,
      sourceBody: source.body,
      executionIssue,
      route,
      priority: derivePriority({ labels: source.labels, sections: splitSections(source.body) }),
      pendingGrantComponents: grantRender.components ?? null,
    });
    const written = writeSnapshot({ repo, controlIssue: n, proposedBody: proposed });
    if (written.exitCode !== 0) {
      return {
        exitCode: written.exitCode === 2 ? 2 : 1,
        state: "PARTIAL_THICK_CREATED",
        executable: false,
        sourceIssue: n,
        executionIssue,
        message: `thick Issue #${executionIssue} exists but the canonical writer did not bind ${repo}#${n}: ${written.message ?? written.state}. ${repo}#${n} is unbound (Execution is not set); do not treat this as converted.`,
        steps,
      };
    }
    steps.push(`bound Execution: #${executionIssue} on ${repo}#${n} via checkWriteControlSnapshot`);
  }

  // ---- 5. independent readback of BOTH Issues ------------------------------------------------------
  let controlBack;
  let thickFinal;
  try {
    controlBack = readIssue({ repo, number: n, fields: ["body", "state"] });
    thickFinal = readIssue({ repo, number: executionIssue, fields: ["body", "state"] });
  } catch (err) {
    return failure("BIND_READBACK_FAILED", `bound ${repo}#${n} to #${executionIssue} but the independent readback failed: ${err.message}; do not report converted.`, { sourceIssue: n, executionIssue });
  }
  const field = readExecutionBulletField(controlBack.body);
  const ptr = !field.conflict && field.value ? parseExecutionPointer(field.value) : { ok: false };
  const snapshot = validateControlSnapshot(controlBack.body, { controlIssue: n });
  const parent = parentLoopIdentifiesControl(thickFinal.body, n);
  if (controlBack.state !== "OPEN" || thickFinal.state !== "OPEN" || !ptr.ok || ptr.issue !== executionIssue || !snapshot.ok || !parent.ok || !parentIs(thickFinal.body, repo, n)) {
    const why = [
      !ptr.ok || ptr.issue !== executionIssue ? `Execution pointer is ${field.value ?? "absent"}` : null,
      snapshot.ok ? null : snapshot.errors.join("; "),
      parent.ok ? null : parent.reason,
      controlBack.state !== "OPEN" || thickFinal.state !== "OPEN" ? "an Issue is not OPEN" : null,
    ].filter(Boolean).join("; ");
    return failure("BIND_READBACK_MISMATCH", `the persisted pair did not read back as the sole bound packet (${why}); do not report converted.`, { sourceIssue: n, executionIssue });
  }
  steps.push("independent readback of both Issues: sole Execution pointer, exact Parent loop, snapshot valid");

  const base = { sourceIssue: n, executionIssue, created, recovered, steps };

  if (bindOnly) {
    return { exitCode: 0, state: "BOUND_NOT_ACTIVATED", executable: false, ...base, message: `Pair bound (${repo}#${n} -> #${executionIssue}) but not activated (--bind-only).`, nextAction: `node tools/orchestration/activate-control-pair.mjs --control-issue ${n} --execution-issue ${executionIssue}` };
  }

  // ---- 6. activation only through activate-control-pair.mjs + a fresh gate -----------------------------
  const result = activate({ repo, controlIssue: n, executionIssue, route }, activateDeps);
  if (result.exitCode === 0 && (result.state === "ACTIVATED" || result.state === "ALREADY_ACTIVE") && result.gateState === "READY_TO_DISPATCH") {
    steps.push(`activation ${result.state}; fresh session-entry gate: READY_TO_DISPATCH for #${executionIssue}`);
    return { exitCode: 0, state: "CONVERTED_READY", executable: true, ...base, gateState: result.gateState, workOn: `#${n}`, message: `Converted. Run: work on #${n}` };
  }
  let pendingNow = false;
  try {
    pendingNow = controlAdvertisesPendingState(readIssue({ repo, number: n, fields: ["body", "state"] }).body);
  } catch {
    pendingNow = false;
  }
  if (result.exitCode === 2 && result.state === "BLOCKED" && pendingNow) {
    return {
      exitCode: 0,
      state: "CONVERTED_PENDING_GRANT",
      executable: false,
      ...base,
      workOn: null,
      message: `Pair bound (${repo}#${n} -> #${executionIssue}) but NOT executable: ${result.errors?.[0] ?? result.message}`,
      nextAction:
        `Founder: approve or decline the exact grant recorded on #${executionIssue}. On approval, promote it with write-thick-grant.mjs ` +
        `(--control-issue ${n} --execution-issue ${executionIssue} --founder-approval-ref <approval comment URL>), then re-run this same command to activate.`,
    };
  }
  return {
    exitCode: 1,
    state: "CONVERTED_NOT_READY",
    executable: false,
    ...base,
    activationState: result.state ?? null,
    gateState: result.gateState ?? null,
    workOn: null,
    message: `Pair bound (${repo}#${n} -> #${executionIssue}) but not executable: ${result.message ?? JSON.stringify(result.errors ?? result.state)}. Do not report ready.`,
  };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (["founder-authorized", "bind-only", "dry-run"].includes(key)) args[key] = true;
    else args[key] = argv[++i];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const identity = resolveRepoIdentity();
  if (!identity.ok) {
    console.error(`Could not determine the current repository identity: ${identity.reason}`);
    process.exit(1);
    return;
  }
  if (args.repo && String(args.repo).toLowerCase() !== String(identity.repo).toLowerCase()) {
    console.error(`Refusing --repo ${args.repo}: it differs from this checkout's repository ${identity.repo}; run from the target repository's checkout.`);
    process.exit(2);
    return;
  }
  let proposedGrant = null;
  if (args["proposed-grant-file"]) {
    try {
      proposedGrant = JSON.parse(readFileSync(args["proposed-grant-file"], "utf8"));
    } catch (err) {
      console.error(`Could not read --proposed-grant-file "${args["proposed-grant-file"]}": ${err.message}`);
      process.exit(1);
      return;
    }
  }
  const result = convertIssuePair({
    repo: identity.repo,
    sourceIssue: args["source-issue"],
    founderAuthorized: Boolean(args["founder-authorized"]),
    proposedGrant,
    route: args.route ?? DEFAULT_ROUTE,
    bindOnly: Boolean(args["bind-only"]),
    dryRun: Boolean(args["dry-run"]),
  });
  const { exitCode, ...rest } = result;
  (exitCode === 0 ? console.log : console.error)(JSON.stringify(rest, null, 2));
  process.exit(exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
