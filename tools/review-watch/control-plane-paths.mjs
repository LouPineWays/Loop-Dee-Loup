// Deterministic matcher for docs/bounded-review-cycle.md's Entry check "control-plane
// path" definition. Given a changed-file path (as `gh` reports it — repo-relative, forward
// slashes, no leading "./"), decides whether it falls under a mandatory-review path
// category, so stage1-gate.mjs can refuse a self-declared `Stage 1 exemption:` marker that
// conflicts with that policy (issue #616).
//
// Issue #616's recurrence (#441/#442, PR #615): a worker changed a `docs/diagnostic-
// traces/*.md` file, self-declared "Stage 1 exemption: evidence-only diagnostic trace" in
// the PR body, and merged without independent review — even though docs/bounded-review-
// cycle.md's Entry check already says every `docs/*.md` path is never trivial and always
// gets the full review cycle. Nothing mechanically enforced that; this module is that
// enforcement.
//
// CONTROL_PLANE_PATH_PATTERNS is defined here, in tools/review-watch/ — a distributed
// subtree per docs/consumer-contract.md's "LDL-managed" list — rather than in
// tools/check-control-plane-paths.mjs, which that same contract explicitly marks as this
// repository's own development state, never installed into a consumer repository. PR #622's
// Stage 1 review (issue #616) found the reverse direction (this file importing that array
// from check-control-plane-paths.mjs) broken by construction: every consumer installation
// copies tools/review-watch/** but not tools/check-control-plane-paths.mjs, so an installed
// stage1-gate.mjs — and every other tools/review-watch/** caller that imports this module —
// would fail with ERR_MODULE_NOT_FOUND before evaluating anything. check-control-plane-
// paths.mjs now imports CONTROL_PLANE_PATH_PATTERNS from here instead (see that file's own
// header comment); it is never distributed, so depending on a distributed subtree from it is
// safe, while the reverse never was. This is the single canonical list of mandatory-review
// control-plane path patterns; check-control-plane-paths.mjs's own doc-consistency check
// cross-checks it against docs/bounded-review-cycle.md's governing prose enumeration, so this
// array and that documentation can never silently diverge — there is exactly one place this
// list is maintained, it just now lives in the distributed subtree instead of the source-only
// script.
export const CONTROL_PLANE_PATH_PATTERNS = [
  // Any root-level *.md file, not a closed list of the three current examples — see the
  // "root-level *.md" section of the pattern-vocabulary comment below for why this must be a
  // genuine wildcard (issue #616 Stage 1 review finding: a new root file such as
  // CONTRIBUTING.md was previously exemption-eligible even though the Entry check's own
  // prose already declares every root-level *.md file control-plane).
  "*.md",
  "docs/*.md",
  ".github/ISSUE_TEMPLATE/*",
  ".github/workflows/*.yml",
  ".claude/**",
  "tools/check-priority-labels.mjs",
  "tools/check-startup-budget.mjs",
  "tools/check-review-invocation-precedence.test.mjs",
  "tools/local-worker/**",
  "tools/review-watch/**",
  "tools/telemetry/**",
  "tools/orchestration/**",
  "tools/ldl-init/**",
  "tools/ldl-update/**",
  "tools/ldl-ack/**",
  "tools/ldl-activate/**",
  "tools/mcp-server/**",
  "tools/ldl-sync/**",
];

// The Entry check's control-plane path policy is scoped to "Within Loop-Dee-Loup's own
// repository" — it governs the Loop's own rules, CI gates, session skills, backlog state,
// and audit machinery, not a consumer repository's independent governing authority. Issue
// #616 Stage 1 review finding: this distributed matcher must not impose Loop's own
// mandatory-review list on an otherwise legitimate exemption in an installed consumer
// repository. stage1-gate.mjs uses isLoopDeeLoupRepo to scope CONTROL_PLANE_PATH_PATTERNS
// enforcement to Loop-Dee-Loup's own repository only, leaving a consumer repository's own
// exemption policy exactly as authoritative as it was before issue #616 — never a second,
// generalized cross-repository policy engine.
export const LOOP_DEE_LOUP_REPO = "LouPineWays/Loop-Dee-Loup";

// Case-insensitive: GitHub repository owner/name slugs are case-insensitive, and this
// comparison must not silently fail to scope the policy purely because of casing.
export function isLoopDeeLoupRepo(repo) {
  return typeof repo === "string" && repo.toLowerCase() === LOOP_DEE_LOUP_REPO.toLowerCase();
}

