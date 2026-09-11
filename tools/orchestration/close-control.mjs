#!/usr/bin/env node
// Deterministic, idempotent thin-control-Issue terminalization primitive — issue #542.
//
// Root cause this closes (the live #486/#487/#538 reproduction): a split thin/thick LDL
// lifecycle can reach a backed CLEAN Stage 2 result, close the thick work Issue
// (`tools/review-watch/lifecycle-gate.mjs close-work-issue`) and the Audit Issue
// (`... close-audit`), correctly obey #486's controller-stop invariant, and still leave the
// founder-facing thin control Issue open with stale compact lifecycle fields (`Lifecycle:
// AUDIT`, `Stage 2: #538` with no terminal status, `Terminal result: none`) — requiring manual
// founder repair. #407/#408 mechanized work/audit terminalization; #486/#487 mechanized the
// controller-stop boundary; this module fills the seam between them by mechanizing the third,
// previously-missing terminalization step: the thin control Issue itself.
//
// This is a narrowly-scoped sibling of `tools/review-watch/lifecycle-gate.mjs`'s
// `checkCloseWorkIssue`/`checkCloseAudit` (same idempotent-close-plus-comment shape), not an
// addition to that module. lifecycle-gate.mjs lives in tools/review-watch, and this
// repository's own established dependency direction runs one way only — tools/orchestration may
// import tools/review-watch internals (next-review-transition-gate.mjs's module comment calls
// this "a deliberate, documented exception"), never the reverse. This primitive needs
// tools/orchestration's own `upsertControlBullet` (ready-dispatch-gate.mjs) to compose the
// terminal control-Issue body, and `write-control-snapshot.mjs`'s `checkWriteControlSnapshot` to
// validate and persist it the same validated way every other LDL-authored control mutation
// already goes through (issue #510's write-before-validate contract, reused rather than
// duplicated — Stage 1 review finding on this PR) — a module inside tools/review-watch could not
// import those without inverting that direction. Living in tools/orchestration instead
// preserves it cleanly.
//
// Control identity (issue #542 requirement 3 — "fail closed on control identity"): this
// primitive never searches for or guesses a control Issue. `--control-issue` is a required
// argument naming the exact Issue to terminalize, supplied by the caller — normally
// `next-review-transition-gate.mjs`'s own `STAGE2_CLOSE_READY` `nextCommand`, which only ever
// includes this command when *that* gate itself was invoked in control-Issue mode (i.e. the
// current invocation's own `--control-issue` argument, never inferred from Stage 2/PR
// provenance or any other search). A direct-reference invocation of that gate (`--audit-issue`
// or `--pr`/`--head`) has no control Issue to name and never chains this command at all — see
// that module's `appendCloseControlCommand`.
//
// Idempotency (issue #542 requirement 4): an already-closed control Issue is treated as already
// terminal — no re-edit, no re-close, no re-comment — mirroring checkCloseWorkIssue's own
// ALREADY_TERMINAL precedent exactly. Synchronization (requirement 5): the GitHub open/closed
// state and the compact lifecycle fields are always changed together, in the same invocation —
// the body is rewritten to a truthful terminal shape *before* the issue is closed, never one
// without the other.
//
// Usage:
//   node tools/orchestration/close-control.mjs --control-issue 487 --audit-issue 538 [--work-issue 486]
// `--repo` is optional and derived from the checkout's own origin remote (resolveRepoIdentity)
// when omitted, matching every other tools/orchestration script's convention.
//
// Exit codes: 0 (CLOSED or ALREADY_TERMINAL), 1 (operational error — missing args, or an
// underlying `gh` call failed/threw), 2 (REJECTED — either the control body's own Stage 2/
// Execution references do not correspond to the supplied `--audit-issue`/`--work-issue`, the
// named audit issue is not itself closed on GitHub, or the composed terminal body failed
// field-local pointer validation; in every REJECTED case the durable Issue is left
// byte-for-byte unchanged, mirroring write-control-snapshot.mjs's own REJECTED contract).
//
// Tests: node --test tools/orchestration/close-control.test.mjs

