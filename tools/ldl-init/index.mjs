#!/usr/bin/env node
// Deterministic bootstrap mechanism for issue #66: installs the reusable Loop-Dee-Loup
// machinery (skills, personas, scripts, and the operating-model documentation they need)
// into an arbitrary existing consumer repository, without a human hand-selecting files
// from this repository. See docs/consumer-contract.md for the full ownership-boundary
// contract this script implements.
//
// Usage (run from a local clone of Loop-Dee-Loup):
//   node tools/ldl-init/index.mjs --dest <path-to-consumer-repo>
//
// --dest must already exist; it does not need to be empty and does not need to be a git
// repository. --root overrides the Loop-Dee-Loup source root (defaults to this script's
// own repository) and exists mainly so tests can point at a disposable fixture instead of
// this repository's real, changing content.
//
// What it does, each run:
//   1. Copies every path in MANAGED_ITEMS from --root into --dest, plus the two BRIDGE_FILES
//      entries — a derived AGENTS.md (see deriveConsumerAgents) and a copied CLAUDE.md, the
//      Claude Code project-instruction entry point that imports AGENTS.md — whose destinations
//      each depend on whether --dest already has its own same-named file.
//   2. Never overwrites a destination path that already exists and is not recorded as
//      LDL-managed in --dest's existing .ldl/manifest.json — that item is skipped
//      instead, so the bootstrap is safe against a non-empty, pre-existing repository.
//   3. Writes .ldl/manifest.json recording the source revision, install time, every
//      installed path with a content hash, and every skipped path with a reason.
//
// Running this again against an already-initialized --dest at the same source revision
// reinstalls the same managed paths with identical content: a predictable no-op, not a
// duplicate or corrupting write. Conflict-safe updates to a *locally modified* managed
// file, and updates to a *newer* Loop-Dee-Loup revision, are out of scope here — see
// docs/consumer-contract.md and issue #67.
//
// Tests: node --test tools/ldl-init/index.test.mjs

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LDL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SOURCE_ONLY_START = "<!-- ldl:source-only:start -->";
const SOURCE_ONLY_END = "<!-- ldl:source-only:end -->";

// The reusable engine/runtime material this repository distributes. Everything else in
// Loop-Dee-Loup (its own docs, its own Burn Order, its own dogfooding history) is
// development state, not consumer-installable machinery — see docs/consumer-contract.md.
// AGENTS.md is handled separately in run(), since its destination depends on consumer
// repository state, not source repository state.
export const MANAGED_ITEMS = [
  { kind: "dir", src: ".claude/skills/context-clearing", dest: ".claude/skills/context-clearing" },
  { kind: "dir", src: ".claude/skills/local-worker", dest: ".claude/skills/local-worker" },
  { kind: "dir", src: ".claude/skills/model-check", dest: ".claude/skills/model-check" },
  { kind: "dir", src: ".claude/skills/persona-maker", dest: ".claude/skills/persona-maker" },
  { kind: "dir", src: ".claude/skills/retro", dest: ".claude/skills/retro" },
  { kind: "dir", src: ".claude/skills/script-maker", dest: ".claude/skills/script-maker" },
  { kind: "dir", src: ".claude/skills/sift", dest: ".claude/skills/sift" },
  { kind: "dir", src: ".claude/skills/skill-maker", dest: ".claude/skills/skill-maker" },
  { kind: "dir", src: ".claude/skills/spend", dest: ".claude/skills/spend" },
  { kind: "file", src: ".claude/personas/audit-verdict-extractor.md", dest: ".claude/personas/audit-verdict-extractor.md" },
  { kind: "dir", src: "tools/local-worker", dest: "tools/local-worker" },
  { kind: "dir", src: "tools/review-watch", dest: "tools/review-watch" },
  { kind: "file", src: "docs/operating-model.md", dest: "docs/operating-model.md" },
  { kind: "file", src: "docs/bounded-review-cycle.md", dest: "docs/bounded-review-cycle.md" },
  { kind: "file", src: "docs/decision-forms.md", dest: "docs/decision-forms.md" },
  { kind: "file", src: "docs/consumer-contract.md", dest: "docs/consumer-contract.md" },
  { kind: "dir", src: ".github/ISSUE_TEMPLATE", dest: ".github/ISSUE_TEMPLATE" },
];

// A "bridge" file's installed destination depends on consumer repository state, not source
// repository state alone: AGENTS.md (content derived from Loop-Dee-Loup's own AGENTS.md with
// its <!-- ldl:source-only:... --> blocks stripped) and CLAUDE.md (copied verbatim — it is
// already the generic Claude Code entry point that imports AGENTS.md via `@AGENTS.md`, see
// docs/consumer-contract.md) share the exact same ownership rule: install straight to the
// consumer repository root when nothing unmanaged is already sitting there, otherwise park the
// content at a template path under `.ldl/` instead of overwriting a consumer-owned file. This
// is why they are resolved separately from MANAGED_ITEMS above rather than listed inside it.
export const BRIDGE_FILES = [
  {
    destRel: "AGENTS.md",
    templateDestRel: ".ldl/AGENTS.template.md",
    readContent: (root) => Buffer.from(deriveConsumerAgents(readFileSync(join(root, "AGENTS.md"), "utf8")), "utf8"),
  },
  {
    destRel: "CLAUDE.md",
    templateDestRel: ".ldl/CLAUDE.template.md",
    readContent: (root) => normalizeLineEndings(readFileSync(join(root, "CLAUDE.md"))),
  },
];

