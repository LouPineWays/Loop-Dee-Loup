#!/usr/bin/env node
// Controller-side, provenance-checked application of an already-reviewed protected-file delta
// onto a current-target successor branch -- issue #980 (control #967; live #867/#868/PR #869).
//
// Problem this closes: after `resolve-protected-conflict.mjs` fails closed on the predecessor
// (e.g. COMPETING_CHANGE in another executor component), the authorized one-successor route
// (docs/bounded-review-cycle.md § Successor integration PR) re-integrates the settled outcome
// onto current `main` by cherry-picking the predecessor's reviewed/correction commits. When such
// a pick conflicts in a protected operating-contract file, the only mechanically-determined
// result is "current target text plus the exact reviewed addition" -- but a worker authoring that
// edit is refused by the provider's Self-Modification protection, and repeating the request or
// asking the founder again cannot repair a tool-level denial. This script is the deterministic
// controller-side transition for that one case. It never chooses a resolution: it reduces the
// conflict to the single permissible result by the same hunk/whole-file proof
// `resolve-protected-conflict.mjs` uses (target authority preserved in order, only reviewed
// content added) and applies it only when every proof holds; otherwise it fails closed with zero
// protected-file mutation. The worker never writes the protected file.
//
// Eligibility (all required; any failure is a typed FAIL_CLOSED reason, nothing is written):
//   Scope        PROTECTED_PATHS only (AGENTS.md, CLAUDE.md). Executor-substrate and ordinary
//                conflicts in the same cherry-pick stay with the authorized worker.
//   Identity     the current branch is the canonical successor branch
//                `issue-<execution>-successor-of-<pr>-attempt-<k>`; a cherry-pick is in progress
//                (CHERRY_PICK_HEAD, single-parent, an ancestor of the corrected head, not already
//                in HEAD).
//   Control      the open control Issue binds Execution, PR and the exact
//                `correction-satisfied at <corrected> (reviewed <reviewed>)` heads, and every
//                reviewed..corrected commit is attributable to the execution Issue (the same
//                `proveAcceptedCorrectionHead` the same-PR resolver uses).
//   Live         the predecessor PR is OPEN with head == corrected head (no moved predecessor) and
//                the live tip of its base branch is contained in HEAD (no stale target).
//   Accepted     the picked commit is an ancestor of the reviewed head or inside the attributable
//                reviewed..corrected range; its blob is the only source of added content.
//   Provenance   index stages are exactly picked^ / HEAD / picked blobs and modes.
//   Mechanical   per-hunk and whole-file proofs from resolve-protected-conflict.mjs.
// Re-entry: when the path is already staged as exactly the proven result, the verdict is
// ALREADY_RESOLVED (exit 0, no mutation).
//
// Never done here: commit, push, rebase, `cherry-pick --continue`, touch non-protected paths,
// author new words, resolve competing semantics, or relax any provider protection.
//
// Usage (successor worktree, cherry-pick in progress):
//   node <controller-authoritative>/resolve-successor-protected-delta.mjs --control-issue <N>
//     --execution-issue <N> --predecessor-pr <N> --reviewed-head <sha> --corrected-head <sha> [--apply]
//     [--repo <owner/repo>]
//   Without --apply it only reports the verdict. Exit 0 RESOLVED/WOULD_RESOLVE/ALREADY_RESOLVED,
//   2 FAIL_CLOSED (no mutation), 1 usage/operational error.
//
// Tests: node --test tools/orchestration/resolve-successor-protected-delta.test.mjs

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PROTECTED_PATHS,
  closed,
  defaultDeps,
  isRegularGitFileMode,
  parseStagedEntry,
  parseTreeEntry,
  parseUnmerged,
  proveAcceptedCorrectionHead,
  proveFile,
  tokenize,
} from "./resolve-protected-conflict.mjs";
import { resolveRepoIdentity } from "./ready-dispatch-gate.mjs";

const SHA40 = /^[0-9a-f]{40}$/i;
const isPosInt = (n) => Number.isInteger(n) && n > 0;

