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
// tools/orchestration's own `upsertControlBullet` (ready-dispatch-gate.mjs) and
// `validateControlSnapshot` (control-field-validator.mjs) to compose the terminal control-Issue
// body the same validated way every other LDL-authored control mutation already goes through
// (issue #510's write-before-validate contract) — a module inside tools/review-watch could not
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
// underlying `gh` call failed/threw), 2 (REJECTED — the composed terminal body failed
// field-local pointer validation; the durable Issue is left byte-for-byte unchanged, mirroring
// write-control-snapshot.mjs's own REJECTED contract).
//
// Tests: node --test tools/orchestration/close-control.test.mjs

import { execFileSync } from "node:child_process";
import { upsertControlBullet, resolveRepoIdentity } from "./ready-dispatch-gate.mjs";
import { validateControlSnapshot } from "./control-field-validator.mjs";

function defaultGhIssueView({ repo, number }) {
  const raw = execFileSync("gh", ["issue", "view", String(number), "--repo", repo, "--json", "body,state"], {
    encoding: "utf8",
  });
  return JSON.parse(raw);
}

// `--body-file -` (stdin), matching write-control-snapshot.mjs's own defaultGhEditControlIssue:
// the rewritten control-Issue body can exceed a shell argv length limit and, unlike `--body`,
// is never subject to argv-escaping risk for arbitrary Markdown content.
function defaultGhEditBody({ repo, controlIssue, body }) {
  execFileSync("gh", ["issue", "edit", String(controlIssue), "--repo", repo, "--body-file", "-"], {
    input: body,
    encoding: "utf8",
  });
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

// `ghIssueViewImpl`, `ghEditImpl`, `ghCloseImpl`, and `ghCommentImpl` are all injected so tests
// can drive this end-to-end without touching the real network or `gh` CLI.
export async function checkCloseControl(
  args,
  {
    ghIssueViewImpl = defaultGhIssueView,
    ghEditImpl = defaultGhEditBody,
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

  const proposedBody = buildTerminalControlBody(controlData.body ?? "", {
    auditIssue: auditIssueNumber,
    workIssue: workIssueNumber,
  });

  // Issue #510's write-before-validate contract, reused verbatim rather than re-implemented:
  // never persist a composed control-Issue body without validating its parser-sensitive fields
  // first. A validation failure leaves the durable Issue body byte-for-byte unchanged — the
  // write is never attempted, the same ordering write-control-snapshot.mjs's REJECTED path
  // already guarantees.
  const validation = validateControlSnapshot(proposedBody);
  if (!validation.ok) {
    return {
      exitCode: 2,
      state: "REJECTED",
      controlIssue: controlIssueNumber,
      errors: validation.errors,
      message:
        `Refusing to terminalize ${repo}#${controlIssue}: the composed terminal control snapshot failed field-local ` +
        `pointer validation before persistence:\n- ${validation.errors.join("\n- ")}`,
    };
  }

  try {
    await ghEditImpl({ repo, controlIssue: controlIssueNumber, body: proposedBody });
  } catch (err) {
    return { exitCode: 1, message: `gh issue edit failed for ${repo}#${controlIssue}: ${err.message}` };
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
