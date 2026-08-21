# Loop-Dee-Loup

A hyper-lean agentic execution loop for vibecoding.

Loop-Dee-Loup turns a founder-approved feature proposal into verified vertical slices while keeping agent sessions disposable and founder interruptions rare. GitHub carries continuity between sessions; Claude executes the current slice; repository checks and bounded reviews provide control.

## Design doctrine

- The execution issue is a subagent-sized vertical slice: one coherent outcome, implemented through every layer it requires.
- A slice must be independently verifiable and leave the product and repository in a valid state.
- Internal steps such as inspect, implement, test, document, and review stay inside the slice.
- Decompose just in time. Do not predict an entire project hierarchy before current evidence exists.
- Agent sessions are disposable. The founder starts or resumes one with a short issue reference.
- Durable state is a compact snapshot, not a transcript.
- Verification evidence advances the loop. Status prose does not.
- After dispatch, routine technical choices and handoffs are autonomous.
- Existing repository safety, review, merge, and release rules remain authoritative.

## Version-one dispatch

No daemon or automatic session launcher is required.

The founder starts a fresh Claude Code session with a terse instruction such as:

> Run Loop-Dee-Loup issue #12.

The issue and repository provide the context. Claude executes autonomously until the vertical slice is complete or a genuine interrupt condition is reached. It updates durable GitHub state, identifies the next slice, and ends the session. The founder can later start another fresh session with the next issue reference.

This single-line dispatch is scheduling, not a routine approval gate.

## Vertical-slice test

Create an execution issue only when all are true:

- it produces one observable capability, correction, or closure outcome;
- one agent session can own it with bounded context;
- it includes the code, tests, configuration, documentation, and verification needed for that outcome;
- it can be evaluated without completing a sibling issue first;
- merging it leaves the target repository coherent.

Do not split one outcome into separate issues for research, backend, UI, tests, documentation, or PR administration merely because those are different activities. Keep them inside the slice. Create a new issue when the outcome, authority boundary, or required context genuinely changes.

## Founder decision forms

Do not conduct serial one-question-at-a-time discovery.

Before asking for founder input, inspect the proposal, repository authority, and currently visible critical path. If more than one founder-level question is known, generate one self-contained decision form that the founder can complete asynchronously and return as a whole.

Each question must include:

- why the answer blocks or changes a vertical slice;
- two or three mutually exclusive options when appropriate;
- a recommended option and its tradeoffs;
- a suggested default response;
- a free-comment field.

Finish with a general comments field for constraints or alternatives the form did not anticipate.

After the completed form returns:

1. write settled answers into the parent snapshot;
2. convert the critical-path outcome into implementable vertical slices;
3. identify accepted independent outcomes and route them to the correct Burn Order: a target repository's own (not something Loop-Dee-Loup creates or owns), or Loop-Dee-Loup's own (`docs/burn-order.md`) when the outcome is about the Loop itself;
4. discard rejected options and avoid turning every suggestion into backlog work;
5. generate another form only if the answers expose new founder-level blockers that could not reasonably have been included earlier.

If two decision-form rounds produce no implementable slice, diagnose the proposal or decomposition before generating the next form. Use that diagnosis to consolidate or redirect the critical path rather than repeating the same questionnaire.

## Core loop

1. Capture a feature proposal and create or refresh its compressed parent issue.
2. Analyze the currently visible critical path.
3. When founder decisions block slicing, generate one batched decision form and incorporate the completed answers.
4. Derive exactly one next vertical slice.
5. Start a fresh Claude Code session against that slice issue.
6. Implement and verify the entire slice without routine founder involvement.
7. Route it through the target repository's required PR and bounded review gates.
8. Merge when all gates pass, audit when required, and create a correction slice if the audit is not clean.
9. Refresh the parent snapshot, designate the next slice, and stop at the clean session boundary.
10. Repeat from a new terse dispatch until done or genuinely blocked.

Issues are external state machines, not replacement chat transcripts.

## Session communication

Claude Code chat is a control surface, not the durable record. Keep it deliberately terse:

- short kickoff acknowledgement;
- a question only when founder judgment or manual action is required;
- a concise completion or blocked handoff.

Put durable state, evidence, decisions, and next work in the issue or PR rather than narrating them repeatedly in chat.

## Founder interrupts

Stop and ask only when the available authority cannot safely determine:

- intended user or business outcome;
- a material scope, UX, monetization, legal, privacy, security, or irreversible tradeoff;
- credentials or a manual action only the founder can perform;
- how to proceed after a failed safety or correctness gate;
- whether a newly discovered opportunity belongs in the approved feature.

Do not request routine permission to implement an accepted approach, run checks, address verified defects, prepare the next slice, or merge after every required gate passes.

## First trial

The first controlled trial is Covenant's remaining `wolfscairn-list-and-privacy` work after PR #94. Its first execution slice is to ship the complete Buttondown signup surface on `covenant.wolfscairn.com`, including form behavior, CSP, presentation, tests, documentation, and repository integration. The live email interaction remains a founder-only external verification boundary.

See `docs/operating-model.md` and `docs/experiment-brief.md`.
