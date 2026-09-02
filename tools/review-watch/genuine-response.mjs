// Shared genuine-Codex-response classifier for docs/bounded-review-cycle.md's Stage 1 and
// Stage 2 review-watching machinery. Extracted out of stage1-gate.mjs (issue #165) so
// trigger.mjs can reuse the exact same classification when deciding whether an earlier PR
// head already received a genuine response, without a circular import between trigger.mjs
// and stage1-gate.mjs (stage1-gate.mjs already imports findExistingTrigger from
// trigger.mjs). stage1-gate.mjs re-exports isGenuineResponse from here so existing callers
// and tests importing it from stage1-gate.mjs are unaffected.
//
// A response from the bot login is not automatically a genuine review, per AGENTS.md's
// Code Review Rules: a reply of "BLOCKED", or one where a mutation attempt (edit/commit/
// push/PR update) was refused for lacking write permission, is a violated reviewer-role
// boundary — docs/bounded-review-cycle.md's own Stage 1 step 3 and Stage 2 step 10 both
// require retrying that the same way as no reply at all, never treating it as satisfied.
// findAllMatches (poll.mjs) only checks login and timestamp, so without this filter any
// such reply would silently open the gate. Matched against the truncated body_excerpt
// findAllMatches already returns, which is long enough to catch a leading status word or
// an early permission-denial sentence. The patterns below (BLOCKED_STATUS_PATTERN,
// ELLIPTICAL_REFUSAL_PATTERN, PRONOUN/ATTEMPT_CUE/PERMISSION_LACK_PATTERN) are
// isGenuineResponse's non-genuine signals.
//
// Anchored to the (normalized) start of the message: a genuine, unrelated review is
// free-form prose that can mention "BLOCKED" or a permission phrase anywhere in its body
// (issue #151's regression, and issue #161's Failure A/B below), but an actual status/
// refusal reply *opens* with its status rather than burying it inside findings content.
const BLOCKED_STATUS_PATTERN = /^\s*BLOCKED\b/i;

