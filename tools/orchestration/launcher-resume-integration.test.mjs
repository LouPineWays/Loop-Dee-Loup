import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDecisionSurface,
  renderDecisionSurface,
  newSurfaceId,
  resolveFounderResume,
  renderTerminalReturn,
  projectTerminalReturn,
  resumeFromDurableState,
  Outcome,
} from "./launcher-step.mjs";
import { verifyTrustedTrigger, parseLaunchAuthorization } from "./launch-authorization.mjs";
import { planClaim, parseAttemptClaims } from "./attempt-claim.mjs";

const qs = [
  { id: "Q1", question: "Ship scope A or B?", blocking: "slice scope", options: ["A", "B"], recommended: "A", resolves: "scope" },
  { id: "Q2", question: "Rename?", blocking: "naming", resolves: "naming" },
];
const SID = "379-r1-abc123";
const rq = parseDecisionSurface(renderDecisionSurface({ controlIssue: 379, questions: qs, surfaceId: SID })).questions;
const ans = (body, perm = "write", sid = SID) => ({ id: 1, body: `- **Surface id:** ${sid}
${body}`, authorPermission: perm });

test("check 13: one batched decision surface; resumes automatically when exactly one continuation remains", () => {
  const body = renderDecisionSurface({ controlIssue: 379, questions: qs, surfaceId: SID });
  assert.equal((body.match(/^## /gm) ?? []).length, 1);
  assert.match(body, /Question Q1/);
  assert.match(body, /Question Q2/);
  const ids = ["Q1", "Q2"];
  const partial = resolveFounderResume({ surfaceId: SID, questionIds: ids, questions: rq, comments: [ans("- **Answer Q1:** A")], continuations: ["c1"] });
  assert.equal(partial.resume, false);
  assert.equal(partial.outcome, Outcome.WAITING);
  const full = [ans("- **Answer Q1:** A\n- **Answer Q2:** no")];
  const one = resolveFounderResume({ surfaceId: SID, questionIds: ids, questions: rq, comments: full, continuations: ["c1"] });
  assert.equal(one.resume, true);
  assert.equal(one.continuation, "c1");
  assert.equal(resolveFounderResume({ surfaceId: SID, questionIds: ids, questions: rq, comments: full, continuations: ["c1", "c2"] }).resume, false);
  assert.equal(resolveFounderResume({ surfaceId: SID, questionIds: ids, questions: rq, comments: full, continuations: [] }).resume, false);
  const weak = resolveFounderResume({
    questionIds: ids, questions: rq,
    comments: [ans("- **Answer Q1:** A\n- **Answer Q2:** x", "read")],
    continuations: ["c1"],
  });
  assert.equal(weak.resume, false);
  assert.equal(renderDecisionSurface({ controlIssue: 379, questions: [], surfaceId: SID }), null);
});

test("check 14: terminal CLEAN projects compact fields to #379 and proves them on read-back", async () => {
  const input = {
    objective: "Launcher",
    terminalResult: "CLEAN",
    evidencePointers: ["PR #1", "Audit #2"],
    residualLimitation: "",
    founderDecision: "none",
  };
  const block = renderTerminalReturn(input);
  for (const f of ["Objective", "Terminal result", "Evidence", "Residual limitation", "Founder decision"]) {
    assert.match(block, new RegExp(`\\*\\*${f}:\\*\\*`));
  }
  assert.match(block, /Residual limitation:\*\* none/);
  let stored = "";
  const ok = await projectTerminalReturn(input, {
    writeControl: async (b) => {
      stored = `x\n${b}`;
    },
    readControl: async () => stored,
  });
  assert.equal(ok.outcome, Outcome.ADVANCED);
  assert.equal(ok.evidence.selectsNextObjective, false);
  const lost = await projectTerminalReturn(input, { writeControl: async () => {}, readControl: async () => "" });
  assert.equal(lost.outcome, Outcome.FAIL_CLOSED);
  assert.equal(renderTerminalReturn({ ...input, evidencePointers: [] }), null);
  assert.equal(renderTerminalReturn({ ...input, founderDecision: "maybe" }), null);
});

test("check 15: replacement environment resumes from durable state only; untrusted event gains nothing", () => {
  const auth = parseLaunchAuthorization(
    [
      {
        id: 9,
        authorPermission: "write",
        body: "## Launch Authorization (v1)\n- **Control issue:** #379\n- **Execution issue:** #73\n- **Authorized objective:** o\n- **Authorized by:** a\n- **Nonce:** nonce-12345",
      },
    ],
    { controlIssue: 379 },
  ).authorization;
  const good = { name: "workflow_dispatch", isFork: false, actorPermission: "write", inputs: { control_issue: 379, nonce: "nonce-12345" } };
  const trig = verifyTrustedTrigger(good, { authorization: auth });
  const plan = planClaim(parseAttemptClaims([]), {}, { attemptId: "5-1", nonce: auth.nonce });
  const durable = { authorization: auth, claimsPlan: plan, requiredEnvironment: { node: "22" } };
  const r = resumeFromDurableState({ durable, trigger: trig, environment: { node: "22", hostname: "other-box" } });
  assert.equal(r.outcome, Outcome.ADVANCED);
  assert.equal(r.evidence.resume, true);
  const mism = resumeFromDurableState({ durable, trigger: trig, environment: { node: "18" } });
  assert.equal(mism.outcome, Outcome.FAIL_CLOSED);
  assert.equal(mism.evidence.durableHold, true);
  const fork = verifyTrustedTrigger({ ...good, isFork: true }, { authorization: auth });
  assert.equal(resumeFromDurableState({ durable, trigger: fork, environment: { node: "22" } }).outcome, Outcome.FAIL_CLOSED);
  assert.equal(verifyTrustedTrigger({ ...good, actorPermission: "read" }, { authorization: auth }).trusted, false);
});

test("decision surface retains the required general-comments field and a surface id", () => {
  const body = renderDecisionSurface({ controlIssue: 379, questions: qs, surfaceId: SID });
  assert.match(body, /\*\*General comments:\*\*/);
  assert.ok(body.includes(`- **Surface id:** ${SID}`));
  assert.equal(renderDecisionSurface({ controlIssue: 379, questions: qs }), null, "surface id is required");
  assert.equal(renderDecisionSurface({ controlIssue: 379, questions: qs, surfaceId: "x" }), null);
});

test("answers bind to the exact surface: reused Q1 on a later surface is not inherited; corrections win", () => {
  const ids = ["Q1", "Q2"];
  const older = ans("- **Answer Q1:** A\n- **Answer Q2:** no", "write", "379-r1-old111");
  const none = resolveFounderResume({ surfaceId: "379-r2-new222", questionIds: ids, questions: rq, comments: [older], continuations: ["c1"] });
  assert.equal(none.resume, false);
  assert.deepEqual(none.missing, ids);
  const unbound = { id: 3, authorPermission: "write", body: "- **Answer Q1:** A\n- **Answer Q2:** no" };
  assert.equal(resolveFounderResume({ surfaceId: SID, questionIds: ids, questions: rq, comments: [unbound], continuations: ["c1"] }).resume, false);
  const first = ans("- **Answer Q1:** A\n- **Answer Q2:** no");
  const fix = ans("- **Answer Q1:** B\n- **General comments:** thanks");
  const r = resolveFounderResume({ surfaceId: SID, questionIds: ids, questions: rq, comments: [first, fix], continuations: ["c1"] });
  assert.equal(r.resume, true);
  assert.equal(r.answers.Q1, "B");
  assert.equal(r.generalComments, "thanks");
  assert.equal(resolveFounderResume({ questionIds: ids, questions: rq, comments: [first], continuations: ["c1"] }).outcome, "FAIL_CLOSED");
  assert.notEqual(newSurfaceId(379, qs, 1), newSurfaceId(379, qs, 2));
});

test("consumed nonce (REPLAY) and non-starting claim actions never resume", () => {
  const trigger = { trusted: true };
  const durable = (action) => ({ authorization: { commentId: 1 }, claimsPlan: { action } });
  const env = {};
  assert.equal(resumeFromDurableState({ durable: durable("REPLAY"), trigger, environment: env }).outcome, Outcome.FAIL_CLOSED);
  for (const a of ["BLOCK", "ALREADY_CLAIMED", undefined]) {
    const r = resumeFromDurableState({ durable: durable(a), trigger, environment: env });
    assert.equal(r.outcome, Outcome.WAITING, String(a));
    assert.notEqual(r.evidence.resume, true);
  }
  for (const a of ["CLAIM", "RECONCILE_THEN_CLAIM"]) {
    assert.equal(resumeFromDurableState({ durable: durable(a), trigger, environment: env }).outcome, Outcome.ADVANCED, a);
  }
});

test("founder answers resume only through a deterministic projection onto authoritative decisions", () => {
  const full = [ans("- **Answer Q1:** A\n- **Answer Q2:** no")];
  const ok = resolveFounderResume({ surfaceId: SID, questionIds: ["Q1", "Q2"], questions: rq, comments: full, continuations: ["c1"] });
  assert.deepEqual(ok.decisions, [{ key: "scope", answer: "A" }, { key: "naming", answer: "no" }]);
  // no declared projection (legacy surface / omitted questions) -> pending, never a guessed mapping
  const noQ = resolveFounderResume({ surfaceId: SID, questionIds: ["Q1", "Q2"], comments: full, continuations: ["c1"] });
  assert.equal(noQ.resume, false);
  assert.equal(noQ.outcome, Outcome.WAITING);
  assert.match(noQ.reason, /not deterministically applicable/);
  const bare = parseDecisionSurface(renderDecisionSurface({ controlIssue: 379, surfaceId: SID, questions: [{ id: "Q1", question: "x?", blocking: "b" }] })).questions;
  assert.equal(resolveFounderResume({ surfaceId: SID, questionIds: ["Q1"], questions: bare, comments: [ans("- **Answer Q1:** anything")], continuations: ["c1"] }).resume, false);
  // an answer outside the declared options cannot be applied
  const off = resolveFounderResume({ surfaceId: SID, questionIds: ["Q1", "Q2"], questions: rq, comments: [ans("- **Answer Q1:** C\n- **Answer Q2:** no")], continuations: ["c1"] });
  assert.equal(off.resume, false);
  assert.match(off.reason, /declared options/);
  assert.equal(parseDecisionSurface(renderDecisionSurface({ controlIssue: 379, surfaceId: SID, questions: qs })).questions[0].resolves, "scope");
});