// Resolves where one BRIDGE_FILES entry should install for a given consumer repository: its
// own root destRel when the consumer doesn't already own an unmanaged file there (or a prior
// LDL run is already recorded as managing it), otherwise its templateDestRel instead of
// overwriting the consumer's file — unless the consumer's on-disk root file already matches the
// target content byte-for-byte, which is the one safe signal LDL can use to recognize the
// documented manual-merge step (parking a template, then hand-merging it into the consumer's
// own file) has already been completed: `resolvedByContentMatch` tells callers to treat that
// destination as LDL-managed going forward even though `existingManifest` doesn't yet record it,
// so the merge actually clears pendingManualIntegration instead of the bridge being permanently
// re-parked at its template on every later run because the file was never marked managed.
// Exported so tools/ldl-update and tools/mcp-server/status.mjs resolve this exact same ownership
// decision rather than a second implementation of it.
export function planBridgeOp({ destRel, templateDestRel, content, destRoot, existingManifest }) {
  const alreadyManaged = Boolean(existingManifest?.files?.some((f) => f.dest === destRel));
  const absDest = join(destRoot, destRel);
  const destExists = existsSync(absDest);
  if (!destExists || alreadyManaged) {
    return { destRel, content, resolvedByContentMatch: false };
  }
  let onDiskMatchesTarget = false;
  try {
    onDiskMatchesTarget = contentMatchesHash(readFileSync(absDest), sha256(content));
  } catch {
    onDiskMatchesTarget = false; // unreadable (e.g. a directory) — fall through to templateDestRel
  }
  if (onDiskMatchesTarget) {
    return { destRel, content, resolvedByContentMatch: true };
  }
  return { destRel: templateDestRel, content, resolvedByContentMatch: false };
}

// Plans every BRIDGE_FILES entry against one consumer repository: reads/derives each entry's
// source content and resolves its destination via planBridgeOp. Returns:
//   bridgePlans           - {bridge, op, resolvedByContentMatch} per entry, for template
//                            supersession checks and derivePendingManualIntegration() below;
//   bridgeOps             - just the {destRel, content} ops, ready to push onto planInstall's/
//                            planUpdate's own `ops`;
//   resolvedManifestPatch - synthetic {dest, sha256} records for entries planBridgeOp resolved
//                            by content match. `existingManifest` genuinely doesn't record these
//                            as LDL-managed yet, but planInstall/planUpdate's own ownership
//                            checks must treat them as managed anyway — otherwise "the consumer's
//                            file already matches" would be classified as an unrelated
//                            pre-existing file and skipped instead of recorded, and the bridge
//                            would never actually graduate out of pendingManualIntegration.
//                            Callers merge this into the `existingManifest` they pass to
//                            planInstall/planUpdate (never into the one passed back into this
//                            function, which must keep reading the true recorded state).
// Throws if a BRIDGE_FILES entry's source content cannot be read/derived from `root`; callers
// translate that into their own exitCode/error-result convention.
export function planBridges({ root, destRoot, existingManifest }) {
  const bridgePlans = BRIDGE_FILES.map((bridge) => {
    const content = bridge.readContent(root);
    const { destRel, resolvedByContentMatch } = planBridgeOp({ ...bridge, content, destRoot, existingManifest });
    return { bridge, op: { destRel, content }, resolvedByContentMatch };
  });
  const bridgeOps = bridgePlans.map((p) => p.op);
  const resolvedManifestPatch = bridgePlans
    .filter((p) => p.resolvedByContentMatch)
    .map((p) => ({ dest: p.op.destRel, sha256: sha256(p.op.content) }));
  return { bridgePlans, bridgeOps, resolvedManifestPatch };
}

// Merges resolvedManifestPatch (see planBridges above) into the `files` list of the manifest
// object passed to planInstall/planUpdate's own ownership checks, without mutating or otherwise
// altering the caller's real existingManifest/parsedManifest (which planBridgeOp and the
// template-supersession checks must keep reading unpatched). A no-op passthrough when there is
// nothing to patch, so callers can always call this rather than conditionally branching.
export function withResolvedBridgesManaged(existingManifest, resolvedManifestPatch) {
  if (resolvedManifestPatch.length === 0) return existingManifest;
  return { ...(existingManifest || {}), files: [...(existingManifest?.files || []), ...resolvedManifestPatch] };
}

// Looks up a BRIDGE_FILES entry by its root destRel ("AGENTS.md" or "CLAUDE.md"). Exported so
// tools/ldl-ack validates a caller-supplied bridge name against the exact same set this script
// itself resolves, rather than a second hardcoded list.
export function findBridgeByDestRel(destRel) {
  return BRIDGE_FILES.find((b) => b.destRel === destRel) || null;
}

