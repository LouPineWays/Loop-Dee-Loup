// Pre-publication validator for a findings-bearing Stage 1 correction (issue #964, control #963;
// live reproduction #951 / #950 / PR #962: commit c9786d8 `Fix #950 ...` was published, caught
// only by merge-ready after clean Stage 1, and repaired by a history rewrite).
//
// Provider-independent and offline: given the execution Issue, the reviewed head, and a candidate
// local head, it inspects the complete local reviewed..candidate range with plain git and denies
// when any commit (a) fails the existing correction-provenance verifier
// (`verifyCorrectionProvenance`, next-review-transition-gate.mjs -- the exact semantics the
// post-publication finalizer applies) or (b) uses a GitHub auto-close keyword for the execution
// Issue (`findClosingKeywordMatch`, the canonical matcher merge-ready uses). It never touches
// GitHub, never authorizes a force-push, and is advisory defense in depth: merge-ready and the
// correction finalizer remain independent post-publication checks.
//
// Also exports `classifyGitPushCommand`, the structural shell classifier the Claude Code hook uses
// to decide whether a Bash call would execute `git push` and which local head it publishes.
// Unclassifiable push intent is reported as such so the caller can fail closed.

import { execFileSync } from "node:child_process";
import { findClosingKeywordMatch } from "../review-watch/closing-keyword.mjs";

const REC = "\x1e";
const FLD = "\x1f";

function defaultGit(args, { cwd }) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

// Reads the complete local reviewed..candidate range. Throws on any git failure or truncation.
export function readLocalRange({ cwd, reviewedHead, candidate = "HEAD", gitImpl = defaultGit }) {
  const git = (args) => gitImpl(args, { cwd });
  const reviewed = git(["rev-parse", "--verify", `${reviewedHead}^{commit}`]).trim();
  const head = git(["rev-parse", "--verify", `${candidate}^{commit}`]).trim();
  try {
    git(["merge-base", "--is-ancestor", reviewed, head]);
  } catch {
    throw new Error(`reviewed head ${reviewed} is not an ancestor of candidate ${head}`);
  }
  const expected = Number.parseInt(git(["rev-list", "--count", `${reviewed}..${head}`]).trim(), 10);
  if (!Number.isInteger(expected)) throw new Error("could not count local correction range");
  const raw = git(["log", "--reverse", `--format=%H${FLD}%P${FLD}%B${REC}`, `${reviewed}..${head}`]);
  const commits = raw
    .split(REC)
    .map((r) => r.replace(/^\n/, ""))
    .filter((r) => r.trim().length > 0)
    .map((r) => {
      const [sha, parents, ...rest] = r.split(FLD);
      const parentShas = parents.trim() ? parents.trim().split(/\s+/) : [];
      return { sha: sha.trim(), parents: parentShas.length, parentShas, message: rest.join(FLD) };
    });
  if (commits.length !== expected) {
    throw new Error(`local range enumeration incomplete (read ${commits.length}, expected ${expected})`);
  }
  return { reviewed, head, commits };
}

// Pure core: `commits` as produced by readLocalRange. Returns { ok, reason, offenders }.
export async function evaluateCorrectionCommits(commits, executionIssue, { repo, verifyProvenanceImpl } = {}) {
  const verify =
    verifyProvenanceImpl ?? (await import("./next-review-transition-gate.mjs")).verifyCorrectionProvenance;
  const offenders = [];
  for (const c of commits) {
    const single = verify([c], executionIssue);
    if (!single.ok) offenders.push({ sha: c.sha, reason: single.reason });
    const closing = findClosingKeywordMatch(c.message, executionIssue, repo);
    if (closing) {
      offenders.push({
        sha: c.sha,
        reason: `uses auto-close keyword "${closing}" for execution Issue #${executionIssue} (use a non-closing form such as "Address #${executionIssue} ...")`,
      });
    }
  }
  if (offenders.length === 0) {
    const whole = verify(commits, executionIssue);
    if (!whole.ok) offenders.push({ sha: null, reason: whole.reason });
  }
  return offenders.length === 0
    ? { ok: true, offenders: [] }
    : { ok: false, reason: offenders.map((o) => `${o.sha ? o.sha.slice(0, 12) : "range"}: ${o.reason}`).join("; "), offenders };
}

// Full local validation. Never throws: any inability to prove the complete range is a deny.
export async function validateCorrectionRange({
  executionIssue,
  reviewedHead,
  candidate = "HEAD",
  cwd,
  repo,
  gitImpl,
  verifyProvenanceImpl,
}) {
  if (!Number.isInteger(executionIssue) || executionIssue <= 0 || typeof reviewedHead !== "string" || !reviewedHead) {
    return { ok: false, reason: "missing execution Issue or reviewed head binding", offenders: [] };
  }
  try {
    const { commits, head } = readLocalRange({ cwd, reviewedHead, candidate, gitImpl });
    const result = await evaluateCorrectionCommits(commits, executionIssue, { repo, verifyProvenanceImpl });
    return { ...result, head, commitCount: commits.length };
  } catch (err) {
    return { ok: false, reason: `local correction range could not be fully established: ${err?.message ?? err}`, offenders: [] };
  }
}

