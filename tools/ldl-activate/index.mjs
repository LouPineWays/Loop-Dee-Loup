#!/usr/bin/env node
// Deterministic, explicit activation mechanism for issue #282: turns on an optional,
// consumer-owned LDL integration (today, only the #274 automated consumer-sync/review
// lifecycle) without a human hand-copying and adapting YAML out of documentation. See
// docs/consumer-contract.md, "Optional integration activation", for the full ownership
// boundary this script implements, and tools/ldl-init/index.mjs / tools/ldl-update/index.mjs
// for the sibling install/update mechanisms this one deliberately does not modify.
//
// Usage (run from a local clone of Loop-Dee-Loup, against an already-`tools/ldl-init`-
// bootstrapped consumer repository):
//   node tools/ldl-activate/index.mjs --dest <path-to-consumer-repo> --capability <id>
//   node tools/ldl-activate/index.mjs --list
//
// --dest must already have a valid .ldl/manifest.json — this mechanism has nothing to
// activate against otherwise (same requirement as tools/ldl-update, and for the same
// reason: it needs durable provenance of what's already installed/activated to compare
// against). --list requires no --dest and simply enumerates the capabilities this script
// knows how to activate. --root overrides the Loop-Dee-Loup source root (defaults to this
// script's own repository) and exists mainly so tests can point at a disposable fixture
// instead of this repository's real, changing docs/consumer-contract.md content.
//
// What it does, each run against a real --capability:
//   1. Extracts the capability's canonical file content straight out of
//      docs/consumer-contract.md's own fenced example-workflow blocks (see
//      extractExampleWorkflowYaml below) — there is exactly one copy of this content, ever;
//      this script never carries a second, independently-drifting template copy.
//   2. Classifies every target file against --dest's on-disk state and, if this capability
//      was already activated there, the provenance hash this script itself recorded last
//      time (see planCapabilityFile): already active and current, safely updatable (locally
//      untouched since activation), a genuine local-vs-upstream conflict, or a pre-existing
//      consumer-owned file that must be parked for manual review instead of overwritten.
//   3. Refuses the whole run — writing nothing — if any file lands in conflict, the same
//      fail-closed guarantee tools/ldl-update already gives MANAGED_ITEMS content.
//   4. Otherwise installs/updates whatever is safe to install/update, parks whatever
//      collides with an unrelated pre-existing consumer file, and records the outcome in
//      `.ldl/manifest.json`'s `activatedCapabilities` array (never touching
//      `ldlSourceRevision`/`installedAt`/`files`, which remain tools/ldl-init's and
//      tools/ldl-update's own fields) and `pendingManualIntegration` (shared with the
//      AGENTS.md/CLAUDE.md bridge mechanism, so every "needs a human" fact lives in one
//      place).
//
// Re-running this with the same --capability after --root's docs/consumer-contract.md
// content changes is how an already-activated integration picks up an upstream correction
// (issue #282 requirement 7's chosen model — a deterministic re-apply command, not a second
// ldl-update-integrated ownership path): it detects local divergence via the same 3-way
// hash comparison tools/ldl-update already uses for MANAGED_ITEMS, and refuses unsafe
// overwrite exactly the same way. tools/ldl-update/index.mjs's planUpdate() and conflict
// logic are entirely untouched by this file.
//
// Tests: node --test tools/ldl-activate/index.test.mjs

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  contentMatchesHash,
  deriveActivatedCapabilityReminder,
  findUnsafeDestReason,
  findUnsafeLdlDirReason,
  isValidManifest,
  normalizeLineEndings,
  parseArgs,
  pendingIntegrationListsEqual,
  sha256,
} from "../ldl-init/index.mjs";

export { parseArgs };

// Re-exported so a caller reasoning about capability activation can import this reminder from
// here instead of tools/ldl-init/index.mjs, where it actually lives (alongside
// deriveSyncPrerequisiteWarnings, the other cross-cutting warning derived from manifest state —
// see its own comment there for why).
export { deriveActivatedCapabilityReminder };