// Validates and computes the manifest patch for issue #153's ownership-preserving manual
// integration acknowledgement: a durable attestation that the *current* LDL bridge target for
// one BRIDGE_FILES entry has been merged by hand into the consumer-owned destination it was
// parked next to. Distinct from planBridgeOp's own resolvedByContentMatch graduation (which
// this function neither duplicates nor weakens): resolvedByContentMatch recognizes a
// byte-identical replacement and lets the destination graduate into the normal LDL-managed
// `files[]` set; this recognizes a genuine merge that keeps consumer-owned content in the file,
// and — per issue #153 requirement 3 — never adds that destination to `files[]`. The caller is
// responsible for persisting the returned patch into `manualIntegrationAcknowledgements` and
// leaving `files[]` untouched.
//
// Fails closed (returns { ok: false, reason }) rather than recording a misleading acknowledgement
// (issue #153 requirement 6) when:
//   - `bridgeDestRel` doesn't name a real BRIDGE_FILES entry;
//   - there is no existing manifest to acknowledge against;
//   - the bridge doesn't currently resolve to its templateDestRel given the *current* --root
//     content and --dest state — i.e. there is no pending manual integration to acknowledge
//     right now (already installed, already content-match-graduated, or the caller's `--dest`
//     was never actually parked in the first place);
//   - the parked template itself is missing or unsafe (symlinked, or blocked by a non-directory)
//     — the same on-disk evidence a prior `tools/ldl-init`/`tools/ldl-update` run would have
//     produced when it genuinely parked this bridge, so its absence means either the manual step
//     was never actually reached or the path has since been tampered with;
//   - the consumer-owned destination itself is unsafe to read (symlinked, or blocked by a
//     non-directory) — planBridgeOp already implies it exists to reach the templateDestRel
//     branch, but not that it's safe.
//
// The acknowledged hash is always recomputed fresh from `bridge.readContent(root)` — never read
// off the parked template file on disk — so there is no code path by which a caller could
// attest to a target older than the one --root currently defines (issue #153 requirement 4);
// the moment --root's bridge content changes, this same recomputation makes a later
// `derivePendingManualIntegration` call stop matching the recorded acknowledgedTargetSha256, and
// the bridge becomes pending again automatically, without this function needing to track
// revision or staleness itself.
//
// Exported so tools/ldl-ack and tools/mcp-server share this exact validation, rather than
// separate CLI/MCP implementations of the same acknowledgement rule (issue #153 constraint).
export function planAcknowledgeIntegration({ bridgeDestRel, root, destRoot, existingManifest }) {
  const bridge = findBridgeByDestRel(bridgeDestRel);
  if (!bridge) {
    return {
      ok: false,
      reason: `unknown bridge "${bridgeDestRel}" — must be one of: ${BRIDGE_FILES.map((b) => b.destRel).join(", ")}`,
    };
  }
  if (!existingManifest) {
    return { ok: false, reason: "no .ldl/manifest.json found — run tools/ldl-init first" };
  }

  let content;
  try {
    content = bridge.readContent(root);
  } catch (err) {
    return { ok: false, reason: `failed deriving current bridge target from --root: ${err.message}` };
  }

  const { destRel } = planBridgeOp({ ...bridge, content, destRoot, existingManifest });
  if (destRel !== bridge.templateDestRel) {
    return {
      ok: false,
      reason: `${bridge.destRel} has no pending manual integration to acknowledge right now (it is not currently parked at ${bridge.templateDestRel})`,
    };
  }

  const unsafeTemplateReason = findUnsafeDestReason(destRoot, bridge.templateDestRel);
  if (unsafeTemplateReason) {
    return { ok: false, reason: `${bridge.templateDestRel} is unsafe: ${unsafeTemplateReason}` };
  }
  const absTemplatePath = join(destRoot, bridge.templateDestRel);
  if (!existsSync(absTemplatePath)) {
    return {
      ok: false,
      reason: `${bridge.templateDestRel} does not exist — expected the parked template that establishes the current bridge target`,
    };
  }
  // The parked template on disk must actually be *this* target's content, not a stale one left
  // over from an earlier Loop-Dee-Loup revision (Stage 1 review finding on PR #159): planBridgeOp
  // above only asks "does this bridge currently resolve to its templateDestRel", which stays true
  // across a source revision bump even before a consumer's own `tools/ldl-update` run has ever
  // refreshed the parked file — recomputing `content` fresh from --root without checking the
  // template's actual bytes would let an acknowledgement bind to a target the human parked
  // template on disk never showed the consumer, durably misreporting an outdated operating
  // contract as fully activated. `contentMatchesHash` applies the same checkout-line-ending
  // tolerance every other comparison in this file uses.
  if (!contentMatchesHash(readFileSync(absTemplatePath), sha256(content))) {
    return {
      ok: false,
      reason:
        `${bridge.templateDestRel} does not match the current bridge target content — it is stale relative to --root. ` +
        `Run tools/ldl-update against --dest first to refresh the parked template, then acknowledge.`,
    };
  }

  const absDestPath = join(destRoot, bridge.destRel);
  const unsafeDestReason = findUnsafeDestReason(destRoot, bridge.destRel);
  if (unsafeDestReason) {
    return { ok: false, reason: `${bridge.destRel} is unsafe: ${unsafeDestReason}` };
  }
  let destStat;
  try {
    destStat = statSync(absDestPath);
  } catch {
    return { ok: false, reason: `${bridge.destRel} does not exist at the destination — nothing to acknowledge as integrated` };
  }
  // A directory (or other non-regular node) sitting at the bridge's own destRel is not a file a
  // human could have merged anything into — findUnsafeDestReason only guards symlinks and a
  // non-directory blocking a path *segment*, not a non-file leaf (Stage 1 review finding on PR
  // #159), and planBridgeOp already parks in this case only because readFileSync on a directory
  // throws, not because it recognized this as a genuine consumer-owned file.
  if (!destStat.isFile()) {
    return { ok: false, reason: `${bridge.destRel} is not a regular file at the destination — nothing to acknowledge as integrated` };
  }

  return {
    ok: true,
    dest: bridge.destRel,
    template: bridge.templateDestRel,
    acknowledgedTargetSha256: sha256(content),
  };
}