// -- shell classification -----------------------------------------------------------------

const SCOPE_OPEN = "\u0000scope-open";
const SCOPE_CLOSE = "\u0000scope-close";

// Splits a command into command segments on ; && || | & newline, command substitution and
// subshell delimiters, honoring simple single/double quoting. Each segment is tokenized.
export function splitShellSegments(command) {
  const segments = [];
  let tokens = [];
  let cur = "";
  let has = false;
  let quote = null;
  const pushTok = () => {
    if (has) tokens.push(cur);
    cur = "";
    has = false;
  };
  const pushSeg = () => {
    pushTok();
    if (tokens.length) segments.push(tokens);
    tokens = [];
  };
  let backtickOpen = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === "\\" && quote !== "'" && command[i + 1] === "\n") {
      i += 1; // backslash-newline is a line continuation, removed before tokenization
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        cur += command[(i += 1)];
      } else cur += ch;
      has = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < command.length) {
      cur += command[(i += 1)];
      has = true;
    } else if (/\s/.test(ch) && ch !== "\n") {
      pushTok();
    } else if (ch === "(" || ch === ")" || ch === "`") {
      // Subshell / command-substitution scope boundary: emit a marker so directory changes
      // inside the scope are not carried past it.
      // Preserve an opening backtick as a dynamic token before entering its scope.
      // Otherwise `git `command`` looks like an inert `git` with no subcommand.
      if (ch === "`" && !backtickOpen) { cur += "`"; has = true; }
      pushSeg();
      if (ch === "`") {
        segments.push([backtickOpen ? SCOPE_CLOSE : SCOPE_OPEN]);
        backtickOpen = !backtickOpen;
      } else segments.push([ch === "(" ? SCOPE_OPEN : SCOPE_CLOSE]);
    } else if (ch === "\n" || ch === ";" || ch === "&" || ch === "|" || ch === "{" || ch === "}") {
      pushSeg();
    } else if (ch === "$" && command[i + 1] === "(") {
      // Keep the substitution marker in the outer token. Its contents have a
      // separate scope, but the outer git subcommand is still shell-expanded.
      cur += "$(";
      has = true;
      pushSeg();
      segments.push([SCOPE_OPEN]);
      i += 1;
    } else {
      cur += ch;
      has = true;
    }
  }
  pushSeg();
  return segments;
}

const WRAPPERS = new Set([
  "bash", "sh", "zsh", "dash", "ksh", "fish", "eval", "env", "xargs", "command", "exec", "time",
  "nohup", "sudo", "powershell", "pwsh", "cmd", "cmd.exe", "node", "python", "python3", "source", ".", "watch", "timeout", "nice", "setsid",
]);
const GIT_GLOBAL_WITH_ARG = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env"]);
const PUSH_FLAGS_OK = new Set([
  "-u", "--set-upstream", "--no-verify", "--verify", "-q", "--quiet", "-v", "--verbose", "--progress",
  "--no-progress", "--porcelain", "--atomic", "--no-thin", "--thin", "--signed=false", "--no-signed",
]);
const PUSH_FLAGS_FORCE = new Set(["-f", "--force", "--force-if-includes"]);

const baseName = (t) => t.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "");

