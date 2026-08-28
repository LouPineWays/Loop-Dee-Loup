// Deterministic evidence-sufficiency gate for .claude/skills/spend, built for issue #139.
//
// Issue #120 asked whether LDL's token expenditure was appropriately allocated, found the
// telemetry needed to answer that missing, and still closed CLEAN — "no correction
// justified by available evidence" read as if expenditure had been shown appropriate,
// when the honest result was that the question couldn't be answered at all. This module
// exists so that determination is a checked fact, not something re-derived by model
// reasoning each time /spend runs (which is exactly the kind of drift that let a
// materially incomplete record produce an unqualified CLEAN in the first place).
//
// A "claim type" names one class of question /spend gets asked, together with the reduced
// record fields (dotted paths into reduceSession()'s output) that must be present —
// non-null, and non-empty for arrays/objects — before that specific question is
// answerable. This is deliberately per-claim, not one global completeness rule: issue #139
// requires that a narrow claim (e.g. "did this session compact repeatedly?") stay
// answerable even when a broader one (e.g. token allocation) is not. Add a new claim type
// here when /spend needs to ask a new class of question with its own evidence bar — do not
// invent an ad hoc completeness check inside the skill instead.
//
// This module makes no judgment about whether the *available* evidence shows a defect —
// that remains .claude/skills/spend's job. It only answers "is there enough evidence here
// to render a verdict on this specific claim at all."
//
// Tests: node --test tools/telemetry/sufficiency.test.mjs

import { pathToFileURL } from "node:url";
import { reduceSession } from "./reduce.mjs";

// `requires`: fields that must be non-null/non-empty (via isPresent below).
// `requiresPositive`: fields that must additionally be a real number > 0 — for a claim
// that would otherwise be "satisfied" by an array defaulting to [] whether or not the
// collection mechanism ever ran at all (an empty `compaction_events` looks identical for
// "zero compactions, confirmed by 40 hook events" and "no hook ever fired"). Found in
// review of #139/PR #144: without this, reduceEvents([]) reported compaction_frequency
// and subagent_invocation_pattern as SUFFICIENT purely because their arrays default
// empty, not because anything was actually observed.
// `requiresTrue`: fields that must be exactly `true` — for a claim where a false/partial
// signal must not be treated as satisfied the way a present-but-false value would be
// under `requires`' isPresent check (`false` is a real, present boolean, not a missing
// value, so it needs its own check).
export const CLAIM_REQUIREMENTS = {
  token_allocation: {
    label: "whether the whole session's token expenditure (main-agent vs. subagent, by model) was appropriately allocated",
    requires: ["measured.token_usage_main_total", "measured.token_usage_subagent_total"],
    // A PreCompact-only transcript_usage event (no SessionEnd yet, or a crash before one)
    // reflects only the usage accumulated up to that point — main/subagent totals can both
    // be present and still understate the whole session's real expenditure. Found in
    // review of #139/PR #144: without this, an in-progress session's partial snapshot
    // could authorize a whole-session CLEAN/NOT CLEAN verdict.
    requiresTrue: ["measured.token_usage_is_session_complete"],
  },
  monetary_cost_total: {
    label: "the session's total monetary cost",
    requires: ["measured.cost_usd_total"],
  },
  monetary_cost_by_model: {
    label: "monetary cost broken down by model",
    // Always null today — this collector has no local pricing table (see README's "What
    // it deliberately still cannot measure"), so this claim is always INSUFFICIENT until
    // that changes. Kept as its own claim type, split from monetary_cost_total, so a
    // per-model cost question can no longer pass on session-total cost alone (found in
    // review of #139/PR #144).
    requires: ["measured.cost_usd_by_model"],
  },
  compaction_frequency: {
    label: "whether the session compacted, how often, and why",
    requires: ["measured.compaction_events"],
    requiresPositive: ["measured.hook_event_count"],
  },
  subagent_invocation_pattern: {
    label: "how many subagents ran, of what type, and when",
    requires: ["measured.subagent_start_events"],
    requiresPositive: ["measured.hook_event_count"],
  },
};

// Exported so tools/telemetry/coverage.mjs (issue #199's telemetry-battery aggregation)
// reads the same field-presence rule this gate uses, rather than re-deriving its own.
export function getPath(obj, dottedPath) {
  return dottedPath.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

// An empty array or empty object is still a real, measured "nothing happened" fact (e.g.
// zero compactions) — only null/undefined means the mechanism never produced this field.
export function isPresent(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return true;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

// Exported for the same reason as getPath/isPresent above.
export function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

// Pure: takes an already-reduced record (reduceSession()'s or reduceEvents()'s output)
// and one claim type, returns which of that claim's required fields are missing. Throws
// on an unrecognized claim type — a typo here should fail loudly, not silently pass every
// check it doesn't recognize.
export function assessSufficiency(record, claimType) {
  const spec = CLAIM_REQUIREMENTS[claimType];
  if (!spec) {
    throw new Error(`Unknown claim type "${claimType}". Known: ${Object.keys(CLAIM_REQUIREMENTS).join(", ")}`);
  }
  const missingFields = (spec.requires ?? []).filter((fieldPath) => !isPresent(getPath(record, fieldPath)));
  const missingPositive = (spec.requiresPositive ?? []).filter((fieldPath) => !isPositiveNumber(getPath(record, fieldPath)));
  const missingTrue = (spec.requiresTrue ?? []).filter((fieldPath) => getPath(record, fieldPath) !== true);
  const allMissing = [...missingFields, ...missingPositive, ...missingTrue];
  return {
    claimType,
    label: spec.label,
    verdict: allMissing.length === 0 ? "SUFFICIENT" : "INSUFFICIENT",
    missingFields: allMissing,
  };
}

function main() {
  const [sessionId, claimType] = process.argv.slice(2);
  if (!sessionId || !claimType) {
    console.error("Usage: node tools/telemetry/sufficiency.mjs <session_id> <claim_type>");
    console.error(`Known claim types: ${Object.keys(CLAIM_REQUIREMENTS).join(", ")}`);
    process.exitCode = 1;
    return;
  }
  let result;
  try {
    result = assessSufficiency(reduceSession(sessionId), claimType);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
