---
name: telemetry-battery
description: Run the approximately-weekly /spend + maker telemetry validation battery, gating optimization conclusions on telemetry coverage rather than assuming instrumentation is sufficient.
---

# Telemetry battery

For issue #199: validate the telemetry system itself, on a cadence, separately from
optimizing LDL. Invoke roughly weekly, after real LDL/consumer activity has accumulated —
never per issue, per merged PR, or per methodology tweak. If the last recorded run in
`docs/telemetry-battery-log.md` is under a week old and no unusual volume of work has
happened since, say so and stop rather than running again.

## Step 1 — telemetry coverage, before any optimization claim

Run `node tools/telemetry/coverage.mjs --sample 15` (or a larger `--sample` if unusually
little happened in the last week). This aggregates `sufficiency.mjs`'s existing per-claim
evidence requirements — `CLAIM_REQUIREMENTS`, the real `/spend` evidence contract — across
the recent session sample, so the "decision-critical fields" list is never a second,
hand-maintained checklist. Do not eyeball `.claude/telemetry/records/*.json` by hand or
invent a different completeness rule.

Read the printed verdict plainly:

- **SUFFICIENT** — every decision-critical field was captured in every sampled session.
  Proceed to Step 2.
- **INSUFFICIENT** — one or more fields are `partial` or `unavailable` (the report names
  them). This is itself the finding for this run. Do not round it up to CLEAN.

A gap that matches an already-documented structural limitation (see
`tools/telemetry/README.md`: statusLine never firing outside an interactive terminal,
`SessionEnd` not always invoked) is not new evidence needing a new issue — it is confirming
prior findings still hold. Only a **newly appeared** gap, a **regressed** previously-captured
field, or the **same** gap persisting across two or more consecutive battery runs without
already having an open tracking issue is worth escalating (see Step 4).

## Step 2 — maker telemetry (repository evidence, not session tokens)

No Claude Code interface exposes a skill-invocation boundary the way it does a
subagent/Task boundary, so `persona-maker` / `script-maker` / `skill-maker` execution can
never be measured from session token telemetry — `coverage.mjs` already reports
`per_skill_token_or_cost_attribution` as structurally not applicable, not silently omitted.
Maker activity is instead evaluated from durable repository evidence: issues/PRs the maker
skills produced since the last battery (new scripts under `tools/`, new skills under
`.claude/skills/`, new personas under `.claude/personas/`, and any issue created by a maker
sweep such as #174). Note counts and whether any produced mechanism has since reduced
recurring reasoning cost — do not re-run the full `/spend → script-maker → skill-maker →
persona-maker` sweep order from issue #174 unless Step 1 is SUFFICIENT and real new evidence
since the last sweep justifies it; a battery run is a validation check, not an automatic
excuse to re-open a maker sweep.

## Step 3 — render the combined verdict

```
Telemetry verdict: SUFFICIENT | INSUFFICIENT
Spend verdict:     CLEAN | NOT CLEAN | INCONCLUSIVE
Maker analysis:    NO ACTIONABLE FINDINGS | <finding>
```

`Spend verdict` may only be `CLEAN` or `NOT CLEAN` when `Telemetry verdict` is `SUFFICIENT`.
An `INSUFFICIENT` telemetry verdict always forces `Spend verdict: INCONCLUSIVE`, regardless
of how clean the available evidence looks — `insufficient evidence + no observed problem`
is not the same claim as `sufficient evidence + no problem found`, and only the second one
is CLEAN. When `Telemetry verdict` is `SUFFICIENT`, apply `.claude/skills/spend/SKILL.md`'s
own evidence order and verdict rules to render `Spend verdict` — this skill does not
duplicate that judgment.

A `SUFFICIENT` / `CLEAN` / `NO ACTIONABLE FINDINGS` run is a successful result, not a
prompt to keep searching for a finding. Stop there.

## Step 4 — record the run and check for a trend

Append one row to `docs/telemetry-battery-log.md` (date, sample size, coverage counts, the
three verdicts, and a one-line note). Keep each row terse — this log exists so a future run
can compare, not as a transcript.

Before opening a new issue over a gap or regression, check the log for the same gap in the
immediately preceding row. One run showing a gap is a data point; the same gap appearing in
two or more consecutive rows (or a field that was previously `captured` regressing to
`partial`/`unavailable`) is a persistent trend worth a follow-up issue. A single-run
fluctuation is not.