const LDL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Extracts the fenced ````yaml ... ```` block that immediately follows the first
// "### Example workflow" heading appearing after `sectionHeading` (an exact "## ..." line)
// in docText, bounded by the next "## " heading (or end of file). docs/consumer-contract.md
// deliberately uses four-backtick fences for these two blocks (see that file's own
// surrounding prose) so a real triple-backtick fence inside the workflow's own step-summary
// heredoc content can't prematurely close the outer fence — this only ever matches that
// specific four-backtick marker, never an ordinary triple-backtick fence that might appear
// elsewhere in the section's prose.
export function extractExampleWorkflowYaml(docText, sectionHeading) {
  const sectionIdx = docText.indexOf(sectionHeading);
  if (sectionIdx === -1) throw new Error(`section heading not found in doc: ${sectionHeading}`);
  const nextSectionIdx = docText.indexOf("\n## ", sectionIdx + sectionHeading.length);
  const sectionEnd = nextSectionIdx === -1 ? docText.length : nextSectionIdx;
  const section = docText.slice(sectionIdx, sectionEnd);
  const fenceStart = section.indexOf("````yaml");
  if (fenceStart === -1) throw new Error(`no fenced yaml example workflow found under heading: ${sectionHeading}`);
  const contentStart = section.indexOf("\n", fenceStart) + 1;
  const fenceEnd = section.indexOf("\n````", contentStart);
  if (fenceEnd === -1) throw new Error(`unterminated fenced yaml block under heading: ${sectionHeading}`);
  return section.slice(contentStart, fenceEnd + 1);
}

// The one capability this mechanism activates today (issue #282's proven-capability scope:
// the #274 consumer-sync/review lifecycle). Each entry's `files` names every consumer-owned
// destination this capability installs and the docs/consumer-contract.md section whose
// fenced example workflow is that destination's single source of truth — see
// extractExampleWorkflowYaml above. Adding a second capability later is a data change here,
// not a mechanism change.
export const CAPABILITIES = [
  {
    id: "consumer-sync",
    description:
      "Installs the two consumer-owned GitHub Actions workflows documented in " +
      "docs/consumer-contract.md (\"Automated consumer sync\" and \"Automated Stage 1 and " +
      "merge-ready bookkeeping\"): the scheduled sync that opens/updates an LDL update PR, and " +
      "the review-gate bookkeeping (issue #274) that takes that PR from a founder's `@codex " +
      "review` comment to the visible ldl-sync/merge-ready status without a local terminal or " +
      "coding-agent session. Activating this is what closes the gap YouTubery PR #100 hit: " +
      "the reusable tools/ldl-sync/** helper scripts synced normally, but the consumer-owned " +
      "workflow wiring that actually invokes them was never installed, so the new review " +
      "bookkeeping never activated.",
    files: [
      { destRel: ".github/workflows/ldl-sync.yml", sectionHeading: "## Automated consumer sync" },
      { destRel: ".github/workflows/ldl-sync-review.yml", sectionHeading: "## Automated Stage 1 and merge-ready bookkeeping" },
    ],
  },
];

export function findCapability(id) {
  return CAPABILITIES.find((c) => c.id === id) || null;
}

// Reads --root's docs/consumer-contract.md once and extracts every one of `capability`'s
// target files' canonical content out of it. Normalized through normalizeLineEndings for the
// same reason tools/ldl-init's buildOps() normalizes MANAGED_ITEMS content: a maintainer's
// own checkout line-ending config (e.g. Windows core.autocrlf) must never leak into what this
// script treats as canonical source truth.
export function buildCapabilityOps(root, capability) {
  const docText = readFileSync(join(root, "docs", "consumer-contract.md"), "utf8");
  return capability.files.map((f) => ({
    destRel: f.destRel,
    content: normalizeLineEndings(Buffer.from(extractExampleWorkflowYaml(docText, f.sectionHeading), "utf8")),
  }));
}