// issue #161, Failure B, and four rounds of this correction's own Stage 1 review, converged
// on two genuinely different non-genuine shapes rather than one regex each round kept
// missing:
//
// A refused *self-referential* attempt: the responder itself describes trying (or directly
// refusing) and failing -- "I attempted to push a fix but do not have write access", "I
// tried applying the fix, but I don't have write access", "I cannot apply this fix because I
// don't have write access", "Sorry, I tried to push, but I am not authorized to update this
// branch", "I tried to push a fix. I don't have write access". Four independent fixes here
// were each flagged as wrong:
//  - checking a permission-lack phrase and a mutation verb *anywhere* in the message let an
//    unrelated instruction verb elsewhere ("Update the test") pair with an unrelated
//    permission mention and reject a genuine review;
//  - requiring the verb to be a bare infinitive right after "to" ("... to push") missed the
//    identical refusal phrased with a gerund ("tried applying") or direct object;
//  - requiring a distinct attempt verb (attempted/tried/failed/unable) missed a *direct*
//    modal refusal of the mutation itself ("I cannot apply this fix ..."), and checking the
//    three signals anywhere in a possibly multi-sentence message let an unrelated attempt
//    mentioned in one sentence (e.g. reproducing a bug) pair with an unrelated permission
//    discussion in a *different* sentence of the same genuine review;
//  - restricting the check to one grammatical sentence was too strict in the other
//    direction: "not authorized"/"not permitted" wasn't recognized as a permission-lack
//    phrase at all outside the anchored elliptical check below, and a single refusal spread
//    naturally across two consecutive first-person sentences ("I tried to push a fix. I
//    don't have write access") no longer matched, because neither sentence alone carried
//    both signals.
// isSelfReferentialRefusal (below) groups each maximal run of *consecutive* sentences that
// all mention the responder itself (PRONOUN_PATTERN) into one unit -- ties the refusal to a
// continuous self-referential narrative (fixing the split-across-two-sentences false
// negative) while still not merging in a third-person sentence with no pronoun (fixing the
// unrelated-clause false positive, since that sentence never joins the run) -- then requires
// a refusal-of-action cue (ATTEMPT_CUE_PATTERN, or MODAL_REFUSAL_PATTERN for "cannot/can't
// <verb>" that isn't the permission-lack phrase's own "cannot have") and a genuinely
// *negated* permission/access/authorization phrase (PERMISSION_LACK_PATTERN, which now also
// recognizes bare "not permitted"/"not authorized" -- previously only handled anchored at
// the very start of the message) anywhere within that unit. A second-round finding also
// showed that treating bare "need(ed)" or bare "permission"/"authorized" (with no negation)
// as attempt/permission cues was itself a bug -- "The tests need to cover empty input" and
// "the caller needs permission to read this file" are ordinary review prose, not refusals,
// and neither contains negation. Restricting both cue lists to genuinely negated/attempt-
// specific wording (not bare nouns) is what keeps this conjunction safe without the pronoun
// grouping alone being sufficient. A known residual tradeoff: two consecutive sentences that
// both happen to use "I"/"we" but discuss genuinely unrelated topics (e.g. reproducing a bug
// in one sentence, an unrelated permission-validation finding about the reviewed code in the
// next) could in principle still combine; no concrete case has surfaced, and the "smallest
// reliable boundary" this issue calls for stops here rather than chasing hypothetical
// phrasings indefinitely.
const PRONOUN_PATTERN = /\b(?:I|I'm|I've|[Ww]e|[Ww]e're|[Ww]e've)\b/;
const ATTEMPT_CUE_PATTERN = /\b(?:attempt(?:ed|ing)?|tr(?:y|ies|ied|ying)|fail(?:ed|s|ing)?|unable)\b/i;
// Excludes "cannot/can't have" via the negative lookahead: that's PERMISSION_LACK_PATTERN's
// own territory (a state, not an action), so letting it double here would make a bare
// negated-permission phrase alone satisfy both signals and defeat the two-signal check.
const MODAL_REFUSAL_PATTERN = /\b(?:cannot|can't|could not|couldn't|will not|won't)\s+(?!have\b)\w+/i;
// "lack(s|ing) ... access/permission" (Stage 1 review, fifth round on PR #164) is its own
// negation verb -- "I lack write access" already says "I don't have it" without any "do
// not/don't/cannot have" wording for the first alternative to match. "denied" (sixth round)
// is likewise its own negation, in both the passive ("write access was denied") and active
// ("denied write access") voice a bot reply might use.
const LACK_VERB = "lack(?:s|ing)?";
const PERMISSION_LACK_PATTERN = new RegExp(
  String.raw`\b(?:do not|don't|does not|doesn't|did not|didn't|cannot|can't|could not|couldn't) have (?:write |repository |branch )?(?:access|permission)\b` +
    String.raw`|\b${LACK_VERB}\s+(?:write |repository |branch )?(?:access|permission)\b` +
    String.raw`|\b(?:write |repository |branch )?(?:access|permission)(?:\s+(?:was|is|were|are))?\s+denied\b` +
    String.raw`|\bdenied\s+(?:write |repository |branch )?(?:access|permission)\b` +
    String.raw`|\binsufficient (?:write |repository )?permission\b` +
    String.raw`|\bnot (?:permitted|authorized)\b`,
  "i",
);

function splitIntoSentences(text) {
  return text.split(/(?<=[.!?])\s+/).filter(Boolean);
}

function isSelfReferentialRefusal(text) {
  const sentences = splitIntoSentences(text);
  let i = 0;
  while (i < sentences.length) {
    if (!PRONOUN_PATTERN.test(sentences[i])) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < sentences.length && PRONOUN_PATTERN.test(sentences[j])) j++;
    const unit = sentences.slice(i, j).join(" ");
    if ((ATTEMPT_CUE_PATTERN.test(unit) || MODAL_REFUSAL_PATTERN.test(unit)) && PERMISSION_LACK_PATTERN.test(unit)) {
      return true;
    }
    i = j;
  }
  return false;
}

