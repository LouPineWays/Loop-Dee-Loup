#!/usr/bin/env node
// Standalone exercise script for worker unit 454-D, scenarios 3-7 (the negative controls with
// no real historical analogue, plus one fully-constructed merge-gate-composition fixture).
// Every dependency is injected (stage1RunImpl, checkMergeReadyImpl, checkCorrectionDeltaImpl,
// ghIssueViewImpl) -- no network access, no `gh` CLI call, nothing real is read or mutated.
// Writes one JSON artifact per scenario next to this script.
//
// Run: node docs/stage1-correction-satisfaction-proof-runs/454-constructed-fixtures-exercise.mjs

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  runNextReviewTransitionGate,
  resolvePreMergeVerdict,
} from "../../tools/orchestration/next-review-transition-gate.mjs";
import { checkCorrectionDelta } from "../../tools/review-watch/stage1-correction-gate.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const REVIEWED = "aaaaaaa1111111111111111111111111111111a";
const CORRECTED = "bbbbbbb2222222222222222222222222222222b";
const STALE_LATER_HEAD = "ccccccc3333333333333333333333333333333c";

const FINDINGS_BODY = "### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request.";
const CLEAN_BODY = "No issues found. Looks good.";

function findingsReceived() {
  return {
    exitCode: 0,
    state: "RESPONSE_RECEIVED",
    matches: [{ body_excerpt: FINDINGS_BODY }],
    unboundGenuineMatches: [],
  };
}
function cleanReceived() {
  return { exitCode: 0, state: "RESPONSE_RECEIVED", matches: [{ body_excerpt: CLEAN_BODY }], unboundGenuineMatches: [] };
}
function notRequested() {
  return { exitCode: 2, state: "NOT_REQUESTED" };
}

function write(name, data) {
  const file = path.join(HERE, `${name}.json`);
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  console.log(`wrote ${file}`);
  console.log(JSON.stringify(data, null, 2));
  console.log("---");
}

async function scenario03UnrelatedChange() {
  // Narrative: PR is reviewed at REVIEWED with findings; the authorized correction pass
  // produces CORRECTED and the control Issue records that pair. Someone then pushes an
  // additional, unrelated commit AFTER the recorded correction -- the PR's real head is now
  // a THIRD sha (STALE_LATER_HEAD) that the disposition never named. The composed gate must
  // not let the old disposition authorize this new, unrelated head.
  const correctionDelta = await checkCorrectionDelta(
    { repo: "o/r", pr: 1, reviewedHead: REVIEWED, correctedHead: CORRECTED, gatedHead: STALE_LATER_HEAD },
    { stage1RunImpl: async () => findingsReceived(), compareImpl: async () => ({ status: "ahead" }) },
  );
  const verdict = resolvePreMergeVerdict(
    { stage1: notRequested(), mergeReady: { exitCode: 0, state: "MERGE_READY" }, stage1Disposition: `correction-satisfied at ${CORRECTED} (reviewed ${REVIEWED})`, correctionDelta },
    { repo: "o/r", pr: 1, head: STALE_LATER_HEAD, issue: 1 },
  );
  return {
    scenario: "3 -- unrelated change negative control",
    narrative:
      "A correction-satisfied disposition names reviewed=" + REVIEWED + ", corrected=" + CORRECTED +
      ". An unrelated commit is then pushed, making the PR's real gated head " + STALE_LATER_HEAD +
      " (never named by the disposition). Expect the old disposition to NOT authorize the new head.",
    correctionDelta,
    composedVerdict: verdict,
    expectation: "correctionDelta.state === HEAD_MISMATCH; composed verdict === NO_ACTION_YET (fails closed, no merge authorization)",
    passed: correctionDelta.state === "HEAD_MISMATCH" && verdict.state === "NO_ACTION_YET",
    documentedLimitation:
      "This mechanism's ancestry check (compare status \"ahead\") cannot detect unrelated content BUNDLED " +
      "into the very same commit the disposition names as \"corrected\" -- only a dishonest or mistaken " +
      "disposition bullet naming that head could hide such content, and stage1-correction-gate.mjs's own " +
      "module comment documents this explicitly as a trust boundary (\"not a content-level guarantee that " +
      "only findings-authorized lines changed\"), not a bug. The protection this scenario actually verifies " +
      "is the one #454 requires: a stale/prior disposition can never silently extend to cover a head it never " +
      "named, which is the case a session could hit by accident (unlike a deliberately falsified bullet).",
  };
}