// Classifies one capability file against destRoot's on-disk state and, when this exact
// destRel is already recorded as activated for this capability, its recorded provenance hash.
// `activatedFileRecord` is the {dest, sha256} entry from an existing
// manifest.activatedCapabilities[].files for this destRel, or undefined when this file has
// never been activated at this destination before.
export function planCapabilityFile({ destRel, content, destRoot, activatedFileRecord, capabilityId }) {
  const unsafeReason = findUnsafeDestReason(destRoot, destRel);
  if (unsafeReason) {
    // A never-activated destRel with an unsafe path used to be classified "skip-unsafe" and
    // silently dropped by run() below (Stage 1 review finding on this mechanism's own PR,
    // #284): the caller would report exit 0/noop:true with no record of why nothing happened —
    // e.g. `.github` replaced by a symlink after bootstrap made activation look like a clean
    // no-op instead of the refusal it actually needed to be. Every unsafe-path hazard this
    // function finds is now a "conflict", so run() refuses the whole activation up front (before
    // writing anything) and reports exactly why, the same fail-closed treatment already applied
    // to an unsafe path under an already-activated file just below.
    return {
      action: "conflict",
      destRel,
      reason: activatedFileRecord
        ? `${unsafeReason} — this path was previously activated and is not safe to update`
        : `${unsafeReason} — refusing to activate this capability`,
    };
  }

  const absDest = join(destRoot, destRel);
  const targetHash = sha256(content);
  const exists = existsSync(absDest);

  if (activatedFileRecord) {
    if (!exists) {
      return { action: "conflict", destRel, reason: "previously activated file is missing locally (deleted since activation)" };
    }
    const currentRaw = readFileSync(absDest);
    if (contentMatchesHash(currentRaw, targetHash)) {
      return { action: "unchanged", destRel, sha256: targetHash };
    }
    if (contentMatchesHash(currentRaw, activatedFileRecord.sha256)) {
      return { action: "update", destRel, content };
    }
    return {
      action: "conflict",
      destRel,
      reason: "locally modified since activation (current content matches neither the recorded provenance nor the current target content)",
    };
  }

  if (!exists) {
    return { action: "install", destRel, content };
  }
  const currentRaw = readFileSync(absDest);
  if (contentMatchesHash(currentRaw, targetHash)) {
    // Already byte-identical to the canonical content even though this destination was never
    // recorded as activated (e.g. hand-copied from the doc before this mechanism existed) —
    // recognize it as active rather than parking a redundant proposal, mirroring
    // tools/ldl-init's planBridgeOp's own resolvedByContentMatch graduation.
    return { action: "unchanged", destRel, sha256: targetHash };
  }
  const templateDestRel = `.ldl/templates/${capabilityId}/${destRel.split("/").pop()}`;
  // The park destination itself must be safe to write through, checked here — before this plan
  // is ever returned — rather than at write time (Stage 1 review finding on this mechanism's
  // own PR, #284). run() below refuses the whole activation on any "conflict" plan before
  // writing anything for any file, so classifying an unsafe park target as a conflict here
  // guarantees it is caught in that same pre-write pass; discovering it only when run() actually
  // tried to write the template could otherwise leave an earlier file in the same run already
  // written (a partial, unmanifested activation) or — worse — silently write the proposed
  // workflow content through a symlink to somewhere outside destRoot entirely.
  const unsafeTemplateReason = findUnsafeDestReason(destRoot, templateDestRel);
  if (unsafeTemplateReason) {
    return {
      action: "conflict",
      destRel,
      reason: `cannot park a proposed ${templateDestRel} for manual review: ${unsafeTemplateReason}`,
    };
  }
  return {
    action: "park",
    destRel,
    templateDestRel,
    content,
    reason: `a pre-existing ${destRel} was not overwritten — review ${templateDestRel} and merge it in by hand to activate this capability`,
  };
}

// Order-independent comparison of two capability `files` arrays ({dest, sha256} pairs), the
// same style as tools/ldl-update's own skipListsEqual/pendingIntegrationListsEqual, used to
// decide whether this run's own capability record actually changed.
function fileListsEqual(a, b) {
  const normalize = (list) => JSON.stringify(list.map((f) => [f.dest, f.sha256]).sort((x, y) => x[0].localeCompare(y[0])));
  return normalize(a) === normalize(b);
}

