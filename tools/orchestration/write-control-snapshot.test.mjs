// Tests for tools/orchestration/write-control-snapshot.mjs — issue #510 (unit 510-A)'s
// write-before-validate helper for the normal LDL-authored thin-control-body edit path.
//
// Run with:
//   node --test tools/orchestration/write-control-snapshot.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { checkWriteControlSnapshot, defaultGhEditControlIssue } from "./write-control-snapshot.mjs";
import { ghRestEditIssueBody } from "../review-watch/lifecycle-gate.mjs";
import { upsertControlBullet, parseControlBullet, isNoneSentinel } from "./ready-dispatch-gate.mjs";

const CORRUPT_BODY = `- **PR:** #509
- **Stage 2:** #508 — NOT CLEAN (correction dispatched as PR #509; a fresh Stage 2 audit is required once #509 merges)
`;

const VALID_BODY = `- **PR:** #509
- **Stage 2:** #508 — NOT CLEAN (correction dispatched; fresh Stage 2 required after the current correction PR merges)
`;

test("checkWriteControlSnapshot: exits 1 when --control-issue is missing", () => {
  const result = checkWriteControlSnapshot({ repo: "owner/repo", proposedBody: VALID_BODY });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /control-issue is required/);
});

test("checkWriteControlSnapshot: exits 1 when no proposed body was supplied", () => {
  const result = checkWriteControlSnapshot({ repo: "owner/repo", controlIssue: 499 });
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /proposed body/);
});

test("checkWriteControlSnapshot: REJECTED — refuses the exact #499 corrupted shape before ever calling the write implementation (write-before-validate ordering, Verification case 7)", () => {
  let editCalled = false;
  const result = checkWriteControlSnapshot(
    { repo: "owner/repo", controlIssue: 499, proposedBody: CORRUPT_BODY },
    { ghEditImpl: () => { editCalled = true; } },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "REJECTED");
  assert.equal(editCalled, false, "an invalid proposed body must never reach the write implementation — the prior durable body is left unchanged");
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /"Stage 2"/);
});

test("checkWriteControlSnapshot: WRITTEN — a valid proposed body is persisted verbatim via the injected write implementation", () => {
  const editCalls = [];
  const result = checkWriteControlSnapshot(
    { repo: "owner/repo", controlIssue: 499, proposedBody: VALID_BODY },
    { ghEditImpl: (args) => editCalls.push(args) },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.state, "WRITTEN");
  assert.equal(editCalls.length, 1);
  assert.equal(editCalls[0].repo, "owner/repo");
  assert.equal(editCalls[0].controlIssue, 499);
  assert.equal(editCalls[0].body, VALID_BODY);
});

test("checkWriteControlSnapshot: an operational failure from the write implementation itself is reported as exit 1, distinct from a REJECTED validation failure", () => {
  const result = checkWriteControlSnapshot(
    { repo: "owner/repo", controlIssue: 499, proposedBody: VALID_BODY },
    {
      ghEditImpl: () => {
        throw new Error("gh: network error");
      },
    },
  );
  assert.equal(result.exitCode, 1);
  assert.match(result.message, /REST write failed/);
});