async function scenario04StaleCorrectedHead() {
  // Narrative: a disposition satisfied corrected head A on an earlier gate run. The PR later
  // moves to a completely different head B (any reason -- another correction round, a rebase,
  // etc.) without the disposition being refreshed. Head A's satisfaction record must not
  // authorize head B.
  const HEAD_A = CORRECTED;
  const HEAD_B = STALE_LATER_HEAD;
  const correctionDelta = await checkCorrectionDelta(
    { repo: "o/r", pr: 1, reviewedHead: REVIEWED, correctedHead: HEAD_A, gatedHead: HEAD_B },
    { stage1RunImpl: async () => findingsReceived(), compareImpl: async () => ({ status: "ahead" }) },
  );
  const verdict = resolvePreMergeVerdict(
    { stage1: notRequested(), mergeReady: { exitCode: 0, state: "MERGE_READY" }, stage1Disposition: `correction-satisfied at ${HEAD_A} (reviewed ${REVIEWED})`, correctionDelta },
    { repo: "o/r", pr: 1, head: HEAD_B, issue: 1 },
  );
  return {
    scenario: "4 -- stale corrected-head negative control",
    narrative: `A satisfaction record for corrected head ${HEAD_A} is checked against a later, different gated head ${HEAD_B}.`,
    correctionDelta,
    composedVerdict: verdict,
    expectation: "correctionDelta.state === HEAD_MISMATCH; composed verdict === NO_ACTION_YET",
    passed: correctionDelta.state === "HEAD_MISMATCH" && verdict.state === "NO_ACTION_YET",
  };
}

async function scenario05NoFindingsLaterChange() {
  // Narrative: the reviewed head got a CLEAN (no findings) Codex response. A later disposition
  // nonetheless claims a "correction-satisfied" pair against that clean reviewed head. There
  // was nothing to correct -- this must fail closed, not be treated as an ordinary clean pass
  // that just needs the normal (non-correction) merge path.
  const correctionDelta = await checkCorrectionDelta(
    { repo: "o/r", pr: 1, reviewedHead: REVIEWED, correctedHead: CORRECTED, gatedHead: CORRECTED },
    { stage1RunImpl: async () => cleanReceived(), compareImpl: async () => ({ status: "ahead" }) },
  );
  const verdict = resolvePreMergeVerdict(
    { stage1: notRequested(), mergeReady: { exitCode: 0, state: "MERGE_READY" }, stage1Disposition: `correction-satisfied at ${CORRECTED} (reviewed ${REVIEWED})`, correctionDelta },
    { repo: "o/r", pr: 1, head: CORRECTED, issue: 1 },
  );
  return {
    scenario: "5 -- no-findings + later change negative control",
    narrative: `Reviewed head ${REVIEWED} has only a clean-pass Stage 1 response (no findings). A later disposition still claims correction-satisfied against it.`,
    correctionDelta,
    composedVerdict: verdict,
    expectation: 'correctionDelta.state === NOT_SATISFIED (findings-provenance reason); composed verdict === AMBIGUOUS (fails closed, never silently satisfied)',
    passed: correctionDelta.state === "NOT_SATISFIED" && verdict.state === "AMBIGUOUS",
  };
}