const wordTokens = (text) => tokenize(String(text ?? "")).filter((t) => !/^\s+$/.test(t));
function tokenCounts(text) {
  const m = new Map();
  for (const t of wordTokens(text)) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}
// Tokens a commit's path-limited diff adds / removes (-U0, renames off).
function diffTokens(deps, top, commit, path) {
  const out = deps.git(["diff-tree", "-p", "--no-commit-id", "--no-renames", "-U0", "-r", commit, "--", path], { cwd: top });
  const added = [];
  const removed = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added.push(line.slice(1));
    else if (line.startsWith("-")) removed.push(line.slice(1));
  }
  return { added: wordTokens(added.join("\n")), removed: wordTokens(removed.join("\n")) };
}
const blobAt = (deps, top, rev, path) => {
  try {
    return deps.git(["cat-file", "blob", `${rev}:${path}`], { cwd: top });
  } catch {
    return "";
  }
};

// Issue #980 Stage 1 correction: the protected result must be exactly the later-target contract
// plus only accepted protected changes from the predecessor's reviewed/correction outcome.
// Ancestry alone proves neither, so this checks content: (1) every intervening successor commit
// (target tip..HEAD) that touched the path added only words already present in the target tip
// blob or added by an accepted (target-unreachable) predecessor commit, and HEAD still carries
// every target-tip word unless an accepted commit removed it; (2) the picked commit is not
// inherited from target history, and its net-added words survive in the effective reviewed
// (or, for a correction-range pick, corrected) blob -- an introduced-then-reverted clause fails.
function proveProtectedProvenance({ deps, top, path, baseTip, head, picked, pickedParent, reviewed, corrected, pickedInReviewed }) {
  const fail = (code, reason) => closed(code, reason, { path });
  let intervening;
  let accepted;
  try {
    intervening = deps.git(["rev-list", "--parents", `${baseTip}..${head}`], { cwd: top }).split("\n").filter(Boolean).map((l) => l.split(" "));
    accepted = deps.git(["rev-list", corrected, `^${baseTip}`], { cwd: top }).split("\n").filter(Boolean);
  } catch (err) {
    return fail("SUCCESSOR_HISTORY_UNPROVEN", `could not enumerate successor/predecessor history: ${String(err.message ?? err).split("\n")[0]}`);
  }
  if (intervening.some((c) => c.length !== 2)) {
    return fail("SUCCESSOR_HISTORY_UNPROVEN", "successor history since the target tip contains a merge or root commit; protected provenance cannot be proven");
  }
  if (!accepted.some((c) => c.toLowerCase() === picked.toLowerCase())) {
    return fail("PICKED_COMMIT_NOT_ACCEPTED", `cherry-picked commit ${picked} is inherited from target history or outside the predecessor's accepted delta`);
  }
  const acceptedAdded = new Set();
  const acceptedRemoved = new Set();
  try {
    for (const c of accepted) {
      const d = diffTokens(deps, top, c, path);
      d.added.forEach((t) => acceptedAdded.add(t));
      d.removed.forEach((t) => acceptedRemoved.add(t));
    }
    const baseCounts = tokenCounts(blobAt(deps, top, baseTip, path));
    for (const [commit] of intervening) {
      const d = diffTokens(deps, top, commit, path);
      if (d.added.some((t) => !baseCounts.has(t) && !acceptedAdded.has(t))) {
        return fail("SUCCESSOR_HISTORY_UNPROVEN", `successor commit ${commit} added protected text not present in the target and not from an accepted predecessor commit`);
      }
    }
    const headCounts = tokenCounts(blobAt(deps, top, head, path));
    for (const [t, n] of baseCounts) {
      if ((headCounts.get(t) ?? 0) < n && !acceptedRemoved.has(t)) {
        return fail("SUCCESSOR_HISTORY_UNPROVEN", "successor HEAD dropped target protected text that no accepted predecessor commit removed");
      }
    }
    const pickedCounts = tokenCounts(blobAt(deps, top, picked, path));
    const parentCounts = tokenCounts(blobAt(deps, top, pickedParent, path));
    const effectiveCounts = tokenCounts(blobAt(deps, top, pickedInReviewed ? reviewed : corrected, path));
    for (const [t, n] of pickedCounts) {
      if (n > (parentCounts.get(t) ?? 0) && (effectiveCounts.get(t) ?? 0) < n) {
        return fail("PICKED_DELTA_NOT_EFFECTIVE", "the picked protected addition is not present in the effective reviewed/corrected content (reverted or superseded)");
      }
    }
  } catch (err) {
    return fail("SUCCESSOR_HISTORY_UNPROVEN", `could not prove protected provenance: ${String(err.message ?? err).split("\n")[0]}`);
  }
  return null;
}

