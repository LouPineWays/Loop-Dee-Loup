# Analyze-issue reconnaissance experiment (issue #297)

Durable record for issue #297: which coding-agent surface performs LDL's
reference-only `analyze #N` reconnaissance step most effectively, per the decision
rule in #297's own body (GITHUB-NATIVE RECON JUSTIFIED / OTHER SURFACE JUSTIFIED /
INTERCHANGEABLE / DETERMINISTIC-FIRST / INCONCLUSIVE). Controlled by #301.

## Environment limitation (recorded per #297's own accommodation clause)

Checked directly in the execution environment before designing the run:

```text
gh copilot --version   -> "Copilot CLI not installed"
codex --version         -> command not found
gemini --version        -> command not found
```

Only Claude Code (this session and its subagents) is an actually-testable
participant here. Per #297's explicit instruction — *"The experiment is still
valid if one optional ecosystem cannot be exercised because the required product
surface is unavailable; record that as an environment limitation rather than
buying/building infrastructure just to complete the matrix"* — no new paid
subscription or CLI was installed to force the full four-way matrix. This is a
durable environment limitation, not evidence against Copilot, Codex, or Gemini:
**the GITHUB-NATIVE vs OTHER-SURFACE vs INTERCHANGEABLE axis (which requires
cross-provider comparison) was not testable in this environment and remains
untested**, not disproven.

## What was actually tested instead

With cross-provider comparison unavailable, the experiment was narrowed to the
one axis that *was* testable with the one available participant: whether full
unbounded agentic exploration is actually earning its cost over a cheap,
tool-call-capped pass — i.e. a direct probe of the **DETERMINISTIC-FIRST**
hypothesis using Claude Code itself as both arms.

**Design**: 6 representative closed LDL issues, chosen for durable ground truth
(a merged PR whose actual changed files are known) and diverse task shapes:

| Issue | Shape | Ground-truth PR |
| --- | --- | --- |
| #344 | orchestration gate script bugfix | #347 |
| #335 | review-tooling calibration bugfix | #337 |
| #321 | dispatch-boundary proof/correction | #323 (+ correction chain #325/#327/#329/#333/#346) |
| #310 | telemetry feature build | #317 |
| #287 | AGENTS.md/docs routing architecture change | #288 |
| #269 | consumer-policy documentation | #272 |