// Derives the durable "still needs a human" signal for every bridge file from the actual
// planInstall/planUpdate outcome (toSkip), not merely from planBridgeOp's destination choice.
// Two distinct situations both count:
//   - a bridge resolved to its templateDestRel (the consumer owns the root file and its content
//     doesn't match the target) and that template write itself either succeeded (the ordinary,
//     documented "merge this template into your file by hand" case) or was *also* skipped (an
//     unrelated file or unsafe path already occupies the template destination too, so there is
//     no template on disk yet for a human to merge — a materially different situation the
//     ordinary reason text must not claim);
//   - a bridge resolved straight to its own destRel but that root write was skipped (e.g. a
//     dangling symlink or other unsafe path component blocks it) — the bridge is not actually
//     installed at all, which a destRel-only check would otherwise miss entirely and report as
//     fully activated.
// `acknowledgements` (issue #153) is the manifest's own `manualIntegrationAcknowledgements`
// list — an ownership-preserving completion path distinct from planBridgeOp's
// resolvedByContentMatch graduation (see planAcknowledgeIntegration below): a bridge parked at
// its templateDestRel is excluded from the returned pending list when an acknowledgement for
// that exact `bridge.destRel` binds to the exact content hash of the current target (`op.content`),
// so a stale acknowledgement — recorded against a since-changed bridge target — never suppresses
// a genuinely new pending requirement. Only ever consulted for the templateDestRel branch: an
// acknowledgement attests that a human merged the parked template into the consumer-owned root
// file, which has no bearing on the unrelated "root write itself failed" branch below. Callers
// that don't pass `acknowledgements` (the default `[]`) get exactly the prior behavior, so every
// existing call site and test is unaffected until it opts in.
// Exported so tools/ldl-update and tools/mcp-server/status.mjs derive this exact same signal
// from their own toInstall/toSkip outcome instead of a second implementation of it.
export function derivePendingManualIntegration(bridgePlans, toSkip, acknowledgements = []) {
  const skipReasonByDest = new Map(toSkip.map((s) => [s.dest, s.reason]));
  const pending = [];
  for (const { bridge, op } of bridgePlans) {
    const skipReason = skipReasonByDest.get(op.destRel);
    if (op.destRel === bridge.templateDestRel) {
      const ack = acknowledgements.find((a) => a.dest === bridge.destRel);
      if (ack && op.content !== undefined && ack.acknowledgedTargetSha256 === sha256(op.content)) {
        continue;
      }
      pending.push({
        dest: bridge.destRel,
        template: bridge.templateDestRel,
        reason: skipReason
          ? `a pre-existing ${bridge.destRel} was not overwritten, and its derived template could not be written to ${bridge.templateDestRel} either (${skipReason}) — resolve manually before relying on the LDL operating contract being active`
          : `a pre-existing ${bridge.destRel} was not overwritten — merge ${bridge.templateDestRel} into it by hand to activate the LDL operating contract`,
      });
    } else if (skipReason) {
      pending.push({
        dest: bridge.destRel,
        template: bridge.templateDestRel,
        reason: `${bridge.destRel} could not be installed (${skipReason}) — the LDL operating contract is not active until this is resolved manually`,
      });
    }
  }
  return pending;
}

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    args[key] = argv[++i];
  }
  return args;
}

// Strips every <!-- ldl:source-only:start/end --> block (Loop-Dee-Loup's own instance
// state — its own Burn Order, its own prototype trial) out of Loop-Dee-Loup's own
// AGENTS.md, leaving the generic operating contract a consumer repository actually needs.
// Pure string transform so it is trivially unit-testable without touching the filesystem.
export function deriveConsumerAgents(sourceText) {
  // Normalize CRLF/CR to LF first (issue #146): sourceText comes from a working-tree read,
  // which carries CRLF whenever the Loop-Dee-Loup checkout doing the deriving has
  // core.autocrlf (or an equivalent) converting line endings on checkout — Windows by far
  // the common case. Left unnormalized, a source-only block spanning CRLF-terminated lines
  // leaves behind a run of "\r\n\r\n\r\n" where the blank-line collapse below (which matches
  // 3+ *consecutive* "\n") silently fails to fire, since each "\n" here is separated by a
  // "\r" rather than adjacent to the next one — producing the exact stray-blank-line
  // regression this issue exists to prevent, independent of the MCP process-coherence bug.
  // Routed through the shared normalizeLineEndings primitive (Stage 2 audit finding on PR
  // #147, issue #146) rather than a second inline copy of the same CRLF/CR-to-LF transform,
  // so the two never independently drift — normalizeLineEndings is Buffer-in/Buffer-out, so
  // sourceText round-trips through a Buffer here and stays a string everywhere below, which
  // this function's own "pure string transform" contract (see the comment above it) depends
  // on for its `.indexOf`/`.slice` calls.
  sourceText = normalizeLineEndings(Buffer.from(sourceText, "utf8")).toString("utf8");
  let result = "";
  let cursor = 0;
  for (;;) {
    const startIdx = sourceText.indexOf(SOURCE_ONLY_START, cursor);
    if (startIdx === -1) {
      result += sourceText.slice(cursor);
      break;
    }
    const endIdx = sourceText.indexOf(SOURCE_ONLY_END, startIdx);
    if (endIdx === -1) {
      throw new Error(`unterminated ${SOURCE_ONLY_START} block in source AGENTS.md`);
    }
    result += sourceText.slice(cursor, startIdx);
    cursor = endIdx + SOURCE_ONLY_END.length;
  }
  // Collapse the run of blank lines a removed block leaves behind down to a single one.
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trimEnd() + "\n";
}

