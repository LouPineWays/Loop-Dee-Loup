#!/usr/bin/env node
// Deterministic, bounded protected-file merge-conflict reconciliation -- issue #907 (control
// #908; live reproduction #867/#868/PR #869).
//
// Problem this closes: a correction-conflict recovery worker (docs/bounded-review-cycle.md §
// Correction-satisfied merge-conflict recovery) merged current `origin/main` into a corrected PR
// head and reached one remaining conflict hunk in `AGENTS.md`: main's rewritten paragraph plus
// one already-reviewed clause the PR had added to it. The resolution was mechanically
// determined, yet the worker stopped because the provider/runtime self-modification protection
// (rightly) refused an agent-authored edit to the operating contract. LDL must not teach an agent
// to bypass that protection; it must instead make the authorized transition deterministic.
//
// This script is that transition. It never *chooses* a resolution. It reduces a protected-file
// conflict to exactly one permissible result by proof, and applies that result only when every
// proof holds; otherwise it fails closed with zero protected-file mutation. A worker invokes it
// in the merge-in-progress checkout instead of editing the file itself.
//
// Eligibility (all required; any failure is a FAIL_CLOSED reason code, nothing is written):
//   Scope        the path is in PROTECTED_PATHS (a closed list -- not a general editor) and is a
//                regular three-stage content conflict (base, PR side, target side all present).
//   Binding      this checkout is the live pre-bound PR-head reservation (the lock record
//                pr-head-checkout-preflight.mjs wrote; `--binding-token`/`--pr` must match it if given), HEAD equals the reservation's
//                pinned corrected head AND the PR's live head (no stale/moved head).
//   Merge        a merge is in progress whose MERGE_HEAD equals the live tip of the PR's base
//                branch (no stale target) and is not already contained in HEAD.
//   Provenance   the index's stage blobs are exactly HEAD:path (PR side), MERGE_HEAD:path
//                (target side) and the single merge-base's path (base) -- a tampered index or
//                worktree cannot feed the proof.
//   Reviewed     the PR side's file is byte-identical to the file at the Stage 1 reviewed head
//                (`--reviewed-head`, a proven ancestor of HEAD): nothing in the protected file
//                changed after review, so no unreviewed post-review content can ride through.
//   Mechanical   per conflict hunk, a token-level three-way proof: the PR side is a pure
//                insertion into the base (it deletes/rewrites nothing); each insertion sits
//                between two base tokens the target side kept unchanged and adjacent (so the
//                target never edited or inserted at that point); and the composed result minus
//                the PR insertions equals the target side exactly. Target content is therefore
//                wholly preserved and only already-reviewed PR content is added.
// Anything else -- a target change that would be dropped, both sides editing/inserting at the
// same place, a PR-side rewrite, ambiguous alignment -- is a founder interrupt, never selected.
//
// Never done here: commit, push, rebase, touch other conflicted files, write a path outside
// PROTECTED_PATHS, or relax a provider protection. The worker still resolves ordinary conflicts,
// commits the merge, verifies, pushes, and finalizes per the recovery contract.
//
// Usage (from the reserved checkout, merge in progress):
//   node tools/orchestration/resolve-protected-conflict.mjs --reviewed-head <sha> [--apply]
//     [--pr <N>] [--binding-token <token>] [--path AGENTS.md]... [--repo <owner/repo>]
//   Without --apply it only reports the verdict (dry run). Exit 0 RESOLVED/WOULD_RESOLVE,
//   2 FAIL_CLOSED (founder interrupt, no mutation), 1 usage/operational error.
//
// Tests: node --test tools/orchestration/resolve-protected-conflict.test.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseBindingLockReason } from "./pr-head-checkout-preflight.mjs";
import { parseWorktreeListPorcelain } from "./worktree-preflight.mjs";
import { normalizePathForComparison } from "./classify-primary-path-lock.mjs";
import { readGithubPr } from "./github-read.mjs";
import { resolveRepoIdentity } from "./ready-dispatch-gate.mjs";

