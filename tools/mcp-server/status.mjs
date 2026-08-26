// Read-only LDL consumer-repository status computation for issue #110. Deliberately does
// not reimplement drift/conflict detection: it calls the exact same planUpdate() that
// tools/ldl-update/index.mjs's run() uses to decide what it would write, just without ever
// calling applyInstall/writeFileSync. Keeping status and update on one shared code path is
// the point — see docs/mcp-server.md and the "Reuse existing synchronization logic"
// section of issue #110.
//
// Tests: node --test tools/mcp-server/status.test.mjs

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  buildOps,
  defaultResolveRevision,
  derivePendingManualIntegration,
  findUnsafeDestReason,
  findUnsafeLdlDirReason,
  isValidManifest,
  planBridges,
  withResolvedBridgesManaged,
} from "../ldl-init/index.mjs";
import { contentMatchesHash, pendingIntegrationListsEqual, planUpdate, skipListsEqual } from "../ldl-update/index.mjs";

// Mirrors the {toInstall, supersededTemplates, skipSetChanged, pendingIntegrationChanged} =>
// no-op decision inside tools/ldl-update's run(), computed here read-only so a status check
// and a real update agree on what counts as "nothing to do" without a second implementation
// of that rule.
function planStatusUpdate({ ops, destRoot, existingManifest, bridgePlans, resolvedManifestPatch }) {
  const { toInstall, toSkip, conflicts, unchangedFiles } = planUpdate({
    ops,
    destRoot,
    existingManifest: withResolvedBridgesManaged(existingManifest, resolvedManifestPatch),
  });

  // Mirrors tools/ldl-update's own supersession check exactly, including the symlink/blocking-
  // path guard (Stage 2 audit finding on PR #131): without it, a template path replaced by a
  // symlink whose target content happens to hash-match the recorded template hash would be
  // misclassified as safely superseded instead of reported as a conflict, so status would claim
  // "current"/"outdated" over a repository ldl_update would actually refuse.
  const supersededTemplates = [];
  for (const { bridge, op } of bridgePlans) {
    const previousTemplateEntry = existingManifest.files.find((f) => f.dest === bridge.templateDestRel);
    if (op.destRel !== bridge.destRel || !previousTemplateEntry) continue;
    const unsafeTemplateReason = findUnsafeDestReason(destRoot, bridge.templateDestRel);
    if (unsafeTemplateReason) {
      conflicts.push({
        dest: bridge.templateDestRel,
        reason: `${unsafeTemplateReason} — this path was previously LDL-managed and is not safe to update`,
      });
      continue;
    }
    const staleTemplatePath = join(destRoot, ...bridge.templateDestRel.split("/"));
    if (!existsSync(staleTemplatePath)) {
      supersededTemplates.push(bridge.templateDestRel);
    } else if (contentMatchesHash(readFileSync(staleTemplatePath), previousTemplateEntry.sha256)) {
      supersededTemplates.push(bridge.templateDestRel);
    } else {
      conflicts.push({
        dest: bridge.templateDestRel,
        reason: `locally modified since install and now superseded by ${bridge.destRel} — refusing to discard the local edit`,
      });
    }
  }

  // Computed from the actual toInstall/toSkip outcome, not merely from planBridgeOp's
  // destination choice — see derivePendingManualIntegration's own comment. Passes the
  // manifest's own manualIntegrationAcknowledgements (issue #153) so status agrees with
  // tools/ldl-update's own no-op/pending determination for an acknowledged bridge, rather than
  // reporting it pending again from a read-only path ldl_update itself would not re-flag.
  const pendingManualIntegration = derivePendingManualIntegration(bridgePlans, toSkip, existingManifest.manualIntegrationAcknowledgements || []);

  const skipSetChanged = !skipListsEqual(toSkip, existingManifest.skipped || []);
  const pendingIntegrationChanged = !pendingIntegrationListsEqual(pendingManualIntegration, existingManifest.pendingManualIntegration || []);
  const isNoop = toInstall.length === 0 && supersededTemplates.length === 0 && !skipSetChanged && !pendingIntegrationChanged;

  return { toInstall, toSkip, conflicts, unchangedFiles, isNoop, supersededTemplates, pendingManualIntegration };
}

