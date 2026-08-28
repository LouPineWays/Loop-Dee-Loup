---
name: stage1-classifier-hardening
description: Diagnose and fix a reported false-positive or false-negative in Stage 1's genuine-response classifier (tools/review-watch/genuine-response.mjs) — isGenuineResponse, findExemption, and the primitives they compose.
---

# Stage 1 classifier hardening

**Trigger:** a new misclassification is reported against `tools/review-watch/genuine-response.mjs` — a genuine Codex review wrongly gated as non-genuine (or vice versa), a BLOCKED/refusal/Codex-Cloud-setup reply wrongly accepted as a real review, or a PR-body `Stage 1 exemption:` declaration wrongly matched or missed by `findExemption`.

**Out of scope:** state-machine / correlation-logic defects — binding a response to the wrong frozen PR head, re-triggering across fix-commit heads, or anything about *which* comment/timestamp is being evaluated rather than *how a given piece of text classifies*. Those (e.g. issues #163, #165) are structurally different, single-occurrence defects. Route them through the normal bounded-review-cycle correction, not this skill.

## Procedure

1. **Reproduce with the real input.** Production callers never classify a full comment body — `findAllMatches` truncates it to `body_excerpt = body.slice(0, 200)` before `isGenuineResponse`/`findExemption` ever see it (`poll.mjs`; consumed in `stage1-gate.mjs`, `trigger.mjs`, `lifecycle-gate.mjs`). Reproduce from that exact 200-character excerpt, not the full reported body — a longer input can hide or reveal signals past character 200 and make the reproduction not match production behavior.
2. **Rule out a duplicate.** Check the input against every existing guard function (`isCodexCloudSetupPrompt`, `stripLeadingMarkdownWrapper`, `isSelfReferentialRefusal`, `BLOCKED_STATUS_PATTERN`, `ELLIPTICAL_REFUSAL_PATTERN`, `EXEMPTION_PATTERN`/`blankFencedBlocks`) and every case already in `tools/review-watch/*.test.mjs` — this may already be fixed, or be a near-neighbor of a documented boundary.
3. **Scope the fix.** Fix only in this shared LDL module (`genuine-response.mjs` or `stage1-gate.mjs`). Never patch around it in a consumer/target repository.
4. **Extend the narrowest primitive.** Locate the single pattern or function whose boundary is wrong and adjust that — don't bolt on a new isolated regex or a parallel classification path.
5. **Add bidirectional tests.** Two assertions, in opposite classification directions: (a) the reported case now classifies correctly (a false negative's non-genuine input now returns `false`; a false positive's genuine input now returns `true`), and (b) a near-neighbor case of the *other* class is unaffected — for a false-negative fix (tightening), a genuine review discussing or quoting the same syntax still returns `true`; for a false-positive fix (loosening), a real BLOCKED/refusal/setup-prompt variant still returns `false`. Two tests that both assert the same boolean is not bidirectional and can pass while the fix silently over-loosens or over-tightens the guard.
6. **Rerun the full suite.** All of `tools/review-watch/*.test.mjs` must still pass — every previously-fixed boundary documented in `genuine-response.mjs`'s own comments must not regress.

## Stop condition

Stop once the extended primitive passes its new bidirectional tests and the full suite passes unchanged elsewhere. Do not redesign the gate, add coverage for unobserved hypothetical phrasing, or authorize a second review round from inside this skill. If step 3 reveals the defect is actually a correlation/state-machine issue, stop and hand it to the normal bounded-review-cycle correction instead of forcing a text-classifier fix.

## Why this exists

Issues #151, #161, and #162 (fix PRs and Stage 2 audits #155, #164/#167/#168, #173) each independently re-derived this same reproduce → dedupe → scope → narrow-extend → bidirectional-test → full-rerun sequence from scratch. Applying it directly is measurably faster than re-deriving it on the next occurrence.