import { execFileSync } from "node:child_process";
import {
  upsertControlBullet,
  resolveRepoIdentity,
  parseControlBullet,
  isNoneSentinel,
  parseExecutionPointer,
  findNearDuplicateBulletLabels,
  readExecutionBulletField,
  extractActiveExecutionRef,
  parseHeadingBlock,
  describeExecutionConflict,
} from "./ready-dispatch-gate.mjs";
import { checkWriteControlSnapshot } from "./write-control-snapshot.mjs";

function defaultGhIssueView({ repo, number }) {
  const raw = execFileSync("gh", ["issue", "view", String(number), "--repo", repo, "--json", "body,state"], {
    encoding: "utf8",
  });
  return JSON.parse(raw);
}

function defaultGhClose({ repo, controlIssue }) {
  execFileSync("gh", ["issue", "close", String(controlIssue), "--repo", repo], { encoding: "utf8" });
}

function defaultGhComment({ repo, controlIssue, body }) {
  execFileSync("gh", ["issue", "comment", String(controlIssue), "--repo", repo, "--body", body], { encoding: "utf8" });
}

// Pure. Composes the terminal control-Issue body from the current (pre-terminal) body — see
// issue #542's Required behavior #1 for the minimum fields a terminal control state must
// truthfully record. Reuses `upsertControlBullet` verbatim (never a second bullet-rewrite
// implementation): it already handles both the ad hoc "- **Label:** value" bullet convention
// real control Issues use in practice and the shipped `parent-execution` template's "### State"
// heading shape, so this composition works unchanged regardless of which shape the control
// Issue actually uses.
//
// "Stage 2" is set to a single "#<auditIssue>" pointer plus trailing annotation prose ("—
// CLEAN, closed") — never a second embedded "#N"/URL reference — so it remains exactly one
// parseable pointer, satisfying control-field-validator.mjs's cardinality check the same way
// every other valid "Stage 2" bullet already must (issue #510's #499 corruption was exactly a
// second pointer embedded in this same field's own explanatory prose).
//
// "Terminal result" is a new, freeform compact-evidence field (not one of
// control-field-validator.mjs's parser-sensitive DEFAULT_CONTROL_FIELD_SPECS, so it is never
// pointer-cardinality-constrained) — it may name both the audit and work issue references for a
// human skimming the terminal state, matching the shape issue #543's own control Issue already
// uses ("- **Terminal result:** none" pre-terminalization).
export function buildTerminalControlBody(body, { auditIssue, workIssue }) {
  const stage2Value = `#${auditIssue} — CLEAN, closed`;
  const terminalResultParts = [`Backed CLEAN Stage 2 audit #${auditIssue} closed`];
  if (typeof workIssue === "number" && Number.isFinite(workIssue)) {
    terminalResultParts.push(`work issue #${workIssue} closed`);
  }
  const terminalResult = `${terminalResultParts.join("; ")}; control terminalized by tools/orchestration/close-control.mjs.`;

  let next = body ?? "";
  next = upsertControlBullet(next, "Lifecycle", "DONE");
  next = upsertControlBullet(next, "Route", "none");
  next = upsertControlBullet(next, "Stage 2", stage2Value);
  next = upsertControlBullet(next, "Blocker", "none");
  next = upsertControlBullet(next, "Founder decision", "none");
  next = upsertControlBullet(next, "Terminal result", terminalResult);
  return next;
}

// Pure. Durable explanation comment posted on a real (non-dry-run) control-Issue
// terminalization — names the backing Stage 2 evidence so a fresh reader never has to
// reconstruct why this control Issue was closed by automation rather than by hand, mirroring
// closeWorkIssueComment's own precedent in tools/review-watch/lifecycle-gate.mjs.
function terminalControlComment({ repo, auditIssue, workIssue }) {
  const workIssueClause = typeof workIssue === "number" && Number.isFinite(workIssue) ? `, and gated work issue ${repo}#${workIssue} is closed` : "";
  return (
    `Terminalized by \`tools/orchestration/close-control.mjs\`: Stage 2 audit issue ${repo}#${auditIssue} recorded ` +
    `a CLEAN verdict backed by a completed Stage 2 audit report${workIssueClause}. Per issue #542, a split ` +
    "thin/thick lifecycle's founder-facing thin control Issue is terminalized (compact lifecycle fields rewritten " +
    "to a truthful terminal state, then closed) inside the same bounded STAGE2_CLOSE_READY transition that closes " +
    "the work/audit pair, closing the #486/#487/#538 gap where this step required manual founder repair."
  );
}

