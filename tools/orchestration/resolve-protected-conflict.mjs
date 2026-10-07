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
//   Scope        default selection stays on PROTECTED_PATHS. Correction-satisfied control mode
//                may additionally select registered executor-substrate paths; ordinary work
//                product and unregistered paths remain ineligible.
//   Binding      this checkout is the live pre-bound PR-head reservation (the lock record
//                pr-head-checkout-preflight.mjs wrote; `--binding-token`/`--pr` must match it if given), HEAD equals the reservation's
//                pinned corrected head AND the PR's live head (no stale/moved head).
//   Merge        a merge is in progress whose MERGE_HEAD equals the live tip of the PR's base
//                branch (no stale target) and is not already contained in HEAD.
//   Provenance   the index's stage blobs are exactly HEAD:path (PR side), MERGE_HEAD:path
//                (target side) and the single merge-base's path (base) -- a tampered index or
//                worktree cannot feed the proof.
//   Accepted     content is byte-identical to the Stage 1 reviewed head OR the exact
//                correction-satisfied HEAD bound by --control-issue/--execution-issue, with every
//                reviewed..HEAD commit attributable to that execution Issue.
//   Mechanical   per hunk, the result preserves target authority and adds only accepted PR
//                content. Pure insertions remain supported; same-gap additions require unique
//                containment; shared rewrites require identical base deletions and one resulting
//                hunk to contain the other. Competing content/order remains fail-closed.
//   Whole file   the same invariant is then proven over the COMPLETE resolved file (plain
//                segments included): every target-file token survives in order and every other
//                token run is reviewed PR content, so a PR-side deletion/rewrite outside a
//                conflict hunk fails closed (PR #923 Stage 1 finding).
// Anything else -- target loss, asymmetric rewrites, non-containing same-gap edits, stale
// correction provenance, or ambiguous alignment -- is a founder interrupt/stop, never selected.
//
// Never done here: commit, push, rebase, touch unrequested conflicts, write ordinary work-product
// paths, author novel executor-substrate semantics, or relax a provider protection. The worker still resolves ordinary conflicts,
// commits the merge, verifies, pushes, and finalizes per the recovery contract.
//
// Usage (from the reserved checkout, merge in progress):
//   node <controller-authoritative>/resolve-protected-conflict.mjs --reviewed-head <sha> [--apply]
//     [--control-issue <N> --execution-issue <N> --all-executor-substrate]
//     [--pr <N>] [--binding-token <token>] [--path <eligible-path>]... [--repo <owner/repo>]
//   Without --apply it only reports the verdict (dry run). Exit 0 RESOLVED/WOULD_RESOLVE,
//   2 FAIL_CLOSED (founder interrupt, no mutation), 1 usage/operational error.
//
// Tests: node --test tools/orchestration/resolve-protected-conflict.test.mjs

import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseBindingLockReason } from "./pr-head-checkout-preflight.mjs";
import { parseWorktreeListPorcelain } from "./worktree-preflight.mjs";
import { normalizePathForComparison } from "./classify-primary-path-lock.mjs";
import { readGithubIssue, readGithubPr } from "./github-read.mjs";
import { classifyMechanicalIntegrationPath } from "./executor-substrate-authority.mjs";
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
      ins.get(gap).push({ token: otherTokens[j], index: j });
    }
  }
  return ins;
}

function sameDeletionMask(a, b) {
  return a.length === b.length && a.every((x, i) => (x < 0) === (b[i] < 0));
}

function uniqueContiguousIndex(haystack, needle) {
  if (needle.length === 0) return { index: 0, unique: true };
  let found = -1;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) { ok = false; break; }
    }
    if (!ok) continue;
    if (found !== -1) return { index: -1, unique: false };
    found = i;
  }
  return { index: found, unique: found !== -1 };
}

