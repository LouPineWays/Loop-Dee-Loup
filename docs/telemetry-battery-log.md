# Telemetry battery log

Durable, append-only record of each `telemetry-battery` skill run (issue #199), so
coverage, verdicts, and findings can be compared across runs without re-deriving them from
session logs each time. Add one row per run; do not edit or delete prior rows. Full command
output stays local/transient (`.claude/telemetry/`, gitignored) — this log keeps only the
compact, comparable result.

`docs/telemetry-battery-log.sessions.json` (durable, git-tracked, alongside this file) is
the growing list of every session id any run has already sampled — pass its path to
`--exclude-ids-file` on every run's coverage command, then to `--record-ids` afterward, only
once that run's row below is durably written (see `.claude/skills/telemetry-battery/
SKILL.md` Steps 1 and 4). This, not a row's **As of** timestamp, is what guarantees two runs
never double-count the same session: a resumed or still-running session's file keeps
getting touched, so mtime-based filtering (`--since`/`--sample`) alone cannot prove a
session wasn't already counted, and can even permanently drop one that was only ever
temporarily excluded (Stage 2 audit of PR #203 and Stage 1 review of PR #205 — see
`docs/telemetry-battery-log.sessions.json`'s history and `coverage.mjs`'s `--all` flag,
which is why the recommended invocation no longer uses `--since` at all).

| Date | Sample | As of | Fields | Captured | Partial | Unavailable | Telemetry verdict | Spend verdict | Maker analysis | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-28 | 15 sessions | 2026-08-28T07:31:28.565Z | 8 | 3 | 2 | 3 | INSUFFICIENT | INCONCLUSIVE (token/cost claims); SUFFICIENT for `compaction_frequency` and `subagent_invocation_pattern` (fully captured, no material finding) | NO NEW EVIDENCE SINCE #174 (2026-08-27, CLEAN) | Initial proving run for issue #199 (`node tools/telemetry/coverage.mjs --sample 15 --exclude-session <this run's own session id>`). Gaps: `measured.cost_usd_total`/`measured.cost_usd_by_model` (statusLine's confirmed non-interactive gap), `measured.token_usage_is_session_complete` (0/15 — no genuine `SessionEnd`-sourced sample in the sample), and `measured.token_usage_main_total`/`measured.token_usage_subagent_total` (partial, 5/15 — post-#178 `SessionEnd`-not-always-invoked gap). All three are already-documented structural limitations, not new discoveries. Per-claim rendering (not a single blended verdict) correctly keeps the fully-evidenced structural claims out of the token/cost claims' INCONCLUSIVE result. No follow-up issue: first row, no prior cutoff to diff against, and every gap is already root-caused in `tools/telemetry/README.md`. |
| 2026-08-31 | 6 sessions | 2026-08-31T10:35:33.303Z | 8 | 3 | 2 | 3 | INSUFFICIENT | INCONCLUSIVE (`token_allocation`, `monetary_cost_total`, `monetary_cost_by_model` — accepted #178/#229 structural limitations, unchanged); CLEAN for `compaction_frequency` (0 compactions, 6/6 sessions) and `subagent_invocation_pattern` (2/6 sessions ran subagents, no anomaly) | OUT OF SCOPE — #238 non-goals exclude re-running script-maker/skill-maker/persona-maker; same-day maker sweep already completed in #226 (NO CHANGE WARRANTED, closed 2026-08-31) | Rerun for issue #238, follow-up to #226 (2026-08-31 operational sweep, closed same day) and the #178/#229 "Not recoverable" resolution. Fresh cohort: 6 sessions selected as every completed session-log file with mtime strictly after #226's self-reported evidence-window end (2026-08-31T07:49:25Z), excluding the live session running #238. Exact ids recorded in `docs/telemetry-battery-log.sessions.json`. The 15 ids from the 2026-08-28 row do not overlap (all predate 2026-08-28). #226 never appended a log row or called `--record-ids` for its own cohort (#226 itself flagged this as friction, explicitly out of scope for #226) and its own per-claim sample sizes were inconsistent within the same sweep (82/67/23 across different claims), so its exact session-id membership could not be reconstructed precisely; this run used #226's self-reported window-end timestamp as a conservative, documented cutoff instead, guaranteeing no overlap without estimating unknown membership. Findings: 0/6 sessions show genuine `SessionEnd`-captured `token_usage_is_session_complete` (continues #226's 0/23 and the closed #178/#229 "Not recoverable" conclusion — not reopening #178, no distinct contradictory evidence); 0/6 `cost_usd_total` (continues the documented statusLine non-interactive gap); 0 compactions across 6/6 sessions (continues #226's 0/82, CLEAN); 2/6 sessions ran subagents (4 starts each), 4/6 ran none — ordinary variance, no anomaly. No coverage regression or improvement vs #226; differences are cohort size/window only (6 sessions over ~3 hours vs #226's 23-82 over ~1 week), not an instrumentation change. No new follow-up issue warranted. |

**2026-08-28 migration note** (not a battery run — added by the issue #204/#205 correction,
after the row above was already written): `docs/telemetry-battery-log.sessions.json` and
`coverage.mjs`'s `--exclude-ids-file`/`--record-ids`/`--all` did not exist when the row above
ran. Introducing them retroactively seeded `docs/telemetry-battery-log.sessions.json` with
the same 15 session ids that row already reported sampling, so the next real battery run
correctly treats them as already counted instead of re-sampling them. The row above is left
as originally written (append-only) rather than rewritten to claim it used a mechanism that
did not exist yet.
