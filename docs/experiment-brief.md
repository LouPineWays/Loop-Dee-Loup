# Initial experiment brief

## Product intent

Loop-Dee-Loup is the founder's hyper-lean agentic loop for vibecoding. It is not a simulation of a conventional software organization.

The founder starts a Claude Code session with a short issue reference. When that issue is one subagent-sized vertical slice, the session completes the outcome across every necessary layer without routine involvement, records durable state in GitHub, and stops. When the issue instead requires multiple slices, the session decomposes it — materializing every currently foreseeable slice as its own issue and closing the source — without executing any of them; see `AGENTS.md` § Decomposition boundary.

## Hypothesis

Issue-dispatched, low-chatter vertical slices will reduce message/context token consumption and founder coordination without weakening correctness.

The optimization target is **validated product progress per token and substantive founder interruption**, not minimum tokens in isolation. One-line session dispatches are measured separately from judgment requests.

## Decision-form cycle

When the accepted outcome does not yet support an implementable vertical slice:

1. inspect the repository and map the currently visible critical path;
2. batch all founder-level blocking decisions into one form;
3. include recommendations, tradeoffs, suggested defaults, per-question comments, and a general comments field;
4. accept the completed form as one durable response;
5. write settled decisions into the parent snapshot;
6. add only founder-accepted independent outcomes as Burn Order candidates;
7. generate another form only for newly exposed critical blockers;
8. diagnose and redirect the critical path before a third form if two completed forms still yield no implementable slice.

For the Covenant pilot, the Story 3.3 contract already settles the implementation path, so no decision form should be generated unless repository inspection exposes a genuine unresolved founder choice.

## First trial

Run Covenant's active `wolfscairn-list-and-privacy` Burn Order item through the full loop.

### Entry gate

Covenant PR #94 must first close its existing bounded inline-review round. Its two current P1 findings are documentation corrections:

1. Reconcile published source-label claims with Buttondown tags being unavailable and unset.
2. Update the decision checklist so steps 1–7 are complete and step 8 is the sole outstanding item.

Those corrections belong to PR #94's consolidated correction pass, not to the pilot.

### First execution slice after PR #94

**Outcome:** ship the complete Buttondown signup surface on `covenant.wolfscairn.com`.

The single slice includes:

- form markup from the settled Story 3.3 contract;
- GitHub Pages-compatible CSP emitted through `site/build.py`;
- no-JavaScript behavior and graceful Buttondown failure;
- required CTA hierarchy, brand-wide positioning, privacy link, and presentation;
- affected tests, fixtures, documentation, and generated output;
- local verification, PR creation, one bounded inline review, consolidated valid fixes, and merge after all gates pass.

Do not split form, CSP, presentation, tests, documentation, or review corrections into separate execution issues. They are layers and activities serving one shippable outcome.

After merge, the required exact-commit acceptance audit is a control issue. The live Buttondown email flow is a founder-only external verification boundary: submit, confirm, receive a test broadcast, and unsubscribe. Verified evidence closes FR-24 and `wolfscairn-list-and-privacy`.

## Issue-dispatched loop

1. **INTAKE:** record an accepted feature proposal and its outcome.
2. **SNAPSHOT:** compress current truth into the parent issue.
3. **CRITICAL PATH:** identify founder decisions blocking implementable slices.
4. **FORM:** batch those decisions when needed and incorporate the completed response.
5. **SLICE:** derive an implementable subagent-sized vertical slice — when the outcome genuinely needs several, materialize every currently foreseeable one and close the source as a decomposition record instead of executing any of them.
6. **DISPATCH:** founder starts a fresh session naming the one slice issue to execute.
7. **EXECUTE:** session completes that entire slice without routine founder involvement.
8. **VERIFY:** independently check the integrated outcome.
9. **INTEGRATE:** use the target repository's PR, review, merge, and audit rules.
10. **REFRESH:** update the parent snapshot; designate at most one next slice only when this slice's completion exposes new follow-on work not already known at dispatch.
11. **STOP:** end at the clean slice boundary.
12. **RESUME:** a later terse dispatch starts from GitHub state.
13. **CLOSE:** finish only from verified feature acceptance evidence.

## State model

- PROPOSED
- NEEDS_FOUNDER
- READY
- EXECUTING
- VERIFYING
- REVIEW
- AUDIT
- CORRECTION
- BLOCKED_FAILURE
- BLOCKED_EXTERNAL
- READY_NEXT_SESSION
- DECOMPOSED
- DONE

Multiple resulting slices may exist as durable issues once a source is decomposed; only the founder-dispatched slice is EXECUTING at a time. State transitions require evidence, not prose claims.

## Measurements

Record for the experimental item and a comparable recent baseline where available:

- total input and output tokens;
- message/conversation tokens;
- repository/context rereading tokens;
- fresh Claude Code sessions;
- one-line dispatch messages;
- decision forms generated and completed;
- questions per form and form rounds before an implementable slice;
- substantive founder questions and manual actions;
- unnecessary founder approval requests;
- vertical slices created;
- control issues created;
- rework and correction slices;
- elapsed time to validated completion;
- review and acceptance-audit outcomes.

## Success criteria

The trial succeeds only if:

- message/context tokens decline materially;
- total tokens per validated outcome do not increase materially;
- no correctness, IP, privacy, security, or acceptance gate is weakened;
- no routine in-session transition requires founder approval;
- founder involvement beyond terse dispatch is limited to genuine judgment or manual-action boundaries;
- issue maintenance costs less effort than the context it replaces;
- a fresh session can complete its slice without reconstructing conversation history;
- execution issues remain vertical rather than multiplying by implementation layer.

No target percentage is fixed before a baseline is measured.

## Failure signals

Stop or redesign if:

- sessions routinely need comments or prior slices;
- the parent becomes an append-only transcript;
- decomposition predicts a large hierarchy before evidence requires it;
- one outcome is fragmented into research, backend, UI, test, or documentation issues;
- issue creation becomes clerical work;
- state is duplicated between Covenant's Burn Order and Loop-Dee-Loup;
- agents cross scope or safety boundaries in the name of autonomy;
- sessions ask foreseeable founder questions serially instead of batching them;
- decision-form answers create speculative or duplicate Burn Order items;
- two completed forms fail to produce an implementable slice;
- sessions request approval for routine technical transitions;
- chat narration remains the dominant token category;
- compressed context causes defects or rework.

## Non-goals for the first trial

- No daemon, webhook dispatcher, or automatic session launcher.
- No general multi-repository platform.
- No simulated company hierarchy or ceremony layer.
- No comprehensive roadmap decomposition.
- No horizontal ticket breakdown.
- No replacement of Covenant's source of truth.
- No weakening of repository review or merge gates.
- No optimization of tokens at the expense of validated progress.

## Decision after trial

After the stopping audit and live test:

- **ADOPT:** use the loop for additional feature-sized work.
- **REVISE:** change the state, slice, or interrupt contract and repeat once.
- **REJECT:** retain only components proven better than the existing workflow.
