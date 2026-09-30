// Tests for the LDL-owned thin-control mutation perimeter -- issue #799 (control #438).
//
// Closes the post-#768 gap: #768 made `validateControlSnapshot` + `write-control-snapshot.mjs`
// the canonical write-side validator/writer, but nothing forced every LDL-owned body mutation
// through it. Covered here:
//   1. the exact #726 `#761 -- ...` blocker shape is refused before any durable write;
//   2. canonical `Blocked by #761.` + coherent resume state is accepted and, once #761 is
//      CLOSED, reconciles (restoring the saved continuation, clearing both companions);
//   3. a genuine free-form (no Issue reference) blocker stays valid and non-reconcilable;
//   4. a bypass guard: no production orchestration file persists an Issue body outside the
//      approved writer (allowlist below is the complete inventory);
//   5. the live-controller hook boundary refuses a raw body edit and permits the canonical writer;
//   6. a synthetic consumer-continuation fixture crossing the exact #726 stranding seam.
//
// Run with: node --test tools/orchestration/control-mutation-perimeter.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkWriteControlSnapshot } from "./write-control-snapshot.mjs";
import { checkReconcileControlBlocker } from "./reconcile-control-blocker.mjs";
import { checkReadyDispatch } from "./ready-dispatch-gate.mjs";
import { runSessionEntryGate } from "./session-entry-gate.mjs";
import { decideRawControlBodyWrite } from "./control-body-write-guard.mjs";

const REPO = "LouPineWays/Loop-Dee-Loup";
const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = join(HERE, "..");

// The exact shape found durably on #726 on 2026-09-30.
const MALFORMED_761 =
  "#761 — live recurrence of the correction-dispatch verdict transport seam while resuming this control. " +
  "Resume this conflict-recovery path only after #761 provides the deterministic verdict → reservation → " +
  "formatter handoff; #764 remains closed.";

function body({ blocker, blockedLifecycle = "none", blockedRoute = "none", lifecycle = "BLOCKED", route = "none" }) {
  return [
    "- **Execution:** #725",
    `- **Lifecycle:** ${lifecycle}`,
    `- **Route:** ${route}`,
    `- **Blocker:** ${blocker}`,
    `- **Blocked lifecycle:** ${blockedLifecycle}`,
    `- **Blocked route:** ${blockedRoute}`,
    "- **Founder decision:** none",
    "",
  ].join("\n");
}

// -- 1. exact malformed shape refused before durable mutation -------------------------------

test("#726 recurrence: the exact malformed `#761 — ...` blocker is REJECTED before the write implementation is ever called", () => {
  let writes = 0;
  const result = checkWriteControlSnapshot(
    { repo: REPO, controlIssue: 726, proposedBody: body({ blocker: MALFORMED_761 }) },
    { ghEditImpl: () => { writes += 1; } },
  );
  assert.equal(result.exitCode, 2);
  assert.equal(result.state, "REJECTED");
  assert.equal(writes, 0);
  assert.match(result.errors.join("\n"), /outside the recognized/);
});

test("missing or invalid saved resume metadata cannot accompany a purported reconcilable blocker", () => {
  for (const b of [
    body({ blocker: "Blocked by #761." }),
    body({ blocker: "Blocked by #761.", blockedLifecycle: "READY", blockedRoute: "none" }),
    body({ blocker: "Blocked by #761.", blockedLifecycle: "NOT_A_LIFECYCLE", blockedRoute: "unchanged" }),
    body({ blocker: "Blocked by #761.", blockedLifecycle: "BLOCKED", blockedRoute: "unchanged" }),
  ]) {
    let writes = 0;
    const r = checkWriteControlSnapshot({ repo: REPO, controlIssue: 726, proposedBody: b }, { ghEditImpl: () => { writes += 1; } });
    assert.equal(r.exitCode, 2, b);
    assert.equal(writes, 0);
  }
});

// -- 2/3. canonical accepted; free-form stays representable but non-reconcilable --------------

const CANONICAL = body({ blocker: "Blocked by #761.", blockedLifecycle: "REVIEW", blockedRoute: "unchanged", route: "implementation worker" });

test("canonical `Blocked by #761.` with coherent saved resume state is accepted", () => {
  let written = null;
  const r = checkWriteControlSnapshot({ repo: REPO, controlIssue: 726, proposedBody: CANONICAL }, { ghEditImpl: ({ body: b }) => { written = b; } });
  assert.equal(r.exitCode, 0);
  assert.equal(written, CANONICAL);
});

test("genuine free-form blocker with no Issue reference stays valid and is intentionally non-reconcilable", async () => {
  const freeForm = body({ blocker: "Waiting on the founder to rotate the external API credential." });
  const w = checkWriteControlSnapshot({ repo: REPO, controlIssue: 726, proposedBody: freeForm }, { ghEditImpl: () => {} });
  assert.equal(w.exitCode, 0);
  const r = await checkReconcileControlBlocker(
    { repo: REPO, "control-issue": 726 },
    { ghIssueViewImpl: async () => ({ state: "OPEN", body: freeForm }), ghEditImpl: () => { throw new Error("must not write"); } },
  );
  assert.equal(r.state, "AMBIGUOUS_BLOCKER");
});

