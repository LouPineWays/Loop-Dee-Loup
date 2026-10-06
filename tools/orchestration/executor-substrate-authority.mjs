#!/usr/bin/env node
// Deterministic executor-substrate classification + component-scoped authority check —
// issue #702 (docs/operating-model.md § Executor-substrate mutation authority).
//
// Two mutation classes:
//   WORK_PRODUCT       — ordinary product/application/record changes. Cannot alter how
//                        FUTURE workers reason, route, verify, select models/tools,
//                        interpret authority, or execute. Ordinary bounded envelope, no
//                        extra ceremony.
//   EXECUTOR_SUBSTRATE — a surface whose change does alter future-worker behavior. Mutable
//                        only under durable authority naming the specific COMPONENT, the
//                        intended change, and the verification required. Authority for one
//                        component never implies a neighbouring component, and no
//                        category-level grant ("*", "all", CONTROL_PLANE_WRITE) exists.
//
// Classification is by semantic effect, not directory name alone: the registry below maps
// paths to named components, with explicit WORK_PRODUCT carve-outs for mixed-purpose
// locations (tests, fixtures, run logs, local-only/dev-server config), and a content-based
// "no semantic change" check (line-ending/trailing-whitespace/blank-line-only, or JSON that
// parses to an identical value) so a formatting-only edit is not over-classified.
//
// This is a pure classifier + guard (mirrors execution-authority-gate.mjs); it is not a
// permission server. #554/#556 (terminal-state Manuals) and #574/#575 (adversarial
// hardening) stay separate; #179 can consume `authorization.component` from this registry.
//
// Authority shape (durable; named by the dispatch/Issue/Manual that authorizes the work):
//   { executorSubstrate: [ { component, intendedChange, verification, paths? } ] }
//   `paths` optionally narrows the grant to globs within the component.
//
// Outcome when a change is rejected is always action "STOP_AND_PROPOSE": the worker returns
// a bounded proposal/interrupt naming the extra component and does not widen its envelope.
//
// Usage (CLI): node tools/orchestration/executor-substrate-authority.mjs \
//                --base <git-ref> [--authority <file.json>]
//   Compares the working tree against <git-ref>; exit 0 allowed, 1 rejected, 2 usage error.
//
// Tests: node --test tools/orchestration/executor-substrate-authority.test.mjs

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const WORK_PRODUCT = "WORK_PRODUCT";
export const EXECUTOR_SUBSTRATE = "EXECUTOR_SUBSTRATE";

// Evaluated before components: always WORK_PRODUCT because they cannot change future
// worker behavior (verification fixtures/tests are exercised by the substrate, they are not
// the substrate; run records and local/dev-server config are not read as instructions).
const WORK_PRODUCT_CARVE_OUTS = [
  "**/*.test.mjs",
  "**/fixtures/**",
  "docs/*-proof-runs/**",
  "docs/*-proof-runs.md",
  "docs/diagnostic-traces/**",
  "docs/telemetry-battery-log*",
  "docs/execution-boundary-probe-runs/**",
  ".claude/settings.local.json",
  ".claude/launch.json",
  ".claude/action-envelope-state/**",
  ".claude/telemetry/**",
  "tools/telemetry/**",
];

// Registry misses inside these namespaces are unattributable executor/control-plane surfaces
// and fail closed (a new component needs registration), rather than becoming work product.
const EXECUTOR_NAMESPACES = [".claude/**", ".github/**", "tools/**"];

