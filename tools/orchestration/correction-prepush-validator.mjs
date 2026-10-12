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
  // Per-token expansion provenance (Stage 1 #1084): 0 = no live expansion (single-quoted or escaped `$`),
  // 1 = expansion inside double quotes (one word), 2 = unquoted expansion (word-splittable).
  tokens.dyn = [];
  let curDyn = 0;
  const pushTok = () => {
    if (has) {
      tokens.push(cur);
      tokens.dyn.push(curDyn);
    }
    cur = "";
    has = false;
    curDyn = 0;
  };
  const pushSeg = () => {
    pushTok();
    if (tokens.length) segments.push(tokens);
    tokens = [];
    tokens.dyn = [];
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
      } else {
        cur += ch;
        if (quote === '"' && (ch === "$" || ch === "`")) curDyn = Math.max(curDyn, 1);
      }
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
      if (ch === "`" && !backtickOpen) { cur += "`"; has = true; curDyn = 2; }
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
      curDyn = 2;
      pushSeg();
      segments.push([SCOPE_OPEN]);
      i += 1;
    } else {
      cur += ch;
      has = true;
      if (ch === "$") curDyn = 2;
    }
  }
  pushSeg();
  return segments;
}

const WRAPPERS = new Set([
  "bash", "sh", "zsh", "dash", "ksh", "fish", "eval", "env", "xargs", "command", "exec", "time",
  "nohup", "sudo", "powershell", "pwsh", "cmd", "cmd.exe", "node", "python", "python3", "source", ".", "watch", "timeout", "nice", "setsid", "stdbuf",
]);
const GIT_GLOBAL_WITH_ARG = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env"]);
const PUSH_FLAGS_OK = new Set([
  "-u", "--set-upstream", "--no-verify", "--verify", "-q", "--quiet", "-v", "--verbose", "--progress",
  "--no-progress", "--porcelain", "--atomic", "--no-thin", "--thin", "--signed=false", "--no-signed",
]);
const PUSH_FLAGS_FORCE = new Set(["-f", "--force", "--force-if-includes"]);

const SHELL_EXPANSION_REASON = "the git subcommand depends on shell expansion and could not be proven not to be `push`";
const STDIN_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "cmd", "cmd.exe", "powershell", "pwsh"]);
// Expansion forms: POSIX `$`/backtick, cmd `%VAR%` and delayed `!VAR!`.
const hasPosixExpansion = (t) => /[$`]/.test(t);
const hasAnyExpansion = (t) => /[$`%!]/.test(t);
const baseName = (t) => t.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, "");

