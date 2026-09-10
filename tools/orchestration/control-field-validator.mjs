#!/usr/bin/env node
// Deterministic pre-persistence validator for thin-control-state parser-sensitive fields —
// issue #510 (unit 510-A).
//
// Control Issue #499's live corruption: after Stage 2 audit #508 returned NOT CLEAN and the
// repository correctly routed a bounded correction to PR #509, the compact snapshot recorded
// a canonical "Stage 2" field whose own value embedded a *second* parseable pointer as
// parenthetical prose:
//
//   - **Stage 2:** https://github.com/LouPineWays/Loop-Dee-Loup/issues/508 — Verdict: NOT
//     CLEAN (correction dispatched as PR #509; a fresh Stage 2 audit is required once #509
//     merges)
//
// `next-review-transition-gate.mjs --control-issue 499` then failed closed with AMBIGUOUS —
// correct read-time behavior, but only *after* the corrupt shape was already durable. This
// module closes the gap on the write side: it validates a *proposed* control-Issue body's
// parser-sensitive bold-bullet fields (field-local cardinality, plus pointer kind where the
// field's own name makes the expected kind authoritative) before a caller persists it,
// refusing the write rather than discovering the corruption on the next read.
//
// Deliberately a *new*, small, additive module rather than an extraction of
// ready-dispatch-gate.mjs's or next-review-transition-gate.mjs's existing near-duplicate /
// pointer-cardinality logic (Shared Contract on #510: "Do not extract ... merely for
// tidiness if a smaller diff ... satisfies #510's acceptance criteria with less risk to the
// two already-hardened gates."). Every primitive this module uses — parseControlBullet,
// parseExecutionPointer, findNearDuplicateBulletLabels, isNoneSentinel,
// readExecutionBulletField, describeExecutionConflict — is imported verbatim from
// ready-dispatch-gate.mjs, the same parser/guard logic next-review-transition-gate.mjs's own
// "PR"/"Stage 2" reading (parseOptionalIssueRefGuarded) already trusts. This module does not
// reinterpret what a pointer or a near-duplicate label is; it only decides, generically, when
// a *proposed write* should be refused before it becomes durable state.
//
// Field-local, not whole-body: each field spec below is validated against its own bullet's
// own value only. Historical/relationship prose elsewhere in the body (or inside a different
// field's own value) never contaminates a different field's parse result, and a body naming
// several distinct fields that each carry exactly one pointer (e.g. "PR: #509" alongside
// "Stage 2: #508") is not ambiguity — see #510's acceptance criteria and verification cases
// 3 and 4.
//
// Pointer kind: current authority (parseExecutionPointer) does not distinguish "#N" from a
// full pull/issue URL when counting references — both are folded into the same numeric
// pointer set, and that latitude is preserved here unchanged (a bare "#N" never fails a kind
// check, since no kind information exists to check it against). Only when a field's *own*
// value is expressed as a full GitHub URL does that URL's own path segment ("/pull/" vs
// "/issues/") get compared against the field's expected kind — using information the existing
// regex already extracts and discards, never a new syntax or a semantic inference about what
// a bare number "probably" means. "PR" expects a pull-kind URL when a URL is used at all;
// "Execution"/"Execution issue" and "Stage 2" expect issue-kind URLs, since neither ever names
// a pull request in this repository's own two-plane vocabulary.
//
// Tests: node --test tools/orchestration/control-field-validator.test.mjs

import {
  parseControlBullet,
  parseExecutionPointer,
  isNoneSentinel,
  findNearDuplicateBulletLabels,
  readExecutionBulletField,
  describeExecutionConflict,
} from "./ready-dispatch-gate.mjs";

// Pure. Extracts { kind, number } for every full GitHub issue/PR URL reference inside `value`
// — kind is "pull" for a "/pull/N" path segment, "issue" for a "/issues/N" one. A bare "#N"
// reference carries no URL and therefore no kind information at all; this function only ever
// reports on URL-shaped references, mirroring parseExecutionPointer's own `urlRefs` regex
// (`/\/(?:pull|issues)\/(\d+)/g`) so the two stay in lockstep rather than drifting into a
// second, slightly different URL-matching rule.
export function extractUrlPointerKinds(value) {
  if (typeof value !== "string") return [];
  const pattern = /\/(pull|issues)\/(\d+)/g;
  return [...value.matchAll(pattern)].map((m) => ({ kind: m[1] === "pull" ? "pull" : "issue", number: Number(m[2]) }));
}

