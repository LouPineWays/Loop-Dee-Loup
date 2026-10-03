// Tests for the issue #868 replacement-audit primitives in tools/review-watch/lifecycle-gate.mjs:
// the "Supersedes audit" provenance field, the replacement composer, the one-replacement
// classification, the superseded-predecessor exclusion in findMatchingOpenAuditIssues, and the
// immediately-consistent REST scan / REST create transports.
//
// Run with:
//   node --test tools/review-watch/audit-replacement.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseSupersedesAuditRef,
  composeReplacementAuditBody,
  composeReplacementAuditTitle,
  classifyAuditReplacements,
  findMatchingOpenAuditIssues,
  hasCanonicalAuditShape,
  checkPreAuditPendingState,
  parseMergeCommitRef,
  parseWorkIssueRef,
  parseVerificationChecklistRef,
  ghRestCreateIssue,
  listIssuesCreatedSince,
} from "./lifecycle-gate.mjs";

const MERGE = "16a01b579e1d146f057cd02c1a122bcf568e2d1f";

function auditBody({ work = 860, merge = MERGE, verdict = "PENDING", supersedes = null } = {}) {
  return [
    ...(supersedes === null ? [] : ["### Supersedes audit", "", supersedes, ""]),
    "### Merged PR", "", "https://github.com/o/r/pull/865", "",
    "### Work issue", "", `#${work}`, "",
    "### Exact merge commit", "", merge, "",
    "### Stage 1 inline review disposition", "", "Single inline round at frozen head `f1b59b5`.", "",
    "### Audit scope", "", "Complete files at the exact merge commit.", "",
    "### Verification checklist", "", "1. First check.", "2. Second check.", "",
    "### Findings", "", "Pending — awaiting Stage 2 audit response.", "",
    "### Verdict", "", verdict, "",
    "### Next authorized action", "", "Pending audit.", "",
  ].join("\n");
}

const issue = (number, body, { state = "OPEN", createdAt = "2026-10-02T10:00:00Z" } = {}) => ({ number, title: `[Audit] ${number}`, body, state, createdAt });

test("parseSupersedesAuditRef: strict bare #N only; absent or any other shape is not a replacement", () => {
  assert.equal(parseSupersedesAuditRef(auditBody({ supersedes: "#866" })), 866);
  assert.equal(parseSupersedesAuditRef(auditBody()), null);
  assert.equal(parseSupersedesAuditRef(auditBody({ supersedes: "866" })), null);
  assert.equal(parseSupersedesAuditRef(auditBody({ supersedes: "#866 and #864" })), null);
  assert.equal(parseSupersedesAuditRef(auditBody({ supersedes: "see https://github.com/o/r/issues/866" })), null);
});

test("composeReplacementAuditBody: preserves every canonical field byte-for-byte, stays pending, adds only the leading provenance section", () => {
  const original = auditBody();
  const replacement = composeReplacementAuditBody(original, 866);
  assert.equal(replacement, `### Supersedes audit\n\n#866\n\n${original}`);
  assert.equal(parseSupersedesAuditRef(replacement), 866);
  assert.ok(hasCanonicalAuditShape(replacement));
  assert.deepEqual(checkPreAuditPendingState(replacement), { ok: true });
  assert.equal(parseMergeCommitRef(replacement), parseMergeCommitRef(original));
  assert.equal(parseWorkIssueRef(replacement), parseWorkIssueRef(original));
  assert.equal(parseVerificationChecklistRef(replacement), parseVerificationChecklistRef(original));
  // Independence: no response-shape guidance or failure narrative is added -- the only new words
  // are the provenance heading and the predecessor number.
  assert.equal(replacement.replace(original, ""), "### Supersedes audit\n\n#866\n\n");
});

test("composeReplacementAuditTitle: keeps the [Audit] prefix searchable and names the predecessor", () => {
  assert.equal(composeReplacementAuditTitle("[Audit] PR #865 exact merge 16a01b5 (work #860)", 866), "[Audit] PR #865 exact merge 16a01b5 (work #860) (replaces #866)");
  assert.equal(composeReplacementAuditTitle("PR #865", 866), "[Audit] PR #865 (replaces #866)");
});

const CLASSIFY = { predecessorNumber: 866, predecessorCreatedAt: "2026-10-02T09:00:00Z", mergeCommitOid: MERGE, executionIssue: 860 };