// Classifies a Bash command. Returns:
//   { push: false }                                    -- no `git push` intent
//   { push: true, classifiable: true, pushes: [{ cwd, candidate }] }
//   { push: true, classifiable: false, reason }        -- push intent that cannot be safely analyzed
// `baseCwd` is the hook's working directory; `cd`/`pushd` in earlier segments are honored only for
// simple literal paths, otherwise a following push is unclassifiable.
export function classifyGitPushCommand(command, { baseCwd } = {}) {
  if (typeof command !== "string") return { push: false };
  // A literal `push` is not required: a shell variable can supply the subcommand (`S=push; git "$S" ...`).
  if (!/\bpush\b/.test(command) && !(/\bgit\b/.test(command) && (command.includes("$") || command.includes(String.fromCharCode(96))))) return { push: false };
  const segments = splitShellSegments(command);
  const pushes = [];
  let cwd = baseCwd;
  let cwdUnknown = false;
  const scopes = [];
  for (let tokens of segments) {
    if (tokens.length === 1 && tokens[0] === SCOPE_OPEN) {
      scopes.push({ cwd, cwdUnknown });
      continue;
    }
    if (tokens.length === 1 && tokens[0] === SCOPE_CLOSE) {
      // restore the enclosing scope's directory; an unbalanced close fails closed
      const saved = scopes.pop();
      if (saved) ({ cwd, cwdUnknown } = saved);
      else cwdUnknown = true;
      continue;
    }
    // skip leading VAR=value assignments, refusing ones that redirect Git's repository
    while (tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
      if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|CONFIG\w*)=/.test(tokens[0]) && tokens.slice(1).some((t) => t === "git")) {
        return { push: true, classifiable: false, reason: `\`${tokens[0].split("=")[0]}\` changes which repository Git operates on` };
      }
      tokens = tokens.slice(1);
    }
    if (!tokens.length) continue;
    const first = baseName(tokens[0]);
    if (first === "cd" || first === "pushd" || first === "set-location" || first === "sl") {
      const arg = tokens[1];
      if (!arg || /[$~%`]/.test(arg) || arg === "-") cwdUnknown = true;
      else cwd = joinPath(cwd, arg);
      continue;
    }
    if (first === "git") {
      let i = 1;
      let gitCwd = cwd;
      let unknown = cwdUnknown;
      while (i < tokens.length && tokens[i].startsWith("-")) {
        const t = tokens[i];
        if (t === "-C") {
          const v = tokens[i + 1] ?? "";
          if (!v || /[$~%`]/.test(v)) unknown = true;
          else gitCwd = joinPath(gitCwd, v);
          i += 2;
        } else if (/^--(git-dir|work-tree)(=|$)/.test(t)) {
          return { push: true, classifiable: false, reason: `git global option \`${t}\` changes which repository the push operates on` };
        } else if (GIT_GLOBAL_WITH_ARG.has(t)) i += 2;
        else i += 1;
      }
      // A subcommand that depends on shell expansion cannot be proven not to be `push` (Audit #1027).
      if (typeof tokens[i] === "string" && (tokens[i].includes("$") || tokens[i].includes("`"))) {
        return { push: true, classifiable: false, reason: "the git subcommand depends on shell expansion and could not be proven not to be `push`" };
      }
      if (tokens[i] !== "push") continue;
      const args = tokens.slice(i + 1);
      const parsed = parsePushArgs(args);
      if (parsed.error) return { push: true, classifiable: false, reason: parsed.error };
      if (unknown || !gitCwd) return { push: true, classifiable: false, reason: "the working directory of the push could not be determined" };
      pushes.push({ cwd: gitCwd, candidate: parsed.candidate });
      continue;
    }
    if (WRAPPERS.has(first) && /\bgit\b[\s\S]*\bpush\b/.test(tokens.join(" "))) {
      return { push: true, classifiable: false, reason: `\`git push\` is nested inside a \`${first}\` wrapper` };
    }
  }
  if (pushes.length === 0) {
    // "push" appeared but never as a git subcommand we can see; treat a bare mention of
    // `git ... push` that survived tokenization oddly as unclassifiable, otherwise unaffected.
    return /\bgit\b[^\n]*\bpush\b/.test(command) && !segments.some((t) => baseName(t[0] ?? "") === "echo" || baseName(t[0] ?? "") === "git")
      ? { push: true, classifiable: false, reason: "a `git push` appears in a form that could not be structurally parsed" }
      : { push: false };
  }
  return { push: true, classifiable: true, pushes };
}

function joinPath(base, rel) {
  if (/^([A-Za-z]:)?[\\/]/.test(rel)) return rel;
  if (!base) return rel;
  return `${base.replace(/[\\/]+$/, "")}/${rel}`;
}

// Supports: flags from an allowlist, optionally a remote, then at most one refspec.
function parsePushArgs(args) {
  const positional = [];
  for (const a of args) {
    if (a.startsWith("-")) {
      if (PUSH_FLAGS_FORCE.has(a) || /^--force/.test(a) || /^-[A-Za-z]*f/.test(a)) {
        return { error: `force-enabled push option \`${a}\` is refused; correction pushes must be ordinary non-forced pushes` };
      }
      if (PUSH_FLAGS_OK.has(a) || a.startsWith("--receive-pack")) continue;
      return { error: `push option \`${a}\` is not recognized by the correction pre-push guard` };
    }
    positional.push(a);
  }
  if (positional.length > 2) return { error: "push names more than one refspec" };
  const refspec = positional.length === 2 ? positional[1] : null;
  if (refspec === null) {
    return { error: "push without an explicit remote and refspec (configured push refspecs could publish unvalidated refs)" };
  }
  if (refspec.startsWith("+")) return { error: "force-enabled `+` refspec is refused" };
  const bare = refspec;
  if (bare === "" || bare.startsWith("^") || bare === "--all" || bare === "--mirror") return { error: "push refspec is a deletion or bulk push" };
  if (bare.includes(":")) {
    const src = bare.split(":")[0];
    if (!src) return { error: "push refspec deletes a remote ref" };
    return { candidate: src };
  }
  return { candidate: bare };
}