// Pattern vocabulary (matches every shape CONTROL_PLANE_PATH_PATTERNS actually uses; this
// is not a general-purpose glob engine):
//   - a literal path with no wildcard and no "/" segment beyond the given prefix, e.g.
//     "tools/check-priority-labels.mjs" — exact match.
//   - "dir/**" — matches `dir` itself or anything under it, at any depth.
//   - "dir/<wildcard>" where <wildcard> contains "*" (e.g. "docs/*.md",
//     ".github/workflows/*.yml", ".github/ISSUE_TEMPLATE/*") — matches any path under
//     `dir/` (at any depth, not just directly inside it) whose basename matches the
//     wildcard segment. Diagnostic traces live under docs/diagnostic-traces/*.md, one level
//     deeper than docs/*.md's literal directory reading — the whole reason this recurred —
//     so this matcher deliberately treats the wildcard as reaching any depth under `dir/`
//     rather than only files placed directly inside it, matching the governing prose's
//     plain-English "any docs/*.md" rather than a stricter single-segment glob library's
//     default.
//   - a pattern with no "/" at all — matches only a file with no directory component (i.e.
//     at repository root). CONTROL_PLANE_PATH_PATTERNS spells this as a genuine "*.md"
//     wildcard token (not individual literal filenames): the Entry check's own prose already
//     declares every root-level *.md file control-plane, "(currently AGENTS.md, CLAUDE.md,
//     README.md)" only as illustrative examples of what already exists — a future root-level
//     *.md file (e.g. CONTRIBUTING.md) is control-plane from the moment it exists, with no
//     matching edit needed here, exactly like check-control-plane-paths.mjs's own CI-trigger
//     "*.md" pattern already treats it (see that script's WORKFLOW_PATH check).
//
// Tests: node --test tools/review-watch/control-plane-paths.test.mjs

function escapeRegExpLiteral(segment) {
  return segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

// Converts a single wildcard segment (e.g. "*.md", "*") into a RegExp matched against a
// path's basename only — never against a full path containing "/" — since every caller
// below applies this exclusively to basenames.
function wildcardSegmentToRegExp(segment) {
  const pattern = segment.split("*").map(escapeRegExpLiteral).join(".*");
  return new RegExp(`^${pattern}$`);
}

function basename(path) {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

// Builds a `(path) => boolean` matcher for one pattern string from
// CONTROL_PLANE_PATH_PATTERNS. See the module comment above for the three shapes handled.
function buildMatcher(pattern) {
  if (!pattern.includes("/")) {
    // Root-only pattern, e.g. "*.md": no directory component allowed at all.
    const re = wildcardSegmentToRegExp(pattern);
    return (path) => !path.includes("/") && re.test(path);
  }

  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return (path) => path === prefix || path.startsWith(`${prefix}/`);
  }

  const lastSlash = pattern.lastIndexOf("/");
  const dir = pattern.slice(0, lastSlash);
  const tail = pattern.slice(lastSlash + 1);

  if (!tail.includes("*")) {
    // A literal file path with a directory component, e.g.
    // "tools/check-priority-labels.mjs" — exact match only, not basename-recursive: a
    // different file that happens to share this basename deeper under the same directory
    // is not this specific governing script.
    return (path) => path === pattern;
  }

  // A directory-scoped extension/name wildcard, e.g. "docs/*.md",
  // ".github/workflows/*.yml", ".github/ISSUE_TEMPLATE/*" — matches any path under `dir/`
  // whose basename satisfies the wildcard, at any depth (see module comment).
  const tailRe = wildcardSegmentToRegExp(tail);
  return (path) => path.startsWith(`${dir}/`) && tailRe.test(basename(path));
}

const MATCHERS = CONTROL_PLANE_PATH_PATTERNS.map((pattern) => ({ pattern, test: buildMatcher(pattern) }));

// Returns every CONTROL_PLANE_PATH_PATTERNS entry that `path` matches (usually 0 or 1, but
// a path could in principle satisfy more than one category — e.g. a file directly under
// ".claude/" also happening to match a more specific pattern). Empty array means `path` is
// not a mandatory-review control-plane path under current Loop-Dee-Loup authority.
export function matchingControlPlanePatterns(path) {
  if (typeof path !== "string" || path.length === 0) return [];
  return MATCHERS.filter((m) => m.test(path)).map((m) => m.pattern);
}

export function isControlPlanePath(path) {
  return matchingControlPlanePatterns(path).length > 0;
}