// First match wins; keep specific components ahead of their catch-alls.
export const EXECUTOR_COMPONENTS = [
  {
    component: "model-selection-policy",
    description: "Model/provider/effort selection and local-delegation policy",
    paths: [".claude/skills/model-check/**", "tools/local-worker/**", ".claude/skills/local-worker/**"],
  },
  { component: "personas", description: "Reusable subagent expertise profiles", paths: [".claude/personas/**"] },
  { component: "skills", description: "Reusable repository-local skills", paths: [".claude/skills/**"] },
  {
    component: "worker-configuration",
    description: "Shared worker/agent harness configuration (hooks, permissions, env)",
    paths: [".claude/settings.json"],
  },
  {
    component: "routing-policy",
    description: "Dispatch readiness, route selection, planning/manifest routing",
    paths: [
      "tools/orchestration/ready-dispatch-gate.mjs",
      "tools/orchestration/session-entry-gate.mjs",
      "tools/orchestration/control-plane-*.mjs",
      "tools/orchestration/prepare-dispatch-manifest.mjs",
      "tools/orchestration/route-qualification.mjs",
      "tools/orchestration/next-review-transition-gate.mjs",
      "tools/orchestration/*-execution-plan.mjs",
      "tools/orchestration/correct-unit-dependency.mjs",
      "tools/orchestration/dependency-grammar.mjs",
      "tools/orchestration/blocker-grammar.mjs",
      "tools/orchestration/reconcile-control-blocker.mjs",
      "docs/route-evidence.json",
    ],
  },
  {
    component: "dispatch-prompts",
    description: "Formatters that author worker prompts",
    paths: ["tools/orchestration/format-dispatch-prompt.mjs", "tools/orchestration/format-unit-dispatch-prompt.mjs"],
  },
  {
    component: "authority-guards",
    description: "Execution-authority, action-envelope, control-write guards and this classifier",
    paths: [
      "tools/orchestration/execution-authority-gate.mjs",
      "tools/orchestration/executor-substrate-authority.mjs",
      "tools/orchestration/action-envelope*.mjs",
      "tools/orchestration/verify-action-envelope.mjs",
      "tools/orchestration/control-body-write-guard.mjs",
      "tools/orchestration/control-field-validator.mjs",
      "tools/orchestration/transition-guard.mjs",
      "tools/orchestration/launch-authorization.mjs",
      "tools/orchestration/attempt-claim.mjs",
      "tools/orchestration/write-control-snapshot.mjs",
    ],
  },
  {
    component: "review-control",
    description: "Stage 1/Stage 2 review, audit and merge-gate machinery and contracts",
    paths: [
      "tools/review-watch/**",
      "docs/bounded-review-cycle.md",
      "docs/stage2-audit-contract*.md",
      ".github/workflows/**",
      ".github/ISSUE_TEMPLATE/**",
    ],
  },
  {
    component: "operating-contract",
    description: "Shared manual: AGENTS.md, CLAUDE.md and operating docs read by every worker",
    paths: [
      "AGENTS.md",
      "CLAUDE.md",
      "docs/operating-model.md",
      "docs/decision-forms.md",
      "docs/priority-horizons.md",
      "docs/consumer-contract.md",
      "docs/consumer-quickstart.md",
    ],
  },
  {
    component: "consumer-distribution",
    description: "Installer/updater/sync tooling that propagates the substrate to consumers",
    paths: ["tools/ldl-*", "tools/ldl-*/**", "tools/mcp-server/**", "docs/mcp-server.md"],
  },
  {
    component: "verification-controls",
    description: "Production check scripts executed by CI/gates that decide whether future work passes",
    paths: ["tools/check-*.mjs"],
  },
  {
    component: "orchestration-lifecycle",
    description: "Remaining orchestration tooling (finalizers, launcher, preflights); catch-all",
    paths: ["tools/orchestration/**"],
  },
];

const globCache = new Map();
// Minimal glob: `**` spans directories, `*` stays within a path segment.
function globToRegExp(glob) {
  if (globCache.has(glob)) return globCache.get(glob);
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slashAfter = glob[i + 2] === "/";
        re += slashAfter ? "(?:.*/)?" : ".*";
        i += slashAfter ? 2 : 1;
      } else re += "[^/]*";
    } else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  const rx = new RegExp(`^${re}$`);
  globCache.set(glob, rx);
  return rx;
}

export function matchesGlob(path, glob) {
  return globToRegExp(glob).test(path);
}

export function normalizePath(path) {
  if (typeof path !== "string" || path.trim() === "") return null;
  const p = path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (p.startsWith("/") || p.split("/").includes("..")) return null;
  return p;
}