// Single loader shared by computeStatus() (compact summary) and computeUpdatePlan() (path-
// level evidence for server.mjs's ldl_update tool) — exactly one place reads a manifest,
// builds ops, and plans against them, per issue #110's "no second implementation" boundary.
// Returns a discriminated result instead of throwing: `kind` is "error" (dest missing, unsafe
// namespace, corrupt manifest, or any other failure), "not_initialized", or "plan" (the full
// planStatusUpdate() output plus the parsed manifest and target revision). Deliberately does
// not catch exceptions raised by its own steps (buildOps, readFileSync, planStatusUpdate,
// etc.) — every caller is required to run this inside its own try/catch, which is what makes
// the per-repository error isolation guarantee independent of which internal step happens to
// throw, rather than a list of individually wrapped call sites that a future change could
// silently fall outside of.
function loadPlan({ dest, root }, deps = {}) {
  const { resolveRevisionImpl = defaultResolveRevision } = deps;

  if (!dest) {
    return { kind: "error", dest: dest ?? null, error: "missing required field: dest" };
  }
  if (!existsSync(dest) || !statSync(dest).isDirectory()) {
    return { kind: "error", dest, error: `dest does not exist or is not a directory: ${dest}` };
  }

  const sourceRevision = resolveRevisionImpl(root);

  // Same guard tools/ldl-init and tools/ldl-update apply before ever reading provenance: a
  // symlinked .ldl (or manifest.json), or a non-directory sitting at .ldl, could otherwise
  // read through to somewhere outside dest. Refusing here keeps status's "safe to
  // synchronize" claim consistent with what ldl_update would actually do against the same
  // repository, instead of reporting current/outdated over an unsafe namespace ldl_update
  // would refuse outright.
  const unsafeLdlReason = findUnsafeLdlDirReason(dest);
  if (unsafeLdlReason) {
    return { kind: "error", dest, error: `Refusing to read: ${unsafeLdlReason}` };
  }

  const manifestPath = join(dest, ".ldl", "manifest.json");
  if (!existsSync(manifestPath)) {
    return { kind: "not_initialized", dest, sourceRevision };
  }

  let parsedManifest;
  try {
    parsedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return { kind: "error", dest, error: `existing .ldl/manifest.json is not valid JSON: ${err.message}` };
  }
  if (!isValidManifest(parsedManifest)) {
    return {
      kind: "not_initialized",
      dest,
      sourceRevision,
      note: "existing .ldl/manifest.json is not in the expected shape — treated as uninitialized",
    };
  }

  const ops = buildOps(root);
  const { bridgePlans, bridgeOps, resolvedManifestPatch } = planBridges({ root, destRoot: dest, existingManifest: parsedManifest });
  ops.push(...bridgeOps);

  const { toInstall, toSkip, conflicts, unchangedFiles, isNoop, supersededTemplates, pendingManualIntegration } = planStatusUpdate({
    ops,
    destRoot: dest,
    existingManifest: parsedManifest,
    bridgePlans,
    resolvedManifestPatch,
  });

  return {
    kind: "plan",
    dest,
    sourceRevision,
    parsedManifest,
    toInstall,
    toSkip,
    conflicts,
    unchangedFiles,
    isNoop,
    supersededTemplates,
    pendingManualIntegration,
  };
}

