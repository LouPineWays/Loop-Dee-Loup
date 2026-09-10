# Stage 2 audit contract — ChatGPT project mirror

**Canonical source:** `docs/stage2-audit-contract.md` in `LouPineWays/Loop-Dee-Loup` (GitHub).

**Mirrored revision:** `53738381cb45ba004239347c155fcf6bbd0aeeb9` — the Loop-Dee-Loup commit that
introduced this content. If this snapshot and the live repository file ever disagree, **the
repository file wins**. This file is a versioned reference snapshot for the founder's
**Loop-Dee-Loup Idea Intake** ChatGPT project, not an independently maintained specification.

---

This mirror exists so the Loop-Dee-Loup Idea Intake project can author Stage 2 Audit Issues
(via GitHub's `audit-control-issue` template) without reconstructing the response contract from
conversation history. It carries the same reviewer-role boundary, canonical response skeleton,
verdict semantics, and audit-issue-authoring facts as the repository document. It omits nothing
substantive from that document's contract.

## Role

Stage 2 is independent, read-only assurance over one exact merged commit.

The auditor may: inspect repository files/history, inspect the merged PR and its Stage 1
findings/disposition, run read-only verification commands/tests, inspect CI/GitHub evidence, and
report findings and a verdict.

The auditor must not: edit files, create commits, push branches, open or update a PR, apply a
finding it discovers, change the audit Issue's durable lifecycle fields, or continue into the
correction lifecycle. A finding is reported, not fixed. An attempted mutation invalidates the
response as independent Stage 2 assurance even when the write is rejected for lacking permission.

## Canonical response skeleton

### CLEAN

```markdown
# Stage 2 Audit Report

Exact merge commit: `<full-sha>`

## Severity

| Severity | Count |
| --- | ---: |
| P0 | 0 |
| P1 | 0 |
| P2 | 0 |
| P3 | 0 |

## Findings

None.

## Verification

1. PASS — <check 1 result>
2. PASS — <check 2 result>
...

## Founder judgment

Not required.

Verdict: CLEAN
```

### NOT CLEAN

Copy this skeleton exactly, the same way as CLEAN above. It differs from CLEAN in **three**
places, not two — do not copy CLEAN's all-zero severity table into a NOT CLEAN report: the
severity table's counts reflect actual findings, `## Findings` contains one entry per root cause
(evidence, consequence, smallest correction), and the final line is exactly `Verdict: NOT CLEAN`.

```markdown
# Stage 2 Audit Report

Exact merge commit: `<full-sha>`

## Severity

| Severity | Count |
| --- | ---: |
| P0 | 0 |
| P1 | 1 |
| P2 | 0 |
| P3 | 0 |

## Findings

1. **<root cause>** — <exact evidence: file/line, command output, or quoted text>. Consequence:
   <what breaks>. Smallest correction: <what to change>.

## Verification

1. PASS — <check 1 result>
2. FAIL — <check 2 result>
...

## Founder judgment

Not required.

Verdict: NOT CLEAN
```

The `Verdict:` label line — `Verdict:` at the start of its own line, followed by exactly `CLEAN`
or `NOT CLEAN` — is the canonical, parser-safe verdict declaration in both skeletons. Every
`## Verification` item must be numbered to match the audit Issue's own `Verification checklist`
field, in the same order, with an explicit result (`PASS`/`FAIL`/`BLOCKED` or equivalent) for
every item.

## Verdict semantics

- **CLEAN** — no actionable defect remains against the exact merged commit and the required
  verification contract.
- **NOT CLEAN** — one or more actionable defects remain.
- **PENDING** is lifecycle state before a completed report exists; it is never a verdict the
  auditor declares.

If something required cannot be verified, say so explicitly and fail closed (NOT CLEAN, or name
the specific unresolved item under Founder judgment) rather than declaring CLEAN over a gap.

## Invalid-response examples

Do not produce: (1) a findings list with no restated merge commit, checklist walk-through, or
verdict; (2) a bare `CLEAN`/`looks good` with no evidence; (3) a response citing the wrong commit
(a PR head, a different PR, or only the frozen Stage 1 reviewed head or, for a correction-satisfied
PR, the corrected head — legitimate only for the one checklist item that specifically asks for it,
never a substitute for the actual merge commit); (4) contradictory verdict declarations in the same response; (5) a response
that edits, commits, pushes, or opens/updates a PR (or narrates having done so); (6) a response
whose own quoted example of this skeleton is mistaken for its actual declaration — keep quoted
examples clearly fenced/indented and make sure the real declaration is not itself inside one.

## What Chat needs when authoring a Stage 2 Audit Issue

When constructing an `audit-control-issue` in GitHub from this project, supply:

- **Merged PR** — link to the merged pull request being audited.
- **Work issue** — the implementation issue this audit gates, or the literal word `none` only
  when the merged PR genuinely has no gated implementation issue.
- **Exact merge commit** — the commit SHA on the target branch (not the PR head).
- **Stage 1 inline review disposition** — link the single inline review round and how each valid
  finding was fixed.
- **Audit scope** — the complete current files, applicable instructions, and source-of-truth
  hierarchy the audit covers.
- **Verification checklist** — a numbered, change-specific list of concrete checks against the
  exact merge commit, derived from the actual diff and its acceptance criteria (not generic
  prose). If the change touches a Loop-Dee-Loup control-plane path, include an item confirming
  every workflow whose `paths:` trigger should match the diff shows a completed run, checked
  against the PR's frozen reviewed head SHA — not the merge commit, since control-plane workflows
  trigger only on `pull_request`.

Leave `Findings` as `Pending — awaiting Stage 2 audit response.` and `Verdict` as `PENDING` at
creation. The auditor's response (posted per the canonical skeleton above) supplies Stage 2 report
evidence only — it is a comment, not an Issue-field edit. The auditor does not edit the audit
Issue's durable lifecycle fields; the controlling repository session later promotes `Verdict` from
that response using repository-authorized tooling. `Findings` can remain `Pending` — current
lifecycle tooling promotes only `Verdict` deterministically.

## Mirror-refresh obligation

Whoever next changes `docs/stage2-audit-contract.md` in the Loop-Dee-Loup repository is
responsible for refreshing this mirror in the same change (or as an immediate follow-up): update
this file's content to match, and update the **Mirrored revision** line above to the new commit.
There is no automatic synchronization between the repository and the ChatGPT project — the
founder manually replaces the project's copy of this file with the refreshed one. Do not build a
provider-specific sync service or webhook for this; a stale mirror is expected to happen between
refreshes, which is exactly why this file states that the repository always wins on divergence.
