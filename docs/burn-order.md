# Loop-Dee-Loup Burn Order

## Purpose

Loop-Dee-Loup improves itself over time — new templates, tighter operating rules, tooling fixes. Those items need a backlog of their own, separate from any target repository's Burn Order (e.g. Covenant's). This document defines that backlog and how items reach it without the founder hand-entering them.

**Never conflate the two.** A target repository's Burn Order is that repository's own prioritized product backlog and stays out of Loop-Dee-Loup entirely. The Loop-Dee-Loup Burn Order below holds only items about the Loop's own process, tooling, and repository — never product features for a target repository.

## The artifact

The Loop-Dee-Loup Burn Order is a real running tool, not just a name for an issue — the same
kind of tool Covenant and Word_Burner each run at `tools/burn-order`, copied and adapted here
(issue [#9](https://github.com/LouPineWays/Loop-Dee-Loup/issues/9)). State lives in
**`docs/burn-order.json`**, tracked in git; the tool itself is documented in
`tools/burn-order/README.md`. Items sit in ordinal heat bands (Now / Soon / Later / Wishes,
plus Blocked and Done outside the running order) and are lane-tagged `process`, `tooling`,
`templates`, or `docs` — Loop-Dee-Loup's own domains, never a target repository's product
lanes. `node tools/burn-order/verify.mjs` checks the file's integrity and gates any PR that
touches it via `.github/workflows/burn-order.yml`.

Issue [#6](https://github.com/LouPineWays/Loop-Dee-Loup/issues/6) remains the pinned index
issue for discoverability, but its body now points here rather than holding the candidate list
itself — `docs/burn-order.json` is the source of truth.

### Running it

```
node tools/burn-order/server.mjs
```

Then open <http://localhost:4137>. No build step, no dependencies. Also registered in
`.claude/launch.json` as `burn-order`. On Windows, double-click
`tools/burn-order/Run Burn Order.bat` instead.

## Intake

The founder logs a raw idea with the `idea-intake` issue template (`.github/ISSUE_TEMPLATE/idea-intake.yml`) — a couple of short fields, fast to fill from a phone, no free-form issue writing required.

## Conversion

When a session is dispatched on (or resumes chat about) an open `idea-intake` issue:

1. Read the raw idea. If it is genuinely ambiguous, ask one direct concise question in chat per the founder interrupt conditions — do not open a full decision form for a single-item backlog entry unless it exposes a real multi-option founder decision.
2. Once clear, write it as one ironed-out outcome line (not an activity, not raw founder wording).
3. Add it to `docs/burn-order.json`, either by running the tool (`node tools/burn-order/server.mjs`, then use "+ Add item") or by hand-editing the JSON directly — pick a lane, place it in the requested band (append at the bottom of that band by default), and give it a short id and title. Run `node tools/burn-order/verify.mjs` after a hand-edit. Do not ask the founder to copy it in themselves.
4. Close the intake issue with `state_reason: completed`, labeled `converted`, linking to the new item (or to issue #6 as the pinned index).
5. Report the fixed `CLEAN` chat line per `AGENTS.md` § Fixed chat report formats.

## Prioritization

The founder may reorder `docs/burn-order.json` at any time, either through the tool's drag/re-rank UI or by hand-editing the file directly (the running page picks up a hand-edit within ~2 seconds). A session converting a new item appends it at the bottom of its band by default and preserves existing order unless the founder asks for reprioritization.

## Turning a candidate into work

A Burn Order candidate is not yet an execution issue. When the founder picks one to run, derive a `parent-execution` (or directly a `work-packet`) issue from it in the normal way, and update the candidate's entry in `docs/burn-order.json` — a `note` naming the tracking issue is enough — rather than leaving it looking idle in the Burn Order. Move it to Done with a `done:{}` block, per `tools/burn-order/README.md`, once the work actually lands; do not retire it by deleting it from the bands.
