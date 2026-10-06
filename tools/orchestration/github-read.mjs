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
    } else if (field === "baseRefName") {
      if (typeof payload.base?.ref !== "string" || payload.base.ref === "") throw bad('"base.ref" field');
      out.baseRefName = payload.base.ref;
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

// REST-backed merge-ready closing evidence — issue #846 (control #845).
//
// `gh pr view --json closingIssuesReferences,commits` is GraphQL-backed and fails with HTTP 403
// in a GraphQL-blocked, REST-authorized remote environment (#817/#835/PR #844 live
// reproduction). This returns the raw evidence `lifecycle-gate.mjs merge-ready` needs through
// REST only: the current PR body, every commit on the PR, and whether a manual Development-
// sidebar PR<->Issue link to `workIssue` is currently active. Fail-closed throughout: an
// unauthorized/unavailable transport, malformed or wrong-identity payload, a PR with more
// commits than REST's documented 250-commit list limit (or a list that does not match the PR's
// own commit count), or ambiguous link-event evidence throws, which callers treat as an
// operational failure, never a clean verdict.
export const PR_COMMIT_LIST_LIMIT = 250;

function callRestPages(path, execFileImpl) {
  const sep = path.includes("?") ? "&" : "?";
  const full = `${path}${sep}per_page=100`;
  const raw = execFileImpl("gh", ["api", full, "--paginate", "--slurp"], { encoding: "utf8" });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`GitHub REST response for ${path} is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed) || parsed.some((page) => !Array.isArray(page))) {
    throw new Error(`GitHub REST response for ${path} is not a paginated JSON array`);
  }
  return parsed.flat();
}

export function readGithubPrClosingEvidence({ repo, number, workIssue, execFileImpl = execFileSync }) {
  const prPath = restPath("pulls", repo, number);
  const pr = callRest(prPath, execFileImpl);
  requireNumber(pr, number, prPath);
  const body = requireStringOrNull(pr, "body", prPath);
  if (!Number.isInteger(pr.commits) || pr.commits < 0) {
    throw new Error(`GitHub REST response for ${prPath} has a malformed or missing "commits" count`);
  }
  if (pr.commits > PR_COMMIT_LIST_LIMIT) {
    throw new Error(
      `PR #${number} has ${pr.commits} commits, beyond the ${PR_COMMIT_LIST_LIMIT}-commit limit of ` +
        `GitHub's list-PR-commits REST endpoint; commit evidence would be incomplete`,
    );
  }

  const commitsPath = `${prPath}/commits`;
  const rawCommits = callRestPages(commitsPath, execFileImpl);
  if (rawCommits.length !== pr.commits) {
    throw new Error(
      `GitHub REST commit list for ${commitsPath} returned ${rawCommits.length} commits, expected ${pr.commits}; ` +
        `commit evidence is incomplete`,
    );
  }
  const commits = rawCommits.map((c) => {
    const message = c?.commit?.message;
    if (typeof c?.sha !== "string" || c.sha === "" || typeof message !== "string") {
      throw new Error(`GitHub REST commit list for ${commitsPath} contains a malformed commit entry`);
    }
    const nl = message.indexOf("\n");
    return {
      oid: c.sha,
      messageHeadline: nl === -1 ? message : message.slice(0, nl),
      messageBody: nl === -1 ? "" : message.slice(nl + 1),
    };
  });

  let manualLinkActive = false;
  if (workIssue !== undefined && workIssue !== null) {
    const timelinePath = restPath("issues", repo, workIssue) + "/timeline";
    const events = callRestPages(timelinePath, execFileImpl);
    const linkEvents = [];
    for (const ev of events) {
      if (ev === null || typeof ev !== "object") {
        throw new Error(`GitHub REST timeline for ${timelinePath} contains a malformed event`);
      }
      if (ev.event !== "connected" && ev.event !== "disconnected") continue;
      const subject = ev.subject;
      // The REST timeline subject carries `url` (e.g. https://api.github.com/repos/o/r/pulls/9) and `type`.
      const m = typeof subject?.url === "string"
        ? /\/repos\/([^/]+\/[^/]+)\/(?:pulls|issues)\/([0-9]+)\/?$/.exec(subject.url)
        : null;
      if (m === null || !Number.isInteger(ev.id)) {
        throw new Error(
          `GitHub REST timeline for ${timelinePath} has a ${ev.event} event with an unreadable subject or id; ` +
            `current link state is ambiguous`,
        );
      }
      const subjectRepo = m[1];
      const subjectNumber = Number(m[2]);
      if (subjectNumber === Number(number) && subjectRepo.toLowerCase() === String(repo ?? "").toLowerCase()) {
        linkEvents.push(ev);
      }
    }
    // Ordered by monotonically increasing event id; the latest event for this exact PR<->Issue
    // pair decides whether the link is currently active.
    linkEvents.sort((a, b) => a.id - b.id);
    const last = linkEvents[linkEvents.length - 1];
    manualLinkActive = last?.event === "connected";
  }

  return { body, commits, manualLinkActive };
}
