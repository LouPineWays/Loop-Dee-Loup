---
name: telemetry-battery
description: Run the approximately-weekly /spend + maker telemetry validation battery, gating optimization conclusions on telemetry coverage rather than assuming instrumentation is sufficient.
---

# Telemetry battery

For issue #199: validate the telemetry system itself, on a cadence, separately from
optimizing LDL. Invoke roughly weekly, after real LDL/consumer activity has accumulated —
never per issue, per merged PR, or per methodology tweak. If the last recorded row in
`docs/telemetry-battery-log.md` is under a week old and no unusual volume of work has
happened since, say so and stop rather than running again.

## Step 1 — telemetry coverage, before any optimization claim

Run:

```
node tools/telemetry/coverage.mjs --all
    --exclude-ids-file docs/telemetry-battery-log.sessions.json
    [--exclude-session <this session's id, if known>]
    --json
```

(On the very first run, `docs/telemetry-battery-log.sessions.json` does not exist yet —
`--exclude-ids-file` against a missing file is the same as excluding nothing.) Do **not**
pass `--record-ids` on this invocation — recording happens later, in Step 4, only once the
result is durably written. `--all` scans every session not already excluded, regardless of
mtime; `docs/telemetry-battery-log.sessions.json` (durable, git-tracked, growing only via
`--record-ids`) is what actually guarantees two runs never double-count the same session.
Neither `--since` nor `--sample` (mtime-based alternatives `coverage.mjs` also supports) is
a disjointness guarantee: a resumed or still-running session's file keeps getting touched,
so its mtime can cross a cutoff again even though it was already counted, and an advancing
cutoff can permanently drop a session that was only ever temporarily excluded (never
recorded) if it happens to stop being touched before catching up to a later cutoff (both
found — the first demonstrated by the battery's own live session — in review of PR #203/
#205). `--all` has neither failure mode because it never filters on mtime.

If the resulting sample is empty, there is not yet enough new activity — say so and stop;
there is nothing to record. Pass `--exclude-session` with this invoking session's own
session id when it is knowable (e.g. from the running session's own telemetry log); a
still-running session has no `SessionEnd`/whole-session measurement yet and, left in the
sample, would inject a guaranteed partial/unavailable result purely from still being open.
This exclusion is intentionally not durable (never add it to
`docs/telemetry-battery-log.sessions.json` by hand): once the session completes, a later
run's `--all` scan picks it up normally, with no cutoff to catch up to. If the id can't be
determined, note that limitation in the run's log row rather than silently accepting a
skewed sample.

This aggregates `sufficiency.mjs`'s existing per-claim evidence requirements —
`CLAIM_REQUIREMENTS`, the real `/spend` evidence contract — across the sample, applying the
exact predicate each field needs (present / positive / exactly true), so the
"decision-critical fields" list and their pass/fail rule are never a second, hand-maintained
checklist. Do not eyeball `.claude/telemetry/records/*.json` by hand or invent a different
completeness rule.

Read the printed verdict plainly:

- **SUFFICIENT** — every decision-critical field was captured in every sampled session.
- **INSUFFICIENT** — one or more fields are `partial` or `unavailable` (the report names
  them). Do not round this up to CLEAN for the overall run (see Step 3).

A gap that matches an already-documented structural limitation (see
`tools/telemetry/README.md`: statusLine never firing outside an interactive terminal,
`SessionEnd` not always invoked) is not new evidence needing a new issue — it is confirming
prior findings still hold. Only a **newly appeared** gap, a **regressed** previously-captured
field, or the **same** gap persisting across two or more consecutive battery runs (guaranteed
disjoint by the `--exclude-ids-file`/`--record-ids` mechanism above — see Step 4) is worth
escalating.

## Step 2 — maker telemetry (repository evidence, not session tokens)

No Claude Code interface exposes a skill-invocation boundary the way it does a
subagent/Task boundary, so `persona-maker` / `script-maker` / `skill-maker` execution can
never be measured from session token telemetry — `coverage.mjs` already reports
`per_skill_token_or_cost_attribution` as structurally not applicable, not silently omitted.
Maker activity is instead evaluated from durable repository evidence. Keep two distinct
questions apart (issue #262): whether mechanisms the makers already produced are working,
and whether new evidence justifies a mechanism that does not exist yet. "No maker artifact
was created this run" is not the same finding as "no maker candidate exists" — the first is
Existing-mechanism validation, the second is New-candidate discovery, and a run reports both.

### Existing-mechanism validation

Note issues/PRs the maker skills produced since the last battery/maker analysis (new
scripts under `tools/`, new skills under `.claude/skills/`, new personas under
`.claude/personas/`, and any issue created by a maker sweep such as #174 or #226). For each,
record whether it is being reused and whether it has reduced recurring reasoning/manual
work, or `none new` if nothing appeared. Do not re-run the full `/spend → script-maker →
skill-maker → persona-maker` sweep order from issue #174 merely because this step ran — a
battery run is a validation check, not an automatic excuse to re-open a maker sweep.

### New-candidate discovery

Separately, perform a bounded discovery pass over the smallest durable evidence window
needed to detect recurrence — not a rerun of the full maker-sweep stack, and never
triggered by session or sample count alone (a large cohort establishes that enough real
work happened to inspect; it is not itself evidence of a reusable pattern).

1. Start from new durable repository evidence since the last maker analysis/battery:
   relevant issues, PRs, review/audit outcomes, and closure comments, plus this run's own
   `/spend` evidence. Compute this run's Spend verdict now, before finishing this discovery
   pass, by applying Step 3's per-claim evidence-sufficiency rules
   (`.claude/skills/spend/SKILL.md`) to Step 1's coverage output — Step 3 is where that
   verdict is *rendered* together with the other two, but discovery needs it as an input
   here, not merely as something rendered afterward.
2. Use session telemetry only for claims it can actually support (structural
   subagent/compaction patterns, token allocation where sufficient). Do not mine raw
   prompt/reasoning transcripts for semantic recurrence merely to manufacture a candidate.
3. **Bounded diagnostic-trace evidence (issue #310).** When a concrete orchestration,
   routing, or dispatch-duplication claim is under investigation, check
   `docs/diagnostic-traces/index.json` for a relevant entry (matching control/execution
   issue numbers, or a `pre_dispatch_status: "violation"` row worth explaining) before
   deciding evidence is unavailable. This index is metadata-only (session, control/
   execution issue, path, `pre_dispatch_status`) — read it freely, but open an individual
   trace file (`tools/telemetry/diagnostic-trace.mjs`'s output; see
   `tools/telemetry/README.md`) only when it actually bears on the claim at hand, never as
   a routine sweep. Never scan raw Claude transcripts directly from this step. Never load
   every diagnostic trace by default. A trace's presence supports the specific claim its
   fields actually represent (e.g. `execution_issue_read_by_controller_before_dispatch`,
   `dispatch_prompt.reference_only`) — it is opt-in proving/debug evidence, not a
   representative sample: do not extrapolate it into a fleet-wide rate or percentage, and
   the *absence* of a trace is not evidence the behavior did or did not occur. This does
   not replace or weaken Step 1's coverage contract or any maker's own evidence bar; it is
   one additional, bounded evidence source this step may consult.
4. Identify concrete repeated friction or repeated work classes, if any, from that evidence.
5. **Cross-window recurrence.** The discovery window is not a hard temporal boundary on when
   a pattern may have begun. A plausible candidate may have first appeared before the
   previous maker analysis and fallen short of the evidence bar then; new evidence can make
   that older signal materially clearer (another occurrence, a revealed common cause, an
   expertise boundary now shown to recur). When new evidence points to a plausible pattern,
   follow it backward into targeted older issues/PRs/audits as needed to establish its full
   recurrence history — do not reload the whole repository history, and do not require every
   qualifying occurrence to be new. Conversely, do not re-litigate an old rejected/deferred
   candidate merely because time passed: reconsidering one requires new material evidence
   that strengthens, changes, or completes its recurrence case, not just its age. A prior
   `NO CHANGE WARRANTED` remains correct for the evidence available at that time.
6. Check existing scripts, skills, personas, governing rules (`AGENTS.md`, this file, other
   skills), and open issues before treating anything as a new candidate — an existing
   mechanism (including one already fixed by a governing-rule or skill-text correction that
   the next occurrence confirms holds) makes the candidate `NO CHANGE WARRANTED`, not a
   duplicate recommendation.
7. Apply the existing cheapest-mechanism hierarchy to whatever remains: a deterministic
   repeated operation with at least two real prior instances routes to Script Maker; a
   recurring judgment/workflow that cannot be reduced cleanly to a script routes to Skill
   Maker; a recurring expertise/context boundary routes to Persona Maker; otherwise it is
   ordinary one-off instructions or is declined. Do not weaken any maker's own evidence bar
   to manufacture a candidate.
8. Record an explicit disposition for each maker category — `CANDIDATE` (with the recurring
   problem, the evidence supporting it, whether that evidence spans earlier and current
   windows, why an existing mechanism does not already solve it, and why this is the
   cheapest safe mechanism) or an evidence-backed `NO CHANGE WARRANTED`.

The battery does not implement a `CANDIDATE` finding itself, and a `CANDIDATE` does not halt
the run: Step 3 still renders the combined verdict and Step 4 still records the log row, the
run artifact, and the sampled session ids exactly as it would for `NO CHANGE WARRANTED`. A
qualified independent recommendation instead becomes its own implementation-ready issue
under normal LDL issue-intake rules — intake, not the battery run, stops at the
recommendation without implementing it.

## Step 3 — render the combined verdict

```
Telemetry verdict: SUFFICIENT | INSUFFICIENT
Spend verdict:     CLEAN | NOT CLEAN | INCONCLUSIVE (per material claim)

Maker analysis
  Existing mechanisms:
  - <mechanism>: effective | ineffective | insufficient evidence | none new
  Candidate discovery:
  - Script Maker:  CANDIDATE | NO CHANGE WARRANTED
  - Skill Maker:   CANDIDATE | NO CHANGE WARRANTED
  - Persona Maker: CANDIDATE | NO CHANGE WARRANTED
```

A compact equivalent (e.g. folded into the log row's one-line note) is acceptable — this is
not a mandate for a verbose permanent report format. Every `CANDIDATE` line must still carry
its source-linked evidence somewhere in the durable record (the log row's note, or a linked
issue); a bare `CANDIDATE` label with no evidence is not a completed disposition.

Apply `.claude/skills/spend/SKILL.md`'s own per-claim evidence-sufficiency rules — this
skill does not duplicate or override that judgment, and does not collapse it into one
blended verdict. `Telemetry verdict: INSUFFICIENT` here means at least one decision-critical
field is not reliably captured across the sample; it prohibits reporting the run's *overall*
economic picture as `CLEAN` (an unqualified "expenditure was fine" claim resting on gapped
evidence), but it does **not** by itself force every individual claim to `INCONCLUSIVE`.
`monetary_cost_by_model` is always `INSUFFICIENT` today (no local pricing table) — if that
were treated as a global gate, `Spend verdict` could never be anything but `INCONCLUSIVE`,
permanently masking a real `NOT CLEAN` finding on a claim (e.g. `compaction_frequency`,
`subagent_invocation_pattern`) whose own evidence is actually `SUFFICIENT`. Render each
material claim's verdict on its own evidence, exactly as `/spend` already does; use the
overall `Telemetry verdict` only to decide whether an *overall* CLEAN summary is permitted.

A `SUFFICIENT` / `CLEAN` run whose maker analysis reports `none new` and
`NO CHANGE WARRANTED` across all three categories is a successful result, not a prompt to
keep searching for a finding. Stop there.

## Step 4 — record the run, then record the ids, then check for a trend

First, append one row to `docs/telemetry-battery-log.md`: date, sample size, the sample's
**As of** value (`coverage.mjs`'s printed value — informational only, not an input to a
future run), coverage counts, the three verdicts, and a one-line note. `docs/
telemetry-battery-log.md` is append-only: never edit or rewrite a prior row, even to add
detail a later mechanism change makes possible — add a new row or a dated note below the
table instead.

Also save this run's Step 1 `coverage.mjs --json` output verbatim to
`docs/telemetry-battery-log-runs/<date>.json` (a new, durable, git-tracked file per run —
the raw `.claude/telemetry/sessions/*.jsonl` session logs behind it stay correctly
local/transient and gitignored, but this JSON output is itself just aggregate counts and
field statuses, no session content, so it carries no more disclosure risk than the row's own
summary text already does). Without this, the row's coverage numbers and **As of** value are
not independently reproducible from a checkout that lacks the original local session logs —
found by the Stage 2 audit on issue #240 after the 2026-08-31 row shipped without it.

Only once that row and artifact are durably written, record this run's sample as counted:

```
node tools/telemetry/coverage.mjs --session <id1> --session <id2> ... \
    --record-ids docs/telemetry-battery-log.sessions.json --json
```

using the exact `sessionIds` array Step 1's JSON output reported (never the excluded
invoking session's own id — see Step 1). Doing this only after the row exists means an
interrupted run (crash, context loss, founder interrupt) between Step 1 and this point
leaves nothing recorded, so a later run's `--all` scan safely re-samples the same sessions
instead of silently excluding evidence no durable row ever accounted for (Stage 1 review
finding on PR #205).

Before opening a new issue over a gap or regression, check the log's immediately preceding
row. Because every run's sample is guaranteed disjoint from every prior run's (Step 1's
`--exclude-ids-file`, backed by this step's `--record-ids`), a repeated gap across two
consecutive rows is genuinely two independent confirmations, not the same stale evidence
(or the same resumed/still-running session) counted twice — treat that repetition (or a
field that regressed from `captured` to `partial`/`unavailable`) as a persistent trend worth
a follow-up issue. A gap appearing only in the first-ever run (no prior row to compare
against), or one that already has an open tracking issue, is not new escalation-worthy
evidence.
