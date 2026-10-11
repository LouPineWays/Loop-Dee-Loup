// Canonical PR supersession metadata contract -- issue #1070 (control #539; the #963/#964/#1021/
// #1026/#1027 recurrence of #1060).
//
// ONE producer/consumer contract. A successor PR affirmatively declares the predecessor it replaces
// with a standalone, top-level body line:
//
//   Supersedes #<predecessor>.
//
// (trailing period optional, case-insensitive, up to three leading spaces). Producers
// (`successor-integration-preflight.mjs`) accept only this form as "canonical"; the downstream Stage 2
// correction-PR gate (`next-review-transition-gate.mjs` `findSupersededCandidates`) and the
// finalizer cross-phase guard recognize exactly the same form via `canonicalSupersededNumbers`. Quoted,
// blockquoted, indented-code, fenced, checklist, struck-through, negated, wrong-number or
// prefix-colliding (`#10210`) text is never a witness.
//
// `referencesLegacySupersede` is deliberately the LOOSE detector (any inline `Supersedes #N` prose,
// the pre-#1070 producer rule). It is never positive authority for a new successor; it only lets a
// caller fail closed on already-existing noncanonical lineage instead of mistaking it for absence.

export function canonicalSupersededNumbers(body) {
  const affirmed = new Set();
  if (typeof body !== "string") return affirmed;
  let fence = null;
  for (const line of body.split(/\r?\n/)) {
    const boundary = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (boundary && boundary[1][0] === fence.char && boundary[1].length >= fence.length) fence = null;
      continue;
    }
    if (boundary) {
      fence = { char: boundary[1][0], length: boundary[1].length };
      continue;
    }
    const marker = line.match(/^\s{0,3}Supersedes\s+#([1-9]\d*)\.?\s*$/i);
    if (marker) affirmed.add(Number(marker[1]));
  }
  return affirmed;
}

export function hasCanonicalSupersede(body, predecessorPr) {
  return canonicalSupersededNumbers(body).has(Number(predecessorPr));
}

export function referencesLegacySupersede(body, predecessorPr) {
  return typeof body === "string" && new RegExp(String.raw`\bSupersedes\s*:?\s*#${predecessorPr}(?!\d)`, "i").test(body);
}