// Closed list of operating-contract files this reconciliation may ever write. Deliberately not
// derived from the executor-substrate classifier: widening it is a new, separately authorized
// change to this script, never a runtime option.
export const PROTECTED_PATHS = Object.freeze(["AGENTS.md", "CLAUDE.md"]);

const MAX_ALIGN_CELLS = 4_000_000;
const SHA_RE = /^[0-9a-f]{7,64}$/i;

export function tokenize(text) {
  return text.split(/(\s+)/).filter((t) => t !== "");
}

// Longest-common-subsequence alignment of `base` against `other`. Returns null when the
// problem is too large to align (fail closed rather than approximate).
export function align(base, other) {
  const n = base.length;
  const m = other.length;
  if ((n + 1) * (m + 1) > MAX_ALIGN_CELLS) return null;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        base[i] === other[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const baseToOther = new Array(n).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (base[i] === other[j]) {
      baseToOther[i] = j;
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return baseToOther;
}

// Insertions of `other` relative to `base` given an alignment: Map gap -> [{ token }], where
// gap g sits between base tokens g-1 and g.
function insertionsOf(baseToOther, otherTokens) {
  const ins = new Map();
  const otherToBase = new Map();
  baseToOther.forEach((o, b) => {
    if (o >= 0) otherToBase.set(o, b);
  });
  let gap = 0;
  for (let j = 0; j < otherTokens.length; j++) {
    if (otherToBase.has(j)) gap = otherToBase.get(j) + 1;
    else {
      if (!ins.has(gap)) ins.set(gap, []);
      ins.get(gap).push({ token: otherTokens[j] });
    }
  }
  return ins;
}

// Pure. Proves (or refuses) the single mechanical resolution of ONE conflict hunk. `prText` is
// the PR side, `baseText` the merge base, `targetText` the target side, `reviewedText` the whole
// reviewed protected file. Returns { ok: true, resolved, insertedText } or { ok: false, code,
// reason }.
export function proveHunk({ prText, baseText, targetText, reviewedText }) {
  const base = tokenize(baseText);
  const pr = tokenize(prText);
  const target = tokenize(targetText);
  const prAlign = align(base, pr);
  const targetAlign = align(base, target);
  if (!prAlign || !targetAlign) return fail("HUNK_TOO_LARGE", "conflict hunk too large to prove mechanically");

  if (prAlign.some((x) => x < 0)) {
    return fail("PR_SIDE_REWRITES_BASE", "the PR side deletes or rewrites base content; not a pure reviewed insertion");
  }
  const prIns = insertionsOf(prAlign, pr);
  if (prIns.size === 0) return fail("NO_PR_CHANGE", "the PR side adds nothing to the base; not the expected conflict shape");

  const targetIns = insertionsOf(targetAlign, target);
  const n = base.length;
  const insertBefore = new Map(); // target token index -> PR tokens placed before it
  let appendAtEnd = null;
  for (const [gap, entries] of prIns) {
    const text = entries.map((e) => e.token).join("");
    if (text.trim() !== "" && !reviewedText.includes(text.trim())) {
      return fail("UNREVIEWED_PR_CONTENT", "a PR-side insertion is not present in the Stage 1 reviewed file");
    }
    const left = gap > 0 ? targetAlign[gap - 1] : null;
    const right = gap < n ? targetAlign[gap] : null;
    if ((gap > 0 && left < 0) || (gap < n && right < 0)) {
      return fail("COMPETING_CHANGE", "the target side edited or removed content adjacent to a PR-side insertion");
    }
    if (targetIns.has(gap)) {
      return fail("COMPETING_CHANGE", "both sides add content at the same position; ordering is a semantic choice");
    }
    if (gap > 0 && gap < n && right !== left + 1) {
      return fail("AMBIGUOUS_ALIGNMENT", "the target side's token alignment around the insertion point is not contiguous");
    }
    const toks = entries.map((e) => e.token);
    if (gap < n) insertBefore.set(right, toks);
    else appendAtEnd = toks;
  }

  const out = [];
  const inserted = [];
  for (let j = 0; j < target.length; j++) {
    if (insertBefore.has(j)) {
      for (const t of insertBefore.get(j)) {
        inserted.push(out.length);
        out.push(t);
      }
    }
    out.push(target[j]);
  }
  if (appendAtEnd) {
    for (const t of appendAtEnd) {
      inserted.push(out.length);
      out.push(t);
    }
  }
  const resolved = out.join("");

  // Independent re-verification of both halves of the proof.
  // (1) Target content is wholly preserved: the result minus the proven PR insertions is the
  //     target side exactly.
  const insertedAt = new Set(inserted);
  const withoutInsertions = out.filter((_, i) => !insertedAt.has(i)).join("");
  if (withoutInsertions !== targetText) {
    return fail("VERIFICATION_FAILED", "composed result does not preserve the target side exactly");
  }
  // (2) Only PR content is added: base plus the proven PR insertions reproduces the PR side
  //     exactly, and every inserted token is accounted for.
  const prRebuilt = [];
  for (let gap = 0; gap <= n; gap++) {
    if (prIns.has(gap)) prRebuilt.push(...prIns.get(gap).map((e) => e.token));
    if (gap < n) prRebuilt.push(base[gap]);
  }
  const insertedCount = [...prIns.values()].reduce((sum, e) => sum + e.length, 0);
  if (prRebuilt.join("") !== prText || inserted.length !== insertedCount) {
    return fail("VERIFICATION_FAILED", "proven insertions do not reproduce the PR side's content");
  }
  return { ok: true, resolved };
}

function fail(code, reason) {
  return { ok: false, code, reason };
}

// Parses `git merge-file -p --diff3` output into ordered segments: { text } | { conflict: {
// ours, base, theirs } }. Returns null on any malformed marker structure.
export function parseDiff3(output) {
  const lines = output.split(/(?<=\n)/);
  const segments = [];
  let plain = "";
  let state = "plain";
  let cur = null;
  for (const line of lines) {
    const bare = line.replace(/\r?\n$/, "");
    if (state === "plain") {
      if (/^<{7}( |$)/.test(bare)) {
        if (plain) segments.push({ text: plain });
        plain = "";
        cur = { ours: "", base: "", theirs: "" };
        state = "ours";
      } else if (/^(\|{7}|={7}|>{7})( |$)/.test(bare)) return null;
      else plain += line;
    } else if (state === "ours") {
      if (/^\|{7}( |$)/.test(bare)) state = "base";
      else if (/^(<{7}|={7}|>{7})( |$)/.test(bare)) return null;
      else cur.ours += line;
    } else if (state === "base") {
      if (/^={7}$/.test(bare)) state = "theirs";
      else if (/^(<{7}|\|{7}|>{7})( |$)/.test(bare)) return null;
      else cur.base += line;
    } else if (state === "theirs") {
      if (/^>{7}( |$)/.test(bare)) {
        segments.push({ conflict: cur });
        cur = null;
        state = "plain";
      } else if (/^(<{7}|\|{7}|={7})( |$)/.test(bare)) return null;
      else cur.theirs += line;
    }
  }
  if (state !== "plain") return null;
  if (plain) segments.push({ text: plain });
  return segments;
}

// Pure. Proves a whole file; returns { ok, resolved, hunks } or the first failure.
export function proveFile({ diff3Output, reviewedText }) {
  const segments = parseDiff3(diff3Output);
  if (!segments) return fail("MALFORMED_CONFLICT", "conflict markers are not a well-formed diff3 structure");
  const hunks = segments.filter((s) => s.conflict);
  if (hunks.length === 0) return fail("NO_CONFLICT_HUNKS", "no conflict hunks to reconcile; not the expected shape");
  let resolved = "";
  let count = 0;
  for (const seg of segments) {
    if (seg.text !== undefined) {
      resolved += seg.text;
      continue;
    }
    const r = proveHunk({
      prText: seg.conflict.ours,
      baseText: seg.conflict.base,
      targetText: seg.conflict.theirs,
      reviewedText,
    });
    if (!r.ok) return { ...r, hunk: count + 1 };
    resolved += r.resolved;
    count++;
  }
  if (/^(<{7}|\|{7}|={7}|>{7})( |$)/m.test(resolved)) {
    return fail("VERIFICATION_FAILED", "resolved text still contains conflict markers");
  }
  return { ok: true, resolved, hunks: count };
}

// ---------------------------------------------------------------------------------------------
// Orchestration (git/gh effects injected for tests).
// ---------------------------------------------------------------------------------------------

function git(args, { cwd, input } = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
}

export function defaultDeps() {
  return {
    git: (args, opts) => git(args, opts),
    readPr: ({ repo, pr }) => readGithubPr({ repo, number: pr, fields: ["headRefOid", "baseRefName", "state"] }),
    readBranchTip: ({ repo, branch }) =>
      JSON.parse(
        execFileSync("gh", ["api", `repos/${repo}/git/ref/heads/${branch}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
      ).object?.sha,
    mergeFile: ({ ours, base, theirs }) => {
      const dir = mkdtempSync(join(tmpdir(), "ldl-protected-conflict-"));
      try {
        writeFileSync(join(dir, "ours"), ours);
        writeFileSync(join(dir, "base"), base);
        writeFileSync(join(dir, "theirs"), theirs);
        try {
          return execFileSync(
            "git",
            ["merge-file", "-p", "--diff3", "-L", "ours", "-L", "base", "-L", "theirs", join(dir, "ours"), join(dir, "base"), join(dir, "theirs")],
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
          );
        } catch (err) {
          // Exit status = number of conflicts (positive); the merged text is still on stdout.
          if (typeof err.status === "number" && err.status > 0 && typeof err.stdout === "string") return err.stdout;
          throw err;
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    writeFile: (path, text) => writeFileSync(path, text),
  };
}

function closed(code, reason, extra = {}) {
  return { exitCode: 2, verdict: "FAIL_CLOSED", code, reason, mutated: false, ...extra };
}

function parseUnmerged(lsFilesU) {
  const byPath = new Map();
  for (const line of lsFilesU.split("\n")) {
    if (!line.trim()) continue;
    const m = /^(\d+) ([0-9a-f]+) ([123])\t(.+)$/.exec(line);
    if (!m) return null;
    if (!byPath.has(m[4])) byPath.set(m[4], {});
    byPath.get(m[4])[m[3]] = { mode: m[1], oid: m[2] };
  }
  return byPath;
}

export async function resolveProtectedConflict(
  { repo, pr, token, reviewedHead, paths = [], apply = false, cwd = process.cwd() },
  deps = defaultDeps(),
) {
  const prGiven = pr !== undefined && pr !== null && !Number.isNaN(pr);
  if (
    (prGiven && (!Number.isInteger(pr) || pr <= 0)) ||
    (token !== undefined && token !== null && (typeof token !== "string" || !token)) ||
    typeof reviewedHead !== "string" ||
    !SHA_RE.test(reviewedHead) ||
    typeof repo !== "string" ||
    !repo
  ) {
    return { exitCode: 1, verdict: "OPERATIONAL_ERROR", message: "--reviewed-head <sha> and a repository are required; --pr/--binding-token, when given, must be well-formed" };
  }
  for (const p of paths) {
    if (!PROTECTED_PATHS.includes(p)) {
      return closed("PATH_NOT_ELIGIBLE", `${p} is not an eligible protected operating-contract path (${PROTECTED_PATHS.join(", ")})`);
    }
  }
  const g = (args) => deps.git(args, { cwd }).trim();
  let top, head, reviewed;
  let mergeHead;
  try {
    top = g(["rev-parse", "--show-toplevel"]);
    head = g(["rev-parse", "HEAD"]);
    try {
      reviewed = g(["rev-parse", "--verify", `${reviewedHead}^{commit}`]);
    } catch {
      return closed("REVIEWED_HEAD_UNKNOWN", `reviewed head ${reviewedHead} is not a commit in this repository`);
    }
  } catch (err) {
    return { exitCode: 1, verdict: "OPERATIONAL_ERROR", message: `could not read checkout state: ${String(err.message ?? err).split("\n")[0]}` };
  }

  // Binding: this checkout must be the live PR-head reservation (a locked, non-primary worktree
  // carrying pr-head-checkout-preflight.mjs's lock record). `--binding-token`/`--pr`, when given,
  // must match that record; when omitted they are read from it.
  let binding = null;
  try {
    const worktrees = parseWorktreeListPorcelain(g(["worktree", "list", "--porcelain"]));
    const same = (a, b) => normalizePathForComparison(a) !== null && normalizePathForComparison(a) === normalizePathForComparison(b);
    const here = worktrees.filter((w) => same(w.path, top));
    if (here.length !== 1) return closed("BINDING_UNVERIFIED", "this checkout is not exactly one registered worktree");
    binding = here[0].locked ? parseBindingLockReason(here[0].lockedReason) : null;
    if (!binding) return closed("BINDING_UNVERIFIED", "this checkout carries no PR-head binding reservation");
    if (same(here[0].path, worktrees[0]?.path)) return closed("BINDING_UNVERIFIED", "the reserved checkout is the primary checkout");
    if (token && binding.token !== token) return closed("BINDING_UNVERIFIED", "the binding token does not match this checkout's reservation");
    const others = worktrees.filter((w) => w !== here[0] && w.locked && parseBindingLockReason(w.lockedReason)?.token === binding.token);
    if (others.length) return closed("BINDING_UNVERIFIED", `reservation ${binding.token} is claimed by more than one worktree`);
  } catch (err) {
    return { exitCode: 1, verdict: "OPERATIONAL_ERROR", message: `could not read worktree bindings: ${String(err.message ?? err).split("\n")[0]}` };
  }
  if (prGiven && binding.pr !== pr) return closed("BINDING_UNVERIFIED", `the reservation is for PR #${binding.pr}, not PR #${pr}`);
  pr = binding.pr;
  try {
    mergeHead = g(["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
  } catch {
    return closed("NO_MERGE_IN_PROGRESS", "no merge is in progress in this checkout");
  }

  // Live PR / target state.
  let prView, baseTip;
  try {
    prView = await deps.readPr({ repo, pr });
    baseTip = await deps.readBranchTip({ repo, branch: prView.baseRefName });
  } catch (err) {
    return { exitCode: 1, verdict: "OPERATIONAL_ERROR", message: `could not read live PR/target state: ${String(err.message ?? err).split("\n")[0]}` };
  }
  if (prView.state !== "OPEN") return closed("PR_NOT_OPEN", `PR #${pr} is ${prView.state}`);
  if (head !== binding.sha || head !== prView.headRefOid) {
    return closed("STALE_HEAD", `HEAD ${head} must equal both the reservation's pinned head ${binding.sha} and the PR's live head ${prView.headRefOid}`);
  }
  if (typeof baseTip !== "string" || mergeHead !== baseTip) {
    return closed("STALE_TARGET", `MERGE_HEAD ${mergeHead} is not the live tip ${baseTip} of ${prView.baseRefName}`);
  }
  try {
    deps.git(["merge-base", "--is-ancestor", reviewed, head], { cwd });
  } catch {
    return closed("REVIEWED_HEAD_NOT_ANCESTOR", "the reviewed head is not an ancestor of the corrected head");
  }
  try {
    deps.git(["merge-base", "--is-ancestor", mergeHead, head], { cwd });
    return closed("TARGET_ALREADY_MERGED", "MERGE_HEAD is already contained in HEAD");
  } catch {
    // not an ancestor: expected
  }
  let mergeBase;
  try {
    const bases = g(["merge-base", "--all", head, mergeHead]).split("\n").filter(Boolean);
    if (bases.length !== 1) return closed("AMBIGUOUS_MERGE_BASE", `expected exactly one merge base, found ${bases.length}`);
    mergeBase = bases[0];
  } catch (err) {
    return { exitCode: 1, verdict: "OPERATIONAL_ERROR", message: `could not compute merge base: ${String(err.message ?? err).split("\n")[0]}` };
  }

  const unmerged = parseUnmerged(deps.git(["ls-files", "-u"], { cwd }));
  if (!unmerged) return closed("MALFORMED_INDEX", "could not parse the index's unmerged entries");
  const targets = paths.length ? paths : [...unmerged.keys()].filter((p) => PROTECTED_PATHS.includes(p));
  if (targets.length === 0) return closed("NO_PROTECTED_CONFLICT", "no unmerged eligible protected path in this checkout");

  const results = [];
  for (const path of targets) {
    const st = unmerged.get(path);
    if (!st || !st[1] || !st[2] || !st[3]) return closed("NOT_A_CONTENT_CONFLICT", `${path} is not a three-stage content conflict`, { path });
    const blobAt = (rev) => g(["rev-parse", "--verify", `${rev}:${path}`]);
    let headOid, targetOid, baseOid, reviewedOid;
    try {
      headOid = blobAt(head);
      targetOid = blobAt(mergeHead);
      baseOid = blobAt(mergeBase);
      reviewedOid = blobAt(reviewed);
    } catch {
      return closed("PROVENANCE_MISMATCH", `${path} is missing at HEAD, MERGE_HEAD, the merge base or the reviewed head`, { path });
    }
    if (st[2].oid !== headOid || st[3].oid !== targetOid || st[1].oid !== baseOid) {
      return closed("PROVENANCE_MISMATCH", `${path}'s index stages do not match HEAD / MERGE_HEAD / merge-base blobs`, { path });
    }
    if (headOid !== reviewedOid) {
      return closed("UNREVIEWED_POST_REVIEW_CONTENT", `${path} at the corrected head differs from the Stage 1 reviewed head`, { path });
    }
    const content = (oid) => deps.git(["cat-file", "blob", oid], { cwd });
    const diff3 = deps.mergeFile({ ours: content(headOid), base: content(baseOid), theirs: content(targetOid) });
    const proof = proveFile({ diff3Output: diff3, reviewedText: content(reviewedOid) });
    if (!proof.ok) return closed(proof.code, proof.reason, { path, hunk: proof.hunk });
    results.push({ path, resolved: proof.resolved, hunks: proof.hunks });
  }

  // Every proof held -- only now may anything be written.
  if (apply) {
    for (const r of results) {
      deps.writeFile(join(top, r.path), r.resolved);
      deps.git(["add", "--", r.path], { cwd });
    }
  }
  return {
    exitCode: 0,
    verdict: apply ? "RESOLVED" : "WOULD_RESOLVE",
    mutated: apply,
    paths: results.map((r) => ({ path: r.path, hunks: r.hunks })),
  };
}

function parseArgs(argv) {
  const args = { paths: [], apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--path") args.paths.push(argv[++i]);
    else if (a === "--pr") args.pr = Number(argv[++i]);
    else if (a === "--binding-token") args.token = argv[++i];
    else if (a === "--reviewed-head") args.reviewedHead = argv[++i];
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
    try {
      const id = resolveRepoIdentity();
      if (!id.ok) throw new Error(id.reason);
      repo = id.repo;
    } catch (err) {
      console.error(`could not resolve repository identity: ${err.message}`);
      return 1;
    }
  }
  const result = await resolveProtectedConflict({ ...args, repo });
  console.log(JSON.stringify(result, null, 2));
  return result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