export async function resolveSuccessorProtectedDelta(
  { repo, controlIssue, executionIssue, predecessorPr, reviewedHead, correctedHead, apply = false, cwd = process.cwd() },
  deps = defaultDeps(),
) {
  if (
    !isPosInt(controlIssue) ||
    !isPosInt(executionIssue) ||
    !isPosInt(predecessorPr) ||
    typeof reviewedHead !== "string" ||
    !SHA40.test(reviewedHead) ||
    typeof correctedHead !== "string" ||
    !SHA40.test(correctedHead) ||
    typeof repo !== "string" ||
    !repo
  ) {
    return {
      exitCode: 1,
      verdict: "OPERATIONAL_ERROR",
      message: "--control-issue, --execution-issue, --predecessor-pr, 40-character --reviewed-head and --corrected-head are required",
    };
  }
  const g = (args, opts = {}) => deps.git(args, { cwd, ...opts }).trim();
  let top, head, branch, picked, reviewed, corrected;
  try {
    top = g(["rev-parse", "--show-toplevel"]);
    head = g(["rev-parse", "HEAD"]);
    branch = g(["rev-parse", "--abbrev-ref", "HEAD"]);
    reviewed = g(["rev-parse", "--verify", `${reviewedHead}^{commit}`]);
    corrected = g(["rev-parse", "--verify", `${correctedHead}^{commit}`]);
  } catch (err) {
    return closed("REVIEWED_HEAD_UNKNOWN", `reviewed/corrected head is not a commit in this repository: ${String(err.message ?? err).split("\n")[0]}`);
  }
  if (reviewed.toLowerCase() !== reviewedHead.toLowerCase() || corrected.toLowerCase() !== correctedHead.toLowerCase()) {
    return closed("REVIEWED_HEAD_UNKNOWN", "reviewed/corrected head did not resolve to the exact commit supplied");
  }
  const branchRe = new RegExp(`^issue-${executionIssue}-successor-of-${predecessorPr}-attempt-[1-9]\\d*$`);
  if (!branchRe.test(branch)) {
    return closed("SUCCESSOR_IDENTITY_UNVERIFIED", `current branch ${branch} is not the canonical successor branch for execution #${executionIssue} / predecessor PR #${predecessorPr}`);
  }
  try {
    picked = g(["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"]);
  } catch {
    return closed("NO_CHERRY_PICK_IN_PROGRESS", "no cherry-pick is in progress in this checkout");
  }

  // Live predecessor / target identity (revalidated at mutation time, below, again before writes).
  const live = async () => {
    const prView = await deps.readPr({ repo, pr: predecessorPr });
    const baseTip = await deps.readBranchTip({ repo, branch: prView.baseRefName });
    return { prView, baseTip };
  };
  let snap;
  try {
    snap = await live();
  } catch (err) {
    return { exitCode: 1, verdict: "OPERATIONAL_ERROR", message: `could not read live predecessor/target state: ${String(err.message ?? err).split("\n")[0]}` };
  }
  const checkLive = ({ prView, baseTip }) => {
    if (prView.state !== "OPEN") return closed("PREDECESSOR_NOT_OPEN", `predecessor PR #${predecessorPr} is ${prView.state}`);
    if (String(prView.headRefOid).toLowerCase() !== corrected.toLowerCase()) {
      return closed("STALE_PREDECESSOR_HEAD", `predecessor PR #${predecessorPr} head ${prView.headRefOid} is not the authorized corrected head ${corrected}`);
    }
    if (typeof baseTip !== "string") return closed("STALE_TARGET", "live target tip is unreadable");
    try {
      deps.git(["merge-base", "--is-ancestor", baseTip, head], { cwd });
    } catch {
      return closed("STALE_TARGET", `live ${prView.baseRefName} tip ${baseTip} is not contained in the successor HEAD ${head}`);
    }
    return null;
  };
  const liveFail = checkLive(snap);
  if (liveFail) return liveFail;

  const isAncestor = (a, b) => {
    try {
      deps.git(["merge-base", "--is-ancestor", a, b], { cwd });
      return true;
    } catch {
      return false;
    }
  };
  if (!isAncestor(reviewed, corrected)) return closed("REVIEWED_HEAD_NOT_ANCESTOR", "the reviewed head is not an ancestor of the corrected head");
  if (!isAncestor(picked, corrected)) return closed("PICKED_COMMIT_NOT_ACCEPTED", `cherry-picked commit ${picked} is not part of the predecessor's corrected history`);
  if (isAncestor(picked, head)) return closed("PICKED_COMMIT_ALREADY_IN_HEAD", `cherry-picked commit ${picked} is already contained in HEAD`);
  let parents;
  try {
    parents = g(["rev-list", "--parents", "-n", "1", picked]).split(" ").slice(1);
  } catch (err) {
    return { exitCode: 1, verdict: "OPERATIONAL_ERROR", message: `could not read picked commit parents: ${String(err.message ?? err).split("\n")[0]}` };
  }
  if (parents.length !== 1) return closed("PICKED_COMMIT_NOT_SINGLE_PARENT", "the cherry-picked commit must have exactly one parent");
  const pickedParent = parents[0];

  // Accepted content: the control Issue must bind this exact correction-satisfied pair (the
  // governing authority link); the picked commit is then either reviewed history or inside the
  // attributable reviewed..corrected range.
  const correctionProof = await proveAcceptedCorrectionHead({ repo, controlIssue, executionIssue, pr: predecessorPr, reviewed, head: corrected, cwd }, deps);
  if (!correctionProof.ok) return correctionProof;
  const pickedInReviewed = isAncestor(picked, reviewed);
  if (!pickedInReviewed && !correctionProof.commits.some((c) => c.toLowerCase() === picked.toLowerCase())) {
    return closed("PICKED_COMMIT_NOT_ACCEPTED", `cherry-picked commit ${picked} is not inside the attributable reviewed..corrected range`);
  }

  const unmerged = parseUnmerged(deps.git(["ls-files", "-u", "--full-name"], { cwd: top }));
  if (!unmerged) return closed("MALFORMED_INDEX", "could not parse the index's unmerged entries");
  const unmergedProtected = [...unmerged.keys()].filter((p) => PROTECTED_PATHS.includes(p));
  const stagedProtected = [];
  for (const p of PROTECTED_PATHS) {
    if (unmerged.has(p)) continue;
    // Candidate re-entry: staged (stage 0) and touched by this pick.
    const touched = deps.git(["diff-tree", "--no-commit-id", "--name-only", "-r", picked, "--", p], { cwd: top }).trim();
    if (touched === p) stagedProtected.push(p);
  }
  const targets = [...unmergedProtected, ...stagedProtected];
  if (targets.length === 0) return closed("NO_PROTECTED_CONFLICT", "no unmerged or previously-resolved protected path for this cherry-pick");

  const content = (oid) => deps.git(["cat-file", "blob", oid], { cwd });
  const results = [];
  for (const path of targets) {
    const treeEntryAt = (rev) => parseTreeEntry(deps.git(["ls-tree", "--full-tree", rev, "--", path], { cwd: top }), path);
    let headEntry, pickedEntry, baseEntry;
    try {
      headEntry = treeEntryAt(head);
      pickedEntry = treeEntryAt(picked);
      baseEntry = treeEntryAt(pickedParent);
    } catch {
      return closed("PROVENANCE_MISMATCH", `${path} tree provenance could not be read at HEAD, the picked commit or its parent`, { path });
    }
    if (!headEntry || !pickedEntry || !baseEntry) {
      return closed("PROVENANCE_MISMATCH", `${path} is missing at HEAD, the picked commit or its parent`, { path });
    }
    const entries = [headEntry, pickedEntry, baseEntry];
    if (entries.some((e) => e.type !== "blob" || !isRegularGitFileMode(e.mode))) {
      return closed("NON_REGULAR_CONTENT_CONFLICT", `${path} must be a regular file at every provenance point`, { path });
    }
    if (entries.some((e) => e.mode !== headEntry.mode)) {
      return closed("MODE_MISMATCH", `${path} changes file mode across HEAD / picked commit / its parent; mode choices are not resolved mechanically`, { path });
    }
    const prov = proveProtectedProvenance({
      deps, top, path, baseTip: snap.baseTip, head, picked, pickedParent, reviewed, corrected, pickedInReviewed,
    });
    if (prov) return prov;
    const st = unmerged.get(path);
    if (st) {
      if (!st[1] || !st[2] || !st[3]) return closed("NOT_A_CONTENT_CONFLICT", `${path} is not a three-stage content conflict`, { path });
      if (
        st[1].oid !== baseEntry.oid || st[1].mode !== baseEntry.mode ||
        st[2].oid !== headEntry.oid || st[2].mode !== headEntry.mode ||
        st[3].oid !== pickedEntry.oid || st[3].mode !== pickedEntry.mode
      ) {
        return closed("PROVENANCE_MISMATCH", `${path}'s index stages do not exactly match picked^ / HEAD / picked blobs and modes`, { path });
      }
    }
    try {
      if (!deps.isRegularFile(join(top, path))) return closed("NON_REGULAR_WORKTREE_PATH", `${path} is not a regular worktree file`, { path });
    } catch {
      return closed("NON_REGULAR_WORKTREE_PATH", `${path} is missing or cannot be proven a regular worktree file`, { path });
    }
    // PR-side (ours in merge-file terms) is the picked blob; target side is the successor HEAD.
    const pickedText = content(pickedEntry.oid);
    const headText = content(headEntry.oid);
    const diff3 = deps.mergeFile({ ours: pickedText, base: content(baseEntry.oid), theirs: headText });
    const proof = proveFile({ diff3Output: diff3, reviewedText: pickedText, targetText: headText });
    if (!proof.ok) return closed(proof.code, proof.reason, { path, hunk: proof.hunk });
    results.push({ path, resolved: proof.resolved, hunks: proof.hunks, mode: headEntry.mode, wasUnmerged: Boolean(st) });
  }

  // Expected blobs are hashed before any write so a hashing failure can never follow a mutation.
  try {
    for (const r of results) {
      r.expectedOid = deps.git(["hash-object", "--stdin"], { cwd: top, input: r.resolved }).trim();
      r.alreadyStaged = false;
      if (!r.wasUnmerged) {
        const staged = parseStagedEntry(deps.git(["ls-files", "--stage", "--full-name", "--", r.path], { cwd: top }), r.path);
        r.alreadyStaged = Boolean(staged && staged.oid === r.expectedOid && staged.mode === r.mode);
      }
    }
  } catch (err) {
    return { exitCode: 1, verdict: "OPERATIONAL_ERROR", message: `could not evaluate staged protected state: ${String(err.message ?? err).split("\n")[0]}`, mutated: false };
  }
  // A touched path that is already staged must be exactly the proven result; otherwise refuse
  // before any write. Staged-correct paths are left alone while unmerged ones are applied.
  const mismatched = results.find((r) => !r.wasUnmerged && !r.alreadyStaged);
  if (mismatched) {
    return closed("NOT_A_CONTENT_CONFLICT", "a protected path touched by this pick is staged as something other than the proven result", { path: mismatched.path });
  }
  const pending = results.filter((r) => r.wasUnmerged);
  if (pending.length === 0) {
    return { exitCode: 0, verdict: "ALREADY_RESOLVED", mutated: false, paths: results.map((r) => ({ path: r.path, hunks: r.hunks })) };
  }

  if (apply) {
    // Revalidate live identity and local HEAD immediately before the first protected write.
    try {
      const again = await live();
      const fail = checkLive(again);
      if (fail) return fail;
      if (g(["rev-parse", "HEAD"]).toLowerCase() !== head.toLowerCase()) {
        return closed("SUCCESSOR_IDENTITY_UNVERIFIED", "successor HEAD moved after the provenance proof");
      }
    } catch (err) {
      return { exitCode: 1, verdict: "OPERATIONAL_ERROR", message: `could not re-read live state before mutation: ${String(err.message ?? err).split("\n")[0]}`, mutated: false };
    }
    for (const r of pending) {
      try {
        if (!deps.isRegularFile(join(top, r.path))) return closed("NON_REGULAR_WORKTREE_PATH", `${r.path} stopped being a regular worktree file`, { path: r.path });
      } catch {
        return closed("NON_REGULAR_WORKTREE_PATH", `${r.path} cannot be proven to remain a regular worktree file`, { path: r.path });
      }
    }
    // From here any failure may follow a worktree change: never report mutated:false.
    const applied = [];
    for (const r of pending) {
      let replaced = false;
      try {
        deps.replaceFileAtomically(join(top, r.path), r.resolved, r.mode);
        replaced = true;
        deps.git(["add", "--", r.path], { cwd: top });
        const staged = parseStagedEntry(deps.git(["ls-files", "--stage", "--full-name", "--", r.path], { cwd: top }), r.path);
        if (!staged || staged.mode !== r.mode || staged.oid !== r.expectedOid) {
          return {
            exitCode: 1, verdict: "OPERATIONAL_ERROR", code: "POSTCONDITION_FAILED", message: `${r.path} did not stage as the proven blob`,
            mutated: true, path: r.path, appliedPaths: applied,
          };
        }
        applied.push(r.path);
      } catch (err) {
        return {
          exitCode: 1,
          verdict: "OPERATIONAL_ERROR",
          code: "ATOMIC_REPLACE_FAILED",
          message: `could not apply ${r.path}: ${String(err.message ?? err).split("\n")[0]}`,
          mutated: replaced || applied.length > 0 || Boolean(err?.mutated),
          path: r.path,
          appliedPaths: applied,
        };
      }
    }
  }
  return {
    exitCode: 0,
    verdict: apply ? "RESOLVED" : "WOULD_RESOLVE",
    mutated: apply,
    paths: pending.map((r) => ({ path: r.path, hunks: r.hunks })),
    pickedCommit: picked,
  };
}

function parseArgs(argv) {
  const args = { apply: false };
  const num = (v) => Number(v);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--control-issue") args.controlIssue = num(argv[++i]);
    else if (a === "--execution-issue") args.executionIssue = num(argv[++i]);
    else if (a === "--predecessor-pr") args.predecessorPr = num(argv[++i]);
    else if (a === "--reviewed-head") args.reviewedHead = argv[++i];
    else if (a === "--corrected-head") args.correctedHead = argv[++i];
    else if (a === "--repo") args.repo = argv[++i];
    else return { error: `unknown argument ${a}` };
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    console.error(args.error);
    return 1;
  }
  let repo = args.repo;
  if (!repo) {
    const id = resolveRepoIdentity();
    if (!id.ok) {
      console.error(`could not resolve repository identity: ${id.reason}`);
      return 1;
    }
    repo = id.repo;
  }
  const result = await resolveSuccessorProtectedDelta({ ...args, repo });
  console.log(JSON.stringify(result, null, 2));
  return result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