// Pure. Validates one already-extracted field value against cardinality (reusing
// parseExecutionPointer verbatim — zero or multiple recognized pointers fails) and, when
// `expectedKind` is given, pointer kind for any URL-shaped reference the value contains. A
// value of `null`/`undefined` means the field's bullet was simply not present in the body at
// all — that is not itself a validation failure here (field presence/requiredness is a
// read-time gate concern this module does not own); an explicit "none" sentinel is valid.
export function validatePointerFieldValue(rawValue, { label, expectedKind = null } = {}) {
  if (rawValue === null || rawValue === undefined) {
    return { ok: true, present: false };
  }
  if (isNoneSentinel(rawValue)) {
    return { ok: true, present: true, sentinel: "none" };
  }
  const parsed = parseExecutionPointer(rawValue);
  if (!parsed.ok) {
    return { ok: false, present: true, reason: `"${label}" field ${JSON.stringify(rawValue)}: ${parsed.reason}` };
  }
  if (expectedKind) {
    const wrongKind = extractUrlPointerKinds(rawValue).find((p) => p.kind !== expectedKind);
    if (wrongKind) {
      return {
        ok: false,
        present: true,
        reason:
          `"${label}" field ${JSON.stringify(rawValue)} names a ${wrongKind.kind}-kind reference ` +
          `(#${wrongKind.number}), but this field requires a ${expectedKind}-kind reference`,
      };
    }
  }
  return { ok: true, present: true, issue: parsed.issue };
}

// The parser-sensitive fields ready-dispatch-gate.mjs / next-review-transition-gate.mjs
// already structurally trust (#510 Required Behavior #1: "At minimum preserve the existing
// structured semantics for fields used by ready-dispatch-gate.mjs / next-review-transition-
// gate.mjs, including current execution, PR, and Stage 2 references."). "Execution" carries
// its own alias ("Execution issue") and near-duplicate/alias-conflict handling already
// implemented by readExecutionBulletField — reused directly rather than re-derived.
export const DEFAULT_CONTROL_FIELD_SPECS = [
  { label: "Execution", isExecutionField: true, expectedKind: "issue" },
  { label: "PR", expectedKind: "pull" },
  { label: "Stage 2", expectedKind: "issue" },
];

// Pure. Validates one field spec against a proposed control-Issue body. Returns
// { ok: true, label, ... } or { ok: false, label, reason }.
export function validateControlField(body, spec) {
  const { label, expectedKind = null, isExecutionField = false } = spec;

  if (isExecutionField) {
    const field = readExecutionBulletField(body);
    if (field.conflict) {
      return { ok: false, label, reason: describeExecutionConflict(field) };
    }
    return { ...validatePointerFieldValue(field.value, { label, expectedKind }), label };
  }

  const raw = parseControlBullet(body, label);
  if (raw !== null) {
    const nearDuplicates = findNearDuplicateBulletLabels(body, label);
    if (nearDuplicates.length > 0) {
      return {
        ok: false,
        label,
        reason:
          `"${label}" reference is ambiguous: recognized "- **${label}:**" bullet (${JSON.stringify(raw)}) coexists ` +
          `with unrecognized near-duplicate label(s) ${nearDuplicates
            .map((m) => `"- **${m.label}:**" (${JSON.stringify(m.raw)})`)
            .join(", ")} that could represent the same live field — refusing to select the canonical value as ` +
          "authoritative",
      };
    }
  }
  return { ...validatePointerFieldValue(raw, { label, expectedKind }), label };
}

// Pure. Validates every field spec in `fields` (default: DEFAULT_CONTROL_FIELD_SPECS) against
// a proposed control-Issue body. Returns { ok: true } when every field's own value satisfies
// its cardinality/kind contract, or { ok: false, errors: [reason, ...] } naming every field
// that failed — field-local: a field that is simply absent from the body never contributes an
// error, and one field's value never contaminates another's result. This is the "smallest
// deterministic guard that validates the resulting parser-sensitive control fields before
// writing them durably" #510 Required Behavior #1 asks for; it has no opinion on *how* a
// caller obtains a proposed body or *what* it does with an invalid result — see
// write-control-snapshot.mjs for the write-before-validate-ordering caller this module was
// built for.
export function validateControlSnapshot(body, { fields = DEFAULT_CONTROL_FIELD_SPECS } = {}) {
  const errors = [];
  for (const spec of fields) {
    const result = validateControlField(body, spec);
    if (!result.ok) errors.push(result.reason);
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