// True only when a before/after pair is provably semantically identical for future
// workers: EOL / trailing-whitespace / blank-line differences, or JSON with equal value.
export function isNonSemanticChange(path, before, after) {
  if (typeof before !== "string" || typeof after !== "string") return false;
  if (path.endsWith(".json")) {
    try {
      return JSON.stringify(canonicalJson(JSON.parse(before))) === JSON.stringify(canonicalJson(JSON.parse(after)));
    } catch {
      return false;
    }
  }
  if (/\.(md|markdown)$/i.test(path)) {
    // Markdown whitespace can be structural (two trailing spaces = hard break; blank lines
    // delimit paragraphs/lists/code): only EOL and single trailing space/tab runs are cosmetic.
    const mdNorm = (s) =>
      s
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((l) => (/ {2,}$/.test(l) ? l : l.replace(/[ \t]+$/, "")))
        .join("\n");
    return mdNorm(before) === mdNorm(after);
  }
  const norm = (s) =>
    s
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((l) => l.replace(/[ \t]+$/, ""))
      .filter((l) => l !== "")
      .join("\n");
  return norm(before) === norm(after);
}

function canonicalJson(v) {
  if (Array.isArray(v)) return v.map(canonicalJson);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonicalJson(v[k])]));
  }
  return v;
}

// Classify one path (optionally with before/after content for semantic-effect checks).
export function classifyPath(path, { before, after, registry = EXECUTOR_COMPONENTS, carveOuts = WORK_PRODUCT_CARVE_OUTS } = {}) {
  const p = normalizePath(path);
  if (p === null) {
    // Unaddressable/escaping path: fail closed as unattributable substrate.
    return { path, class: EXECUTOR_SUBSTRATE, component: null, reason: "invalid or escaping path fails closed" };
  }
  if (carveOuts.some((g) => matchesGlob(p, g))) {
    return { path: p, class: WORK_PRODUCT, component: null, reason: "work-product carve-out (cannot alter future worker behavior)" };
  }
  const hit = registry.find((c) => c.paths.some((g) => matchesGlob(p, g)));
  if (!hit) {
    if (EXECUTOR_NAMESPACES.some((g) => matchesGlob(p, g))) {
      return {
        path: p,
        class: EXECUTOR_SUBSTRATE,
        component: null,
        reason: "unregistered surface in an executor/control-plane namespace fails closed; propose registering a component",
      };
    }
    return { path: p, class: WORK_PRODUCT, component: null, reason: "not a registered executor component" };
  }
  if (isNonSemanticChange(p, before, after)) {
    return { path: p, class: WORK_PRODUCT, component: null, reason: `no semantic change to ${hit.component} (formatting/equivalent value only)` };
  }
  return { path: p, class: EXECUTOR_SUBSTRATE, component: hit.component, reason: `changes ${hit.component}` };
}

const CATEGORY_LEVEL = new Set(["*", "all", "any", "control_plane", "control_plane_write", "executor_substrate", "executor-substrate"]);

// Validate the durable grants. Returns { grants: Map<component, grant>, problems: [] }.
export function parseAuthority(authority, registry = EXECUTOR_COMPONENTS) {
  const problems = [];
  const grants = new Map();
  const known = new Set(registry.map((c) => c.component));
  const list = authority && Array.isArray(authority.executorSubstrate) ? authority.executorSubstrate : [];
  if (authority && authority.executorSubstrate !== undefined && !Array.isArray(authority.executorSubstrate)) {
    problems.push("executorSubstrate must be an array of component grants");
  }
  for (const g of list) {
    const name = g && typeof g.component === "string" ? g.component.trim() : "";
    if (!name) {
      problems.push("grant missing component name");
    } else if (CATEGORY_LEVEL.has(name.toLowerCase())) {
      problems.push(`category-level grant "${name}" is not valid authority; name a specific component`);
    } else if (!known.has(name)) {
      problems.push(`unknown component "${name}"`);
    } else if (typeof g.intendedChange !== "string" || g.intendedChange.trim() === "") {
      problems.push(`grant for ${name} must state intendedChange`);
    } else if (typeof g.verification !== "string" || g.verification.trim() === "") {
      problems.push(`grant for ${name} must state required verification`);
    } else if (g.paths !== undefined && (!Array.isArray(g.paths) || g.paths.length === 0 || g.paths.some((x) => typeof x !== "string" || x.trim() === ""))) {
      problems.push(`grant for ${name} has malformed paths envelope`);
    } else {
      grants.set(name, g);
    }
  }
  return { grants, problems };
}

