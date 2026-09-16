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
// This intentionally reuses tools/check-control-plane-paths.mjs's own exported
// CONTROL_PLANE_PATH_PATTERNS array rather than hand-copying a second list: that script
// already keeps that array in lockstep with docs/bounded-review-cycle.md's prose
// enumeration (its own doc-consistency check fails CI if the two drift apart), so importing
// it here means this matcher and that documentation can never silently diverge — there is
// exactly one place that list is maintained.
//
// Pattern vocabulary (matches every shape CONTROL_PLANE_PATH_PATTERNS actually uses; this
// is not a general-purpose glob engine):
//   - a literal path with no wildcard and no "/" segment beyond the given prefix, e.g.
//     "AGENTS.md" or "tools/check-priority-labels.mjs" — exact match.
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
//     at repository root). CONTROL_PLANE_PATH_PATTERNS currently spells this as three
//     literal root filenames ("AGENTS.md", "CLAUDE.md", "README.md") rather than a genuine
//     "*.md" wildcard token, so this matcher — reusing that array verbatim, deliberately
//     not inventing a fourth representation of "which root files are control-plane" — only
//     recognizes those three by name; it does not treat every root-level *.md file as
//     control-plane. A newly added root-level *.md file becoming control-plane is the same
//     kind of judgment call check-control-plane-paths.mjs's own module comment already
//     defers to a human/agent, not something this matcher can decide on its own.
//
// Tests: node --test tools/review-watch/control-plane-paths.test.mjs

import { CONTROL_PLANE_PATH_PATTERNS } from "../check-control-plane-paths.mjs";

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
// CONTROL_PLANE_PATH_PATTERNS. See the module comment above for the four shapes handled.
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
