import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderDecisionSurface,
  resolveFounderResume,
  renderTerminalReturn,
  projectTerminalReturn,
  resumeFromDurableState,
  Outcome,
} from "./launcher-step.mjs";
import { verifyTrustedTrigger, parseLaunchAuthorization } from "./launch-authorization.mjs";
import { planClaim, parseAttemptClaims } from "./attempt-claim.mjs";

const qs = [
  { id: "Q1", question: "Ship scope A or B?", blocking: "slice scope", options: ["A", "B"], recommended: "A" },
  { id: "Q2", question: "Rename?", blocking: "naming" },
];
const ans = (body, perm = "write") => ({ id: 1, body, authorPermission: perm });

test("check 13: one batched decision surface; resumes automatically when exactly one continuation remains", () => {
  const body = renderDecisionSurface({ controlIssue: 379, questions: qs });
  assert.equal((body.match(/^## /gm) ?? []).length, 1);
  assert.match(body, /Question Q1/);
  assert.match(body, /Question Q2/);
  const ids = ["Q1", "Q2"];
  const partial = resolveFounderResume({ questionIds: ids, comments: [ans("- **Answer Q1:** A")], continuations: ["c1"] });
  assert.equal(partial.resume, false);
  assert.equal(partial.outcome, Outcome.WAITING);
  const full = [ans("- **Answer Q1:** A\n- **Answer Q2:** no")];
  const one = resolveFounderResume({ questionIds: ids, comments: full, continuations: ["c1"] });
  assert.equal(one.resume, true);
  assert.equal(one.continuation, "c1");
  assert.equal(resolveFounderResume({ questionIds: ids, comments: full, continuations: ["c1", "c2"] }).resume, false);
  assert.equal(resolveFounderResume({ questionIds: ids, comments: full, continuations: [] }).resume, false);
  const weak = resolveFounderResume({
    questionIds: ids,
    comments: [ans("- **Answer Q1:** A\n- **Answer Q2:** x", "read")],
    continuations: ["c1"],
  });
  assert.equal(weak.resume, false);
  assert.equal(renderDecisionSurface({ controlIssue: 379, questions: [] }), null);
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
