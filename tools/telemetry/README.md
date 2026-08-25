# Session telemetry

A repository-local, deterministic collector for the measurable economics of a Claude Code
session — token/cost/context/subagent facts — without spending any model reasoning to
reconstruct them. Built for issue #45, as one concrete application of the deterministic-
mechanism hierarchy in issue #35 (`script → skill requiring judgment`): this script performs
the measurement; `.claude/skills/spend/SKILL.md` performs the judgment on top of it.

## What collects it, and how

Two Claude Code entry points, wired in `.claude/settings.json`:

- **`statusline.mjs`** — Claude Code's statusLine command. In an interactive `claude` terminal
  session, it's re-invoked on session start, on each new assistant message, on `/compact`
  completion, and a few other local render events — never on a model turn, so sampling it costs
  no API tokens. Its payload carries the session's running cost, context-window usage, and
  identity. This script appends a compact sample to the session's raw log **and** prints the
  actual status line text Claude Code displays — both duties are required, since stdout here is
  not optional. See "statusLine's confirmed non-interactive gap" below: this command has not
  been observed to fire at all in this repository's actual (non-interactive) execution mode.
- **`hook.mjs`** — a Claude Code hook, wired for `SessionStart`, `SessionEnd`, `PreCompact`,
  `PostCompact`, `SubagentStart`, and `SubagentStop`. Each firing appends one structural event
  (a boundary, a compaction, a subagent's identity and lifetime) to the same raw log. It never
  writes to stdout: a `SessionStart` hook's stdout is injected straight into the live session's
  context, and every other event's stdout is simply discarded, so any output here would either
  waste tokens or do nothing.

Both entry points share `collect.mjs`, which owns the on-disk shape and the privacy rule below,
and never throw — a telemetry failure must never interrupt or slow down real session use.

## statusLine's confirmed non-interactive gap

PR #99 shipped `statusLine` wiring without a live confirmation that Claude Code actually
invokes it (no interactive `claude` CLI was available in that session to test against the
real `.claude/settings.json`). Issue #107's dogfood run of `/spend` checked every session log
present at the time — 18 sessions — and found zero `statusline_sample` events, while hook-based
structural events fired correctly in the same sessions. That left one question open: whether
the gap was universal to Claude Code, or specific to non-interactive/SDK-embedded sessions.

Issue #104 resolved it. As of 2026-08-25, this repository's telemetry history spans 20 real
session logs with 57 real hook events and, still, zero `statusline_sample` events — and a
manual synthetic stdin payload confirms `statusline.mjs` itself appends a correct event and
prints the correct status line text when actually invoked (matching what `statusline.test.mjs`
exercises), ruling out a script bug. Official Claude Code documentation resolves the remaining
question: `statusLine` is described purely as "a customizable bar at the bottom of Claude Code"
that "renders in its own row above the built-in footer badges" — an interactive-terminal
rendering surface, not part of the Hooks system — while the Agent SDK / headless docs (`claude
-p`) explicitly state that a non-interactive session "runs the hooks in a project's
`.claude/settings.json`" but never mention `statusLine` anywhere on that page, despite covering
hooks and settings behavior in detail.

**Conclusion, scoped to what's actually verified**: in every real session this repository has
captured — all of them running through whatever non-interactive/Agent-SDK-driven harness has
executed Loop-Dee-Loup work to date — `statusLine` has never fired once, while `hook.mjs` fires
reliably in the same sessions. `statusLine` is documented as an interactive-terminal rendering
surface, not part of the Hooks system, and is absent from the Agent SDK / headless docs where
hooks are explicitly covered — consistent with, but not a direct statement of, non-invocation
in headless mode. This repository has not tested every Agent SDK/headless configuration or
`claude -p` directly, so treat "statusLine doesn't fire outside an interactive terminal" as the
best-supported explanation for the observed evidence, not an exhaustively verified claim about
every non-interactive configuration. Either way, it is not a defect in `statusline.mjs` or the
`.claude/settings.json` wiring — the script and wiring are independently confirmed correct (see
above) — and there is no hook-based substitute for statusLine's cost/context-window payload
today.

Practical effect: `cost_usd_total`, `context_window_size`, `last_context_used_percentage`, and
`last_token_usage` should be assumed unavailable in this repository's normal execution mode —
see the `/spend` skill's evidence order, which checks `statusline_sample_count` before treating
a session's cost/context fields as measured rather than falling straight back to
`/usage`/`/context`. If this collector is ever run from a plain interactive `claude` terminal
session, `statusline_sample` events should appear; that specific case remains undogfooded in
this repository.

## What it deliberately cannot measure

Claude Code hooks and the statusLine payload do not expose per-turn or per-subagent token/cost
breakdowns — only OpenTelemetry does, and enabling OTel effectively requires standing up a
collector, which conflicts with this issue's "no hosted infrastructure" constraint. So this
collector can tell you a subagent *ran*, its type, and when it started and stopped, but not how
many tokens or how much cost it consumed. `reduce.mjs` names this explicitly in the record's
`unknown` list rather than estimating it — see "A field that cannot be measured reliably must
remain unknown" in issue #45's requirements. Likewise, per-turn input/output/cache token
breakdown and rate-limit consumption are unavailable from these interfaces.

## Where the data lives

Raw per-session event logs: `.claude/telemetry/sessions/<session_id>.jsonl` (one compact JSON
object per line — see `fixtures/*.jsonl` for real shapes). Reduced records:
`.claude/telemetry/records/<session_id>.json`. Both are git-ignored (`.claude/telemetry/` in
the repository root `.gitignore`) — this is transient local evidence, not durable repository
state. `LDL_TELEMETRY_DIR` overrides the whole tree, mainly so tests never touch a real
session's data.

## Privacy and data minimization

Only coarse identifiers and numeric measurements are ever written: session id, repo
owner/name, the basename (not full path) of the working directory, model id, cost/token/line
counts, context-window percentages, and (for subagent/compaction events) agent id/type and
compaction trigger. Never: prompts, responses, reasoning, tool output, source file contents,
`transcript_path`, or any other full filesystem path. `collect.test.mjs` and `hook.test.mjs`
assert this directly against payloads that include disallowed fields.

## Reducing a session

```
node tools/telemetry/reduce.mjs <session_id> [--out <path>]
```

Reads the session's raw log and prints a normalized record with three sections —
`measured` (straight from collected events), `derived` (deterministic arithmetic/aggregation),
and `unknown` (evidence this mechanism cannot establish, named explicitly). It also writes the
same record to `--out`, or `.claude/telemetry/records/<session_id>.json` by default.
`reduceEvents()` is exported as a pure function for testing and for direct use from another
script without shelling out.

The reducer never classifies anything as good, bad, wasteful, or efficient — see the
Non-goals section of issue #45. `.claude/skills/spend/SKILL.md` is the layer that applies
judgment, using this record as its primary evidence source instead of reconstructing these
facts from `/usage`, `/context`, or the transcript.

## Tests

```
node --test tools/telemetry/*.test.mjs
```

`reduce.test.mjs` exercises the pure reducer against four representative fixtures: a normal
single-agent session, a session with several subagent invocations, incomplete telemetry (a
session that ended before `SessionEnd` fired and before any statusLine sample landed), and a
session containing a compaction. `collect.test.mjs`, `hook.test.mjs`, and `statusline.test.mjs`
cover the shared helpers and both entry points, including end-to-end subprocess runs with
piped stdin. `reduce.cli.test.mjs` covers the reducer's CLI plumbing.
