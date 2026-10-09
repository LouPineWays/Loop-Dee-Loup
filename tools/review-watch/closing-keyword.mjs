// Canonical GitHub auto-close keyword matcher, extracted unchanged from lifecycle-gate.mjs
// (issue #964) so merge-ready (post-publication) and the correction pre-push validator share one
// grammar. Pure and dependency-free.

// GitHub's own closing-keyword set (close/closes/closed, fix/fixes/fixed, resolve/resolves/
// resolved), case-insensitive, optionally followed by a colon, before "#N" or GitHub's
// repository-qualified "owner/repo#N" form (Stage 1 review finding on this PR: a
// commit-only closing reference like `Fixes owner/repo#151` is not surfaced by
// closingIssuesReferences at all, since that field only covers PR-body/sidebar sources, so
// this scan needs to recognize the qualified form directly or miss it entirely). The
// trailing \b on the issue number keeps "#151" from matching inside "#1510" — both are word
// characters, so \b only holds where the digit run actually ends. Global so
// findClosingKeywordMatch can walk every match in the text, not just the first, to find one
// scoped to the right repository.
function closingKeywordPatternFor(issueNumber) {
  return new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b\\s*:?\\s*(?:([\\w.-]+/[\\w.-]+)\\s*)?#${issueNumber}\\b`, "gi");
}

// Pure. Returns the matched closing-keyword phrase (e.g. "Fixes #151") if `text` closes
// `issueNumber` via a GitHub auto-close keyword, or null. Deliberately does not match
// non-closing references like "Addresses #151" or "Implements #151" — those are the
// documented safe form (docs/bounded-review-cycle.md Stage 1 step 8) and must never be
// flagged as a violation. When `repo` is given, a repository-qualified match
// (`owner/repo#N`) only counts when its repository equals `repo` — a commit that closes a
// same-numbered issue in a *different* repository must not block this one (Stage 1 review
// finding on this PR). Without `repo`, any qualified match counts, failing closed rather
// than silently ignoring a qualifier it can't evaluate.
export function findClosingKeywordMatch(text, issueNumber, repo) {
  if (!text) return null;
  const pattern = closingKeywordPatternFor(issueNumber);
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const qualifiedRepo = match[1];
    if (!qualifiedRepo || !repo || qualifiedRepo.toLowerCase() === repo.toLowerCase()) {
      return match[0];
    }
  }
  return null;
}