test("an already-durable malformed blocker still fails closed at consumption; readers do not guess", async () => {
  const r = await checkReconcileControlBlocker(
    { repo: REPO, "control-issue": 726 },
    { ghIssueViewImpl: async () => ({ state: "OPEN", body: body({ blocker: MALFORMED_761 }) }), ghEditImpl: () => { throw new Error("must not write"); } },
  );
  assert.equal(r.state, "AMBIGUOUS_BLOCKER");
});

// -- 4. bypass guard ---------------------------------------------------------------------------

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".mjs") && !name.endsWith(".test.mjs")) out.push(p);
  }
  return out;
}

// Complete inventory of production files permitted to persist an Issue body (non-comment):
//   write-control-snapshot.mjs -- THE approved thin-control writer (validateControlSnapshot first).
//   lifecycle-gate.mjs         -- rewrites a Stage 2 *Audit* Issue's own `### Verdict` field; an
//                                 audit record, not parser-sensitive thin-control state.
// control-body-write-guard.mjs only *names* the patterns it refuses.
const BODY_WRITE_ALLOWLIST = new Set([
  "orchestration/write-control-snapshot.mjs",
  "review-watch/lifecycle-gate.mjs",
  "orchestration/control-body-write-guard.mjs",
]);

const RAW_BODY_WRITE_PATTERNS = [
  { name: "gh issue edit", re: /["']issue["']\s*,\s*["']edit["']/ },
  { name: "GraphQL updateIssue", re: /updateIssue\b/ },
];

test("bypass guard: no production orchestration file persists an Issue body outside the approved allowlist", () => {
  const offenders = [];
  for (const file of walk(TOOLS_DIR)) {
    const rel = relative(TOOLS_DIR, file).split("\\").join("/");
    if (BODY_WRITE_ALLOWLIST.has(rel)) continue;
    const text = readFileSync(file, "utf8");
    for (const { name, re } of RAW_BODY_WRITE_PATTERNS) {
      if (re.test(text)) offenders.push(`${rel}: ${name}`);
    }
    // A REST PATCH is only acceptable against an Issue *comment* endpoint.
    text.split("\n").forEach((line, i) => {
      if (/PATCH/.test(line) && /issues\//.test(line) && !/issues\/comments\//.test(line)) {
        offenders.push(`${rel}:${i + 1}: PATCH of a non-comment issues/ endpoint`);
      }
    });
  }
  assert.deepEqual(offenders, [], "raw Issue-body persistence found outside the approved writer; route it through write-control-snapshot.mjs");
});

test("bypass guard: the approved thin-control writer validates before it persists", () => {
  const text = readFileSync(join(HERE, "write-control-snapshot.mjs"), "utf8");
  assert.ok(text.indexOf("validateControlSnapshot(") < text.indexOf("ghEditImpl({"));
});

test("bypass guard: every specialized control mutator composes checkWriteControlSnapshot rather than writing itself", () => {
  for (const f of ["close-control.mjs", "reconcile-control-blocker.mjs", "transition-guard.mjs", "finalize-pr-breakpoint.mjs", "finalize-correction-breakpoint.mjs", "finalize-audit-breakpoint.mjs"]) {
    const text = readFileSync(join(HERE, f), "utf8");
    assert.match(text, /checkWriteControlSnapshot/, f);
  }
});

// -- 5. live-controller boundary ---------------------------------------------------------------

test("hook boundary: representative raw thin-control body edits are denied", () => {
  for (const command of [
    "gh issue edit 726 --body-file /tmp/body.md",
    "gh issue edit 726 --repo LouPineWays/Loop-Dee-Loup --body \"x\"",
    "cat b.md | gh issue edit 726 -F -",
    "gh issue edit 726 --body-file=b.md",
    "gh api repos/LouPineWays/Loop-Dee-Loup/issues/726 -X PATCH -f body=@b.md",
    "gh api graphql -f query='mutation { updateIssue(input:{id:\"x\",body:\"y\"}) { clientMutationId } }'",
    "echo hi && gh issue edit 726 --body-file b.md",
  ]) {
    const d = decideRawControlBodyWrite({ toolName: "Bash", command });
    assert.equal(d.permissionDecision, "deny", command);
    assert.match(d.permissionDecisionReason, /write-control-snapshot\.mjs/);
  }
});

test("hook boundary: the canonical writer and unrelated gh operations are permitted", () => {
  for (const command of [
    "node tools/orchestration/write-control-snapshot.mjs --control-issue 726 --body-file -",
    "cat b.md | node tools/orchestration/write-control-snapshot.mjs --control-issue 726 --body-file -",
    "gh issue edit 726 --add-label priority:now",
    "gh issue view 726 --json body",
    "gh issue comment 726 --body-file note.md",
    "gh pr edit 12 --body-file pr.md",
    "gh api repos/LouPineWays/Loop-Dee-Loup/issues/comments/9 -X PATCH -F body=@c.md",
    "gh api repos/LouPineWays/Loop-Dee-Loup/issues/726/comments -X POST -F body=@c.md",
    "gh api repos/LouPineWays/Loop-Dee-Loup/issues/726",
  ]) {
    assert.equal(decideRawControlBodyWrite({ toolName: "Bash", command }).permissionDecision, "allow", command);
  }
  assert.equal(decideRawControlBodyWrite({ toolName: "Edit", command: "gh issue edit 1 --body x" }).permissionDecision, "allow");
});

// -- 6. synthetic consumer-continuation fixture ------------------------------------------------

test("synthetic continuation: canonical blocked snapshot -> BLOCKED -> prerequisite CLOSED -> reconcile -> fresh continuation, never AMBIGUOUS_BLOCKER", async () => {
  const CONTROL = 9726;
  const PREREQ = 9761;
  const store = {
    [CONTROL]: {
      state: "OPEN",
      body: [
        `- **Execution:** #9725`,
        "- **Lifecycle:** BLOCKED",
        "- **Route:** implementation worker",
        "- **PR:** https://github.com/LouPineWays/Loop-Dee-Loup/pull/9763",
        "- **Stage 1:** requested",
        "- **Stage 2:** none",
        `- **Blocker:** Blocked by #${PREREQ}.`,
        "- **Blocked lifecycle:** REVIEW",
        "- **Blocked route:** unchanged",
        "- **Founder decision:** none",
        "",
      ].join("\n"),
    },
    [PREREQ]: { state: "OPEN", body: "Ordinary prerequisite slice." },
  };

  // The canonical snapshot must itself pass the approved writer's validation.
  assert.equal(checkWriteControlSnapshot({ repo: REPO, controlIssue: CONTROL, proposedBody: store[CONTROL].body }, { ghEditImpl: () => {} }).exitCode, 0);

  const ghIssueViewImpl = async ({ number }) => {
    const d = store[Number(number)];
    if (!d) throw new Error(`no such issue ${number}`);
    return { ...d };
  };
  const ghEditImpl = ({ controlIssue, body: b }) => { store[Number(controlIssue)].body = b; };
  const transitionCalls = [];
  const impls = {
    resolveRepoIdentityImpl: () => ({ ok: true, repo: REPO }),
    checkReadyDispatchImpl: (args) => checkReadyDispatch(args, { ghIssueViewImpl, ghPrListImpl: async () => [] }),
    checkReconcileControlBlockerImpl: (args) => checkReconcileControlBlocker(args, { ghIssueViewImpl, ghEditImpl }),
    runNextReviewTransitionGateImpl: async (args) => {
      transitionCalls.push(args);
      return { exitCode: 0, state: "NO_ACTION_YET", controlIssue: args.controlIssue, actionEnvelope: { mode: "none", authorizedActions: [] } };
    },
  };

  // Pass 1: prerequisite still open -> terminal BLOCKED/INCOMPLETE_PREREQUISITE, nothing written.
  const before = store[CONTROL].body;
  const first = await runSessionEntryGate({ repo: REPO, controlIssue: CONTROL }, impls);
  assert.equal(first.ok, true);
  assert.equal(first.state, "BLOCKED");
  assert.equal(first.reconciliation.state, "INCOMPLETE_PREREQUISITE");
  assert.equal(store[CONTROL].body, before);

  // Prerequisite terminalizes CLOSED (ordinary, non-audit issue: closure alone satisfies).
  store[PREREQ].state = "CLOSED";

  // Pass 2: deterministic reconciliation restores the saved continuation; fresh gate evaluation
  // reaches the post-PR REVIEW continuation with no AMBIGUOUS_BLOCKER anywhere in the trail.
  const second = await runSessionEntryGate({ repo: REPO, controlIssue: CONTROL }, impls);
  assert.equal(second.ok, true);
  assert.notEqual(second.state, "BLOCKED");
  assert.ok(second.provenance.every((p) => p.state !== "AMBIGUOUS_BLOCKER"));
  assert.ok(second.provenance.some((p) => p.gate === "reconcile-control-blocker" && p.state === "UNBLOCKED"));
  assert.equal(transitionCalls.length, 1, "fresh evaluation continued into the post-PR transition gate");
  const restored = store[CONTROL].body;
  assert.match(restored, /\*\*Lifecycle:\*\* REVIEW/);
  assert.match(restored, /\*\*Blocker:\*\* none/i);
  assert.match(restored, /\*\*Blocked lifecycle:\*\* none/i);
  assert.match(restored, /\*\*Blocked route:\*\* none/i);
});