// Given one consumer repository path, returns a compact structured status equivalent to
// what tools/ldl-update would do if run against it right now, without writing anything.
// `deps.resolveRevisionImpl` is injectable for deterministic tests, matching the pattern
// tools/ldl-init and tools/ldl-update already use.
//
// The entire computation runs inside one try/catch: any exception anywhere in loadPlan() —
// not merely the couple of call sites a prior fix happened to wrap — becomes this
// repository's own {status: "error"} result. computeStatusAll() below additionally never
// lets a per-repository rejection propagate, so the per-repository independence guarantee
// holds even if a future change to loadPlan introduces a new throwing call this function
// itself somehow failed to catch.
export async function computeStatus({ dest, root }, deps = {}) {
  let plan;
  try {
    plan = loadPlan({ dest, root }, deps);
  } catch (err) {
    return { dest: dest ?? null, status: "error", error: err.message };
  }

  if (plan.kind === "error") {
    return { dest: plan.dest, status: "error", error: plan.error };
  }

  if (plan.kind === "not_initialized") {
    return {
      dest: plan.dest,
      status: "not_initialized",
      installedRevision: null,
      sourceRevision: plan.sourceRevision,
      updateAvailable: null,
      managedFileCount: 0,
      skippedFileCount: 0,
      conflicts: [],
      pendingManualIntegration: [],
      next: "ldl_init",
      ...(plan.note ? { note: plan.note } : {}),
    };
  }

  const status = plan.conflicts.length > 0 ? "conflict" : plan.isNoop ? "current" : "outdated";
  const next = status === "conflict" ? "manual_resolution" : status === "outdated" ? "ldl_update" : "none";

  return {
    dest: plan.dest,
    status,
    installedRevision: plan.parsedManifest.ldlSourceRevision,
    sourceRevision: plan.sourceRevision,
    updateAvailable: status === "outdated",
    managedFileCount: plan.parsedManifest.files.length,
    skippedFileCount: (plan.parsedManifest.skipped || []).length,
    conflicts: plan.conflicts.map((c) => ({ dest: c.dest, reason: c.reason })),
    // Surfaces any bridge file (AGENTS.md/CLAUDE.md) still parked at its template path
    // awaiting a manual merge into a consumer-owned file — see docs/consumer-contract.md,
    // "The AGENTS.md and CLAUDE.md special case". Independent of sync status: a repository can
    // be fully `current` while a bridge sits at its template indefinitely, which is expected
    // steady state, not a defect this field's presence should be read as reporting.
    //
    // Sourced from `plan.pendingManualIntegration` — the freshly recomputed value from this
    // call's own planStatusUpdate() — never from `plan.parsedManifest.pendingManualIntegration`
    // (the stale value the *existing* manifest happened to record). The two can legitimately
    // diverge: a manifest from before this field existed has none recorded at all even though a
    // bridge is genuinely parked at a template right now, and computeStatus must report that
    // real, current condition rather than silently reading it as fully resolved.
    pendingManualIntegration: plan.pendingManualIntegration.map((p) => ({
      dest: p.dest,
      template: p.template,
      reason: p.reason,
    })),
    next,
  };
}

// Cheap multi-repository status per issue #110 requirement 5: one bounded call, each
// repository resolved independently so one bad path doesn't fail the whole batch.
// Promise.allSettled (rather than Promise.all) is a deliberate second layer of the same
// guarantee computeStatus()'s own try/catch already provides — even a future computeStatus
// change that reintroduced an uncaught throw could not take the rest of the batch down with
// it, because a per-repository rejection is converted to that repository's own error result
// right here instead of rejecting the whole batch.
export async function computeStatusAll({ repos, root }, deps = {}) {
  const settled = await Promise.allSettled(repos.map((dest) => computeStatus({ dest, root }, deps)));
  return settled.map((outcome, i) =>
    outcome.status === "fulfilled"
      ? outcome.value
      : { dest: repos[i], status: "error", error: outcome.reason?.message ?? String(outcome.reason) },
  );
}

// Read-only "would this update do" plan for one repository, exposing the actual changed/
// skipped path lists (not just counts) so tools/mcp-server/server.mjs's ldl_update tool can
// report the compact structured evidence issue #110 requirement 3 asks for — previous
// revision, resulting revision, changed paths, skipped paths, conflicts — without
// reimplementing planUpdate()/planStatusUpdate() a second time. Runs the same loadPlan() used
// by computeStatus above; callers are responsible for their own try/catch, matching that
// function's contract.
export function computeUpdatePlan({ dest, root }, deps = {}) {
  return loadPlan({ dest, root }, deps);
}
