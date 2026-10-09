// Exact-merge change-scope baseline verification for Stage 2 audit checklists -- issue #1005
// (control #1006; live reproduction PR #958 / work #954 / control #956 / Audit #1004).
//
// The defect: Audit #1004's mandatory checklist item 4 told the reviewer to run
// `git diff <PR original base> <exact merge>`. The original base had gone stale (main advanced
// before the merge), so the range included 26 unrelated files and the check could never pass; the
// independent reviewer correctly reported NOT CLEAN on the checklist itself. The truthful range for
// an exact merge commit is `<first parent of the merge> <merge>`, derived from the merged commit
// topology after the merge exists -- never from a saved PR-base SHA.
//
// This module is the small deterministic check. It does not interpret checklist prose: it extracts
// only literal `git diff ... <base> <merge-commit>` command shapes whose head is the audited exact
// merge commit, and compares the base against the commit's actual first parent read from GitHub.
// Anything it cannot prove (unreadable commit, no parent, truncated file list, a non-SHA/symbolic
// base) fails closed to a specific state; it never guesses that a saved base is safe.
//
// Tests: node --test tools/orchestration/scope-baseline.test.mjs

import { execFileSync } from "node:child_process";

const FULL_SHA = /^[0-9a-f]{40}$/i;
// GitHub's commit endpoint paginates `files` (default 30/page) and caps the total at 3000; at the cap the
// list is not provably complete.
const COMMIT_FILES_CAP = 3000;
const COMMIT_FILES_PER_PAGE = 100;

export const ScopeState = Object.freeze({
  OK: "OK",
  NO_SCOPE_COMMAND: "NO_SCOPE_COMMAND",
  STALE_SCOPE_BASELINE: "STALE_SCOPE_BASELINE",
  UNVERIFIABLE_SCOPE_BASELINE: "UNVERIFIABLE_SCOPE_BASELINE",
  MERGE_PARENT_UNPROVEN: "MERGE_PARENT_UNPROVEN",
});