// ---- xargs analysis (Audit #1077 and Stage 1 findings on PR #1078) ----
const LAUNCHERS = new Set(["command", "env", "nice", "nohup", "exec", "time", "setsid", "sudo"]);
const XARGS_SHORT_WITH_ARG = new Set(["E", "I", "L", "n", "P", "s", "a", "d", "J", "R", "S"]);
const XARGS_SHORT_OPT_ARG = new Set(["e", "i", "l"]);
const XARGS_LONG_WITH_ARG = new Set(["--max-args", "--max-procs", "--max-chars", "--delimiter", "--arg-file", "--process-slot-var"]);
// Long options whose argument is optional (GNU requires `=`, other implementations may take the next
// token): both interpretations are analyzed and either one being a possible push fails closed.
const XARGS_LONG_OPT_ARG = new Set(["--replace", "--eof", "--logical-eof", "--max-lines"]);
const XARGS_REASON = "`xargs git` may receive its subcommand from standard input or a replacement string and could not be proven not to be `push`";
// Commands that only print or search their arguments and never exec them.
// `rg` (--pre) and `man` (pager/preprocessor options) can spawn subprocesses, so they are not listed.
const INERT_LEADERS = new Set(["echo", "printf", "cat", "grep", "which", "type"]);
// Expansion level of token k: 0 none (single-quoted/escaped), 1 double-quoted, 2 unquoted/word-splittable.
// Tokens without recorded provenance fall back to the raw-text test (conservative).
const dynLevel = (tokens, k) => (tokens.dyn ? (tokens.dyn[k] ?? 0) : /[$`]/.test(tokens[k] ?? "") ? 2 : 0);
const isDynamicTok = (tokens, k, repl) => dynLevel(tokens, k) > 0 || (repl !== null && tokens[k].includes(repl));

// Index of the first token that is not a launcher (command/env/nice/...) or its options; -1 when the
// launcher's semantics cannot be established.
function skipLaunchers(tokens, start) {
  let i = start;
  while (i < tokens.length) {
    const name = baseName(tokens[i]);
    if (!LAUNCHERS.has(name)) return i;
    i += 1;
    while (i < tokens.length) {
      const t = tokens[i];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) i += 1;
      else if (name === "env" && t === "-S") return -1;
      else if (name === "env" && /^-[uCP]$/.test(t)) i += 2;
      else if (name === "nice" && t === "-n") i += 2;
      else if (name === "sudo" && /^-[ugCDhprRTU]$/.test(t)) i += 2;
      else if (t === "--") { i += 1; break; }
      else if (t.startsWith("-") && t.length > 1) i += 1;
      else break;
    }
  }
  return i;
}

// GNU getopt_long accepts any unambiguous prefix of a long option, so `--repl=@` is `--replace=@`.
const XARGS_LONG_ALL = [
  "--arg-file", "--delimiter", "--eof", "--exit", "--help", "--interactive", "--max-args", "--max-chars",
  "--max-lines", "--max-procs", "--no-run-if-empty", "--null", "--open-tty", "--process-slot-var", "--replace",
  "--show-limits", "--verbose", "--version", "--logical-eof",
];
// Returns the canonical long option names a (possibly abbreviated) option may denote. An exact match is
// unique; otherwise every option sharing the prefix is returned so the caller can fail closed on any of them.
function resolveXargsLong(name) {
  if (XARGS_LONG_ALL.includes(name)) return [name];
  return XARGS_LONG_ALL.filter((c) => c.startsWith(name));
}

// Analyzes the command portion of an xargs invocation starting at token index `j` with replacement string `repl`.
function analyzeXargsCommand(tokens, j, repl) {
  if (j >= tokens.length) return null; // no command: xargs runs `echo`
  const e = skipLaunchers(tokens, j);
  if (e === -1) return XARGS_REASON;
  if (e >= tokens.length) return null;
  const exe = tokens[e];
  if (isDynamicTok(tokens, e, repl)) return XARGS_REASON;
  const name = baseName(exe);
  if (name !== "git") {
    // an interpreter handed a bare git token cannot be proven benign
    return WRAPPERS.has(name) && tokens.slice(e + 1).some((t) => baseName(t) === "git") ? XARGS_REASON : null;
  }
  let g = e + 1;
  while (g < tokens.length && tokens[g].startsWith("-")) {
    if (isDynamicTok(tokens, g, repl)) return XARGS_REASON;
    g += GIT_GLOBAL_WITH_ARG.has(tokens[g]) ? 2 : 1;
  }
  const sub = tokens[g];
  if (sub === undefined || sub === "push" || isDynamicTok(tokens, g, repl)) return XARGS_REASON;
  return null;
}

// Returns a fail-closed reason when this segment is an `xargs` that may run git's push subcommand, else null.
// `anyXargs` is true when the whole command mentions xargs, so a dynamically expanded command position in
// this segment could itself be `xargs`.
function analyzeXargs(tokens, anyXargs = false) {
  const li = skipLaunchers(tokens, 0);
  if (li === -1) return tokens.some((t) => baseName(t) === "xargs") ? XARGS_REASON : null;
  const dyn = (k) => dynLevel(tokens, k) > 0;
  const rawDyn = (t) => /[$`]/.test(t);
  const tail = (from) => tokens.slice(from);
  if (anyXargs && li < tokens.length && dyn(li)) return XARGS_REASON;
  // an unquoted expansion in executable position is word-split and may itself supply every executable word
  // (`X='xargs git'; ... | $X`), so no following literal `git` is required to be a possible push
  if (li < tokens.length && dynLevel(tokens, li) === 2) return XARGS_REASON;
  // a shell-expanded command position may itself be `xargs` supplied by the environment (Audit #1083), so
  // it followed by `git` (or another expansion/wrapper) cannot be proven benign even without a literal xargs
  if (li < tokens.length && dyn(li) && tail(li + 1).some((t, k) => baseName(t) === "git" || dyn(li + 1 + k) || WRAPPERS.has(baseName(t)))) return XARGS_REASON;
  if (baseName(tokens[li] ?? "") !== "xargs") {
    // a shell wrapper's inline payload may itself run xargs
    if (WRAPPERS.has(baseName(tokens[li] ?? ""))) {
      // an unresolved wrapper (timeout, stdbuf, nested chains) in front of xargs cannot be unwrapped, and a
      // shell-expanded token after a wrapper may itself be the `xargs` command it runs. A wrapper may also
      // re-parse single-quoted text, so raw `$` counts here.
      if (tail(li + 1).some((t) => baseName(t) === "xargs" || (anyXargs && rawDyn(t)))) return XARGS_REASON;
      // two executable words supplied by expansion (`timeout 5 "$X" "$G"`) or an expansion followed by git
      const wi = tokens.findIndex((t, k) => k > li && dyn(k));
      if (wi !== -1 && tail(wi + 1).some((t, k) => baseName(t) === "git" || dyn(wi + 1 + k) || WRAPPERS.has(baseName(t)))) return XARGS_REASON;
      for (const t of tail(li + 1)) {
        if (/\bxargs\b/.test(t) && /\s/.test(t) && classifyGitPushCommand(t, {}).push) return XARGS_REASON;
      }
    } else if (!INERT_LEADERS.has(baseName(tokens[li] ?? ""))) {
      // an unrecognized leading command (ionice, taskset, chrt, ...) may exec its arguments, so a later literal
      // `xargs` followed by `git` cannot be proven benign (Audit #1081)
      // A dynamic executable, an interpreter, or a nested wrapper after xargs is equally unprovable.
      const xi = tokens.findIndex((t, k) => k > li && /\bxargs\b/.test(t));
      if (xi !== -1 && tail(xi + 1).some((t, k) => baseName(t) === "git" || dyn(xi + 1 + k) || WRAPPERS.has(baseName(t)))) return XARGS_REASON;
      if (anyXargs && tokens.some((t, k) => k >= li && dyn(k))) return XARGS_REASON;
      // a shell-expanded token (inherited `X=xargs`) followed by git/another expansion/wrapper, with no literal xargs (Audit #1083)
      const di = tokens.findIndex((t, k) => k > li && dyn(k));
      if (di !== -1 && tail(di + 1).some((t, k) => baseName(t) === "git" || dyn(di + 1 + k) || WRAPPERS.has(baseName(t)))) return XARGS_REASON;
    }
    return null;
  }
  // Explore every plausible option parse as a set of (position, replacement) states, each visited once, so
  // repeated optional-argument options cannot cause exponential re-analysis.
  const seen = new Set();
  const stack = [[li + 1, null]];
  while (stack.length) {
    const [start, startRepl] = stack.pop();
    const key = `${start}\u0000${startRepl}`;
    if (seen.has(key)) continue;
    seen.add(key);
    let j = start;
    let repl = startRepl;
    while (j < tokens.length) {
      const t = tokens[j];
      if (t === "--") { j += 1; break; }
      if (!t.startsWith("-") || t === "-") break;
      if (t.startsWith("--")) {
        const eq = t.indexOf("=");
        const raw = eq === -1 ? t : t.slice(0, eq);
        const val = eq === -1 ? undefined : t.slice(eq + 1);
        const names = resolveXargsLong(raw);
        // an ambiguous or unknown abbreviation is analyzed as each candidate (or as a plain option)
        const candidates = names.length ? names : [raw];
        for (const name of candidates.slice(1)) {
          const consumes = XARGS_LONG_WITH_ARG.has(name) && val === undefined;
          stack.push([j + (consumes ? 2 : 1), name === "--replace" ? (val ? val : "{}") : repl]);
          if (XARGS_LONG_OPT_ARG.has(name) && val === undefined && j + 1 < tokens.length) {
            stack.push([j + 2, name === "--replace" ? tokens[j + 1] : repl]);
          }
        }
        const name = candidates[0];
        if (XARGS_LONG_OPT_ARG.has(name) && val === undefined && j + 1 < tokens.length) {
          // GNU requires `=`; other implementations may take the next token: the consumed interpretation
          // is explored as its own state, the unconsumed one continues here.
          stack.push([j + 2, name === "--replace" ? tokens[j + 1] : repl]);
        }
        if (name === "--replace") repl = val ? val : "{}";
        j += XARGS_LONG_WITH_ARG.has(name) && val === undefined ? 2 : 1;
        continue;
      }
      let consumed = 1;
      for (let k = 1; k < t.length; k += 1) {
        const c = t[k];
        if (!XARGS_SHORT_WITH_ARG.has(c) && !XARGS_SHORT_OPT_ARG.has(c)) continue;
        const rest = t.slice(k + 1);
        const needsArg = XARGS_SHORT_WITH_ARG.has(c);
        if (rest === "" && needsArg) consumed = 2;
        if (c === "I") repl = rest !== "" ? rest : (tokens[j + 1] ?? "{}");
        else if (c === "i") repl = rest !== "" ? rest : "{}";
        break;
      }
      j += consumed;
    }
    if (analyzeXargsCommand(tokens, j, repl)) return XARGS_REASON;
  }
  return null;
}