function tokenSubsequence(needle, haystack) {
  let n = 0;
  for (const token of haystack) if (n < needle.length && token === needle[n]) n++;
  return n === needle.length;
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

  // #939: identical shared base rewrites are composable only when one resulting hunk contains the other.
  if (prAlign.some((x) => x < 0)) {
    if (!sameDeletionMask(prAlign, targetAlign)) {
      return fail("PR_SIDE_REWRITES_BASE", "the PR side deletes or rewrites base content that the target side does not delete identically");
    }
    if (tokenSubsequence(target, pr)) return { ok: true, resolved: prText };
    if (tokenSubsequence(pr, target)) return { ok: true, resolved: targetText };
    return fail("COMPETING_CHANGE", "shared base rewrite still leaves competing non-containing content");
  }

  const prIns = insertionsOf(prAlign, pr);
  if (prIns.size === 0) return fail("NO_PR_CHANGE", "the PR side adds nothing to the base; not the expected conflict shape");
  const targetIns = insertionsOf(targetAlign, target);
  const n = base.length;
  const insertBefore = new Map();
  const insertAfter = new Map();
  let appendAtEnd = null;
  for (const [gap, entries] of prIns) {
    const text = entries.map((e) => e.token).join("");
    if (text.trim() !== "" && !reviewedText.includes(text.trim())) return fail("UNREVIEWED_PR_CONTENT", "a PR-side insertion is not present in accepted Stage 1/correction content");
    const left = gap > 0 ? targetAlign[gap - 1] : null;
    const right = gap < n ? targetAlign[gap] : null;
    if ((gap > 0 && left < 0) || (gap < n && right < 0)) return fail("COMPETING_CHANGE", "the target side edited or removed content adjacent to a PR-side insertion");
    const toks = entries.map((e) => e.token);
    if (targetIns.has(gap)) {
      const te = targetIns.get(gap);
      const tt = te.map((e) => e.token);
      if (uniqueContiguousIndex(tt, toks).unique) continue;
      const targetInPr = uniqueContiguousIndex(toks, tt);
      if (!targetInPr.unique) return fail("COMPETING_CHANGE", "same-gap additions are non-containing or ambiguously repeated");
      const prefix = toks.slice(0, targetInPr.index);
      const suffix = toks.slice(targetInPr.index + tt.length);
      if (prefix.length) insertBefore.set(te[0].index, prefix);
      if (suffix.length) insertAfter.set(te[te.length - 1].index, suffix);
      continue;
    }
    if (gap > 0 && gap < n && right !== left + 1) return fail("AMBIGUOUS_ALIGNMENT", "the target side token alignment around the insertion point is not contiguous");
    if (gap < n) insertBefore.set(right, toks);
    else appendAtEnd = toks;
  }

  const out = [];
  const inserted = [];
  for (let j = 0; j < target.length; j++) {
    if (insertBefore.has(j)) for (const t of insertBefore.get(j)) { inserted.push(out.length); out.push(t); }
    out.push(target[j]);
    if (insertAfter.has(j)) for (const t of insertAfter.get(j)) { inserted.push(out.length); out.push(t); }
  }
  if (appendAtEnd) for (const t of appendAtEnd) { inserted.push(out.length); out.push(t); }
  const resolved = out.join("");
  const insertedAt = new Set(inserted);
  if (out.filter((_, i) => !insertedAt.has(i)).join("") !== targetText) return fail("VERIFICATION_FAILED", "composed result does not preserve the target side exactly");
  const prRebuilt = [];
  for (let gap = 0; gap <= n; gap++) {
    if (prIns.has(gap)) prRebuilt.push(...prIns.get(gap).map((e) => e.token));
    if (gap < n) prRebuilt.push(base[gap]);
  }
  if (prRebuilt.join("") !== prText) return fail("VERIFICATION_FAILED", "proven insertions do not reproduce the PR side content");
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
// Whole-file invariant (Stage 1 finding on PR #923): the per-hunk proof alone leaves the plain
// (non-conflict) segments unproven, so a reviewed PR-side deletion/rewrite of target content
// outside a conflict hunk could ride through. This checks the COMPLETE resolved file: every
// target-file token must survive in order (target wholly preserved), and every remaining token
// run must be reviewed PR content. Linear greedy subsequence match; fails closed on any doubt.
export function proveWholeFile({ resolved, targetText, reviewedText }) {
  if (typeof targetText !== "string") return fail("VERIFICATION_FAILED", "target file text is required for the whole-file proof");
  const target = tokenize(targetText);
  const out = tokenize(resolved);
  let t = 0;
  const runs = [];
  let run = "";
  for (const tok of out) {
    if (t < target.length && tok === target[t]) {
      t++;
      if (run) runs.push(run);
      run = "";
    } else run += tok;
  }
  if (run) runs.push(run);
  if (t !== target.length) {
    return fail("TARGET_CONTENT_DROPPED", "the resolved file does not preserve the whole target file; a PR-side deletion or rewrite outside the conflict hunk would drop target content");
  }
  for (const r of runs) {
    if (r.trim() !== "" && !reviewedText.includes(r.trim())) {
      return fail("UNREVIEWED_PR_CONTENT", "the resolved file adds content that is not present in the Stage 1 reviewed file");
    }
  }
  return { ok: true };
}

export function proveFile({ diff3Output, reviewedText, targetText }) {
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
  const whole = proveWholeFile({ resolved, targetText, reviewedText });
  if (!whole.ok) return whole;
  return { ok: true, resolved, hunks: count };
}

// ---------------------------------------------------------------------------------------------
// Orchestration (git/gh effects injected for tests).
// ---------------------------------------------------------------------------------------------

function git(args, { cwd, input } = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
}

function parseControlBullet(body, label) {
  const prefix = `- **${label}:**`;
  const line = String(body ?? "").split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : null;
}

function parseIssueRef(value) {
  const m = /^#(\d+)$/.exec(String(value ?? "").trim());
  return m ? Number(m[1]) : null;
}

function parseCorrectionSatisfied(value) {
  const m = /^correction-satisfied at ([0-9a-f]{7,64}) \(reviewed ([0-9a-f]{7,64})\)$/i.exec(String(value ?? "").trim());
  return m ? { correctedHead: m[1].toLowerCase(), reviewedHead: m[2].toLowerCase() } : null;
}

export function commitMessageReferencesIssue(message, issue) {
  if (!Number.isInteger(issue) || issue <= 0) return false;
  const re = new RegExp(`(^|[^\\w/])#${issue}(?!\\w)`);
  return re.test(String(message ?? ""));
}

async function proveAcceptedCorrectionHead({ repo, controlIssue, executionIssue, pr, reviewed, head, cwd }, deps) {
  if (!Number.isInteger(controlIssue) || controlIssue <= 0 || !Number.isInteger(executionIssue) || executionIssue <= 0) {
    return closed("UNREVIEWED_POST_REVIEW_CONTENT", "corrected head differs from reviewed head without exact control/execution identity");
  }
  let control;
  try { control = await deps.readIssue({ repo, issue: controlIssue }); }
  catch (err) { return closed("CORRECTION_PROVENANCE_UNVERIFIED", `could not read control Issue #${controlIssue}: ${String(err.message ?? err).split("\n")[0]}`); }
  if (control?.state !== "OPEN") return closed("CORRECTION_PROVENANCE_UNVERIFIED", `control Issue #${controlIssue} is not OPEN`);
  const body = control?.body ?? "";
  const stage1 = parseCorrectionSatisfied(parseControlBullet(body, "Stage 1"));
  if (parseIssueRef(parseControlBullet(body, "Execution")) !== executionIssue || parseIssueRef(parseControlBullet(body, "PR")) !== pr || !stage1 || stage1.correctedHead !== head.toLowerCase() || stage1.reviewedHead !== reviewed.toLowerCase()) {
    return closed("CORRECTION_PROVENANCE_UNVERIFIED", `control Issue #${controlIssue} does not bind Execution #${executionIssue}, PR #${pr}, and the exact correction-satisfied heads`);
  }
  let commits;
  try { commits = deps.git(["rev-list", "--reverse", `${reviewed}..${head}`], { cwd }).trim().split("\n").filter(Boolean); }
  catch (err) { return closed("CORRECTION_PROVENANCE_UNVERIFIED", `could not enumerate correction commits: ${String(err.message ?? err).split("\n")[0]}`); }
  if (commits.length === 0) return closed("CORRECTION_PROVENANCE_UNVERIFIED", "no correction commits found between reviewed and corrected heads");
  for (const commit of commits) {
    let message;
    try { message = deps.git(["show", "-s", "--format=%B", commit], { cwd }); }
    catch (err) { return closed("CORRECTION_PROVENANCE_UNVERIFIED", `could not read correction commit ${commit}: ${String(err.message ?? err).split("\n")[0]}`); }
    if (!commitMessageReferencesIssue(message, executionIssue)) return closed("CORRECTION_PROVENANCE_UNVERIFIED", `correction commit ${commit} is not attributable to execution Issue #${executionIssue}`);
  }
  return { ok: true, commits };
}
export function defaultDeps() {
  return {
    git: (args, opts) => git(args, opts),
    readPr: ({ repo, pr }) => readGithubPr({ repo, number: pr, fields: ["headRefOid", "baseRefName", "state"] }),
    readIssue: ({ repo, issue }) => readGithubIssue({ repo, number: issue, fields: ["body", "state"] }),
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
    replaceFileAtomically: (path, text, mode) => replaceRegularFileAtomically(path, text, mode),
    isRegularFile: (path) => lstatSync(path).isFile(),
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

const REGULAR_GIT_FILE_MODES = new Set(["100644", "100755"]);

function isRegularGitFileMode(mode) {
  return REGULAR_GIT_FILE_MODES.has(mode);
}

function fsModeForGitMode(mode) {
  if (mode === "100755") return 0o755;
  if (mode === "100644") return 0o644;
  throw new Error(`unsupported protected-file Git mode ${mode}`);
}

// Replace the final directory entry rather than opening the protected path for writing. A late
// swap to a symlink/hard link therefore replaces that entry instead of following it elsewhere.
export function replaceRegularFileAtomically(path, text, mode) {
  const tempDir = mkdtempSync(join(dirname(path), ".ldl-protected-conflict-replace-"));
  const tempPath = join(tempDir, "replacement");
  let replaced = false;
  try {
    const fsMode = fsModeForGitMode(mode);
    writeFileSync(tempPath, text, { encoding: "utf8", flag: "wx", mode: fsMode });
    chmodSync(tempPath, fsMode);
    renameSync(tempPath, path);
    replaced = true;
    if (!lstatSync(path).isFile() || readFileSync(path, "utf8") !== text) {
      const err = new Error("atomic protected-file replacement postcondition failed");
      err.mutated = true;
      throw err;
    }
  } catch (err) {
    if (replaced) err.mutated = true;
    throw err;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function parseTreeEntry(lsTree, expectedPath) {
  const line = lsTree.trim();
  const m = /^(\d+) ([^ ]+) ([0-9a-f]+)\t(.+)$/.exec(line);
  if (!m || m[4] !== expectedPath) return null;
  return { mode: m[1], type: m[2], oid: m[3] };
}

function parseStagedEntry(lsFilesStage, expectedPath) {
  const line = lsFilesStage.trim();
  const m = /^(\d+) ([0-9a-f]+) 0\t(.+)$/.exec(line);
  if (!m || m[3] !== expectedPath) return null;
  return { mode: m[1], oid: m[2] };
}

export async function resolveProtectedConflict(
  { repo, pr, token, reviewedHead, controlIssue = null, executionIssue = null, paths = [], includeExecutorSubstrate = false, apply = false, cwd = process.cwd() },
  deps = defaultDeps(),
) {
  const prGiven = pr !== undefined && pr !== null && !Number.isNaN(pr);
  if (
    (prGiven && (!Number.isInteger(pr) || pr <= 0)) ||
    (token !== undefined && token !== null && (typeof token !== "string" || !token)) ||
    (controlIssue !== null && controlIssue !== undefined && (!Number.isInteger(controlIssue) || controlIssue <= 0)) ||
    (executionIssue !== null && executionIssue !== undefined && (!Number.isInteger(executionIssue) || executionIssue <= 0)) ||
    typeof reviewedHead !== "string" ||
    !SHA_RE.test(reviewedHead) ||
    typeof repo !== "string" ||
    !repo
  ) {
    return { exitCode: 1, verdict: "OPERATIONAL_ERROR", message: "--reviewed-head <sha> and a repository are required; --pr/--binding-token/--control-issue/--execution-issue, when given, must be well-formed" };
  }
  const explicitPathClasses = new Map();
  for (const p of paths) {
    if (PROTECTED_PATHS.includes(p)) {
      explicitPathClasses.set(p, classifyMechanicalIntegrationPath(p));
      continue;
    }
    const classified = classifyMechanicalIntegrationPath(p);
    if (!classified.eligible) {
      return closed("PATH_NOT_ELIGIBLE", `${p} is not a registered executor-substrate component eligible for deterministic merge integration`);
    }
    if (!controlIssue || !executionIssue) {
      return closed("MECHANICAL_INTEGRATION_AUTHORITY_MISSING", `${p} is executor substrate (${classified.component}); exact control/execution identity is required`);
    }
    explicitPathClasses.set(p, classified);
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

  let correctionProvenance = null;
  if (head.toLowerCase() !== reviewed.toLowerCase()) {
    const proof = await proveAcceptedCorrectionHead({ repo, controlIssue, executionIssue, pr, reviewed, head, cwd }, deps);
    if (!proof.ok) return proof;
    correctionProvenance = proof;
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

  const unmerged = parseUnmerged(deps.git(["ls-files", "-u", "--full-name"], { cwd: top }));
  if (!unmerged) return closed("MALFORMED_INDEX", "could not parse the index's unmerged entries");
  if (includeExecutorSubstrate && (!controlIssue || !executionIssue)) {
    return closed("MECHANICAL_INTEGRATION_AUTHORITY_MISSING", "--all-executor-substrate requires exact --control-issue and --execution-issue identities");
  }
  const targets = paths.length
    ? paths
    : [...unmerged.keys()].filter((p) => {
        if (PROTECTED_PATHS.includes(p)) return true;
        return includeExecutorSubstrate && classifyMechanicalIntegrationPath(p).eligible;
      });
  if (targets.length === 0) return closed("NO_PROTECTED_CONFLICT", "no unmerged eligible protected/executor-substrate path in this checkout");
  const includesExecutorSubstrate = targets.some((p) => !PROTECTED_PATHS.includes(p));
  if (includesExecutorSubstrate && !correctionProvenance) {
    return closed("MECHANICAL_INTEGRATION_AUTHORITY_MISSING", "executor-substrate integration requires exact correction-satisfied control binding and correction provenance");
  }
  const pathClasses = new Map(targets.map((p) => [p, explicitPathClasses.get(p) ?? classifyMechanicalIntegrationPath(p)]));

  const results = [];
  for (const path of targets) {
    const st = unmerged.get(path);
    if (!st || !st[1] || !st[2] || !st[3]) return closed("NOT_A_CONTENT_CONFLICT", `${path} is not a three-stage content conflict`, { path });

    const worktreePath = join(top, path);
    try {
      if (!deps.isRegularFile(worktreePath)) {
        return closed("NON_REGULAR_WORKTREE_PATH", `${path} is not a regular worktree file; refusing any write-through path`, { path });
      }
    } catch {
      return closed("NON_REGULAR_WORKTREE_PATH", `${path} is missing or cannot be proven to be a regular worktree file`, { path });
    }

    const treeEntryAt = (rev) => parseTreeEntry(deps.git(["ls-tree", "--full-tree", rev, "--", path], { cwd: top }), path);
    let headEntry, targetEntry, baseEntry, reviewedEntry;
    try {
      headEntry = treeEntryAt(head);
      targetEntry = treeEntryAt(mergeHead);
      baseEntry = treeEntryAt(mergeBase);
      reviewedEntry = treeEntryAt(reviewed);
    } catch {
      return closed("PROVENANCE_MISMATCH", `${path} tree provenance could not be read at HEAD, MERGE_HEAD, the merge base or the reviewed head`, { path });
    }
    if (!headEntry || !targetEntry || !baseEntry || !reviewedEntry) {
      return closed("PROVENANCE_MISMATCH", `${path} is missing at HEAD, MERGE_HEAD, the merge base or the reviewed head`, { path });
    }

    const indexEntries = [st[1], st[2], st[3]];
    const treeEntries = [baseEntry, headEntry, targetEntry, reviewedEntry];
    if (
      indexEntries.some((entry) => !isRegularGitFileMode(entry.mode)) ||
      treeEntries.some((entry) => entry.type !== "blob" || !isRegularGitFileMode(entry.mode))
    ) {
      return closed("NON_REGULAR_CONTENT_CONFLICT", `${path} must be a regular-file content conflict at every index/tree provenance point`, { path });
    }

    if (
      st[2].oid !== headEntry.oid ||
      st[3].oid !== targetEntry.oid ||
      st[1].oid !== baseEntry.oid ||
      st[2].mode !== headEntry.mode ||
      st[3].mode !== targetEntry.mode ||
      st[1].mode !== baseEntry.mode
    ) {
      return closed("PROVENANCE_MISMATCH", `${path}'s index stages do not exactly match HEAD / MERGE_HEAD / merge-base modes and blobs`, { path });
    }
    const provenanceModes = [baseEntry.mode, headEntry.mode, targetEntry.mode, reviewedEntry.mode];
    if (provenanceModes.some((mode) => mode !== provenanceModes[0])) {
      return closed(
        "MODE_MISMATCH",
        `${path} changes regular-file mode across merge-base / HEAD / MERGE_HEAD / reviewed-head provenance; protected mode choices are not resolved mechanically`,
        { path },
      );
    }
    if (!correctionProvenance && (headEntry.oid !== reviewedEntry.oid || headEntry.mode !== reviewedEntry.mode)) {
      return closed("UNREVIEWED_POST_REVIEW_CONTENT", `${path} at the corrected head differs from the Stage 1 reviewed head in content or mode`, { path });
    }

    const pathClass = pathClasses.get(path);
    if (!PROTECTED_PATHS.includes(path) && (!pathClass || !pathClass.eligible)) {
      return closed("PATH_NOT_ELIGIBLE", `${path} is not a registered executor-substrate component`, { path });
    }
    const content = (oid) => deps.git(["cat-file", "blob", oid], { cwd });
    const acceptedText = correctionProvenance ? content(headEntry.oid) : content(reviewedEntry.oid);
    const diff3 = deps.mergeFile({ ours: content(headEntry.oid), base: content(baseEntry.oid), theirs: content(targetEntry.oid) });
    const proof = proveFile({ diff3Output: diff3, reviewedText: acceptedText, targetText: content(targetEntry.oid) });
    if (!proof.ok) return closed(proof.code, proof.reason, { path, hunk: proof.hunk });
    results.push({ path, component: pathClass?.component ?? null, resolved: proof.resolved, hunks: proof.hunks, mode: targetEntry.mode });
  }

  // Every proof held. Re-check every write target as a regular file immediately before the
  // mutation phase so a protected path cannot be redirected through a symlink after proof.
  if (apply) {
    for (const r of results) {
      try {
        if (!deps.isRegularFile(join(top, r.path))) {
          return closed("NON_REGULAR_WORKTREE_PATH", `${r.path} stopped being a regular worktree file before mutation`, { path: r.path });
        }
      } catch {
        return closed("NON_REGULAR_WORKTREE_PATH", `${r.path} cannot be proven to remain a regular worktree file before mutation`, { path: r.path });
      }
    }
    for (const r of results) {
      const worktreePath = join(top, r.path);
      try {
        deps.replaceFileAtomically(worktreePath, r.resolved, r.mode);
      } catch (err) {
        return {
          exitCode: 1,
          verdict: "OPERATIONAL_ERROR",
          code: "ATOMIC_REPLACE_FAILED",
          message: `could not atomically replace ${r.path}: ${String(err.message ?? err).split("\n")[0]}`,
          mutated: Boolean(err?.mutated),
          path: r.path,
        };
      }
      try {
        const expectedOid = deps.git(["hash-object", "--stdin"], { cwd: top, input: r.resolved }).trim();
        deps.git(["add", "--", r.path], { cwd: top });
        const staged = parseStagedEntry(deps.git(["ls-files", "--stage", "--full-name", "--", r.path], { cwd: top }), r.path);
        if (!staged || staged.mode !== r.mode || staged.oid !== expectedOid) {
          return {
            exitCode: 1,
            verdict: "OPERATIONAL_ERROR",
            code: "POSTCONDITION_FAILED",
            message: `${r.path} did not stage as the proven regular-file mode/blob after atomic replacement`,
            mutated: true,
            path: r.path,
          };
        }
      } catch (err) {
        return {
          exitCode: 1,
          verdict: "OPERATIONAL_ERROR",
          code: "POSTCONDITION_FAILED",
          message: `could not verify staged postcondition for ${r.path}: ${String(err.message ?? err).split("\n")[0]}`,
          mutated: true,
          path: r.path,
        };
      }
    }
  }
  return {
    exitCode: 0,
    verdict: apply ? "RESOLVED" : "WOULD_RESOLVE",
    mutated: apply,
    paths: results.map((r) => ({ path: r.path, component: r.component, hunks: r.hunks })),
    acceptedContent: correctionProvenance
      ? { source: "correction-satisfied-head", controlIssue, executionIssue, commits: correctionProvenance.commits }
      : { source: "stage1-reviewed-head" },
  };
}

function parseArgs(argv) {
  const args = { paths: [], apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--all-executor-substrate") args.includeExecutorSubstrate = true;
    else if (a === "--path") args.paths.push(argv[++i]);
    else if (a === "--pr") args.pr = Number(argv[++i]);
    else if (a === "--binding-token") args.token = argv[++i];
    else if (a === "--reviewed-head") args.reviewedHead = argv[++i];
    else if (a === "--control-issue") args.controlIssue = Number(argv[++i]);
    else if (a === "--execution-issue") args.executionIssue = Number(argv[++i]);
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