test("checkWriteControlSnapshot: cross-field coexistence (PR + Stage 2 pointing at distinct issues) is accepted and written (Verification case 3)", () => {
  const editCalls = [];
  const result = checkWriteControlSnapshot(
    { repo: "owner/repo", controlIssue: 499, proposedBody: "- **PR:** #509\n- **Stage 2:** #508\n" },
    { ghEditImpl: (args) => editCalls.push(args) },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(editCalls.length, 1);
});

// -- #437 unit 437-C, Required Behavior #3 (the #408 reproduction) ---------------------------
//
// FOUNDER_DECISION_408_BEFORE_BODY is the verbatim shape of GitHub issue #408's own real body,
// confirmed via its `userContentEdits` revision history: the edit at 2026-09-07T14:02:24Z,
// where the founder's approval had just been recorded ("Founder decision: approved skipping a
// second Stage 1 Codex round on the correction commit (2026-09-07); see Operating rule below")
// but not yet marked consumed, alongside durable evidence elsewhere in the same body that the
// decision was already exercised (Route: "PR #435 merged; Stage 2 audit #436 triggered against
// the exact merge commit"; Stage 2: "#436 (triggered ...)"). In the real history, #408 cleared
// this Founder decision in a *separate* later edit (2026-09-07T14:21:33Z) that touched no other
// field -- exactly the "requires a later housekeeping invocation" gap #437's Shared Contract
// point 1 says 437-A's prose closes procedurally. This test proves the corrected discipline is
// mechanically achievable with the existing `upsertControlBullet`/`checkWriteControlSnapshot`
// primitives: composing the Founder-decision clear *and* a substantive Lifecycle advance into
// one proposed body and persisting both through exactly one `write-control-snapshot.mjs` call.
const FOUNDER_DECISION_408_BEFORE_BODY = `- **Execution issue:** #407
- **Lifecycle:** AUDIT
- **Route:** PR #435 merged; Stage 2 audit #436 triggered against the exact merge commit
- **Stage 2:** #436 (triggered https://github.com/LouPineWays/Loop-Dee-Loup/issues/436#issuecomment-5571754033)
- **Blocker:** none
- **Founder decision:** approved skipping a second Stage 1 Codex round on the correction commit (2026-09-07); see Operating rule below
- **Terminal result:** none
`;

test("checkWriteControlSnapshot: #408 reproduction — clearing a consumed Founder decision composes into the same call as a substantive Lifecycle advance (Required Behavior #3)", () => {
  // Compose the proposed body the way a decision-consuming transition is required to: two
  // upsertControlBullet calls building one body, persisted through exactly one
  // checkWriteControlSnapshot invocation -- never a Founder-decision-only write followed by a
  // separate later housekeeping edit.
  let proposedBody = FOUNDER_DECISION_408_BEFORE_BODY;
  proposedBody = upsertControlBullet(
    proposedBody,
    "Founder decision",
    "none — prior approval to skip a second Stage 1 Codex round on the correction commit was exercised before PR #435 merged on 2026-09-07; the settled decision remains recorded in Stage 1 / Operating rule below",
  );
  proposedBody = upsertControlBullet(proposedBody, "Lifecycle", "DONE");

  const editCalls = [];
  const result = checkWriteControlSnapshot(
    { repo: "owner/repo", controlIssue: 408, proposedBody },
    { ghEditImpl: (args) => editCalls.push(args) },
  );

  assert.equal(result.exitCode, 0, `expected the composed #408-shape body to pass validation and write; got: ${JSON.stringify(result)}`);
  assert.equal(result.state, "WRITTEN");
  assert.equal(editCalls.length, 1, "the Founder-decision clear and the Lifecycle advance must persist through exactly one write, not a follow-up housekeeping edit");

  const writtenBody = editCalls[0].body;
  const writtenFounderDecision = parseControlBullet(writtenBody, "Founder decision");
  assert.ok(isNoneSentinel(writtenFounderDecision), `Founder decision must read a "none" sentinel after the consuming transition; got: ${JSON.stringify(writtenFounderDecision)}`);
  assert.match(writtenFounderDecision, /prior approval .* was exercised/, "the compact resolution note must preserve why the decision was already exercised (provenance, per #437 Required Behavior #6)");
  assert.equal(parseControlBullet(writtenBody, "Lifecycle"), "DONE");
  // Provenance: the evidence that the decision was exercised (the merged PR / triggered Stage 2
  // audit) survives untouched in the same written body -- clearing the live field must not erase
  // why it was blocked or what satisfied it.
  assert.match(writtenBody, /PR #435 merged; Stage 2 audit #436 triggered/);
});

// Issue #818: REST transport boundary (GraphQL-independent persistence).
const restReply = (over = {}, body = VALID_BODY) => JSON.stringify({
  number: 499, html_url: "https://github.com/Owner/Repo/issues/499", body, ...over,
});
function restRun(reply, calls = []) {
  return (cmd, args, opts) => { calls.push({ cmd, args, opts }); if (reply instanceof Error) throw reply; return reply; };
}
const writeVia = (runImpl, body = VALID_BODY) =>
  checkWriteControlSnapshot({ repo: "owner/repo", controlIssue: 499, proposedBody: body }, {
    ghEditImpl: (a) => defaultGhEditControlIssue(a, runImpl),
  });

test("REST transport: WRITTEN, exact body sent as JSON over stdin via gh api PATCH, repo case-insensitive", () => {
  const calls = [];
  const r = writeVia(restRun(restReply(), calls));
  assert.equal(r.state, "WRITTEN");
  assert.deepEqual(calls[0].args, ["api", "-X", "PATCH", "repos/owner/repo/issues/499", "--input", "-"]);
  assert.equal(JSON.parse(calls[0].opts.input).body, VALID_BODY);
  assert.ok(!calls[0].args.includes("issue"), "must not use GraphQL-backed gh issue edit");
});

test("REST transport: large multiline body with shell-hostile characters round-trips via stdin", () => {
  const big = VALID_BODY + "line with `ticks` $VAR \"quotes\" 'single' && | > <\n".repeat(5000);
  const calls = [];
  assert.equal(writeVia(restRun(restReply({}, big), calls), big).state, "WRITTEN");
  assert.equal(JSON.parse(calls[0].opts.input).body, big);
});

test("REST transport: CRLF-only echo difference is accepted", () => {
  assert.equal(writeVia(restRun(restReply({}, VALID_BODY.replace(/\n/g, "\r\n")))).state, "WRITTEN");
});

test("REST transport: invalid body is REJECTED and transport never invoked", () => {
  const calls = [];
  const r = writeVia(restRun(restReply(), calls), CORRUPT_BODY);
  assert.equal(r.exitCode, 2);
  assert.equal(calls.length, 0);
});

// Issue #835: known trailing attribution decoration.
const ATTR = "\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_";
const NO_NL = VALID_BODY.replace(/\n+$/, "");
test("#835 decorated-success: exact body + one attribution block is WRITTEN", () => {
  assert.equal(writeVia(restRun(restReply({}, VALID_BODY + ATTR))).state, "WRITTEN");
  assert.equal(writeVia(restRun(restReply({}, NO_NL + ATTR + "\n")), NO_NL).state, "WRITTEN");
  assert.equal(writeVia(restRun(restReply({}, (VALID_BODY + ATTR).replace(/\n/g, "\r\n")))).state, "WRITTEN");
});
test("#835 decorated-success with preserved trailing blank lines in the request", () => {
  const req = NO_NL + "\n\n\n";
  assert.equal(writeVia(restRun(restReply({}, req + ATTR)), req).state, "WRITTEN");
});
for (const n of [0, 1, 3]) {
  const req = NO_NL + "\n".repeat(n);
  test(`#835 boundary: ${n} trailing newline(s) preserved exactly; removed/extra newline rejected`, () => {
    assert.equal(writeVia(restRun(restReply({}, req + ATTR)), req).state, "WRITTEN");
    if (n > 0) assert.equal(writeVia(restRun(restReply({}, req.slice(0, -1) + ATTR)), req).exitCode, 1);
    assert.equal(writeVia(restRun(restReply({}, req + "\n" + ATTR)), req).exitCode, 1);
    assert.equal(writeVia(restRun(restReply({}, req + ATTR.slice(1))), req).exitCode, 1);
  });
}
test("#835 request already carrying the attribution block: second block rejected, exact echo accepted", () => {
  const req = NO_NL + ATTR;
  assert.equal(writeVia(restRun(restReply({}, req + ATTR)), req).exitCode, 1);
  assert.equal(writeVia(restRun(restReply({}, req)), req).state, "WRITTEN");
});
for (const [name, rb] of [
  ["duplicated attribution", VALID_BODY + ATTR + ATTR],
  ["unrecognized suffix", VALID_BODY + "\n\n---\n_Generated by Someone Else_"],
  ["extra prose after attribution", VALID_BODY + ATTR + "\nmore"],
  ["attribution without separator", NO_NL + "_Generated by [Claude Code](https://claude.ai/code)_"],
  ["prefix injected", "intro\n" + VALID_BODY + ATTR],
  ["body altered then decorated", VALID_BODY.replace("#509", "#510") + ATTR],
  ["content removed then decorated", VALID_BODY.slice(0, -20) + ATTR],
]) {
  test(`#835 rejects ${name}`, () => {
    const r = writeVia(restRun(restReply({}, rb)));
    assert.equal(r.exitCode, 1);
    assert.notEqual(r.state, "WRITTEN");
  });
}
test("#835 decorated wrong target fails; invalid proposal rejected before transport", () => {
  assert.equal(writeVia(restRun(restReply({ number: 500 }, VALID_BODY + ATTR))).exitCode, 1);
  const calls = [];
  assert.equal(writeVia(restRun(restReply({}, CORRUPT_BODY + ATTR), calls), CORRUPT_BODY).exitCode, 2);
  assert.equal(calls.length, 0);
});
test("#835 retry is idempotent: each write sends the same exact body; verification never relaxes", () => {
  const calls = [];
  const run = restRun(restReply({}, VALID_BODY + ATTR), calls);
  assert.equal(writeVia(run).state, "WRITTEN");
  assert.equal(writeVia(run).state, "WRITTEN");
  assert.equal(JSON.parse(calls[1].opts.input).body, VALID_BODY);
  assert.equal(writeVia(restRun(restReply({}, VALID_BODY + ATTR + ATTR))).exitCode, 1);
});
test("#835 non-control callers of ghRestEditIssueBody keep exact verification (no opt-in)", () => {
  assert.throws(() => ghRestEditIssueBody({ repo: "owner/repo", auditIssue: 499, body: VALID_BODY }, restRun(restReply({}, VALID_BODY + ATTR))), /does not match/);
});

for (const [name, reply] of [
  ["wrong issue number", restReply({ number: 500 })],
  ["wrong repository", restReply({ html_url: "https://github.com/Other/Repo/issues/499" })],
  ["pull request response", restReply({ pull_request: { url: "x" } })],
  ["non-JSON response", "<html>oops</html>"],
  ["incomplete response", "{}"],
  ["body mismatch", restReply({}, VALID_BODY + "extra")],
  ["unauthorized/unavailable", new Error("HTTP 403")],
]) {
  test(`REST transport: ${name} is an operational failure (exit 1, never WRITTEN)`, () => {
    const r = writeVia(restRun(reply));
    assert.equal(r.exitCode, 1);
    assert.notEqual(r.state, "WRITTEN");
  });
}

// Issue #1151: activation mode — stale refusal, open-pair validation, independent readback.
const ACT_BODY = "- **Lifecycle:** READY\n- **Execution:** #1151\n- **Route:** implementation worker\n- **Blocker:** none\n- **Founder decision:** none\n";
const ACT_BASE = "- **Lifecycle:** DONE\n- **Execution:** #804\n";

function actWorld({ state = "OPEN", liveBody = ACT_BASE, persist = true } = {}) {
  const w = { body: liveBody, writes: 0 };
  w.readIssueImpl = ({ number }) => (number === 1151 ? { body: "", state: "OPEN" } : { body: w.body, state });
  w.ghEditImpl = ({ body }) => { w.writes++; if (persist) w.body = body; };
  return w;
}
const actCall = (w, over = {}) =>
  checkWriteControlSnapshot(
    { repo: "o/r", controlIssue: 438, proposedBody: ACT_BODY, activation: { executionIssue: 1151, baseBody: ACT_BASE, verifyExecution: () => ({ ok: true }) }, ...over },
    { readIssueImpl: w.readIssueImpl, ghEditImpl: w.ghEditImpl },
  );

test("#1151 activation: OPEN control + unchanged base -> WRITTEN verified after independent readback", () => {
  const w = actWorld();
  const r = actCall(w);
  assert.equal(r.exitCode, 0);
  assert.equal(r.verified, true);
  assert.equal(w.writes, 1);
});

test("#1151 activation: CLOSED control is rejected and never written (closed control + open child)", () => {
  const w = actWorld({ state: "CLOSED" });
  const r = actCall(w);
  assert.equal(r.exitCode, 2);
  assert.equal(w.writes, 0);
});

test("#1151 activation: changed live body -> STALE_CONTROL, no overwrite", () => {
  const w = actWorld({ liveBody: ACT_BASE + "- extra\n" });
  const r = actCall(w);
  assert.equal(r.exitCode, 2);
  assert.equal(r.state, "STALE_CONTROL");
  assert.equal(w.writes, 0);
});

test("#1151 activation: proposal still carrying DONE or a different packet pointer is rejected before write", () => {
  for (const proposedBody of [ACT_BODY.replace("READY", "DONE"), ACT_BODY.replace("#1151", "#804")]) {
    const w = actWorld();
    assert.equal(actCall(w, { proposedBody }).exitCode, 2);
    assert.equal(w.writes, 0);
  }
});

test("#1151 activation: a write that does not persist fails readback and never reports success", () => {
  const w = actWorld({ persist: false });
  const r = actCall(w);
  assert.equal(r.exitCode, 1);
  assert.equal(r.state, "READBACK_MISMATCH");
});

test("#1151 non-activation calls are unchanged (no reads, no pair checks)", () => {
  let reads = 0;
  const r = checkWriteControlSnapshot(
    { repo: "o/r", controlIssue: 499, proposedBody: "- **PR:** #509\n" },
    { ghEditImpl: () => {}, readIssueImpl: () => { reads++; } },
  );
  assert.equal(r.exitCode, 0);
  assert.equal(reads, 0);
});

test("#1151 activation: appended unknown content after PATCH fails readback; known attribution is tolerated; missing proof refused", () => {
  const w = actWorld();
  w.ghEditImpl = ({ body }) => { w.body = `${body}\n### Founder interrupt\n\nstop\n`; };
  assert.equal(actCall(w).exitCode, 1);
  const ok = actWorld();
  ok.ghEditImpl = ({ body }) => { ok.body = `${body}\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_`; };
  assert.equal(actCall(ok).exitCode, 0);
  const none = actWorld();
  const r = actCall(none, { activation: { executionIssue: 1151, baseBody: ACT_BASE } });
  assert.equal(r.exitCode, 1);
  assert.equal(none.writes, 0);
  const bad = actWorld();
  const rb = actCall(bad, { activation: { executionIssue: 1151, baseBody: ACT_BASE, verifyExecution: () => ({ ok: false, reason: "revoked" }) } });
  assert.equal(rb.exitCode, 2);
  assert.equal(bad.writes, 0);
});

test("Audit #1153: CLI refuses the unsupported --activate-execution surface before any I/O and points to the helper", async () => {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, [new URL("./write-control-snapshot.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "--control-issue", "1", "--body-file", "-", "--activate-execution", "2", "--base-body-file", "x"], { encoding: "utf8", input: "" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /activate-control-pair\.mjs/);
});

test("Audit #1153 Stage 1: CLI refuses valueless --activate-execution / --base-body-file by presence", async () => {
  const { spawnSync } = await import("node:child_process");
  const script = new URL("./write-control-snapshot.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  for (const flag of ["--activate-execution", "--base-body-file"]) {
    const r = spawnSync(process.execPath, [script, "--control-issue", "1", "--body-file", "-", flag], { encoding: "utf8", input: "" });
    assert.equal(r.status, 1, flag);
    assert.match(r.stderr, /activate-control-pair\.mjs/, flag);
  }
});

// Issue #1165: combined reopen+activation mutation at the canonical writer.
function reopenWorld({ state = "CLOSED", persistReopen = true, execClosesAfterWrite = false } = {}) {
  const w = { body: ACT_BASE, state, patches: [], writes: 0 };
  w.readIssueImpl = ({ number }) =>
    number === 1151 ? { body: "", state: execClosesAfterWrite && w.patches.length > 0 ? "CLOSED" : "OPEN" } : { body: w.body, state: w.state };
  w.ghEditImpl = ({ body }) => { w.writes++; w.body = body; };
  w.ghReopenImpl = ({ body, state: s }) => {
    w.patches.push(s);
    if (persistReopen || s === "closed") { w.body = body; w.state = s.toUpperCase(); }
  };
  return w;
}
const reopenCall = (w, activation = {}) =>
  checkWriteControlSnapshot(
    { repo: "o/r", controlIssue: 438, proposedBody: ACT_BODY, activation: { executionIssue: 1151, baseBody: ACT_BASE, baseState: "CLOSED", reopen: true, verifyExecution: () => ({ ok: true }), ...activation } },
    { readIssueImpl: w.readIssueImpl, ghEditImpl: w.ghEditImpl, ghReopenImpl: w.ghReopenImpl },
  );

test("#1165 reopen: CLOSED control + coherent READY body -> ONE state+body mutation, verified after independent readback", () => {
  const w = reopenWorld();
  const r = reopenCall(w);
  assert.equal(r.exitCode, 0, JSON.stringify(r));
  assert.equal(r.verified, true);
  assert.deepEqual(w.patches, ["open"]);
  assert.equal(w.writes, 0);
  assert.equal(w.state, "OPEN");
});

test("#1165 reopen: without the reopen flag a CLOSED control is still rejected and never written", () => {
  const w = reopenWorld();
  const r = reopenCall(w, { reopen: false });
  assert.equal(r.exitCode, 2);
  assert.deepEqual(w.patches, []);
  assert.equal(w.state, "CLOSED");
});

test("#1165 reopen: a DONE/stale proposal is rejected by pair validation before any reopen", () => {
  const w = reopenWorld();
  const r = checkWriteControlSnapshot(
    { repo: "o/r", controlIssue: 438, proposedBody: ACT_BASE, activation: { executionIssue: 1151, baseBody: ACT_BASE, baseState: "CLOSED", reopen: true, verifyExecution: () => ({ ok: true }) } },
    { readIssueImpl: w.readIssueImpl, ghEditImpl: w.ghEditImpl, ghReopenImpl: w.ghReopenImpl },
  );
  assert.equal(r.exitCode, 2);
  assert.deepEqual(w.patches, []);
  assert.equal(w.state, "CLOSED");
});

test("#1165 reopen: live state or body no longer the base -> STALE_CONTROL, nothing written", () => {
  const stateMoved = reopenWorld({ state: "OPEN" });
  assert.equal(reopenCall(stateMoved).state, "STALE_CONTROL");
  const bodyMoved = reopenWorld();
  bodyMoved.body += "\nconcurrent";
  assert.equal(reopenCall(bodyMoved).state, "STALE_CONTROL");
  for (const w of [stateMoved, bodyMoved]) assert.deepEqual(w.patches, []);
});

test("#1165 reopen: failed write leaves CLOSED; revoked proof refuses; readback mismatch is restored to CLOSED", () => {
  const failing = reopenWorld();
  failing.ghReopenImpl = () => { throw new Error("HTTP 422"); };
  const rf = reopenCall(failing);
  assert.equal(rf.exitCode, 1);
  assert.equal(rf.state, "REOPEN_WRITE_FAILED");
  assert.equal(failing.state, "CLOSED");

  const revoked = reopenWorld();
  const rr = reopenCall(revoked, { verifyExecution: () => ({ ok: false, reason: "revoked" }) });
  assert.equal(rr.exitCode, 2);
  assert.deepEqual(revoked.patches, []);

  // The execution issue closing between the pre-write check and the readback is revalidated live.
  const lossy = reopenWorld({ execClosesAfterWrite: true });
  const rl = reopenCall(lossy);
  assert.equal(rl.exitCode, 1);
  assert.equal(rl.state, "READBACK_MISMATCH");
  assert.equal(rl.rolledBack, true);
  assert.deepEqual(lossy.patches, ["open", "closed"]);
  assert.equal(lossy.state, "CLOSED");
  assert.equal(lossy.body, ACT_BASE);
});

test("#1165 reopen: rollback never overwrites a concurrent actor's update to the reopened control", () => {
  const w = reopenWorld({ execClosesAfterWrite: true });
  const origRead = w.readIssueImpl;
  let controlReads = 0;
  w.readIssueImpl = (a) => {
    const out = origRead(a);
    // After the writer's own readback, another actor edits the control before rollback re-reads it.
    if (a.number === 438 && ++controlReads === 2) w.body = w.body + "\nconcurrent actor edit";
    return out;
  };
  const r = reopenCall(w);
  assert.equal(r.exitCode, 1);
  assert.equal(r.state, "READBACK_MISMATCH");
  assert.equal(r.rolledBack, false);
  assert.deepEqual(w.patches, ["open"]);
  assert.match(w.body, /concurrent actor edit/);
});