// ---- find -exec analysis (Audit #1085) ----
const FIND_EXEC_FLAGS = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
const FIND_EXEC_REASON = "`find -exec git` may run git's push subcommand (the subcommand or executable is supplied by `{}` or shell expansion) and could not be proven not to be `push`";
// Returns a fail-closed reason when a segment's find -exec/-execdir/-ok/-okdir payload may run `git push`.
function analyzeFindExec(tokens) {
  for (let k = 0; k < tokens.length; k += 1) {
    if (!FIND_EXEC_FLAGS.has(tokens[k])) continue;
    let end = k + 1;
    while (end < tokens.length && tokens[end] !== ";" && tokens[end] !== "+") end += 1;
    const payload = tokens.slice(k + 1, end);
    const pd = (i) => dynLevel(tokens, k + 1 + i) > 0 || payload[i].includes("{}");
    const e = skipLaunchers(payload, 0);
    if (e === -1) return FIND_EXEC_REASON;
    if (e >= payload.length) continue;
    if (pd(e)) return FIND_EXEC_REASON;
    const name = baseName(payload[e]);
    if (name !== "git") {
      // a wrapper/interpreter handed git (or a replacement/expansion) cannot be proven benign
      if (WRAPPERS.has(name) && payload.slice(e + 1).some((t, i) => baseName(t) === "git" || pd(e + 1 + i))) return FIND_EXEC_REASON;
      continue;
    }
    let g = e + 1;
    while (g < payload.length && payload[g].startsWith("-")) {
      if (pd(g)) return FIND_EXEC_REASON;
      g += GIT_GLOBAL_WITH_ARG.has(payload[g]) ? 2 : 1;
    }
    if (g >= payload.length || payload[g] === "push" || pd(g)) return FIND_EXEC_REASON;
  }
  return null;
}

