# Loop-Dee-Loup priority horizons

## Purpose

Loop-Dee-Loup improves itself over time — new templates, tighter operating rules, tooling fixes. Those items need prioritization of their own, separate from any target repository's own backlog (e.g. Covenant's Burn Order).

**Never conflate the two.** A target repository's own backlog mechanism stays out of Loop-Dee-Loup entirely. The priority horizons below hold only items about the Loop's own process, tooling, and repository — never product features for a target repository.

## The model

The GitHub Issue is the backlog item. There is no separate ordinal file, database, or synchronized state to keep in step with it.

Four mutually exclusive labels express the founder's current execution horizon for an accepted, open Issue:

- **`priority:now`** — the explicitly defined set of Issues LDL is working toward right now. Now is a bounded current pipeline/campaign, not a synonym for “important,” “core,” or “high severity.” An Issue enters Now only when the founder has deliberately included it in the current working set. Multiple Issues may legitimately be `priority:now` at once. This label alone does not authorize execution — it does not replace any founder/execution authorization gate elsewhere in `AGENTS.md`.
- **`priority:soon`** — mechanically demonstrated, accepted work that is not yet in the current Now pipeline. The defect, friction, or optimization has concrete evidence and a sufficiently established direction to retain near-term prominence, but it remains discretionary until admitted to Now.
- **`priority:later`** — more abstract work that is worth retaining for future consideration but whose benefit, mechanism, scope, or need is not yet concrete enough to place in the near-term mechanical queue. Research, design exploration, methodology refinement, and unproven optimization hypotheses normally begin here.
- **`priority:wishes`** — optional nice-to-haves worth preserving but currently lower-value and lower-commitment than Later work. Wishes are typically abstract, externally oriented, convenience-oriented, or otherwise nonessential to the founder's current operating goals. They are not rejected ideas.

An Issue carries at most one of these labels at a time. `tools/check-priority-labels.mjs`, run by `.github/workflows/priority-labels.yml` whenever a label lands on an Issue, fails loudly if that Issue now carries more than one `priority:*` label; run it with no arguments to scan every open issue on demand.

Within one horizon, relative order is intentionally unspecified by default. Two Issues carrying the same horizon label are peers unless the founder records a concrete local sequencing decision. A one-off instruction such as “this is the first Soon item after the current Now set” may be recorded in the relevant Issue/control state when it materially affects execution, but do not introduce ordinals, numbered labels, or a synchronized JSON rank file merely to rank an entire horizon.

### Blocked is not a priority horizon

Priority answers "when do we expect to pursue this"; blocked answers "can this proceed right now." Represent blocking with GitHub's native Issue dependency relationship (`blocked by` / `blocking` — `gh api repos/<owner>/<repo>/issues/<n>/dependencies/blocked_by`), not a manually maintained label. An Issue can be `priority:soon` and blocked by another Issue at the same time; the two facts are independent and both live in GitHub's own state, not in a label.

`Done` needs no priority label either — a closed Issue is retired GitHub state, subject to LDL's existing lifecycle semantics (see `AGENTS.md`) for when an implementation Issue may actually close.

Pure lifecycle-evidence/reference artifacts that are intentionally not executable backlog work also need no horizon label. Examples include an Audit Issue whose job is to preserve audit state/evidence and a North Star/reference Issue that explicitly says not to execute it. Do not force such artifacts into Wishes merely to make every open Issue carry a priority.

## Intake

The founder logs a raw idea with the `idea-intake` issue template (`.github/ISSUE_TEMPLATE/idea-intake.yml`) — a couple of short fields, fast to fill from a phone, no free-form issue writing required.

## Conversion

When a session is dispatched on (or resumes chat about) an open `idea-intake` issue:

1. Read the raw idea. If it is genuinely ambiguous, ask one direct concise question in chat per the founder interrupt conditions — do not open a full decision form for a single-item backlog entry unless it exposes a real multi-option founder decision.
2. Once clear, refine that same issue in place into one ironed-out, durable outcome (title and body) rather than opening a second tracking issue to represent the same accepted outcome.
3. Apply the founder-set `priority:*` label using the horizon semantics above. Never promote something to Now merely because it is severe, touches the core loop, is technically interesting, or has existed for a long time. Soon requires concrete/mechanical evidence; Later and Wishes preserve progressively more abstract or discretionary work. When no founder-set horizon can be established from durable authority, surface that as a founder-priority decision rather than guessing from issue age, issue number, estimated difficulty, or model preference — see `AGENTS.md`'s founder decision-form rule.
4. Represent any genuine dependency with GitHub's native Issue `blocked by`/`blocking` relationship, not a label or a free-text cross-reference.
5. Close the original `idea-intake` issue only when refinement produced a genuinely separate durable issue (normal decomposition); otherwise the same issue simply now carries its priority label and refined body, and stays open as the canonical backlog item.
6. Report the fixed `CLEAN` chat line per `AGENTS.md` § Fixed chat report formats.

## Prioritization

The founder may change an Issue's priority horizon at any time by swapping its `priority:*` label. Moving an Issue from Soon to Now means admitting it into the explicitly defined current working set; moving it back out means it is no longer part of that pipeline. Routine implementation work must preserve an Issue's existing priority; only an explicit founder decision changes it.

Priority is therefore a sequencing/value decision, not a defect-severity taxonomy. A concrete bug may remain Soon when it does not belong to the current working set, while a telemetry or infrastructure item may be Now when it is an explicit prerequisite of the current campaign.

## Turning a priority Issue into work

A `priority:now`/`soon`/`later`/`wishes` Issue is already the backlog item — nothing needs to be derived from it into a second issue. When the founder dispatches it (see `AGENTS.md` § Decomposition boundary and § Session execution), that same Issue becomes the active vertical slice, or is decomposed into child slice issues under the normal decomposition rules; a resulting child issue gets its own priority horizon only when the founder sets one.

`priority:now` on more than one Issue does not itself choose which runs first. If automated execution ever needs to choose among several `priority:now` Issues with no other durable signal, it must not invent an order — that remains a founder choice.

## Historical note

This replaced the Loop-Dee-Loup Burn Order (`docs/burn-order.json`, `tools/burn-order/`), retired in issue #192. Issue #6 remains as historical provenance for the retired mechanism; it is no longer the source of current backlog state.
