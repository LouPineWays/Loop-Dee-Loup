# Telemetry battery log

Durable, append-only record of each `telemetry-battery` skill run (issue #199), so
coverage, verdicts, and findings can be compared across runs without re-deriving them from
session logs each time. Add one row per run; do not edit or delete prior rows. Full command
output stays local/transient (`.claude/telemetry/`, gitignored) — this log keeps only the
compact, comparable result.

`docs/telemetry-battery-log.sessions.json` (durable, git-tracked, alongside this file) is
the growing list of every session id any run has already sampled — pass its path to both
`--exclude-ids-file` and `--record-ids` on every run (see `.claude/skills/telemetry-battery/
SKILL.md` Step 1). This, not a row's **As of** timestamp alone, is what guarantees two runs
never double-count the same session: a resumed or still-running session's file keeps
getting touched, so mtime-based `--since` filtering alone cannot prove a session wasn't
already counted (Stage 2 audit finding on PR #203). Still pass a row's **As of** value as
the next run's `--since`, to narrow how much history gets scanned.

| Date | Sample | As of | Fields | Captured | Partial | Unavailable | Telemetry verdict | Spend verdict | Maker analysis | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-08-28 | 15 sessions | 2026-08-28T07:31:28.565Z | 8 | 3 | 2 | 3 | INSUFFICIENT | INCONCLUSIVE (token/cost claims); SUFFICIENT for `compaction_frequency` and `subagent_invocation_pattern` (fully captured, no material finding) | NO NEW EVIDENCE SINCE #174 (2026-08-27, CLEAN) | Initial proving run for issue #199 (`node tools/telemetry/coverage.mjs --sample 15 --exclude-session <this run's own session id> --record-ids docs/telemetry-battery-log.sessions.json`, seeding that file for future runs). Gaps: `measured.cost_usd_total`/`measured.cost_usd_by_model` (statusLine's confirmed non-interactive gap), `measured.token_usage_is_session_complete` (0/15 — no genuine `SessionEnd`-sourced sample in the sample), and `measured.token_usage_main_total`/`measured.token_usage_subagent_total` (partial, 5/15 — post-#178 `SessionEnd`-not-always-invoked gap). All three are already-documented structural limitations, not new discoveries. Per-claim rendering (not a single blended verdict) correctly keeps the fully-evidenced structural claims out of the token/cost claims' INCONCLUSIVE result. No follow-up issue: first row, no prior run to diff against, and every gap is already root-caused in `tools/telemetry/README.md`. |
