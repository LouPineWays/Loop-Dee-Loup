# LDL Diagnostic Review Guidance

## Purpose

Use this source for the diagnostic-review workflow inside the Loop-Dee-Loup Idea Intake project.

Review privacy-minimal diagnostic traces from explicitly opted-in proving/debug sessions and identify where LDL controllers, workers, skills, scripts, or governing instructions behave inefficiently, inconsistently, or incorrectly.

The objective is to improve useful validated progress per scarce resource by making correct execution paths more reliable while reducing unnecessary reasoning, context loading, coordination, rework, and founder interruption.

This source governs evidence analysis and recommendation threshold. It does not replace repository authority, the project's general Issue-engineering rules, Stage 1/Stage 2 correction guidance, or live implementation ownership.

## Authority and boundaries

Current founder instruction and repository-local authority control. A trace records what happened at one point in time; do not reinterpret current LDL methodology from stale evidence when governing instructions changed afterward.

Use only:

- diagnostic artifacts explicitly produced from opted-in proving/debug sessions; and
- the narrow durable repository/GitHub state needed to determine current authority, ownership, recurrence, supersession, or whether a reported defect is already corrected.

Do not routinely inspect raw Claude transcripts.

Do not request, reconstruct, or infer hidden chain-of-thought as evidence.

Do not expand ordinary LDL telemetry into prompt/response/reasoning surveillance.

Diagnostic artifacts may legitimately contain event order, durable references, controller-versus-worker operations, dispatch timing, prompt metadata, subagent events, and compact intentionally preserved reasoning excerpts needed to explain an observable transition.

Raw transcripts remain local unless a separate founder-authorized investigation explicitly requires them.

Diagnostic Review is a Chat-side evidence-analysis workflow. It may produce a bounded correction specification or durable GitHub state under the project's normal Issue-engineering rules, but live source edits, scripts/gates, tests/builds, worktrees, commits/PRs, and runtime verification remain with the coding environment.

## What to look for

Look especially for evidence of:

- unnecessary controller analysis before dispatch;
- thick-Issue content entering a thin controller unnecessarily;
- repeated routing or decomposition already settled by durable state;
- repository reconnaissance, branch/worktree setup, or implementation planning performed by a controller when a worker should own it;
- reconstructed worker prompts instead of durable references;
- failure to use a bounded worker/subagent when the settled route calls for one;
- excessive worker narration instead of compact durable results;
- founder questions existing authority could answer;
- unnecessary polling or lifecycle narration;
- repeated reads of state already represented compactly;
- avoidable review/correction churn caused by unclear authority;
- context retained after its useful stage has ended;
- repeated semantic reasoning that a reliable deterministic mechanism could replace.

Also detect sustained improvements. If a previously unreliable behavior is now consistently correct, record that as evidence that the defect may be stabilizing and deserves less attention.

Do not judge reasoning merely because it is verbose or expensive. Complex reasoning is sometimes necessary. The relevant question is whether the reasoning materially improved the probability of a correct validated result or whether LDL paid again for a decision, discovery step, or coordination task that durable state or deterministic machinery should already have settled.

## Review cadence and evidence disposition

Review only new diagnostic traces not already covered by the previous review or already dispositioned as evidence.

If there are no new traces, stop.

If new traces show no materially new pattern, stop without creating noise.

For each material observation, classify it as one of:

- **isolated** — observed but not yet evidence of a reusable methodology defect;
- **recurring/systemic** — repeated or cross-cutting evidence supports a reusable correction;
- **regression** — behavior previously believed corrected has materially reappeared;
- **sustained improvement** — previously unreliable behavior is repeatedly behaving correctly;
- **insufficient evidence** — available traces cannot support a reliable conclusion.

One unusual reasoning choice is not automatically a methodology defect. Prefer multiple concrete instances before recommending persistent machinery unless severity independently justifies immediate attention.

A finding may add material evidence to an existing outcome without requiring a new implementation cycle. Apply the project's post-completion evidence rules when an existing owner or completed execution packet is involved.

## Analysis method

For each new trace:

1. Identify the intended control/execution boundary.
2. Determine the earliest point where useful execution could legitimately begin.
3. Identify unnecessary reasoning or operations before that point.
4. Identify work performed at the wrong layer.
5. Check whether current durable authority already settled the question being reconsidered.
6. Check whether a cheaper deterministic mechanism could replace repeated model reasoning without reducing correctness.
7. Check whether worker/context boundaries were respected.
8. Check whether the resulting work still reached a correct, independently evidenced outcome.
9. Compare with earlier diagnostic evidence when recurrence, regression, or sustained improvement is material.
10. Decide whether anything warrants durable action.

When several traces describe the same underlying defect, consolidate them by root cause rather than counting them as separate findings.

When evidence spans multiple incidents, distinguish:

- outcome ownership;
- incident/reproduction provenance;
- evidence disposition; and
- execution lifecycle.

Do not assume the Issue being advanced when an incident occurred is the owner of the defect.

## Recommendation threshold

Recommend a durable change only when evidence shows it is likely to prevent meaningful recurring cost or failure, or when a single defect is independently severe enough to justify immediate correction.

Prefer the smallest mechanism supported by the evidence.

Possible corrections include:

- strengthening an existing positive dispatch gate;
- removing ambiguous wording;
- moving a repeated deterministic check into a script;
- reducing controller startup/context authority;
- improving an execution-Issue route or state representation;
- tightening a worker return contract;
- modifying a reusable skill/procedure when the same judgment is repeatedly reconstructed;
- adding a specialized worker only when repeated expertise boundaries justify the persistent complexity.

Do not add machinery for theoretical failures.

Do not create generalized orchestration frameworks, agent hierarchies, RAG systems, dashboards, large taxonomies, or new telemetry streams from isolated observations.

Persistent complexity must amortize. A proposed diagnostic fix should have a plausible recurring path to lower reasoning/context cost, reduce founder interruption/rework, prevent defects, improve assurance, or increase validated autonomy.

## Repository and GitHub interaction

Inspect live GitHub/repository state only when needed to determine whether:

- behavior violated current authority;
- a reported defect has already been corrected;
- recurrence/regression actually exists;
- an existing Issue already owns the outcome;
- a completed execution packet should remain historical while fresh correction work receives a new packet;
- current schema/gate authority changes the interpretation of the trace.

Use narrow sufficient inspection. Do not perform broad historical archaeology by default.

Do not automatically create or modify GitHub Issues because one daily trace looks suspicious.

When evidence crosses the action threshold, follow the project's normal Issue-engineering authority: preserve intent, avoid duplicates, use the canonical Issue schema, constrain scope, define observable acceptance criteria, and use thin control + thick execution state where applicable.

If evidence identifies a provider-independent behavior that coding agents or repository automation must obey, normal supervised Issue engineering may promote the correction into LDL repository authority. Do not promote a Chat-specific observation rule merely because it helps this diagnostic workflow.

## Output when action is warranted

Use only the sections that materially help the next decision or execution handoff.

### Finding

State the recurring, regressed, or independently significant behavior.

### Evidence

Identify the relevant diagnostic traces and durable references. Distinguish reproduction context from outcome owner when needed.

### Classification

Isolated / recurring-systemic / regression / sustained improvement / insufficient evidence.

### Cost or risk

State what the behavior wastes or endangers: context, tokens/model usage, founder attention, correctness, autonomy, review quality, lifecycle reliability, or maintenance burden.

### Smallest recommended correction

State the minimum guidance, deterministic mechanism, skill/procedure, routing/state correction, or execution slice likely to prevent recurrence.

### Confidence

High / medium / low, including important limitations or contradictory evidence.

Do not produce a daily report merely to say everything is fine. Silence is a successful result when there is nothing actionable.

## Success condition

Diagnostic Review is working when:

- recurring reasoning/control defects become visible without the founder reading every session;
- previously fixed behaviors can be shown to remain stable;
- regressions are distinguished from new defects and duplicate evidence;
- deterministic work moves below model reasoning where practical;
- controllers remain thin and workers receive bounded durable context;
- founder interruption and avoidable correction churn decrease;
- diagnostic review remains cheaper than the waste it is intended to prevent; and
- useful findings enter normal durable authority without turning telemetry into autonomous self-modification or surveillance.