// Pure. Reads the control body's own "Stage 2" bullet (the same ambiguity-guarded shape
// next-review-transition-gate.mjs's `parseOptionalIssueRefGuarded` reads for that field) and
// returns { kind: "missing" | "none" | "ambiguous" | "invalid" | "issue", issue?, reason? }.
// Kept local to this module (rather than importing `parseOptionalIssueRefGuarded` from
// next-review-transition-gate.mjs) so this primitive's own dependency direction stays what its
// module comment already documents: it imports only from ready-dispatch-gate.mjs and
// write-control-snapshot.mjs, never from a sibling gate script that itself has a CLI `main()`.
function parseStage2Reference(body) {
  const raw = parseControlBullet(body, "Stage 2");
  if (raw === null) return { kind: "missing" };
  const nearDuplicates = findNearDuplicateBulletLabels(body, "Stage 2");
  if (nearDuplicates.length > 0) {
    return {
      kind: "ambiguous",
      reason:
        `"Stage 2" reference is ambiguous: recognized "- **Stage 2:**" bullet (${JSON.stringify(raw)}) coexists ` +
        `with unrecognized near-duplicate label(s) ${nearDuplicates
          .map((m) => `"- **${m.label}:**" (${JSON.stringify(m.raw)})`)
          .join(", ")} that could represent the same live field`,
    };
  }
  if (isNoneSentinel(raw)) return { kind: "none" };
  const parsed = parseExecutionPointer(raw);
  if (!parsed.ok) return { kind: "invalid", reason: `"Stage 2" field ${JSON.stringify(raw)}: ${parsed.reason}` };
  return { kind: "issue", issue: parsed.issue };
}

// Pure. Reads the control body's own Execution/work-issue reference the same way
// evaluateReadyDispatchGate does (readExecutionBulletField, falling back to the
// parent-execution.yml template's "Minimum authority" block) and returns
// { kind: "missing" | "conflict" | "invalid" | "issue", issue?, reason? }.
function parseExecutionReference(body) {
  const executionField = readExecutionBulletField(body);
  if (executionField.conflict) {
    return { kind: "conflict", reason: describeExecutionConflict(executionField) };
  }
  const raw = executionField.value ?? extractActiveExecutionRef(parseHeadingBlock(body, "Minimum authority"));
  if (raw === null || raw === undefined) return { kind: "missing" };
  const parsed = parseExecutionPointer(raw);
  if (!parsed.ok) return { kind: "invalid", reason: `Execution reference ${JSON.stringify(raw)}: ${parsed.reason}` };
  return { kind: "issue", issue: parsed.issue };
}