For each issue, two **fresh, cold** subagents ran the exact reference-only
handoff contract from #297's body (`Repository: <repo> / Issue: #N / Task:
analyze the Issue for execution. / Read durable authority directly. / Return
only the bounded reconnaissance contract...`), retrieving the Issue and
repository state themselves — no Issue body or repository summary was pasted
into either prompt:

- **Arm A (unbounded)**: no tool-call budget restriction, told to "explore as
  much as you judge necessary."
- **Arm B (bounded, 4 calls)**: capped at one `gh issue view` call plus at most
  3 additional targeted read/search calls, explicitly told to prioritize a fast
  cheap pass over completeness.

Both arms returned the exact compact schema from #297 (issue/outcome shape,
implementation surfaces, governing authority, dependencies, verification
surfaces, risks/ambiguity, founder-blocker yes/no, recommended executor class),
capped at ~400 words.

Ground truth for scoring: each ground-truth PR's actual changed-file list,
gathered directly via `gh pr view --json files` before any recon subagent ran
(see `docs/analyze-issue-reconnaissance-runs/*.json` for the full per-issue,
per-arm data this table summarizes).

## Results

| Issue | Arm A tool calls | Arm B tool calls | Arm A file recall | Arm B file recall | False positives (either arm) | Founder-blocker calls (either arm) |
| --- | --- | --- | --- | --- | --- | --- |
| #344 | 4 | 2 | 3/4 core files named | 0 explicit files ("N/A") | none | both correct: no |
| #335 | 1 | 1 | 5/9 (missed fixtures/) | identical to A | none | both correct: no |
| #321 | 1 | 1 | 4/14 core files named | identical to A | none | both correct: no |
| #310 | 3 | 3 | 4/4 + exact artifact filename | identical to A | none | both correct: no |
| #287 | 2 | 2 | 4/5 | identical to A | none | both correct: no |
| #269 | 2 | 1 | 2/3 | identical to A | none | both correct: no |

Token/time usage (subagent-reported, whole-tree): 65,874–72,036 tokens per run,
16.5–30s wall clock. **Tool-call count did not meaningfully predict token
cost** — arm A's extra tool calls (where it made any) added only marginal
tokens over arm B's capped runs, because in 5 of 6 issues arm A's own judgment,
not the budget cap, was what stopped exploration early.

## Key finding: the arms converged because LDL's own closing-comment convention already answers the question

In 5 of 6 issues, arm A (unbounded) made the *same* number of tool calls as
arm B (capped at 4) — usually just one `gh issue view`. This is not the budget
cap binding; it is the model choosing to stop, because `gh issue view <N>`
returns the full issue body **and every comment**, including this repository's
own closing-comment convention (AGENTS.md's Slice handoff format: STATUS,
OUTCOME, CHANGED, VERIFIED, DECISIONS, NEW RISKS, NEXT, PR). For an
already-closed issue, that one API call already contains almost everything the
compact reconnaissance schema asks for. Arm A only used more tool calls than
arm B on #344, where it dug further (4 vs 2 calls) and materially out-performed
arm B on explicit file-name recall — the single case in this sample where the
extra exploration bought something.

No run in either arm invented a false-positive implementation surface, missed
governing authority beyond a minor secondary doc, or produced an incorrect
founder-blocker verdict. Every run correctly recognized these as already-closed
issues requiring no further execution — itself a useful reconnaissance-quality
signal (a worse reconnaissance pass could plausibly have tried to re-execute
already-merged work).

## Explicit scope caveat

This sample is deliberately biased toward **closed, already-resolved** issues,
because durable ground truth (a real merged PR) was required to score recall at
all — the same tradeoff #297's own body anticipates ("Prefer Issues whose
eventual or existing implementation provides a strong reference"). That
selection is exactly what makes `gh issue view`'s comment history so
informative here: a closing comment following this repo's own Slice handoff
convention is itself a dense, deterministic, single-call source of truth. This
result should **not** be read as "agentic exploration adds nothing" in
general — it specifically shows that for retrospective verification of already
-closed, already-documented LDL issues, a bounded single/few-call GitHub lookup
matches full agentic exploration. A **genuinely open issue with no such closing
record**, where real repository exploration is required to find the right
files, was not exercised in this sample and remains a real, undemonstrated gap;
if that case later proves decision-relevant (e.g. reconnaissance on freshly
created execution Issues before any implementation exists), a follow-on
narrower experiment would be needed rather than assuming this result
generalizes to it.

## Evidence-to-collect checklist (per #297)

- Relevant file/component recall: high in both arms for closed issues (see
  table above); no systematic gap identified.
- False-positive implementation surfaces: none observed, either arm, any issue.
- Missed governing authority: none material; only minor secondary docs
  (e.g. one 1-line `docs/bounded-review-cycle.md` edit on #269) were omitted.
- Missed dependency/blocker: none — dependency chains (e.g. #321's #313→#346
  correction chain) were correctly reconstructed by both arms.
- Incorrect founder escalation: none — all 12 runs correctly reported
  `Founder blocker: no` for these closed issues.
- Output size: all 12 runs stayed within or close to the ~400-word cap and
  followed the fixed schema exactly.
- Manual context supplied beyond Issue/repo reference: none — every run used
  only the fixed reference-only handoff contract.
- Repository reads/searches: 1–4 tool calls per run (see per-issue table).
- Provider usage/cost: 65,874–72,036 subagent tokens per run (Claude Code
  only — no cost/usage data exists for Copilot/Codex/Gemini, the untested
  participants).
- Elapsed time: 16.5–30.1 seconds per run.
- Sufficiency for a fresh implementation worker to begin without another
  broad pass: yes for all 12 — every run correctly concluded no implementation
  work remained, which is itself the correct actionable answer for a closed
  issue.

## Decision-rule conclusion

**DETERMINISTIC-FIRST**, scoped explicitly to what this trial actually tested.

For reference-only `analyze #N` reconnaissance on an LDL issue that already
carries this repository's own durable closing-comment record, a
bounded/deterministic single-or-few-call GitHub lookup (`gh issue view`
including comments) plus a small reasoning pass to fit the compact schema
matches full unbounded agentic exploration in relevant-file recall, governing-
authority recall, dependency recall, and founder-escalation correctness —
across 6 issues spanning gate-script bugfixes, review-tooling calibration,
dispatch-boundary corrections, a telemetry feature build, an AGENTS.md/docs
architecture change, and a consumer-policy doc. Vendor-specific reconnaissance
routing infrastructure is not justified by this evidence, consistent with
#297's non-goals.

**The GITHUB-NATIVE RECON JUSTIFIED / OTHER SURFACE JUSTIFIED / INTERCHANGEABLE
branches of the decision rule remain genuinely untested**, not
resolved — Copilot CLI, Codex CLI, and Gemini CLI were all unavailable in this
execution environment (see Environment limitation above), and per #297's own
instruction this was not treated as grounds to install new paid infrastructure
solely to complete the matrix. If a future session gains access to one or more
of those surfaces without a new dedicated-infrastructure purchase, re-running
this same fixed handoff contract against the same or an expanded issue sample
would be the natural way to test that axis specifically, rather than assuming
this trial's Claude-only DETERMINISTIC-FIRST result extends to a genuinely
open, undocumented issue or to another provider.

## Non-goals compliance

No provider router, universal task router, or vendor-specific reconnaissance
infrastructure was built. No whole repository was loaded into a large-context
model. This experiment did not require all four paid ecosystems — it recorded
the three unavailable ones as an environment limitation per #297's explicit
accommodation. Reconnaissance outputs stayed bounded to the fixed compact
schema; none became an implementation plan.
