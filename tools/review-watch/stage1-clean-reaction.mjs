// Structured Codex "clean" evidence for Stage 1 (issue #776, under #639). Codex's provider
// contract, quoted in every response's own help block, is: "If Codex has suggestions, it will
// comment; otherwise it will react with 👍." A clean round therefore carries a Codex-authored
// `+1` reaction on the PR itself. Live evidence (PRs #754/#771/#773/#775) shows the reaction
// lands one second before the accompanying issue-comment acknowledgement, whose prose rotates
// ("Hooray!", "Another round soon, please!", ...); classifying clean by enumerating that prose
// (stage1-findings.mjs) is not a stable abstraction (superseded #772/#773, #774/#775).
//
// This module is the smallest deterministic reader for that one signal -- not a generalized
// reactions framework and not provider routing. A reaction qualifies only when it is:
//   - authored by the expected Codex bot login (the same `bot` Stage 1 already matches);
//   - content exactly "+1" (any other reaction type is not a clean signal);
//   - created at or after the current accepted Stage 1 trigger (`sinceMs`), so a stale
//     reaction from an earlier round can never satisfy a later trigger;
//   - bound to the head being gated by the existing exact-head rules: reactions carry no
//     commit identity, so they are treated exactly like an unbound issue comment
//     (poll.mjs's matchBelongsToHead: trustworthy only when every trigger round on the thread
//     targets that one head) and must additionally be attributed to that head's own round
//     (trigger.mjs's attributeRound) -- no second head-association system is invented.
//
// A qualifying reaction never manufactures formal-review provenance and never overrides
// genuine findings; stage1-gate.mjs only consults it after finding no formal bound match, and
// still fails closed on an explicit formal findings heading (see hasExplicitFindingsSignal).

import { matchBelongsToHead } from "./poll.mjs";
import { attributeRound } from "./trigger.mjs";

export const CLEAN_REACTION_CONTENT = "+1";

// Pure. Returns the earliest qualifying clean reaction from `reactions` (GitHub's REST
// `issues/{n}/reactions` items), or null.
export function findQualifyingCleanReaction(reactions, { bot, sinceMs, head, rounds }) {
  if (!Array.isArray(reactions)) return null;
  const qualifying = reactions
    .filter((r) => r?.user?.login === bot && r.content === CLEAN_REACTION_CONTENT)
    .filter((r) => {
      const ms = new Date(r.created_at).getTime();
      if (!Number.isFinite(ms) || ms < sinceMs) return false;
      if (!matchBelongsToHead({ commit_id: null }, { head, rounds })) return false;
      return attributeRound(rounds, r.created_at)?.head === head;
    })
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  if (qualifying.length === 0) return null;
  const r = qualifying[0];
  return { id: r.id, login: r.user.login, content: r.content, created_at: r.created_at };
}

// Pure. The one explicit, provider-fixed findings signal cheap enough to detect in a bounded
// excerpt: Codex's own findings heading ("### 💡 Codex Review" + "Here are some automated
// review suggestions"). Its coexistence with a clean reaction is contradictory evidence and
// must fail closed rather than be guessed at.
const FINDINGS_HEADING_PATTERN = /^###\s*💡\s*Codex Review\b/u;
export function hasExplicitFindingsSignal(bodyExcerpt) {
  return FINDINGS_HEADING_PATTERN.test((bodyExcerpt ?? "").trim());
}
