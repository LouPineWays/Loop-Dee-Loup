#!/usr/bin/env node
// Deterministic Stage 1 completion gate for docs/bounded-review-cycle.md. A review-worthy
// PR must not be reported as normally complete/merge-ready (AGENTS.md's `CLEAN` chat
// format, or any other "this slice is done" claim) unless durable GitHub evidence shows
// the mandatory Stage 1 `@codex review` actually happened and drew a genuine response.
//
// This closes a recurring omission, not a one-off: LDL issue #32 found a review-worthy PR
// (#31) that merged without Stage 1 despite the rule already being documented in prose, and
// YouTubery issue #12 reproduced the exact same omission independently — a session
// completed, committed, pushed, and reported a slice done without ever requesting the
// required inline review. Both times the rule existed in AGENTS.md; neither time did
// anything mechanically stop the session from treating the slice as complete anyway. This
// script is the mechanical stop: it reuses trigger.mjs's dedup read and poll.mjs's
// genuine-response matching (never a second, competing representation of "did Stage 1
// happen") to compute one of four states from repository evidence — never from
// conversation memory — and fails closed (a non-zero exit) unless that evidence shows
// Stage 1 either does not apply or already drew a genuine response.
//
// States (see docs/bounded-review-cycle.md's "Stage 1 completion gate" section):
//   EXEMPT           — the PR body records an explicit justified exemption. exit 0.
//   NOT_REQUESTED    — no `@codex review` trigger found at the given --head. exit 2.
//   PENDING          — a trigger exists but no genuine post-trigger bot response yet. exit 2.
//   RESPONSE_RECEIVED — a trigger and a genuine post-trigger bot response both exist. exit 0.
//
// This gate does not evaluate whether a reported finding is valid or whether a correction
// actually fixes it — that is the controlling session's job under Stage 1 steps 4-9. Its
// only job is to prevent the mandatory trigger-and-response transition from being silently
// skipped or assumed.
//
// Usage:
//   node tools/review-watch/stage1-gate.mjs --repo OWNER/REPO --number 50 --head <sha>
//
// Exit codes: 0 = EXEMPT or RESPONSE_RECEIVED (safe to proceed), 2 = NOT_REQUESTED or
// PENDING (must not be reported complete/merge-ready yet), 1 = operational error.
//
// Tests: node --test tools/review-watch/stage1-gate.test.mjs

import { execFileSync } from "node:child_process";
import { endpointsFor, findAllMatches } from "./poll.mjs";
import { findExistingTrigger } from "./trigger.mjs";

// A PR body records an exemption with a line of the exact form:
//   Stage 1 exemption: <reason>
// e.g. "Stage 1 exemption: docs typo fix, not review-worthy per Entry check." Matched
// against the durable PR body (not a comment, not conversation memory) so a fresh session
// re-running this gate sees the same judgment without reconstructing it.
// [ \t]*, not \s*, after the label: \s matches newlines too, so \s* would let an empty
// "Stage 1 exemption:" line swallow the following line of ordinary description text as
// the "reason", accepting a malformed marker as a justified exemption. Restricting to
// horizontal whitespace forces the reason onto the marker's own line.
const EXEMPTION_PATTERN = /^Stage 1 exemption:[ \t]*(.+)$/im;

export function findExemption(body) {
  const match = EXEMPTION_PATTERN.exec(body ?? "");
  return match ? match[1].trim() : null;
}

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

