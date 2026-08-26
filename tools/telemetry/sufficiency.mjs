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

export const CLAIM_REQUIREMENTS = {
  token_allocation: {
    label: "whether token expenditure (main-agent vs. subagent, by model) was appropriately allocated",
    requires: ["measured.token_usage_main_total", "measured.token_usage_subagent_total"],
  },
  monetary_cost: {
    label: "the session's total or per-model monetary cost",
    requires: ["measured.cost_usd_total"],
  },
  context_utilization: {
    label: "how much of the context window was used, including any pre-compaction peak",
    requires: ["measured.context_window_size", "derived.peak_context_used_percentage"],
  },
  compaction_frequency: {
    label: "whether the session compacted, how often, and why",
    requires: ["measured.compaction_events"],
  },
  subagent_invocation_pattern: {
    label: "how many subagents ran, of what type, and when",
    requires: ["measured.subagent_start_events"],
  },
};

function getPath(obj, dottedPath) {
  return dottedPath.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

// An empty array or empty object is still a real, measured "nothing happened" fact (e.g.
// zero compactions) — only null/undefined means the mechanism never produced this field.
function isPresent(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return true;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
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
  const missingFields = spec.requires.filter((fieldPath) => !isPresent(getPath(record, fieldPath)));
  return {
    claimType,
    label: spec.label,
    verdict: missingFields.length === 0 ? "SUFFICIENT" : "INSUFFICIENT",
    missingFields,
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