// `now` is injected so tests get deterministic manifest output without depending on this
// process's own wall-clock time, matching tools/ldl-init's and tools/ldl-update's own `now`
// injection convention.
export async function run(args, deps = {}) {
  const { now = () => new Date().toISOString() } = deps;

  if (Object.prototype.hasOwnProperty.call(args, "list")) {
    return {
      exitCode: 0,
      message: JSON.stringify({ capabilities: CAPABILITIES.map(({ id, description }) => ({ id, description })) }),
    };
  }

  if (!args.dest) {
    return { exitCode: 1, message: "Missing required arg: --dest <path-to-consumer-repo> (or use --list)" };
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

  const knownIds = CAPABILITIES.map((c) => c.id).join(", ");
  if (!args.capability) {
    return { exitCode: 1, message: `Missing required arg: --capability <id>. Known capabilities: ${knownIds}` };
  }
  const capability = findCapability(args.capability);
  if (!capability) {
    return { exitCode: 1, message: `Unknown capability "${args.capability}". Known capabilities: ${knownIds}` };
  }

  const manifestPath = join(destRoot, ".ldl", "manifest.json");
  if (!existsSync(manifestPath)) {
    return {
      exitCode: 1,
      message: "No .ldl/manifest.json found in --dest — run tools/ldl-init first; there is nothing to activate against.",
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return { exitCode: 1, message: `existing .ldl/manifest.json is not valid JSON: ${err.message}` };
  }
  if (!isValidManifest(manifest)) {
    return {
      exitCode: 1,
      message: "existing .ldl/manifest.json is not in the expected shape — run tools/ldl-init to reinitialize before activating.",
    };
  }

  let ops;
  try {
    ops = buildCapabilityOps(root, capability);
  } catch (err) {
    return { exitCode: 1, message: `failed deriving capability "${capability.id}" content from --root ${root}: ${err.message}` };
  }

  const existingCapEntry = (manifest.activatedCapabilities || []).find((c) => c.id === capability.id);

  const plans = ops.map((op) =>
    planCapabilityFile({
      destRel: op.destRel,
      content: op.content,
      destRoot,
      activatedFileRecord: existingCapEntry?.files.find((f) => f.dest === op.destRel),
      capabilityId: capability.id,
    }),
  );

  const conflicts = plans.filter((p) => p.action === "conflict");
  const parked = plans.filter((p) => p.action === "park");
  const unchanged = plans.filter((p) => p.action === "unchanged");
  const toWrite = plans.filter((p) => p.action === "install" || p.action === "update");

  if (conflicts.length > 0) {
    const detail = conflicts.map((c) => `${c.destRel} (${c.reason})`).join("; ");
    return {
      exitCode: 1,
      message: `Refusing to activate: ${conflicts.length} file(s) cannot be safely reconciled: ${detail}`,
    };
  }

  let installedCount = 0;
  let updatedCount = 0;
  const writtenFiles = [];
  for (const p of toWrite) {
    const absDest = join(destRoot, p.destRel);
    mkdirSync(dirname(absDest), { recursive: true });
    writeFileSync(absDest, p.content);
    writtenFiles.push({ dest: p.destRel, sha256: sha256(p.content) });
    if (p.action === "install") installedCount++;
    else updatedCount++;
  }

  // A parked template's provenance is tracked via `parkedSha256` on its pendingManualIntegration
  // entry (issue #282 Stage 1 review finding on this mechanism's own PR, #284): without it, an
  // operator who starts hand-adapting a parked template (e.g. filling in project-specific
  // details before merging it into the conflicting consumer file) would have that edit silently
  // discarded the next time this capability's upstream doc content changes and activation
  // re-runs, because nothing distinguished "still exactly what we last wrote" from "a human has
  // touched this since." Three cases per parked file:
  //   - no template on disk yet -> write it, record the new content's hash as parkedSha256;
  //   - on-disk content already matches the *current* target -> nothing to do (whether it was
  //     just written, or a human already brought it in line with upstream by hand);
  //   - on-disk content differs from the target but matches the *previously recorded*
  //     parkedSha256 -> untouched since this mechanism last wrote it, safe to refresh;
  //   - anything else (on-disk content matches neither, or there is no prior recorded hash to
  //     compare against) -> treat as a local edit and leave it alone; the previously recorded
  //     parkedSha256 (or, if this is the first time provenance was ever tracked for it, the
  //     current on-disk hash) is preserved as-is rather than advanced to the new target, so the
  //     divergence keeps being reported on every subsequent run until the operator actually
  //     resolves the underlying conflict at `destRel` (the real activation success condition —
  //     not merely a settled parked template).
  let parkedChangedCount = 0;
  const parkedProvenanceByDestRel = new Map();
  const existingPendingByDest = new Map((manifest.pendingManualIntegration || []).map((p) => [p.dest, p]));
  for (const p of parked) {
    const absTemplate = join(destRoot, p.templateDestRel);
    const existingEntry = existingPendingByDest.get(p.destRel);
    const targetTemplateHash = sha256(p.content);
    let onDiskRaw = null;
    if (existsSync(absTemplate)) {
      try {
        onDiskRaw = readFileSync(absTemplate);
      } catch {
        onDiskRaw = null; // unreadable (e.g. a directory) — treated as "no template on disk" below
      }
    }

    if (onDiskRaw === null) {
      mkdirSync(dirname(absTemplate), { recursive: true });
      writeFileSync(absTemplate, p.content);
      parkedChangedCount++;
      parkedProvenanceByDestRel.set(p.destRel, { parkedSha256: targetTemplateHash, locallyModified: false });
    } else if (contentMatchesHash(onDiskRaw, targetTemplateHash)) {
      parkedProvenanceByDestRel.set(p.destRel, { parkedSha256: targetTemplateHash, locallyModified: false });
    } else if (existingEntry?.parkedSha256 && contentMatchesHash(onDiskRaw, existingEntry.parkedSha256)) {
      writeFileSync(absTemplate, p.content);
      parkedChangedCount++;
      parkedProvenanceByDestRel.set(p.destRel, { parkedSha256: targetTemplateHash, locallyModified: false });
    } else {
      parkedProvenanceByDestRel.set(p.destRel, {
        parkedSha256: existingEntry?.parkedSha256 || sha256(onDiskRaw),
        locallyModified: true,
      });
    }
  }
  const parkedLocallyModifiedCount = [...parkedProvenanceByDestRel.values()].filter((v) => v.locallyModified).length;

  // A parked file is deliberately excluded here — it never joins the capability's own managed
  // files[] set, exactly as a parked bridge template never joins tools/ldl-init's manifest
  // `files[]` (see tools/ldl-init's planBridgeOp/derivePendingManualIntegration).
  const newFiles = [...unchanged.map((u) => ({ dest: u.destRel, sha256: u.sha256 })), ...writtenFiles].sort((a, b) =>
    a.dest.localeCompare(b.dest),
  );

  // pendingManualIntegration is shared state with the AGENTS.md/CLAUDE.md bridge mechanism
  // (tools/ldl-init/tools/ldl-update) — this run only ever touches the entries whose `dest`
  // belongs to *this* capability's own target file set, re-evaluating them fresh each run and
  // leaving every bridge-file or other-capability entry completely untouched.
  const capabilityDestRels = new Set(ops.map((op) => op.destRel));
  const filteredPending = (manifest.pendingManualIntegration || []).filter((p) => !capabilityDestRels.has(p.dest));
  const newPendingEntries = parked.map((p) => {
    const provenance = parkedProvenanceByDestRel.get(p.destRel);
    return {
      dest: p.destRel,
      template: p.templateDestRel,
      parkedSha256: provenance.parkedSha256,
      reason: provenance.locallyModified
        ? `${p.reason} (note: ${p.templateDestRel} has been locally modified since it was parked and was left untouched even though the canonical content may have changed upstream — resolve manually)`
        : p.reason,
    };
  });
  const pendingManualIntegration = [...filteredPending, ...newPendingEntries];

  const activatedAt = existingCapEntry?.activatedAt || now();
  const newCapEntry = { id: capability.id, activatedAt, files: newFiles };
  const activatedCapabilities = [...(manifest.activatedCapabilities || []).filter((c) => c.id !== capability.id), newCapEntry];

  const nothingWritten = writtenFiles.length === 0 && parkedChangedCount === 0;
  const filesUnchanged = fileListsEqual(newFiles, existingCapEntry?.files || []);
  const pendingUnchanged = pendingIntegrationListsEqual(pendingManualIntegration, manifest.pendingManualIntegration || []);
  const noop = nothingWritten && filesUnchanged && pendingUnchanged;

  if (noop) {
    // Predictable no-op, mirroring tools/ldl-update: leave .ldl/manifest.json completely
    // untouched rather than rewriting it to say nothing changed.
    return {
      exitCode: 0,
      message: JSON.stringify({
        capability: capability.id,
        installed: 0,
        updated: 0,
        unchanged: unchanged.length,
        parked: parked.length,
        parkedLocallyModified: parkedLocallyModifiedCount,
        pendingManualIntegration: (manifest.pendingManualIntegration || []).length,
        noop: true,
      }),
    };
  }

  // Every other top-level field (schemaVersion, ldlSourceRevision, installedAt, files,
  // skipped, manualIntegrationAcknowledgements, and any other capability's own
  // activatedCapabilities entry) is carried forward completely unchanged — activation is not
  // an install or an update, and must not touch fields tools/ldl-init/tools/ldl-update own.
  const updatedManifest = { ...manifest, activatedCapabilities, pendingManualIntegration };
  writeFileSync(manifestPath, JSON.stringify(updatedManifest, null, 2) + "\n");

  return {
    exitCode: 0,
    message: JSON.stringify({
      capability: capability.id,
      installed: installedCount,
      updated: updatedCount,
      unchanged: unchanged.length,
      parked: parked.length,
      parkedLocallyModified: parkedLocallyModifiedCount,
      pendingManualIntegration: pendingManualIntegration.length,
      noop: false,
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
// other script's argv[1] happens to end in "index.mjs" — see the matching guard in
// tools/ldl-init/index.mjs for why a suffix check on argv[1] is unsafe here too.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