test("classifyAuditReplacements: no claimant -> NONE (unrelated audits of other targets never count)", () => {
  assert.deepEqual(classifyAuditReplacements([], CLASSIFY), { kind: "NONE" });
  const other = issue(870, auditBody({ work: 861, supersedes: "#866" }));
  const otherMerge = issue(871, auditBody({ merge: "a".repeat(40), supersedes: "#866" }));
  const plain = issue(872, auditBody());
  assert.deepEqual(classifyAuditReplacements([other, otherMerge, plain], CLASSIFY), { kind: "NONE" });
});

test("classifyAuditReplacements: exactly one OPEN pending later replacement naming the predecessor -> FOUND", () => {
  const r = issue(867, auditBody({ supersedes: "#866" }));
  assert.deepEqual(classifyAuditReplacements([issue(866, auditBody(), { createdAt: "2026-10-02T09:00:00Z" }), r], CLASSIFY), { kind: "FOUND", auditIssue: 867 });
});

test("classifyAuditReplacements: every non-clean replacement shape fails closed to AMBIGUOUS and never authorizes another creation", () => {
  const cases = {
    "two claimants": [issue(867, auditBody({ supersedes: "#866" })), issue(868, auditBody({ supersedes: "#866" }))],
    "wrong predecessor": [issue(867, auditBody({ supersedes: "#865" }))],
    "closed replacement (bound consumed)": [issue(867, auditBody({ supersedes: "#866" }), { state: "CLOSED" })],
    "replacement no longer pending": [issue(867, auditBody({ supersedes: "#866", verdict: "NOT CLEAN" }))],
    "malformed marker still consumes the bound": [issue(867, auditBody({ supersedes: "junk" }))],
    "not created after predecessor": [issue(867, auditBody({ supersedes: "#866" }), { createdAt: "2026-10-02T08:00:00Z" })],
  };
  for (const [name, candidates] of Object.entries(cases)) {
    const result = classifyAuditReplacements(candidates, CLASSIFY);
    assert.equal(result.kind, "AMBIGUOUS", name);
    assert.ok(result.reason.length > 0, name);
  }
});

test("findMatchingOpenAuditIssues: a superseded OPEN predecessor is excluded only by a later same-target OPEN replacement naming it", () => {
  const predecessor = issue(866, auditBody(), { createdAt: "2026-10-02T09:00:00Z" });
  const replacement = issue(867, auditBody({ supersedes: "#866" }), { createdAt: "2026-10-02T10:00:00Z" });
  const target = { mergeCommitOid: MERGE, executionIssue: 860 };
  assert.deepEqual(findMatchingOpenAuditIssues([predecessor, replacement], target).map((m) => m.number), [867]);
  assert.deepEqual(findMatchingOpenAuditIssues([predecessor, replacement], target, { requirePendingState: true }).map((m) => m.number), [867]);
  // No replacement -> the predecessor is still the sole match.
  assert.deepEqual(findMatchingOpenAuditIssues([predecessor], target).map((m) => m.number), [866]);
  // An earlier-created "replacement" does not exclude a later one (contradictory provenance).
  const early = issue(867, auditBody({ supersedes: "#866" }), { createdAt: "2026-10-02T08:00:00Z" });
  assert.equal(findMatchingOpenAuditIssues([predecessor, early], target).length, 2);
  // A replacement naming a different issue excludes nothing.
  const wrong = issue(867, auditBody({ supersedes: "#500" }));
  assert.equal(findMatchingOpenAuditIssues([predecessor, wrong], target).length, 2);
  // A CLOSED replacement is not a current candidate and so cannot exclude the predecessor.
  const closed = issue(867, auditBody({ supersedes: "#866" }), { state: "CLOSED" });
  assert.deepEqual(findMatchingOpenAuditIssues([predecessor, closed], target).map((m) => m.number), [866]);
});

// -- REST transports -------------------------------------------------------------------------

