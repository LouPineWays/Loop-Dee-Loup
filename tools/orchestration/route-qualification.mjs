// Cheapest-qualified route selection (issue #73 unit 73-D, Shared Contract v1).
//
// Pure selector: picks the lowest-relativeCost route that is (a) in the caller's authorized
// `candidates`, (b) currently available, and (c) QUALIFIED by repository-tracked evidence for the
// outcome class and assurance requirement. A cheaper route without qualifying evidence is never
// chosen. Local inference is an optional candidate: available only when
// `availability.localInference === true`; its absence is never a failure by itself. When no route
// qualifies the result is an explicit fail-closed value -- never a silent assurance downgrade.
//
// Evidence file: docs/route-evidence.json, an array of
//   { route, outcomeClass, verifiedClean, reworkRate, founderInterventions, relativeCost,
//     requiresLocalInference }
// Vendor names live only in that file/adapters; lifecycle semantics stay provider-neutral.
//
// Inputs:
//   outcomeClass  string
//   assurance     { maxReworkRate?: number, maxFounderInterventions?: number }  (verifiedClean is always required)
//   candidates    string[]   already-authorized routes (authorization is the caller's concern)
//   evidence      array      parsed docs/route-evidence.json
//   availability  { localInference?: boolean, [route]: boolean }  (a route explicitly false is unavailable)
//
// Run tests with: node --test tools/orchestration/route-qualification.test.mjs

import { readFileSync } from "node:fs";

function failClosed(reason) {
  return { route: null, failClosed: true, reason };
}

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

export function loadRouteEvidence(path = new URL("../../docs/route-evidence.json", import.meta.url)) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function disqualification(entry, assurance) {
  if (entry.verifiedClean !== true) return "no verified-clean evidence";
  if (!isNum(entry.relativeCost)) return "missing relativeCost";
  const { maxReworkRate, maxFounderInterventions } = assurance;
  if (isNum(maxReworkRate) && !(isNum(entry.reworkRate) && entry.reworkRate <= maxReworkRate)) {
    return "rework rate exceeds assurance";
  }
  if (isNum(maxFounderInterventions) && !(isNum(entry.founderInterventions) && entry.founderInterventions <= maxFounderInterventions)) {
    return "founder interventions exceed assurance";
  }
  return null;
}

export function selectRoute({ outcomeClass, assurance, candidates, evidence, availability } = {}) {
  if (typeof outcomeClass !== "string" || outcomeClass === "") return failClosed("missing outcomeClass");
  if (!Array.isArray(candidates) || candidates.length === 0) return failClosed("no authorized candidate routes");
  if (!Array.isArray(evidence)) return failClosed("route evidence missing or malformed");
  const assure = assurance && typeof assurance === "object" ? assurance : {};
  const avail = availability && typeof availability === "object" ? availability : {};

  const skipped = [];
  const qualified = [];
  for (const route of candidates) {
    const entries = evidence.filter((e) => e && e.route === route && e.outcomeClass === outcomeClass);
    if (entries.length === 0) { skipped.push(`${route}: no evidence`); continue; }
    if (entries.length > 1) { skipped.push(`${route}: ambiguous duplicate evidence`); continue; }
    const entry = entries[0];
    if (avail[route] === false) { skipped.push(`${route}: unavailable`); continue; }
    if (entry.requiresLocalInference === true && avail.localInference !== true) {
      skipped.push(`${route}: local inference not available`);
      continue;
    }
    const why = disqualification(entry, assure);
    if (why) { skipped.push(`${route}: ${why}`); continue; }
    qualified.push(entry);
  }

  if (qualified.length === 0) {
    return failClosed(`no qualified authorized route for ${outcomeClass}${skipped.length ? ` (${skipped.join("; ")})` : ""}`);
  }
  // Lowest cost wins; ties break by candidate order (caller's preference), deterministically.
  let best = qualified[0];
  for (const e of qualified) if (e.relativeCost < best.relativeCost) best = e;
  return { route: best.route, reason: `cheapest qualified route for ${outcomeClass} (relativeCost ${best.relativeCost})` };
}
