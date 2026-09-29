// Shared REST-backed GitHub control-state read boundary — issue #725 (control #726).
//
// `gh issue view --json` and `gh pr view --json` are served by GitHub GraphQL. A qualified
// remote/cloud execution environment (e.g. the Claude Code Remote container) can authorize
// GitHub repository access yet block GraphQL by policy (HTTP 403), which made every
// orchestration gate fail before it ever evaluated Issue content (#723 live reproduction).
// This module is the one repository-owned boundary that reads the same fields through the REST
// endpoints (`gh api repos/<repo>/issues/<n>`, `.../pulls/<n>`), which the same environment
// does permit, and returns objects shaped exactly like the `gh ... --json` output the callers
// already consume (`state` upper-cased, `createdAt`, `headRefOid`, `mergeCommit.oid`, ...), so
// parsers and gates see identical input regardless of transport.
//
// Fail-closed: a missing/unauthorized/unavailable transport throws (the `gh` error propagates);
// a malformed or incomplete payload throws a descriptive error. Callers already treat any
// throw from their `ghIssueViewImpl` as an operational failure (exit 1), never a lifecycle
// verdict. Nothing here interprets lifecycle content.
import { execFileSync } from "node:child_process";

function restPath(kind, repo, number) {
  // When `repo` is omitted (some finalize scripts rely on gh's own current-repo resolution) the
  // `{owner}/{repo}` placeholders are expanded by `gh api` from the checkout's own remote.
  return `repos/${repo || "{owner}/{repo}"}/${kind}/${number}`;
}

function callRest(path, execFileImpl) {
  const raw = execFileImpl("gh", ["api", path], { encoding: "utf8" });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`GitHub REST response for ${path} is not valid JSON: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`GitHub REST response for ${path} is not a JSON object`);
  }
  return parsed;
}

function requireNumber(payload, number, path) {
  if (payload.number !== Number(number)) {
    throw new Error(
      `GitHub REST response for ${path} identifies #${JSON.stringify(payload.number)}, expected #${number}`,
    );
  }
}

function requireStringOrNull(payload, key, path) {
  const value = payload[key];
  if (value !== null && typeof value !== "string") {
    throw new Error(`GitHub REST response for ${path} has a malformed or missing "${key}" field`);
  }
  return value ?? "";
}

// Reads one Issue. `fields` is a subset of "body" | "state" | "createdAt"; only requested
// fields are validated and returned (mirroring `gh issue view --json <fields>`).
export function readGithubIssue({ repo, number, fields = ["body", "state"], execFileImpl = execFileSync }) {
  const path = restPath("issues", repo, number);
  const payload = callRest(path, execFileImpl);
  requireNumber(payload, number, path);
  // REST /issues/{n} also serves pull requests as issue-shaped objects; `gh issue view` would
  // not, so reject the PR marker rather than let a PR body be read as authoritative Issue state.
  if (payload.pull_request !== undefined && payload.pull_request !== null) {
    throw new Error(`GitHub REST response for ${path} is a pull request, not an Issue`);
  }
  const out = {};
  for (const field of fields) {
    if (field === "body") {
      out.body = requireStringOrNull(payload, "body", path);
    } else if (field === "state") {
      if (payload.state !== "open" && payload.state !== "closed") {
        throw new Error(`GitHub REST response for ${path} has a malformed or missing "state" field`);
      }
      out.state = payload.state.toUpperCase();
    } else if (field === "createdAt") {
      if (typeof payload.created_at !== "string" || payload.created_at === "") {
        throw new Error(`GitHub REST response for ${path} has a malformed or missing "created_at" field`);
      }
      out.createdAt = payload.created_at;
    } else {
      throw new Error(`readGithubIssue does not support field "${field}"`);
    }
  }
  return out;
}

// Reads one PR. `fields` is a subset of "body" | "state" | "headRefName" | "headRefOid" |
// "mergedAt" | "mergeCommit" (mirroring `gh pr view --json <fields>`; `state` is OPEN, CLOSED or
// MERGED as `gh` reports it).
export function readGithubPr({ repo, number, fields, execFileImpl = execFileSync }) {
  const path = restPath("pulls", repo, number);
  const payload = callRest(path, execFileImpl);
  requireNumber(payload, number, path);
  const bad = (what) => new Error(`GitHub REST response for ${path} has a malformed or missing ${what}`);
  const out = {};
  const requireMergedAt = () => {
    const m = payload.merged_at;
    if (m !== null && (typeof m !== "string" || m === "")) throw bad('"merged_at" field');
    if (payload.state === "open" && m !== null) throw bad('"merged_at" field (inconsistent with open state)');
    return m;
  };
  for (const field of fields) {
    if (field === "body") {
      out.body = requireStringOrNull(payload, "body", path);
    } else if (field === "state") {
      if (payload.state !== "open" && payload.state !== "closed") throw bad('"state" field');
      out.state = requireMergedAt() ? "MERGED" : payload.state.toUpperCase();
    } else if (field === "headRefName") {
      if (typeof payload.head?.ref !== "string" || payload.head.ref === "") throw bad('"head.ref" field');
      out.headRefName = payload.head.ref;
    } else if (field === "headRefOid") {
      if (typeof payload.head?.sha !== "string" || payload.head.sha === "") throw bad('"head.sha" field');
      out.headRefOid = payload.head.sha;
    } else if (field === "mergedAt") {
      out.mergedAt = requireMergedAt();
    } else if (field === "mergeable") {
      // GraphQL reports MERGEABLE / CONFLICTING / UNKNOWN; REST reports true / false / null.
      if (payload.mergeable === true) out.mergeable = "MERGEABLE";
      else if (payload.mergeable === false) out.mergeable = "CONFLICTING";
      else if (payload.mergeable === null) out.mergeable = "UNKNOWN";
      else throw bad('"mergeable" field');
    } else if (field === "mergeCommit") {
      if (requireMergedAt()) {
        if (typeof payload.merge_commit_sha !== "string" || payload.merge_commit_sha === "") {
          throw bad('"merge_commit_sha" field');
        }
        out.mergeCommit = { oid: payload.merge_commit_sha };
      } else {
        out.mergeCommit = null;
      }
    } else {
      throw new Error(`readGithubPr does not support field "${field}"`);
    }
  }
  return out;
}