// Pure. Extracts `git diff` invocations from checklist text whose head revision is `mergeCommit`.
// Accepts `git diff [flags] <base> <head>`, `<base>..<head>` and `<base>...<head>` (flags are any
// whitespace-separated tokens starting with `-`). Returns [{ command, base, head, form }].
export function extractMergeScopeCommands(text, mergeCommit) {
  const merge = String(mergeCommit ?? "").toLowerCase();
  const out = [];
  if (!FULL_SHA.test(merge)) return out;
  for (const m of String(text ?? "").matchAll(/git\s+diff\b([^\n`]*)/gi)) {
    // Pathspecs follow `--`; drop everything from the first bare `--` on before reading revision operands.
    const raw = m[1].trim().split(/\s+/);
    const dd = raw.indexOf("--");
    const tokens = (dd === -1 ? raw : raw.slice(0, dd))
      .map((t) => t.replace(/^[("'`]+|[)"'`.,;:]+$/g, ""))
      .filter((t) => t !== "" && !t.startsWith("-"));
    let base = null;
    let head = null;
    let form = "two-arg";
    // A range operand (`a..b` / `a...b`) is parsed first: any later token is then a pathspec, never the head.
    const range = tokens.length >= 1 ? /^(.+?)(\.\.\.?)(.+)$/.exec(tokens[0]) : null;
    if (range) {
      base = range[1];
      head = range[3];
      form = range[2] === "..." ? "three-dot" : "two-dot";
    } else if (tokens.length >= 2) {
      base = tokens[0];
      head = tokens[1];
    } else {
      continue;
    }
    if (String(head).toLowerCase() !== merge) continue;
    out.push({ command: m[0].trim(), base, head: merge, form });
  }
  return out;
}

// Pure. Is `base` a truthful rendering of "the merge's first parent" for `mergeCommit`?
function isFirstParentReference(base, mergeCommit, firstParent) {
  const b = String(base).toLowerCase();
  if (FULL_SHA.test(b)) return b === String(firstParent).toLowerCase();
  const merge = String(mergeCommit).toLowerCase();
  return b === `${merge}^` || b === `${merge}^1` || b === `${merge}~1`;
}

// Pure. `commit` is { sha, parents: [sha...], files: [path...], filesComplete: bool } read from GitHub.
// Returns { state, ok, firstParent, files, offending: [{command, base, reason}], commands }.
export function checkScopeBaseline({ checklist, mergeCommit, commit }) {
  const commands = extractMergeScopeCommands(checklist, mergeCommit);
  if (commands.length === 0) {
    return { state: ScopeState.NO_SCOPE_COMMAND, ok: true, firstParent: null, files: null, offending: [], commands };
  }
  const parents = Array.isArray(commit?.parents) ? commit.parents.map((p) => String(p).toLowerCase()) : [];
  if (
    !commit ||
    String(commit.sha ?? "").toLowerCase() !== String(mergeCommit).toLowerCase() ||
    parents.length === 0 ||
    !parents.every((p) => FULL_SHA.test(p))
  ) {
    return {
      state: ScopeState.MERGE_PARENT_UNPROVEN,
      ok: false,
      firstParent: null,
      files: null,
      commands,
      offending: commands.map((c) => ({ ...c, reason: "the exact merge commit's parent topology could not be proven from GitHub" })),
    };
  }
  const firstParent = parents[0];
  const offending = [];
  let stale = false;
  for (const c of commands) {
    if (isFirstParentReference(c.base, mergeCommit, firstParent)) continue;
    if (FULL_SHA.test(c.base)) {
      stale = true;
      offending.push({ ...c, reason: `base ${c.base} is not the exact merge's first parent ${firstParent}; the range would include unrelated intervening default-branch work` });
    } else {
      offending.push({ ...c, reason: `base ${JSON.stringify(c.base)} is not a full commit id or <merge>^ / <merge>~1; it cannot be proven to isolate the audited merge` });
    }
  }
  const files = commit.filesComplete === false || (commit.files ?? []).length >= COMMIT_FILES_CAP ? null : [...(commit.files ?? [])].sort();
  if (offending.length === 0) return { state: ScopeState.OK, ok: true, firstParent, files, offending, commands };
  return {
    state: stale ? ScopeState.STALE_SCOPE_BASELINE : ScopeState.UNVERIFIABLE_SCOPE_BASELINE,
    ok: false,
    firstParent,
    files,
    offending,
    commands,
  };
}

// Pure. The truthful scope reference for an exact merge: first parent -> merge.
export function deriveMergeScope(commit) {
  const parents = Array.isArray(commit?.parents) ? commit.parents : [];
  if (!commit || !FULL_SHA.test(String(commit.sha ?? "")) || parents.length === 0 || !FULL_SHA.test(String(parents[0]))) return null;
  return { base: String(parents[0]).toLowerCase(), head: String(commit.sha).toLowerCase(), files: commit.files ?? null };
}

// Pure. Mechanical corrected-checklist text: within each literal `git diff ... <base> <merge>` scope
// command whose base is the proven-stale SHA, replaces that base operand (its first occurrence in the
// command) with the proven first parent. Every other occurrence of the SHA elsewhere in the checklist, and
// all other text, is untouched. `mergeCommit` identifies which commands are scope commands.
export function substituteScopeBase(checklist, staleBase, firstParent, mergeCommit) {
  const stale = String(staleBase).toLowerCase();
  const parent = String(firstParent).toLowerCase();
  return String(checklist ?? "").replace(/git\s+diff\b[^\n`]*/gi, (match) => {
    const hit = extractMergeScopeCommands(match, mergeCommit).some((c) => String(c.base).toLowerCase() === stale);
    if (!hit) return match;
    const at = match.toLowerCase().indexOf(stale);
    return match.slice(0, at) + parent + match.slice(at + stale.length);
  });
}

// Pure. One-line human reason for a failed check.
export function describeScopeFailure(result) {
  if (!result || result.ok) return null;
  const first = result.offending[0];
  return `${result.state}: ${first?.reason ?? "scope baseline could not be proven"} (command: ${first?.command ?? "unknown"})`;
}

export function defaultReadCommit({ repo, sha }) {
  const files = [];
  let payload = null;
  const maxPages = COMMIT_FILES_CAP / COMMIT_FILES_PER_PAGE;
  for (let page = 1; page <= maxPages; page++) {
    const raw = execFileSync("gh", ["api", `repos/${repo}/commits/${sha}?per_page=${COMMIT_FILES_PER_PAGE}&page=${page}`], {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
    const p = JSON.parse(raw);
    payload ??= p;
    const batch = (p.files ?? []).map((f) => f.filename);
    files.push(...batch);
    if (batch.length < COMMIT_FILES_PER_PAGE) break;
  }
  return {
    sha: payload.sha,
    parents: (payload.parents ?? []).map((p) => p.sha),
    files,
    filesComplete: files.length < COMMIT_FILES_CAP,
  };
}

// Async wrapper used by the pre-trigger boundaries. Reads the commit only when the checklist actually
// carries a scope command for the merge (so ordinary audits cost no extra read). Never throws: a read
// failure fails closed to MERGE_PARENT_UNPROVEN.
export async function verifyAuditScopeBaseline({ repo, checklist, mergeCommit }, { readCommitImpl = defaultReadCommit } = {}) {
  const commands = extractMergeScopeCommands(checklist, mergeCommit);
  if (commands.length === 0) {
    return { state: ScopeState.NO_SCOPE_COMMAND, ok: true, firstParent: null, files: null, offending: [], commands };
  }
  let commit = null;
  try {
    commit = await readCommitImpl({ repo, sha: mergeCommit });
  } catch {
    commit = null;
  }
  return checkScopeBaseline({ checklist, mergeCommit, commit });
}