async function scenario06MalformedProvenance() {
  // Two independent malformed/missing-provenance sub-cases, both must fail closed:
  //  (a) reviewedHead has no genuine Stage 1 response at all (NOT_REQUESTED) -- incomplete
  //      review provenance, not just "clean".
  //  (b) the "- **Stage 1:**" bullet itself does not parse as this disposition shape at all
  //      (e.g. missing the "(reviewed ...)" clause) -- parseCorrectionSatisfiedDisposition
  //      returns null, so correctionDelta is never even computed (no false authorization from
  //      a malformed bullet); the composed gate must fall back to plain NO_ACTION_YET, exactly
  //      as if no disposition existed.
  const correctionDeltaA = await checkCorrectionDelta(
    { repo: "o/r", pr: 1, reviewedHead: REVIEWED, correctedHead: CORRECTED, gatedHead: CORRECTED },
    { stage1RunImpl: async () => notRequested(), compareImpl: async () => ({ status: "ahead" }) },
  );
  const verdictA = resolvePreMergeVerdict(
    { stage1: notRequested(), mergeReady: { exitCode: 0, state: "MERGE_READY" }, stage1Disposition: `correction-satisfied at ${CORRECTED} (reviewed ${REVIEWED})`, correctionDelta: correctionDeltaA },
    { repo: "o/r", pr: 1, head: CORRECTED, issue: 1 },
  );

  const malformedDisposition = `correction-satisfied at ${CORRECTED} reviewed ${REVIEWED}`; // missing parens -- does not parse
  const verdictB = await runNextReviewTransitionGate(
    { repo: "o/r", controlIssue: "1" },
    {
      ghIssueViewImpl: async () => ({
        body: `- **PR:** #1\n- **Execution issue:** #1\n- **Stage 1:** ${malformedDisposition}\n`,
        state: "OPEN",
      }),
      ghPrHeadImpl: async () => CORRECTED,
      stage1RunImpl: async () => notRequested(),
      checkMergeReadyImpl: async () => ({ exitCode: 0, state: "MERGE_READY" }),
      checkCorrectionDeltaImpl: async () => {
        throw new Error("must not be called -- a malformed bullet must never reach checkCorrectionDelta at all");
      },
    },
  );

  return {
    scenario: "6 -- malformed/missing provenance",
    subcases: {
      a_no_genuine_response_at_reviewed_head: {
        correctionDelta: correctionDeltaA,
        composedVerdict: verdictA,
        expectation: "correctionDelta.state === NOT_SATISFIED; composed verdict === AMBIGUOUS",
        passed: correctionDeltaA.state === "NOT_SATISFIED" && verdictA.state === "AMBIGUOUS",
      },
      b_malformed_disposition_bullet_never_parses: {
        malformedDisposition,
        composedVerdict: verdictB,
        expectation:
          "parseCorrectionSatisfiedDisposition returns null, checkCorrectionDeltaImpl is never invoked, and " +
          "the composed gate falls back to plain NO_ACTION_YET (identical to no disposition present at all)",
        passed: verdictB.state === "NO_ACTION_YET",
      },
    },
  };
}

async function scenario07MergeGateComposition() {
  // A fully synthetic, network-free exercise of the FULL composed gate
  // (runNextReviewTransitionGate, not the two isolated units in isolation) reaching
  // STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2 end-to-end -- distinct from scenarios
  // 1/2's real-PR evidence, per this unit's own contract requiring "at least one constructed
  // fixture" for this scenario specifically.
  const body = `- **PR:** #1\n- **Execution issue:** #1\n- **Stage 1:** correction-satisfied at ${CORRECTED} (reviewed ${REVIEWED})\n`;
  const result = await runNextReviewTransitionGate(
    { repo: "o/r", controlIssue: "1" },
    {
      ghIssueViewImpl: async () => ({ body, state: "OPEN" }),
      ghPrHeadImpl: async () => CORRECTED,
      stage1RunImpl: async () => notRequested(),
      checkMergeReadyImpl: async () => ({ exitCode: 0, state: "MERGE_READY" }),
      checkCorrectionDeltaImpl: async () =>
        checkCorrectionDelta(
          { repo: "o/r", pr: 1, reviewedHead: REVIEWED, correctedHead: CORRECTED, gatedHead: CORRECTED },
          { stage1RunImpl: async () => findingsReceived(), compareImpl: async () => ({ status: "ahead" }) },
        ),
    },
  );
  return {
    scenario: "7 -- merge-gate composition (constructed fixture)",
    composedVerdict: result,
    expectation: "STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2, exitCode 0",
    passed: result.state === "STAGE1_CORRECTION_SATISFIED_MERGE_AND_TRIGGER_STAGE2" && result.exitCode === 0,
  };
}

async function main() {
  write("454-scenario-03-unrelated-change-negative-control", await scenario03UnrelatedChange());
  write("454-scenario-04-stale-corrected-head-negative-control", await scenario04StaleCorrectedHead());
  write("454-scenario-05-no-findings-later-change-negative-control", await scenario05NoFindingsLaterChange());
  write("454-scenario-06-malformed-missing-provenance", await scenario06MalformedProvenance());
  write("454-scenario-07-merge-gate-composition-constructed", await scenario07MergeGateComposition());
}

main();