test("ghRestCreateIssue: POSTs via REST, verifies identity/state/title/body, tolerates only the one known attribution decoration", () => {
  const calls = [];
  const runImpl = (cmd, args, opts) => {
    calls.push({ cmd, args, input: JSON.parse(opts.input) });
    return JSON.stringify({ number: 900, html_url: "https://github.com/o/r/issues/900", state: "open", title: "T", body: "B", created_at: "2026-10-02T10:00:00Z" });
  };
  assert.deepEqual(ghRestCreateIssue({ repo: "o/r", title: "T", body: "B" }, runImpl), { number: 900, createdAt: "2026-10-02T10:00:00Z" });
  assert.deepEqual(calls[0].args.slice(0, 4), ["api", "-X", "POST", "repos/o/r/issues"]);
  assert.deepEqual(calls[0].input, { title: "T", body: "B" });

  const decorated = () => JSON.stringify({ number: 900, html_url: "https://github.com/o/r/issues/900", state: "open", title: "T", body: "B\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_" });
  assert.equal(ghRestCreateIssue({ repo: "o/r", title: "T", body: "B" }, decorated).number, 900);

  const bad = (patch) => () => JSON.stringify({ number: 900, html_url: "https://github.com/o/r/issues/900", state: "open", title: "T", body: "B", ...patch });
  assert.throws(() => ghRestCreateIssue({ repo: "o/r", title: "T", body: "B" }, bad({ body: "other" })), /body does not match/);
  assert.throws(() => ghRestCreateIssue({ repo: "o/r", title: "T", body: "B" }, bad({ title: "other" })), /title does not match/);
  assert.throws(() => ghRestCreateIssue({ repo: "o/r", title: "T", body: "B" }, bad({ pull_request: {} })), /pull request/);
  assert.throws(() => ghRestCreateIssue({ repo: "o/r", title: "T", body: "B" }, bad({ html_url: "https://github.com/x/y/issues/900" })), /identity/);
  assert.throws(() => ghRestCreateIssue({ repo: "o/r", title: "T", body: "B" }, bad({ state: "closed" })), /open/);
  assert.throws(() => ghRestCreateIssue({ repo: "o/r", title: "T", body: "B" }, () => "not json"), /non-JSON/);
});

function page(items) {
  return JSON.stringify(items);
}
const rest = (number, created_at, extra = {}) => ({ number, title: `[Audit] ${number}`, body: `b${number}`, state: "open", created_at, ...extra });

test("listIssuesCreatedSince: REST-only (never search), skips PRs, stops once a page reaches the lower bound, normalizes the candidate shape", () => {
  const seen = [];
  const runImpl = (cmd, args) => {
    seen.push(args);
    return page([rest(910, "2026-10-02T12:00:00Z"), rest(909, "2026-10-02T11:00:00Z", { pull_request: {} }), rest(908, "2026-10-02T10:00:00Z", { state: "closed" }), rest(900, "2026-10-01T10:00:00Z")]);
  };
  const out = listIssuesCreatedSince({ repo: "o/r", sinceIso: "2026-10-02T10:00:00Z" }, runImpl);
  assert.deepEqual(out.map((c) => [c.number, c.state]), [[910, "OPEN"], [908, "CLOSED"]]);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].includes("repos/o/r/issues") && !seen[0].join(" ").includes("search"));
});

test("listIssuesCreatedSince: follows pages until the lower bound; a truncated or malformed scan throws instead of reading as 'none'", () => {
  const full = Array.from({ length: 100 }, (_, i) => rest(2000 - i, "2026-10-02T12:00:00Z"));
  let calls = 0;
  const twoPages = () => {
    calls++;
    return calls === 1 ? page(full) : page([rest(1800, "2026-10-02T11:00:00Z"), rest(1, "2020-01-01T00:00:00Z")]);
  };
  const out = listIssuesCreatedSince({ repo: "o/r", sinceIso: "2026-10-02T10:00:00Z" }, twoPages);
  assert.equal(calls, 2);
  assert.equal(out.length, 101);

  assert.throws(() => listIssuesCreatedSince({ repo: "o/r", sinceIso: "2026-10-02T10:00:00Z", maxPages: 2 }, () => page(full)), /truncated scan/);
  assert.throws(() => listIssuesCreatedSince({ repo: "o/r", sinceIso: "2026-10-02T10:00:00Z" }, () => "{}"), /not an array/);
  assert.throws(() => listIssuesCreatedSince({ repo: "o/r", sinceIso: "2026-10-02T10:00:00Z" }, () => "oops"), /non-JSON/);
  assert.throws(() => listIssuesCreatedSince({ repo: "o/r", sinceIso: "bad" }, () => "[]"), /sinceIso/);
});
