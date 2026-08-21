# Loop-Dee-Loup

A hyper-lean agentic execution loop for vibecoding.

Loop-Dee-Loup turns a founder-approved feature proposal into small, verified changes while keeping agent sessions disposable and founder interruptions rare. GitHub carries continuity between sessions; Claude executes the current packet; repository checks and bounded reviews provide control.

## Design doctrine

- The work unit is the smallest independently verifiable product increment, not an epic, sprint, department, or simulated job role.
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

The issue and repository provide the context. Claude executes autonomously until the packet is complete or a genuine interrupt condition is reached. It updates durable GitHub state, identifies the next packet, and ends the session. The founder can later start another fresh session with the next issue reference.

This single-line dispatch is scheduling, not a routine approval gate.

## Core loop

1. Capture a feature proposal and obtain founder approval when product intent is not already settled.
2. Create or refresh one parent issue containing the compressed current truth.
3. Derive exactly one next work packet.
4. Start a fresh Claude Code session against that issue.
5. Execute and verify the packet without routine founder involvement.
6. Route the change through the target repository's required PR and bounded review gates.
7. Merge when all gates pass, audit when required, and create a correction packet if the audit is not clean.
8. Refresh the parent snapshot, designate the next packet, and stop at the clean session boundary.
9. Repeat from a new terse dispatch until done or genuinely blocked.

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

Do not request routine permission to implement an accepted approach, run checks, address verified defects, prepare the next packet, or merge after every required gate passes.

## First trial

The first controlled trial is Covenant's remaining `wolfscairn-list-and-privacy` work after PR #94: build the Buttondown signup surface, take it through Covenant's bounded review cycle, and verify the live signup flow end to end.

See `docs/operating-model.md` and `docs/experiment-brief.md`.