// Core guard. changes: [{ path, before?, after? }]. All-or-nothing: any unauthorized
// substrate change rejects the whole set with STOP_AND_PROPOSE.
export function checkExecutorSubstrateAuthority({ changes, authority, registry = EXECUTOR_COMPONENTS } = {}) {
  const { grants, problems } = parseAuthority(authority, registry);
  const classified = (Array.isArray(changes) ? changes : []).map((c) =>
    classifyPath(c && c.path, { before: c && c.before, after: c && c.after, registry })
  );
  const violations = [];
  for (const c of classified) {
    if (c.class !== EXECUTOR_SUBSTRATE) continue;
    const grant = c.component ? grants.get(c.component) : null;
    if (!grant) {
      violations.push({
        path: c.path,
        component: c.component,
        reason: c.component
          ? `component "${c.component}" is not explicitly authorized (authority for other components does not apply)`
          : c.reason,
      });
    } else if (grant.paths && !grant.paths.some((g) => matchesGlob(c.path, g))) {
      violations.push({ path: c.path, component: c.component, reason: `path is outside the bounded envelope granted for "${c.component}"` });
    }
  }
  const substrate = classified.filter((c) => c.class === EXECUTOR_SUBSTRATE);
  // An invalid authority record never authorizes substrate mutation, even when another grant is valid.
  const authorityInvalid = substrate.length > 0 && problems.length > 0;
  const allowed = violations.length === 0 && !authorityInvalid;
  const touched = [...new Set(substrate.map((c) => c.component).filter(Boolean))];
  const result = {
    allowed,
    action: allowed ? "PROCEED" : "STOP_AND_PROPOSE",
    classified,
    violations,
    authorityProblems: problems,
  };
  if (substrate.length > 0 && allowed) {
    // Evidence for independent review (item 5): what changed, why, what stayed out of scope.
    result.evidence = touched.map((component) => ({
      component,
      intendedChange: grants.get(component).intendedChange,
      verification: grants.get(component).verification,
      outOfScopeNeighbors: registry.map((r) => r.component).filter((n) => !grants.has(n)),
    }));
  }
  if (!allowed) {
    const missing = [...new Set(violations.map((v) => v.component).filter(Boolean))];
    result.proposal = {
      reason: authorityInvalid && violations.length === 0
        ? "authority record contains invalid grants; an invalid grant cannot be masked by a valid one"
        : "mutation requires executor components outside the authorized envelope",
      unauthorizedComponents: missing,
      paths: violations.map((v) => v.path),
      authorityProblems: problems,
      instruction: "Do not modify these surfaces. Return a bounded proposal/interrupt naming the component and intended change; stop at the existing envelope.",
    };
  }
  return result;
}

// ---- CLI -------------------------------------------------------------------------------

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
}

export function changesFromGit(base, cwd = process.cwd()) {
  const out = git(["diff", "--name-status", "--no-renames", base], cwd);
  // Untracked additions are invisible to `git diff`; include them as additions.
  const untracked = git(["ls-files", "--others", "--exclude-standard"], cwd)
    .split("\n")
    .filter(Boolean)
    .map((p) => `A\t${p}`);
  const changes = [];
  for (const line of [...out.split("\n").filter(Boolean), ...untracked]) {
    const [status, ...rest] = line.split("\t");
    const path = rest.join("\t");
    let before = null;
    let after = null;
    if (status !== "A") {
      try { before = git(["show", `${base}:${path}`], cwd); } catch { before = null; }
    }
    if (status !== "D" && existsSync(`${cwd}/${path}`)) after = readFileSync(`${cwd}/${path}`, "utf8");
    changes.push({ path, before, after });
  }
  return changes;
}

function main(argv) {
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const base = opt("--base");
  if (!base) {
    console.error("usage: executor-substrate-authority.mjs --base <git-ref> [--authority <file.json>]");
    return 2;
  }
  let authority = {};
  const authFile = opt("--authority");
  if (authFile) {
    try {
      authority = JSON.parse(readFileSync(authFile, "utf8"));
    } catch (e) {
      console.error(`cannot read authority file: ${e.message}`);
      return 2;
    }
  }
  const result = checkExecutorSubstrateAuthority({ changes: changesFromGit(base), authority });
  console.log(JSON.stringify(result, null, 2));
  return result.allowed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