// Classifies a Bash command. Returns:
//   { push: false }                                    -- no `git push` intent
//   { push: true, classifiable: true, pushes: [{ cwd, candidate }] }
//   { push: true, classifiable: false, reason }        -- push intent that cannot be safely analyzed
// `baseCwd` is the hook's working directory; `cd`/`pushd` in earlier segments are honored only for
// simple literal paths, otherwise a following push is unclassifiable.
export function classifyGitPushCommand(command, { baseCwd } = {}) {
  if (typeof command !== "string") return { push: false };
  // A literal `push` is not required: a shell variable can supply the subcommand (`S=push; git "$S" ...`).
  // `xargs` is analyzed even without a literal `push`: stdin or a replacement string can supply it.
  if (!/\bpush\b/.test(command) && !/\bxargs\b/.test(command) && !(/\bgit\b/.test(command) && (hasAnyExpansion(command) || command.includes("{}")))) return { push: false };
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
      const dynRest = tokens.dyn?.slice(1);
      tokens = tokens.slice(1);
      if (dynRest) tokens.dyn = dynRest;
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
      if (typeof tokens[i] === "string" && dynLevel(tokens, i) > 0) {
        return { push: true, classifiable: false, reason: SHELL_EXPANSION_REASON };
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
    // A wrapper whose payload names git and carries shell expansion can supply the subcommand at
    // run time (`bash -c 'git "$S" ...'`, `eval 'git "$S" ...'`, `cmd /c 'git %S% ...'`; Audit #1073).
    const joined = tokens.join(" ");
    const cmdLike = first === "cmd" || first === "cmd.exe";
    if (WRAPPERS.has(first) && /\bgit\b/.test(joined) && (cmdLike ? hasAnyExpansion(joined) : hasPosixExpansion(joined))) {
      return { push: true, classifiable: false, reason: SHELL_EXPANSION_REASON };
    }
    // `xargs` can run `git push` with the subcommand/executable supplied at run time (Audit #1077).
    const xr = analyzeXargs(tokens, /\bxargs\b/.test(command));
    if (xr) return { push: true, classifiable: false, reason: xr };
    const fx = INERT_LEADERS.has(first) ? null : analyzeFindExec(tokens);
    if (fx) return { push: true, classifiable: false, reason: fx };
    // A shell interpreter with no inline program reads it from stdin (`echo 'git "$S" ...' | S=push bash`),
    // so the payload is invisible to this segment; refuse when the command could carry a git push.
    if (STDIN_SHELLS.has(first) && !tokens.slice(1).some((t) => /^-[A-Za-z]*c$/i.test(t) || /^\/[ck]$/i.test(t) || /^-(command|encodedcommand)$/i.test(t) || (!t.startsWith("-") && !t.startsWith("/"))) &&
        segments.length > 1 && /\bgit\b/.test(command) && (hasAnyExpansion(command) || /\bpush\b/.test(command))) {
      return { push: true, classifiable: false, reason: `a \`${first}\` reads its program from a pipeline, so a nested \`git push\` could not be ruled out` };
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