// Pure. Issue #542 requirement 3 ("fail closed on control identity"), extended by the Stage 1
// review finding on this PR (invariant 1 of the correction guidance): supplying `--audit-issue`/
// `--work-issue` alone was never proof that the *named control Issue's own durable body* agrees
// those are its execution/audit — a stale, mistyped, or simply wrong pair of arguments (a typo,
// or a disconnected pair copied from the wrong Issue) could otherwise terminalize a control
// Issue using a completely unrelated audit's CLEAN evidence. Before any mutation, this checks
// that the control body's own "Stage 2" bullet already names exactly `auditIssueNumber` (missing,
// "none", ambiguous, or a different number all fail closed), and — only when a real
// `workIssueNumber` was supplied at all, preserving the explicit no-work-issue
// (ACCEPTED_NO_WORK_ISSUE) exception — that its own Execution/"Minimum authority" reference
// already names exactly `workIssueNumber` too. Returns { ok: true } or { ok: false, errors }.
export function verifyControlCorrespondence(body, { auditIssueNumber, workIssueNumber }) {
  const errors = [];

  const stage2 = parseStage2Reference(body);
  if (stage2.kind === "missing") {
    errors.push(
      `control body has no "- **Stage 2:**" reference at all; refusing to terminalize using audit #${auditIssueNumber}'s evidence without a durable correspondence`,
    );
  } else if (stage2.kind === "none") {
    errors.push(
      `control body's "Stage 2" reference is "none"; refusing to terminalize using audit #${auditIssueNumber}'s evidence without a durable correspondence`,
    );
  } else if (stage2.kind === "ambiguous" || stage2.kind === "invalid") {
    errors.push(stage2.reason);
  } else if (stage2.issue !== auditIssueNumber) {
    errors.push(
      `control body's "Stage 2" reference is #${stage2.issue}, not audit #${auditIssueNumber} being terminalized here — refusing to close this control using an unrelated audit's evidence`,
    );
  }

  if (typeof workIssueNumber === "number" && Number.isFinite(workIssueNumber)) {
    const execution = parseExecutionReference(body);
    if (execution.kind === "missing") {
      errors.push(
        `control body has no Execution/"Minimum authority" reference at all; refusing to terminalize using work issue #${workIssueNumber}'s evidence without a durable correspondence`,
      );
    } else if (execution.kind === "conflict" || execution.kind === "invalid") {
      errors.push(execution.reason);
    } else if (execution.issue !== workIssueNumber) {
      errors.push(
        `control body's Execution reference is #${execution.issue}, not work issue #${workIssueNumber} being terminalized here — refusing to close this control using an unrelated work issue's evidence`,
      );
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// `ghIssueViewImpl`, `ghEditImpl`, `ghCloseImpl`, and `ghCommentImpl` are all injected so tests
// can drive this end-to-end without touching the real network or `gh` CLI. `ghEditImpl` is
// forwarded verbatim to `write-control-snapshot.mjs`'s own `checkWriteControlSnapshot` (see
// below) — when omitted here, that module's own default (a synchronous `gh issue edit
// --body-file -` via stdin) applies, exactly as it does for every other canonical control-body
// write in this repository.
export async function checkCloseControl(
  args,
  {
    ghIssueViewImpl = defaultGhIssueView,
    ghEditImpl,
    ghCloseImpl = defaultGhClose,
    ghCommentImpl = defaultGhComment,
  } = {},
) {
  const { repo, "control-issue": controlIssue, "audit-issue": auditIssue, "work-issue": workIssue } = args;
  if (!repo || !controlIssue || !auditIssue) {
    return { exitCode: 1, message: "Missing required args: --repo, --control-issue, and --audit-issue are all required." };
  }
  const controlIssueNumber = Number(controlIssue);
  const auditIssueNumber = Number(auditIssue);
  const workIssueNumber = workIssue !== undefined && workIssue !== null && workIssue !== "" ? Number(workIssue) : null;

  let controlData;
  try {
    controlData = await ghIssueViewImpl({ repo, number: controlIssue });
  } catch (err) {
    return { exitCode: 1, message: `gh issue view failed for ${repo}#${controlIssue}: ${err.message}` };
  }

  // Issue #542 requirement 4: a safe no-op on an already-closed control Issue. Being closed is
  // trusted as the terminal signal in full — never re-edited, re-closed, or re-commented merely
  // because a rerun observes stale-looking fields, exactly mirroring checkCloseWorkIssue's own
  // ALREADY_TERMINAL contract in tools/review-watch/lifecycle-gate.mjs.
  if (controlData.state === "CLOSED") {
    return { exitCode: 0, state: "ALREADY_TERMINAL", controlIssue: controlIssueNumber };
  }

  // Stage 1 review finding on this PR (invariant 1): fail closed unless the control's own
  // durable Stage 2/Execution references already correspond to the audit/work Issue being
  // terminalized here — a stale, mistyped, or disconnected pair of `--audit-issue`/
  // `--work-issue` arguments must never authorize rewriting this control to DONE using another
  // execution's evidence. Checked before any I/O beyond the control read already above.
  const correspondence = verifyControlCorrespondence(controlData.body ?? "", { auditIssueNumber, workIssueNumber });
  if (!correspondence.ok) {
    return {
      exitCode: 2,
      state: "REJECTED",
      controlIssue: controlIssueNumber,
      errors: correspondence.errors,
      message:
        `Refusing to terminalize ${repo}#${controlIssue}: the control body's own durable references do not ` +
        `correspond to audit #${auditIssueNumber}${typeof workIssueNumber === "number" ? `/work issue #${workIssueNumber}` : ""}:\n- ${correspondence.errors.join("\n- ")}`,
    };
  }

  // Stage 1 review finding on this PR (invariant 1): `next-review-transition-gate.mjs` chains
  // `close-audit` and this command with shell `&&`, but `close-audit`'s own CLI exits 0 even for
  // its normal, non-error `NOT_TERMINAL_YET` result (the audit correctly stayed open) — a 0-exit
  // code alone is never proof the audit actually closed. This primitive independently
  // revalidates the audit issue's own live GitHub state before ever mutating the control, rather
  // than trusting the exit code of whatever produced its `--audit-issue` argument.
  let auditData;
  try {
    auditData = await ghIssueViewImpl({ repo, number: auditIssueNumber });
  } catch (err) {
    return { exitCode: 1, message: `gh issue view failed for ${repo}#${auditIssueNumber}: ${err.message}` };
  }
  if (auditData.state !== "CLOSED") {
    return {
      exitCode: 2,
      state: "REJECTED",
      controlIssue: controlIssueNumber,
      errors: [`audit issue ${repo}#${auditIssueNumber} is not closed (state: ${JSON.stringify(auditData.state)})`],
      message:
        `Refusing to terminalize ${repo}#${controlIssue}: audit issue ${repo}#${auditIssueNumber} is not closed ` +
        `(state: ${JSON.stringify(auditData.state)}) — a nonterminal close-audit result must never authorize control mutation.`,
    };
  }

  const proposedBody = buildTerminalControlBody(controlData.body ?? "", {
    auditIssue: auditIssueNumber,
    workIssue: workIssueNumber,
  });

  // Stage 1 review finding on this PR (invariant 2): route the composed terminal body through
  // the canonical write-before-validate helper (issue #510) instead of a second, duplicated
  // validate-then-`gh issue edit` mutation path — `checkWriteControlSnapshot` already guarantees
  // an invalid proposed body never reaches the write implementation at all.
  const writeResult = checkWriteControlSnapshot({ repo, controlIssue: controlIssueNumber, proposedBody }, { ghEditImpl });
  if (writeResult.exitCode === 2) {
    return {
      exitCode: 2,
      state: "REJECTED",
      controlIssue: controlIssueNumber,
      errors: writeResult.errors,
      message: writeResult.message,
    };
  }
  if (writeResult.exitCode !== 0) {
    return { exitCode: 1, message: writeResult.message };
  }

  try {
    await ghCloseImpl({ repo, controlIssue: controlIssueNumber });
  } catch (err) {
    return {
      exitCode: 1,
      message:
        `Wrote the terminal control snapshot for ${repo}#${controlIssue}, but gh issue close failed: ${err.message}. ` +
        "The body is already terminal; rerunning this same command will retry the close without corrupting the " +
        "already-correct body (re-composing an already-terminal body is a no-op).",
    };
  }

  let commentPosted = true;
  let commentError = null;
  try {
    await ghCommentImpl({
      repo,
      controlIssue: controlIssueNumber,
      body: terminalControlComment({ repo, auditIssue: auditIssueNumber, workIssue: workIssueNumber }),
    });
  } catch (err) {
    commentPosted = false;
    commentError = err.message;
  }

  return {
    exitCode: 0,
    state: "CLOSED",
    controlIssue: controlIssueNumber,
    auditIssue: auditIssueNumber,
    workIssue: workIssueNumber,
    commentPosted,
    ...(commentError
      ? {
          commentError,
          message:
            `Terminalized and closed ${repo}#${controlIssue}, but could not post the durable explanation comment: ` +
            `${commentError}. The issue is closed and its fields are terminal; a follow-up should post the ` +
            "explanation by hand (rerunning close-control will not retry this step on its own, since the issue " +
            "now reads as ALREADY_TERMINAL).",
        }
      : {}),
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    args[a.slice(2)] = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let repo = args.repo;
  if (!repo) {
    const identity = resolveRepoIdentity();
    if (!identity.ok) {
      console.error(`Could not determine the current repository identity (--repo was not supplied): ${identity.reason}`);
      process.exit(1);
      return;
    }
    repo = identity.repo;
  }

  const result = await checkCloseControl({ ...args, repo });
  if (result.exitCode === 1) {
    console.error(result.message);
    process.exit(1);
    return;
  }
  if (result.exitCode === 2) {
    console.error(result.message);
    process.exit(2);
    return;
  }
  console.log(JSON.stringify(result));
  process.exit(0);
}

if (process.argv[1] && process.argv[1].endsWith("close-control.mjs")) {
  main();
}