// Exported so tools/ldl-update can hash on-disk content against recorded/target hashes
// using the exact same digest this script's own manifest entries are computed with.
export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

// Cheap, deterministic text/binary heuristic (issue #146): a NUL byte essentially never
// appears in a legitimate UTF-8/ASCII text file, but does appear near the start of almost
// every real binary format. Every MANAGED_ITEMS/BRIDGE_FILES entry today is markdown, JS, or
// JSON, but this guard exists so a future binary managed item is never silently corrupted by
// line-ending normalization rather than requiring every caller to hand-maintain an
// extension allowlist.
export function looksBinary(buffer) {
  const scanLength = Math.min(buffer.length, 8000);
  for (let i = 0; i < scanLength; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

// Canonicalizes CRLF and lone-CR line endings to LF, for comparison and for source reads —
// but only for content that passes looksBinary()'s text heuristic, so exact-byte semantics
// are preserved for anything that isn't confidently text (issue #146 requirement 1: "Preserve
// exact-byte semantics for files where normalization would not be safe or appropriate").
// Used in two places that must agree on exactly the same normalization: buildOps() below
// (so the content Loop-Dee-Loup treats as canonical source truth doesn't itself carry
// checkout-artifact CRLF, regardless of the LDL maintainer's own git line-ending config) and
// tools/ldl-update's planUpdate() (so an installed file's on-disk representation in a
// consumer's own checkout is compared against that same canonical form, independent of the
// consumer's own checkout line-ending config).
export function normalizeLineEndings(buffer) {
  if (looksBinary(buffer)) return buffer;
  return Buffer.from(buffer.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "utf8");
}

// True when currentBuf's content matches `hash` either byte-for-byte or, for text content,
// under either line-ending representation via normalizeLineEndings (issue #146). Applied
// everywhere previously-managed content — a managed file, a superseded bridge template, or a
// consumer-owned bridge root file being checked for the "already matches the target" bridge
// graduation case in planBridgeOp() below — is compared against a recorded or target hash, so
// a checkout-only line-ending difference (e.g. a consumer's own core.autocrlf converting an
// LF-installed file to CRLF on checkout) is never mistaken for a local edit or a missed
// update, while a genuine content edit still fails every comparison. Checks the CRLF form of
// the normalized content too, not only the LF form, because `hash` itself may have been
// recorded by a pre-#146 run whose own buildOps() read unnormalized CRLF source bytes (Codex
// P2 finding on PR #147) — without this, a consumer who later normalizes their own checkout
// to LF (independent of any LDL run) would see that legacy CRLF-based provenance hash as an
// unresolvable mismatch, a false conflict this issue's "no manual migration" acceptance
// criterion forbids. Exported so tools/ldl-update's planUpdate()/run() and
// tools/mcp-server/status.mjs's read-only mirror of the template-supersession check all apply
// this exact same tolerance, rather than independent implementations that could drift.
export function contentMatchesHash(currentBuf, hash) {
  if (sha256(currentBuf) === hash) return true;
  if (looksBinary(currentBuf)) return false;
  const lf = normalizeLineEndings(currentBuf);
  if (sha256(lf) === hash) return true;
  const crlf = Buffer.from(lf.toString("utf8").replace(/\n/g, "\r\n"), "utf8");
  return sha256(crlf) === hash;
}

// Recursively lists files under absDir as "/"-joined paths relative to absDir, regardless
// of host OS path separator, so manifest dest paths stay stable across platforms.
function walkFiles(absDir, relPrefix = "") {
  let files = [];
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const absPath = join(absDir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(walkFiles(absPath, relPath));
    } else if (entry.isFile()) {
      files.push(relPath);
    }
  }
  return files;
}

// Reads every MANAGED_ITEMS path out of root and returns one install op per file, each
// already carrying its bytes — so planning/writing downstream never needs to know whether
// an op originated from a "file" or "dir" item.
export function buildOps(root) {
  const ops = [];
  for (const item of MANAGED_ITEMS) {
    const absSrc = join(root, item.src);
    if (item.kind === "file") {
      ops.push({ destRel: item.dest, content: normalizeLineEndings(readFileSync(absSrc)) });
    } else {
      for (const relFile of walkFiles(absSrc)) {
        ops.push({ destRel: `${item.dest}/${relFile}`, content: normalizeLineEndings(readFileSync(join(absSrc, relFile))) });
      }
    }
  }
  return ops;
}

// Walks destRoot down to destRel one path segment at a time and returns a reason string
// the moment it finds something that makes writing there unsafe, or null if the path is
// clear. Two distinct hazards, checked together because both are "don't trust what's
// already sitting at or above this destination":
//   - an existing symlink anywhere on the path (including the leaf) could redirect the
//     write outside destRoot entirely, e.g. a pre-existing `.claude/skills/sift` symlinked
//     to somewhere unrelated;
//   - an existing plain file where a directory needs to be (e.g. a file literally named
//     `tools`) would otherwise make mkdirSync throw mid-run, leaving a partially applied,
//     unmanifested install instead of a clean skip.
// Every existence check here uses lstatOrNull, not existsSync: existsSync follows symlinks
// and reports false for a dangling one (Node's own documented behavior), which would let a
// dangling symlink at or above the destination slip through as "absent" — and
// fs.writeFileSync itself follows symlinks by default, so a dangling leaf symlink left
// undetected here would have applyInstall() create its write through the link, materializing
// the write at whatever path the symlink names, possibly outside destRoot entirely.
// Exported so tools/ldl-update can apply the exact same write-through-symlink /
// write-through-non-directory guard when re-planning an update.
export function findUnsafeDestReason(destRoot, destRel) {
  const segments = destRel.split("/");
  const leaf = segments.pop();
  let current = destRoot;
  for (const segment of segments) {
    current = join(current, segment);
    const st = lstatOrNull(current);
    if (!st) continue; // will be created by mkdirSync later — fine
    if (st.isSymbolicLink()) {
      return `existing symlink at ${relative(destRoot, current).split("\\").join("/")} in the destination path — refusing to write through it`;
    }
    if (!st.isDirectory()) {
      return `existing non-directory at ${relative(destRoot, current).split("\\").join("/")} blocks this destination path`;
    }
  }
  const absLeaf = join(current, leaf);
  const leafSt = lstatOrNull(absLeaf);
  if (leafSt && leafSt.isSymbolicLink()) {
    return `existing symlink at ${destRel} — refusing to write through it`;
  }
  return null;
}

// Splits ops into what is safe to (re)install versus what must be left alone. A
// destination is left alone, and recorded under skipped with a reason, when either:
//   - some part of its path is unsafe to write through (see findUnsafeDestReason), or
//   - it already exists and is not recorded as LDL-managed in an existing manifest, i.e.
//     it is a pre-existing, unrelated consumer file this bootstrap is not allowed to touch.
export function planInstall({ ops, destRoot, existingManifest }) {
  const managedDestSet = new Set((existingManifest?.files || []).map((f) => f.dest));
  const toInstall = [];
  const toSkip = [];
  for (const op of ops) {
    const unsafeReason = findUnsafeDestReason(destRoot, op.destRel);
    if (unsafeReason) {
      toSkip.push({ dest: op.destRel, reason: unsafeReason });
      continue;
    }
    const absDest = join(destRoot, op.destRel);
    const exists = existsSync(absDest);
    if (exists && !managedDestSet.has(op.destRel)) {
      toSkip.push({ dest: op.destRel, reason: "destination already exists and is not LDL-managed" });
      continue;
    }
    toInstall.push(op);
  }
  return { toInstall, toSkip };
}

function applyInstall(ops, destRoot) {
  const installed = [];
  for (const op of ops) {
    const absDest = join(destRoot, op.destRel);
    mkdirSync(dirname(absDest), { recursive: true });
    writeFileSync(absDest, op.content);
    installed.push({ dest: op.destRel, sha256: sha256(op.content) });
  }
  return installed;
}

// buildOps() copies working-tree bytes, not the committed blob at HEAD, so a dirty
// Loop-Dee-Loup clone can install content that doesn't match the recorded commit. A
// "-dirty" suffix (the same convention `git describe --dirty` uses) keeps the recorded
// revision an honest description of what was actually installed instead of a silently
// misleading provenance claim.
export function defaultResolveRevision(root) {
  let sha;
  try {
    sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
  try {
    const status = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
    if (status.trim().length > 0) {
      return `${sha}-dirty`;
    }
  } catch {
    // HEAD resolved but status didn't — still report the sha we do have.
  }
  return sha;
}

const SHA256_HEX = /^[0-9a-f]{64}$/i;

// A pre-existing .ldl/manifest.json that isn't in the shape this script writes (absent,
// truncated, or from something else entirely) must not be trusted as a record of what is
// LDL-managed — treating it as absent falls back to safe fresh-install semantics instead
// of either crashing on an unexpected shape or silently trusting arbitrary JSON. Every
// `files` entry must carry a complete, plausible record (a non-empty `dest` and a real
// sha256 hex digest), not just pass a loose type check: an incomplete entry like
// `{"dest":"AGENTS.md"}` would otherwise be accepted as an LDL ownership claim over
// AGENTS.md, and this script would then treat a consumer's own untouched AGENTS.md as
// safe to overwrite — the exact thing the AGENTS.md special case exists to prevent.
// Exported so tools/ldl-update applies this exact same shape check to the manifest it
// reads, rather than trusting or re-implementing a slightly different validation.
export function isValidManifest(value) {
  if (!value || typeof value !== "object" || value.schemaVersion !== 1 || !Array.isArray(value.files)) {
    return false;
  }
  const filesValid = value.files.every(
    (f) =>
      f &&
      typeof f === "object" &&
      typeof f.dest === "string" &&
      f.dest.length > 0 &&
      typeof f.sha256 === "string" &&
      SHA256_HEX.test(f.sha256),
  );
  if (!filesValid) return false;
  // `skipped` is optional (an older or hand-authored manifest may omit it entirely), but
  // when present every entry must carry a real dest/reason pair. tools/ldl-update sorts
  // this list by comparing `.reason` with String.prototype.localeCompare — an entry with a
  // missing or non-string reason would pass through undetected here and only surface later
  // as an uncaught crash mid-comparison, instead of the intended "reinitialize" error.
  if (value.skipped !== undefined) {
    if (!Array.isArray(value.skipped)) return false;
    const skippedValid = value.skipped.every(
      (s) =>
        s &&
        typeof s === "object" &&
        typeof s.dest === "string" &&
        s.dest.length > 0 &&
        typeof s.reason === "string" &&
        s.reason.length > 0,
    );
    if (!skippedValid) return false;
  }
  // `pendingManualIntegration` is optional for the same reason `skipped` is (an older or
  // hand-authored manifest may predate it), but when present every entry must carry a complete
  // dest/template/reason triplet — tools/ldl-update's pendingIntegrationListsEqual() sorts and
  // compares these entries, and an incomplete one would only surface later as a crash instead
  // of the intended "reinitialize" error, exactly as for `skipped` above.
  if (value.pendingManualIntegration !== undefined) {
    if (!Array.isArray(value.pendingManualIntegration)) return false;
    const pendingValid = value.pendingManualIntegration.every(
      (p) =>
        p &&
        typeof p === "object" &&
        typeof p.dest === "string" &&
        p.dest.length > 0 &&
        typeof p.template === "string" &&
        p.template.length > 0 &&
        typeof p.reason === "string" &&
        p.reason.length > 0,
    );
    if (!pendingValid) return false;
  }
  // `manualIntegrationAcknowledgements` (issue #153) is optional for the same reason as the two
  // fields above (an older or hand-authored manifest may predate it). Each entry binds an
  // ownership-preserving manual-integration attestation to the exact target content it covers —
  // `acknowledgedTargetSha256` must be a real sha256 hex digest, not a timeless boolean, or a
  // later-changed bridge target could never be told apart from the one actually integrated.
  if (value.manualIntegrationAcknowledgements !== undefined) {
    if (!Array.isArray(value.manualIntegrationAcknowledgements)) return false;
    const acknowledgementsValid = value.manualIntegrationAcknowledgements.every(
      (a) =>
        a &&
        typeof a === "object" &&
        typeof a.dest === "string" &&
        a.dest.length > 0 &&
        typeof a.template === "string" &&
        a.template.length > 0 &&
        typeof a.acknowledgedTargetSha256 === "string" &&
        SHA256_HEX.test(a.acknowledgedTargetSha256) &&
        typeof a.acknowledgedAt === "string" &&
        a.acknowledgedAt.length > 0,
    );
    if (!acknowledgementsValid) return false;
  }
  return true;
}

// lstatSync wrapped to distinguish "genuinely nothing there" (ENOENT) from every other
// outcome, including a dangling symlink: lstatSync succeeds on a dangling symlink (it
// stats the link itself, not its missing target), so using existsSync — which follows
// symlinks and reports false for a dangling one — to decide whether to lstat at all would
// let a dangling symlink slip through as "absent" and be silently written through anyway.
function lstatOrNull(absPath) {
  try {
    return lstatSync(absPath);
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

// .ldl/ is LDL's own managed namespace (the manifest, and sometimes the derived AGENTS.md
// template) — findUnsafeDestReason() above only guards the MANAGED_ITEMS-derived ops, so
// without this separate check a pre-existing .ldl symlink (dangling or not) or a symlinked
// manifest.json leaf could redirect the manifest write or the stale-template delete
// outside --dest, and a pre-existing .ldl *file* would only be discovered when the final
// mkdirSync() throws, after every other managed file had already been written — a
// partial, unmanifested install. Checking this once, before anything else runs, fails the
// whole run closed instead of partially.
// Exported so tools/ldl-update guards its own .ldl/manifest.json read+rewrite against the
// same symlink/non-directory hazards, before reading any existing provenance.
export function findUnsafeLdlDirReason(destRoot) {
  const dirAbs = join(destRoot, ".ldl");
  const dirSt = lstatOrNull(dirAbs);
  if (dirSt) {
    if (dirSt.isSymbolicLink()) {
      return "existing symlink at .ldl — refusing to write LDL's own managed state through it";
    }
    if (!dirSt.isDirectory()) {
      return "existing non-directory at .ldl — cannot use it as LDL's managed directory";
    }
  }
  const manifestSt = lstatOrNull(join(dirAbs, "manifest.json"));
  if (manifestSt && manifestSt.isSymbolicLink()) {
    return "existing symlink at .ldl/manifest.json — refusing to write LDL's own manifest through it";
  }
  return null;
}

// `resolveRevisionImpl` and `now` are injected so tests get deterministic manifest output
// without depending on this process's own git state or wall-clock time.
export async function run(args, deps = {}) {
  const { resolveRevisionImpl = defaultResolveRevision, now = () => new Date().toISOString() } = deps;

  if (!args.dest) {
    return { exitCode: 1, message: "Missing required arg: --dest <path-to-consumer-repo>" };
  }

  const root = args.root || LDL_ROOT;
  const destRoot = args.dest;

  if (!existsSync(destRoot) || !statSync(destRoot).isDirectory()) {
    return { exitCode: 1, message: `--dest does not exist or is not a directory: ${destRoot}` };
  }

  const unsafeLdlReason = findUnsafeLdlDirReason(destRoot);
  if (unsafeLdlReason) {
    return { exitCode: 1, message: `Refusing to run: ${unsafeLdlReason}` };
  }

  const manifestPath = join(destRoot, ".ldl", "manifest.json");
  let existingManifest = null;
  if (existsSync(manifestPath)) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (err) {
      return { exitCode: 1, message: `existing .ldl/manifest.json is not valid JSON: ${err.message}` };
    }
    existingManifest = isValidManifest(parsed) ? parsed : null;
  }

  let ops;
  try {
    ops = buildOps(root);
  } catch (err) {
    return { exitCode: 1, message: `failed reading managed items from --root ${root}: ${err.message}` };
  }

  // AGENTS.md and CLAUDE.md are each derived/copied from source content but their
  // destinations depend on consumer repository state (does the consumer already have one, and
  // if so, did LDL install it?) — see docs/consumer-contract.md, "The AGENTS.md and CLAUDE.md
  // special case".
  let bridgePlans, bridgeOps, resolvedManifestPatch;
  try {
    ({ bridgePlans, bridgeOps, resolvedManifestPatch } = planBridges({ root, destRoot, existingManifest }));
  } catch (err) {
    return { exitCode: 1, message: `failed deriving consumer bridge file: ${err.message}` };
  }
  ops.push(...bridgeOps);

  // If a prior run parked a bridge's derived template at its templateDestRel (because the
  // consumer had its own file at the time) and this run is now installing straight to the
  // bridge's own destRel instead (the consumer's own file is gone, or its content now matches
  // the target — see planBridgeOp's resolvedByContentMatch), the old template is superseded —
  // remove it so it doesn't linger on disk unrecorded by the new manifest.
  for (const { bridge, op } of bridgePlans) {
    const previousTemplateFile = existingManifest?.files?.some((f) => f.dest === bridge.templateDestRel);
    if (op.destRel === bridge.destRel && previousTemplateFile) {
      const staleTemplatePath = join(destRoot, ...bridge.templateDestRel.split("/"));
      if (existsSync(staleTemplatePath)) {
        rmSync(staleTemplatePath);
      }
    }
  }

  // Bridges planBridgeOp resolved by content match must be treated as LDL-managed by
  // planInstall's own ownership check even though existingManifest doesn't yet record them —
  // see withResolvedBridgesManaged's own comment. Only affects this local copy; existingManifest
  // itself (already consulted above) is left untouched.
  const { toInstall, toSkip } = planInstall({
    ops,
    destRoot,
    existingManifest: withResolvedBridgesManaged(existingManifest, resolvedManifestPatch),
  });
  const installedFiles = applyInstall(toInstall, destRoot).sort((a, b) => a.dest.localeCompare(b.dest));

  // Computed from the actual install outcome (toSkip), not merely from planBridgeOp's
  // destination choice — see derivePendingManualIntegration's own comment for why a
  // destRel-only check would miss an uninstalled bridge. Carries forward any existing
  // manualIntegrationAcknowledgements (issue #153) so a repeat/reinit run against an
  // already-acknowledged bridge doesn't re-open pendingManualIntegration for it.
  const manualIntegrationAcknowledgements = existingManifest?.manualIntegrationAcknowledgements || [];
  const pendingManualIntegration = derivePendingManualIntegration(bridgePlans, toSkip, manualIntegrationAcknowledgements);

  const manifest = {
    schemaVersion: 1,
    ldlSourceRevision: resolveRevisionImpl(root),
    installedAt: now(),
    files: installedFiles,
    skipped: toSkip,
    pendingManualIntegration,
    manualIntegrationAcknowledgements,
  };

  mkdirSync(join(destRoot, ".ldl"), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  return {
    exitCode: 0,
    message: JSON.stringify({
      installed: manifest.files.length,
      skipped: manifest.skipped.length,
      manualIntegrationNeeded: manifest.pendingManualIntegration.length,
      revision: manifest.ldlSourceRevision,
      manifestPath: ".ldl/manifest.json",
    }),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await run(args);
  if (result.exitCode === 0) {
    console.log(result.message);
  } else {
    console.error(result.message);
  }
  process.exit(result.exitCode);
}

// Only run as a CLI when this exact file is the process entrypoint, not merely when some
// other script's argv[1] happens to end in "index.mjs" — tools/ldl-update/index.mjs is
// itself invoked as `node .../index.mjs`, so a suffix check here would run this module's
// own main() (installing/overwriting managed files, then calling process.exit()) as a side
// effect of tools/ldl-update simply importing this module's helpers.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