// The other non-genuine shape has no subject at all: a short, complete, bot-style status
// sentence -- "Insufficient permission to commit changes.", "Not authorized to push changes
// to this branch." -- rather than a human review sentence *about* someone else's permissions
// ("The caller needs permission to read this file") or a security finding describing the
// *reviewed code's* own permission handling ("Missing permission checks allow anonymous
// updates", "No access control is enforced", "No permission to push is required before this
// workflow updates protected branches"). Three rounds of findings on this same anchor:
//  - matching as soon as it saw the opening adjective+noun ("missing permission", "no
//    access") regardless of what followed let an ordinary finding *about* the target code's
//    authorization bugs -- which naturally opens exactly that way -- through;
//  - requiring the "to <verb>" continuation right after the noun narrowed that, but still
//    matched as a mere *prefix*: a genuine finding can coincidentally continue "no permission
//    to push ..." with a real main clause of its own ("... is required before this workflow
//    updates protected branches"), which a real terse status reply never has;
//  - capping what may follow the verb to a fixed small word count was itself an arbitrary
//    threshold a legitimate, merely-longer direct object ("push changes to this branch")
//    could always be one word past -- the cap needed bumping every time a longer real object
//    surfaced, rather than fixing the actual distinction.
// The structural difference a fixed word count was standing in for: a real reply's trailing
// words are a direct-object/prepositional-phrase completion of the *same* verb ("changes",
// "to this branch") with no further finite verb, while a genuine finding's continuation
// starts a *second clause* (an auxiliary/copula/modal, or a subordinating conjunction --
// "is required", "should be", "before this workflow ..."). Instead of bounding length,
// TRAILING_CLAUSE_TAIL (below) bounds *content*: consume any number of trailing words as
// long as none of them opens a new clause (CLAUSE_BOUNDARY_WORD), then require the
// match to reach the end of the (normalized) message -- unbounded object length is fine,
// but a second clause anywhere ends the match and the whole-message anchor then fails,
// exactly like BLOCKED_STATUS_PATTERN and the Codex-Cloud-setup-prompt check above.
//
// An eighth-round finding on this correction's own PR (#164) showed a *causal* explanation
// attached to the refusal by "because"/"since" -- "Not authorized to push changes to this
// branch because repository write permission is unavailable." -- was itself being rejected:
// "because" was (correctly) still a clause boundary for the *main* scan, but the reason
// clause it introduces is still part of the *same* refusal, not an unrelated topic shift,
// and that clause's own internal wording ("permission is unavailable") can legitimately
// contain another CLAUSE_BOUNDARY_WORD ("is"). REASON_CLAUSE_TAIL lets the main scan stop at
// "because"/"since" as before, then optionally consumes everything after it unfiltered --
// once the message has explicitly marked the rest as *why* the same refusal happened, no
// further boundary-word scan is needed.
//
// Two other eighth-round findings on this same PR asked for more than this: recognizing
// arbitrary lexical main verbs ("exists", "appears", "remains", ...) as clause boundaries,
// and binding a permission-denial phrase to the *same grammatical subject* as an attempt
// elsewhere in the sentence (real coreference resolution, e.g. distinguishing "I tried ...
// and found that the caller does not have permission" from a genuine self-referential
// refusal). Both were valid observations but were declined and left unfixed by founder
// decision: this issue's own Non-goals explicitly exclude "parsing arbitrary Markdown
// generally" and "semantic adjudication of review findings", and continuing to enumerate an
// unbounded set of English main verbs, or implementing subject/coreference binding, is
// exactly that -- a fundamentally different (and unbounded) class of work from the smallest-
// reliable-boundary pattern matching this issue calls for. Recognized as a known residual
// gap in both directions rather than silently absent; see PR #164's review thread for the
// concrete examples and disposition, and LDL issue #165 for the separate tooling gap this
// round of back-and-forth exposed (Stage 1 currently allows re-triggering across fix-commit
// heads with no bound on rounds, contrary to docs/bounded-review-cycle.md step 7).
const CLAUSE_BOUNDARY_WORD = "(?:is|are|was|were|has|have|will|would|can|could|should|must|before|after|when|because|since)";
const REASON_CLAUSE_TAIL = String.raw`(?:\s+(?:because|since)\s+\S+(?:\s+\S+)*)?`;
const TRAILING_CLAUSE_TAIL = String.raw`(?:\s+(?!${CLAUSE_BOUNDARY_WORD}\b)\S+)*${REASON_CLAUSE_TAIL}[.!]?\s*$`;
const ELLIPTICAL_REFUSAL_PATTERN = new RegExp(
  String.raw`^(?:insufficient|no|lack of|missing)\s+(?:write |repository |branch )?(?:permission|access)\s+to\s+\w+${TRAILING_CLAUSE_TAIL}` +
    String.raw`|^not (?:permitted|authorized)\s+to\s+\w+${TRAILING_CLAUSE_TAIL}`,
  "i",
);

