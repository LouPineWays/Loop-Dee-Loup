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
import { buildOps, defaultResolveRevision, deriveConsumerAgents, isValidManifest, sha256 } from "../ldl-init/index.mjs";
import { planUpdate, skipListsEqual } from "../ldl-update/index.mjs";

// Mirrors the {toInstall, supersedeTemplate, skipSetChanged} => no-op decision inside
// tools/ldl-update's run(), computed here read-only so a status check and a real update
// agree on what counts as "nothing to do" without a second implementation of that rule.
function planStatusUpdate({ ops, destRoot, existingManifest, agentsDestRel }) {
  const { toInstall, toSkip, conflicts, unchangedFiles } = planUpdate({ ops, destRoot, existingManifest });

  let supersedeTemplate = false;
  const previousTemplateEntry = existingManifest.files.find((f) => f.dest === ".ldl/AGENTS.template.md");
  if (agentsDestRel === "AGENTS.md" && previousTemplateEntry) {
    const staleTemplatePath = join(destRoot, ".ldl", "AGENTS.template.md");
    if (!existsSync(staleTemplatePath)) {
      supersedeTemplate = true;
    } else if (sha256(readFileSync(staleTemplatePath)) === previousTemplateEntry.sha256) {
      supersedeTemplate = true;
    } else {
      conflicts.push({
        dest: ".ldl/AGENTS.template.md",
        reason: "locally modified since install and now superseded by AGENTS.md — refusing to discard the local edit",
      });
    }
  }

  const skipSetChanged = !skipListsEqual(toSkip, existingManifest.skipped || []);
  const isNoop = toInstall.length === 0 && !supersedeTemplate && !skipSetChanged;

  return { toInstall, toSkip, conflicts, unchangedFiles, isNoop };
}

// Given one consumer repository path, returns a compact structured status equivalent to
// what tools/ldl-update would do if run against it right now, without writing anything.
// `deps.resolveRevisionImpl` is injectable for deterministic tests, matching the pattern
// tools/ldl-init and tools/ldl-update already use.
export async function computeStatus({ dest, root }, deps = {}) {
  const { resolveRevisionImpl = defaultResolveRevision } = deps;

  if (!dest) {
    return { dest: dest ?? null, status: "error", error: "missing required field: dest" };
  }
  if (!existsSync(dest) || !statSync(dest).isDirectory()) {
    return { dest, status: "error", error: `dest does not exist or is not a directory: ${dest}` };
  }

  const sourceRevision = resolveRevisionImpl(root);
  const manifestPath = join(dest, ".ldl", "manifest.json");

  if (!existsSync(manifestPath)) {
    return {
      dest,
      status: "not_initialized",
      installedRevision: null,
      sourceRevision,
      updateAvailable: null,
      managedFileCount: 0,
      skippedFileCount: 0,
      conflicts: [],
      next: "ldl_init",
    };
  }

  let parsedManifest;
  try {
    parsedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    return { dest, status: "error", error: `existing .ldl/manifest.json is not valid JSON: ${err.message}` };
  }
  if (!isValidManifest(parsedManifest)) {
    return {
      dest,
      status: "not_initialized",
      installedRevision: null,
      sourceRevision,
      updateAvailable: null,
      managedFileCount: 0,
      skippedFileCount: 0,
      conflicts: [],
      next: "ldl_init",
      note: "existing .ldl/manifest.json is not in the expected shape — treated as uninitialized",
    };
  }

  let ops;
  try {
    ops = buildOps(root);
  } catch (err) {
    return { dest, status: "error", error: `failed reading managed items from root ${root}: ${err.message}` };
  }

  let derivedAgents;
  try {
    derivedAgents = deriveConsumerAgents(readFileSync(join(root, "AGENTS.md"), "utf8"));
  } catch (err) {
    return { dest, status: "error", error: `failed deriving consumer AGENTS.md from root ${root}: ${err.message}` };
  }
  const agentsAlreadyManaged = parsedManifest.files.some((f) => f.dest === "AGENTS.md");
  const destAgentsExists = existsSync(join(dest, "AGENTS.md"));
  const agentsDestRel = !destAgentsExists || agentsAlreadyManaged ? "AGENTS.md" : ".ldl/AGENTS.template.md";
  ops.push({ destRel: agentsDestRel, content: Buffer.from(derivedAgents, "utf8") });

  const { conflicts, isNoop } = planStatusUpdate({ ops, destRoot: dest, existingManifest: parsedManifest, agentsDestRel });

  const status = conflicts.length > 0 ? "conflict" : isNoop ? "current" : "outdated";
  const next = status === "conflict" ? "manual_resolution" : status === "outdated" ? "ldl_update" : "none";

  return {
    dest,
    status,
    installedRevision: parsedManifest.ldlSourceRevision,
    sourceRevision,
    updateAvailable: status === "outdated",
    managedFileCount: parsedManifest.files.length,
    skippedFileCount: (parsedManifest.skipped || []).length,
    conflicts: conflicts.map((c) => ({ dest: c.dest, reason: c.reason })),
    next,
  };
}

// Cheap multi-repository status per issue #110 requirement 5: one bounded call, each
// repository resolved independently so one bad path doesn't fail the whole batch.
export async function computeStatusAll({ repos, root }, deps = {}) {
  return Promise.all(repos.map((dest) => computeStatus({ dest, root }, deps)));
}
