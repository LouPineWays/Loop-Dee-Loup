# Initial experiment brief

## Product intent

Loop-Dee-Loup is the founder's own hyper-lean agentic loop for vibecoding. It is not a simulation of a conventional software organization.

A founder-approved feature is decomposed just in time into small, independently verifiable packets. Fresh agents execute those packets. The controller verifies results and advances automatically. The founder is interrupted only for unresolved product judgment, material risk or tradeoffs, credentials/manual external actions, or genuine exceptions.

## Hypothesis

A compact autonomous loop will reduce message/context token consumption and founder coordination without weakening correctness.

The optimization target is **validated product progress per token and founder interruption**, not minimum tokens or maximum autonomous activity in isolation.

## First trial

Run Covenant's active `wolfscairn-list-and-privacy` Burn Order item through the full loop.

### Entry gate

Covenant PR #94 must first close its existing bounded inline-review round. Its two current P1 findings are documentation corrections:

1. Reconcile published source-label claims with Buttondown tags being unavailable and unset.
2. Update the decision checklist so steps 1–7 are complete and step 8 is the sole outstanding item.

Those corrections belong to PR #94's consolidated correction pass, not to the pilot.

### Pilot scope after PR #94

1. Build the Buttondown signup form into `covenant.wolfscairn.com` from the settled Story 3.3 contract.
2. Emit the documented GitHub Pages-compatible CSP through `site/build.py`.
3. Preserve the no-JavaScript rule, graceful failure, CTA hierarchy, brand-wide list positioning, privacy link, IP boundary, and existing Covenant requirements.
4. Run required local checks.
5. Open the implementation PR and conduct Covenant's one bounded inline review.
6. Verify and batch-fix every valid finding, then merge after all required gates pass.
7. Run the exact-commit post-merge acceptance audit and create a correction packet only if it returns NOT CLEAN.
8. Once live, interrupt the founder only for the manual Buttondown email flow: submit, confirm, receive a test broadcast, and unsubscribe.
9. Verify that evidence, close FR-24 and `wolfscairn-list-and-privacy`, then finish the parent loop.

## Autonomous control loop

1. **INTAKE:** record an accepted feature proposal and its outcome.
2. **SNAPSHOT:** compress current truth into the parent issue.
3. **SELECT:** derive exactly one next packet from current evidence.
4. **EXECUTE:** run a fresh agent session for that packet.
5. **VERIFY:** independently check code, tests, diff, and claimed state.
6. **INTEGRATE:** use the target repository's PR, review, merge, and audit rules.
7. **REFRESH:** update the parent snapshot without appending a transcript.
8. **CONTINUE:** dispatch the next packet automatically.
9. **INTERRUPT:** ask the founder only when an enumerated interrupt condition applies.
10. **CLOSE:** finish only from verified acceptance evidence.

The controller may repeat SELECT through CONTINUE without founder confirmation.

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
- DONE

Only one packet may be NEXT. State transitions require evidence, not prose claims.

## Measurements

Record for the experimental item and a comparable recent baseline where available:

- total input and output tokens;
- message/conversation tokens;
- repository/context rereading tokens;
- number of fresh executor sessions;
- founder questions and manual actions;
- unnecessary founder approval requests;
- work packets created;
- rework and correction packets;
- elapsed time to validated completion;
- review and acceptance-audit outcomes.

## Success criteria

The trial succeeds only if:

- message/context tokens decline materially;
- total tokens per validated outcome do not increase materially;
- no correctness, IP, privacy, security, or acceptance gate is weakened;
- no routine transition requires founder approval;
- founder interruptions are limited to genuine judgment or manual-action boundaries;
- issue maintenance costs less effort than the context it replaces;
- a fresh executor can act without reconstructing conversation history.

No target percentage is fixed before a baseline is measured.

## Failure signals

Stop or redesign if:

- executors routinely need comments or prior children;
- the parent becomes an append-only transcript;
- decomposition predicts a large hierarchy before evidence requires it;
- packet creation becomes clerical work;
- state is duplicated between Covenant's Burn Order and Loop-Dee-Loup;
- agents cross scope or safety boundaries in the name of autonomy;
- the controller requests approval for routine transitions;
- compressed context causes defects or rework.

## Non-goals for the first trial

- No general multi-repository platform.
- No simulated company hierarchy or ceremony layer.
- No comprehensive roadmap decomposition.
- No replacement of Covenant's source of truth.
- No weakening of repository review or merge gates.
- No optimization of tokens at the expense of validated progress.

## Decision after trial

After the stopping audit and live test:

- **ADOPT:** use the loop for additional feature-sized work.
- **REVISE:** change the state, packet, or interrupt contract and repeat once.
- **REJECT:** retain only components proven better than the existing workflow.