// Stage 2 audit finding on issue #141 (LDL#135's own correction cycle): a Codex Cloud
// environment misconfiguration produces this exact reply — "To use Codex here, create an
// environment for this repo." — from the bot login within seconds of the trigger. It is a
// setup prompt, not a review; the BLOCKED/permission patterns above didn't catch it,
// letting it through as RESPONSE_RECEIVED and defeating the gate's whole fail-closed
// purpose whenever Codex Cloud lacks an environment for the repository.
//
// A first fix (three independent OR'd patterns, one per phrase/URL fragment) was itself
// flagged on this correction PR's own Stage 1 review: this repository's diffs necessarily
// discuss these exact strings (this very file, its tests, this comment), so any one
// fragment matching anywhere in a genuine, unrelated review — e.g. one that legitimately
// reports the settings URL as stale — would misclassify that whole review as non-genuine
// and leave the gate wrongly PENDING. Requiring both signals together, anchored to the
// start of the message rather than matched anywhere in it, keeps the exact known setup
// reply caught (it is short — the whole thing fits in body_excerpt's 200 chars, unlike
// every genuine response observed so far, which opens with a review/finding header) while
// no longer rejecting a genuine review merely for mentioning the phrase or URL in passing.
// Issue #274's empirical investigation (LDL PR #275) into whether Codex honors a
// GITHUB_TOKEN (bot)-authored Stage 1 trigger reproduced a second, sibling setup prompt this
// function didn't yet recognize: posting the trigger as `github-actions[bot]` (an identity
// with no Codex account connected) drew "To use Codex here, [create a Codex account and
// connect to github](https://chatgpt.com/codex/cloud/settings/connectors)." instead of an
// actual review -- a distinct connector-authorization prompt from the already-known
// environment-configuration one, but the same underlying shape: a fixed Codex Cloud setup
// message, not a review of anything. Recognized as its own alternative second signal, same
// anchored-to-start discipline as the environment variant, rather than loosening the anchor
// itself -- the anchor is what already keeps a genuine review that merely mentions Codex
// Cloud setup in passing from being misclassified (Stage 1 review finding on PR #142).
function isCodexCloudSetupPrompt(text) {
  const normalized = (text ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!normalized.startsWith("to use codex here")) return false;
  return (
    normalized.includes("create an environment for this repo") ||
    normalized.includes("create a codex account and connect to github")
  );
}

// YouTubery PR #14 (LDL issue #151): a blocked/status reply wrapped in harmless leading
// Markdown presentation -- e.g. "### BLOCKED -- checkout unavailable" -- defeated
// BLOCKED_STATUS_PATTERN's `^\s*BLOCKED\b` anchor, because a heading marker sits before the
// semantic first word. Rather than adding another one-off regex fragment per wrapper
// style, strip harmless leading presentation (heading hashes, blockquote markers, list
// markers, and bold/italic emphasis) once, so classification sees the same leading token a
// human reader would. This only trims the *front* of the text -- classification still
// anchors to the start of the normalized string, so a genuine review that discusses or
// quotes "BLOCKED" later in its body (or as an unrelated Markdown-formatted word) is
// untouched.
//
// Refreshed YouTubery PR #14 review (issue #161, Failure A): a list-wrapped reply --
// e.g. "- **BLOCKED** -- checkout unavailable" -- still defeated the anchor, because the
// leading list marker ("-", "+", "*", or "1.") wasn't among the wrappers stripped. List
// markers are only stripped when followed by whitespace, so they can never consume "*" or
// "_" emphasis markers (which are only ever immediately followed by non-space content) --
// the two wrapper classes stay unambiguous regardless of loop order.
function stripLeadingMarkdownWrapper(text) {
  let s = text ?? "";
  let prev;
  do {
    prev = s;
    s = s.replace(/^\s+/, "");
    s = s.replace(/^>+/, "");
    s = s.replace(/^#{1,6}(?=\s|$)/, "");
    s = s.replace(/^[-+*](?=\s)/, "");
    s = s.replace(/^\d{1,3}[.)](?=\s)/, "");
    s = s.replace(/^[*_]{1,3}(?=\S)/, "");
  } while (s !== prev);
  return s;
}

export function isGenuineResponse(bodyExcerpt) {
  const normalized = stripLeadingMarkdownWrapper(bodyExcerpt ?? "");
  if (isCodexCloudSetupPrompt(normalized)) return false;
  if (BLOCKED_STATUS_PATTERN.test(normalized)) return false;
  if (ELLIPTICAL_REFUSAL_PATTERN.test(normalized)) return false;
  if (isSelfReferentialRefusal(normalized)) return false;
  return true;
}
