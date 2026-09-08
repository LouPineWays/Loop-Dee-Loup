# Stage 2 audit response contract

This is the single, authoritative, reviewer-facing contract for a Loop-Dee-Loup Stage 2 post-merge
audit. A fresh auditor should be able to read this document in full — nothing else — and know its
role, its allowed and prohibited actions, the exact response shape required, and what CLEAN and
NOT CLEAN mean.

`docs/bounded-review-cycle.md` remains the lifecycle/procedure authority (when to trigger, retry
policy, polling, verdict recording, the correction cycle). The audit Issue created from
`.github/ISSUE_TEMPLATE/audit-control-issue.yml` remains the per-audit data carrier (which commit,
which work issue, which checklist). Neither of those duplicates this document's response format;
this document does not duplicate their procedure or per-audit facts.

## 1. Role

Stage 2 is **independent, read-only assurance over one exact merged commit**, named in the audit
Issue's `Exact merge commit` field.

You may:

- inspect repository files and history;
- inspect the merged PR and its Stage 1 findings/disposition;
- run read-only verification commands and tests;
- inspect CI/GitHub evidence (workflow runs, checks);
- report findings and a verdict.

You must not:

- edit files;
- create commits;
- push branches;
- open or update a pull request;
- apply a finding you discover — report it, do not fix it;
- change the audit Issue's durable lifecycle fields (`Verdict`, etc.) — the controlling session
  promotes those from your response;
- continue into the correction lifecycle.

A finding is reported, not fixed. An attempted mutation invalidates your response as independent
Stage 2 assurance even if the write itself is rejected for lacking permission — a blocked write
is a violated role boundary, not evidence you tried hard enough.

**Enforcement note:** the mechanical parser (`tools/review-watch/stage2-report.mjs`, via
`isGenuineResponse`) only recognizes a mutation attempt as such when your own response discloses a
permission-denied refusal in a recognizable phrasing (e.g. "I don't have write access"). It does
not verify from GitHub state whether a mutation actually occurred, and it does not detect a
mutation attempt described in some other way. Do not treat the absence of a mechanical rejection
as proof no mutation happened — the role boundary above is binding regardless of what current
tooling happens to catch.

## 2. Canonical response skeleton

Emit your response in this exact shape. Copy it and fill in the blanks.

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

Same skeleton, with two differences:

- `## Findings` contains one entry per root cause (deduplicated), each with exact evidence
  (file/line, command output, or quoted text), consequence, and smallest correction;
- the final line is exactly:

```text
Verdict: NOT CLEAN
```

The `Verdict:` label line is the canonical, parser-safe verdict declaration. Use it verbatim —
`Verdict:` at the start of its own line, followed by exactly `CLEAN` or `NOT CLEAN` — as the last
line of your response.

Number every `## Verification` item to match the audit Issue's own `Verification checklist`
field, in the same order (see § 4). State a result for every item — `PASS`, `FAIL`, or `BLOCKED`
(or an equivalent explicit result) — never a bare check with no stated outcome.

## 3. Canonical format vs. compatibility parsing

The skeleton in § 2 is what you should produce. `tools/review-watch/stage2-report.mjs` separately
tolerates several other historical shapes it has observed from real audit responses — a leading
status line (`CLEAN — ...`), a combined heading (`## Stage 2 Audit — CLEAN`), or a standalone
verdict heading (`# CLEAN`). Those exist so past audits are not retroactively broken; they are a
compatibility mechanism, not an authoring guide. Do not study the parser's regular expressions to
find a shorter or cleverer response shape — use § 2's skeleton and the exact `Verdict:` label
line.

## 4. Checklist completion

The audit Issue's `Verification checklist` field is part of this contract, not optional context:

- walk through every item it lists, one by one, under `## Verification`;
- preserve its numbering;
- state an explicit result for every item — never silently omit one;
- do not substitute a command log, a findings list, or general prose for the item-by-item
  walk-through. A response with fewer verification items than the checklist requested is treated
  as incomplete, regardless of how much other text it contains.

Checklist sizing and calibration (how many items a checklist should have, how to group related
sub-checks) is the audit-authoring side's concern, covered in
`docs/bounded-review-cycle.md` Stage 2 step 2 — not this document.

## 5. Verdict semantics

- **CLEAN** — no actionable defect remains against the exact merged commit and the required
  verification contract.
- **NOT CLEAN** — one or more actionable defects remain.
- **PENDING** is lifecycle state before a completed report exists. It is never a verdict you
  declare; it is what the audit Issue's `Verdict` field reads before your response lands.

If you cannot verify something required by the checklist or by this contract, say so explicitly
and fail closed — report NOT CLEAN, or name the specific unresolved item under Founder judgment,
rather than declaring CLEAN with an unverified gap.

This document does not change what counts as an actionable defect; it only makes the existing
standard and response shape explicit.

## 6. Invalid-response examples

These do not back a verdict. Each is a real class of failure this contract exists to prevent, not
an exhaustive incident log:

1. **Findings only, no contract.** A list of issues with no restated merge commit, no checklist
   walk-through, and no `Verdict:` line. Even "nothing material remains" must be reported in the
   full skeleton — a bare finding list is not a completed report.
2. **Bare verdict, no evidence.** `"CLEAN"` or `"looks good"` on its own, with no commit
   restatement and no verification content. A verdict with nothing behind it is not evidence.
3. **Wrong commit.** A response that restates a commit other than the audit Issue's own
   `Exact merge commit` — e.g. a PR head SHA, a different PR's commit, or (Stage 1 review finding,
   issue #335) only the frozen Stage 1 reviewed head. Citing the reviewed head is legitimate for
   the one checklist item that specifically asks for it (control-plane workflow runs are keyed to
   it, not the merge commit — see the audit Issue's checklist instructions), but it never replaces
   restating the actual merge commit under audit.
4. **Contradictory verdicts.** Two or more genuine verdict declarations in the same response that
   disagree (e.g. a `CLEAN` status line but a `Verdict: NOT CLEAN` label later). This fails closed
   to no verdict, not to whichever declaration happened to come first.
5. **Mutation attempt.** A response that edits a file, creates a commit, pushes a branch, or opens
   or updates a PR — or narrates having done so — is not independent Stage 2 assurance, per § 1,
   even if the attempt was rejected for lacking write access.
6. **Self-quoted example mistaken for a declaration.** A response that quotes this document's own
   skeleton (e.g. inside a fenced code block, as an illustration) must not have that quoted example
   read as its actual declaration. Keep any quoted example clearly fenced or indented, and make
   sure your own real declaration is not itself inside a fence or indented block.

## 7. Authority and drift

`docs/stage2-audit-contract.md` (this file, at this path, in the Loop-Dee-Loup repository) is
canonical. `.github/ISSUE_TEMPLATE/audit-control-issue.yml` names this document rather than
re-specifying the response format independently. `docs/bounded-review-cycle.md` references this
document for response format and keeps lifecycle/procedure authority.

A mirror of this contract is published for the founder's **Loop-Dee-Loup Idea Intake** ChatGPT
project so it can author Stage 2 Audit Issues without reconstructing this contract from
conversation history — see `docs/stage2-audit-contract.chatgpt-mirror.md`. That mirror is a
versioned snapshot, not a second specification: on any divergence, this repository file wins.
Whoever next changes this document is responsible for refreshing that mirror (§ "Mirror-refresh
obligation" in the mirror file itself) — there is no automatic synchronization.