// issue #161, Failure B, and two rounds of this correction's own Stage 1 review, converged
// on two genuinely different non-genuine shapes rather than one regex each round kept
// missing:
//
// A refused *self-referential* attempt: the responder itself describes trying and failing
// -- "I attempted to push a fix but do not have write access", "I tried applying the fix,
// but I don't have write access". Two independent fixes here were each flagged as wrong:
//  - checking a permission-lack phrase and a mutation verb *anywhere* in the message let
//    an ordinary instruction verb elsewhere ("Update the test") pair with an unrelated
//    permission mention and reject a genuine review;
//  - requiring the verb to be a bare infinitive right after "to" ("... to push") missed
//    the identical refusal phrased with a gerund ("tried applying") or direct object.
// Gating on an explicit first-person pronoun (PRONOUN_PATTERN) plus a real attempt verb
// (ATTEMPT_CUE_PATTERN) plus a genuinely *negated* permission/access phrase
// (PERMISSION_LACK_PATTERN) -- all three present *anywhere*, no verb-form or proximity
// requirement -- fixes both directions: an unrelated instruction elsewhere in a genuine
// review never carries "I ... attempted/tried ... do not have ... access" together, and
// nothing about the negated-permission phrase depends on infinitive form. A second-round
// finding also showed that treating bare "need(ed)" or bare "permission"/"authorized" (with
// no negation) as attempt/permission cues was itself the bug -- "The tests need to cover
// empty input" and "the caller needs permission to read this file" are ordinary review
// prose, not refusals, and neither contains negation ("cannot have", "insufficient", "do
// not have permission"). Restricting both cue lists to genuinely negated/attempt-specific
// wording (not bare nouns) is what keeps this three-way conjunction safe without a pronoun
// check on its own being sufficient.
const PRONOUN_PATTERN = /\b(?:I|I'm|I've|[Ww]e|[Ww]e're|[Ww]e've)\b/;
const ATTEMPT_CUE_PATTERN = /\b(?:attempt(?:ed|ing)?|tr(?:y|ies|ied|ying)|fail(?:ed|s|ing)?|unable)\b/i;
const PERMISSION_LACK_PATTERN =
  /\b(?:do not|don't|does not|doesn't|did not|didn't|cannot|can't|could not|couldn't) have (?:write |repository |branch )?(?:access|permission)\b|\binsufficient (?:write |repository )?permission\b/i;

// The other non-genuine shape has no subject at all: a short, complete, bot-style status
// sentence -- "Insufficient permission to commit changes.", "Not authorized to push this
// branch." -- rather than a human review sentence *about* someone else's permissions
// ("The caller needs permission to read this file"). Anchoring this to the very start of
// the whole (normalized) message, not any sentence boundary within it, is what tells the
// two apart: a genuine finding almost never opens with the bare negated-permission phrase
// as its first words, but a real status reply -- like the already-anchored BLOCKED and
// Codex-Cloud-setup-prompt checks above -- is that phrase from its first character.
const ELLIPTICAL_REFUSAL_PATTERN =
  /^(?:insufficient|no|lack of|missing)\s+(?:write |repository |branch )?(?:permission|access)\b|^not (?:permitted|authorized)\b/i;

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
function isCodexCloudSetupPrompt(text) {
  const normalized = (text ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  return normalized.startsWith("to use codex here") && normalized.includes("create an environment for this repo");
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
  if (
    PRONOUN_PATTERN.test(normalized) &&
    ATTEMPT_CUE_PATTERN.test(normalized) &&
    PERMISSION_LACK_PATTERN.test(normalized)
  ) {
    return false;
  }
  return true;
}

export function parseArgs(argv) {
  const args = { bot: "chatgpt-codex-connector[bot]" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const value = argv[++i];
    args[key] = value;
  }
  return args;
}

// `ghApiImpl` and `ghPrViewImpl` are injected so tests can drive `run` end-to-end without
// touching the real network or `gh` CLI.
export async function run(args, { ghApiImpl = defaultGhApi, ghPrViewImpl = defaultGhPrView } = {}) {
  const { repo, number, head } = args;
  const bot = args.bot ?? "chatgpt-codex-connector[bot]";

  if (!repo || !number || !head) {
    return { exitCode: 1, message: "Missing required args: --repo, --number, --head are all required." };
  }

  let body;
  try {
    body = await ghPrViewImpl({ repo, number });
  } catch (err) {
    return { exitCode: 1, message: `gh pr view failed for ${repo}#${number}: ${err.message}` };
  }

  const exemption = findExemption(body);
  if (exemption) {
    return { exitCode: 0, state: "EXEMPT", reason: exemption };
  }

  const endpoints = endpointsFor("pr", repo, number);
  const commentsEndpoint = endpoints.find((e) => e.name === "issue-comments");

  let comments;
  try {
    comments = await ghApiImpl(commentsEndpoint.path);
  } catch (err) {
    return { exitCode: 1, message: `gh api call failed for ${commentsEndpoint.path}: ${err.message}` };
  }
  if (!Array.isArray(comments)) {
    return {
      exitCode: 1,
      message: `Ambiguous trigger read: expected an array of comments from ${commentsEndpoint.path}.`,
    };
  }

  const trigger = findExistingTrigger(comments, { head });
  if (!trigger) {
    return { exitCode: 2, state: "NOT_REQUESTED" };
  }

  const sinceMs = new Date(trigger.created_at).getTime();
  const matches = [];
  for (const endpoint of endpoints) {
    // The issue-comments thread was already fetched above for the trigger dedup check;
    // reuse it instead of reading it twice.
    let items = endpoint.name === "issue-comments" ? comments : null;
    if (items === null) {
      try {
        items = await ghApiImpl(endpoint.path);
      } catch (err) {
        return { exitCode: 1, message: `gh api call failed for ${endpoint.path}: ${err.message}` };
      }
    }
    matches.push(...findAllMatches(items, { bot, sinceMs, endpointName: endpoint.name }));
  }

  const genuineMatches = matches.filter((m) => isGenuineResponse(m.body_excerpt));

  if (genuineMatches.length === 0) {
    return { exitCode: 2, state: "PENDING", triggerTimestamp: trigger.created_at, nonGenuineMatches: matches };
  }

  return { exitCode: 0, state: "RESPONSE_RECEIVED", triggerTimestamp: trigger.created_at, matches: genuineMatches };
}

function defaultGhApi(path) {
  const raw = execFileSync("gh", ["api", path, "--paginate", "--slurp"], { encoding: "utf8" });
  return JSON.parse(raw).flat();
}

function defaultGhPrView({ repo, number }) {
  const raw = execFileSync("gh", ["pr", "view", String(number), "--repo", repo, "--json", "body"], {
    encoding: "utf8",
  });
  return JSON.parse(raw).body ?? "";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await run(args);
  if (result.exitCode === 1) {
    console.error(result.message);
  } else {
    console.log(JSON.stringify(result));
  }
  process.exit(result.exitCode);
}

// Only run as a CLI when invoked directly, not when the test file imports these functions.
if (process.argv[1] && process.argv[1].endsWith("stage1-gate.mjs")) {
  main();
}
