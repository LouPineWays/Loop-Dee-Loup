// Trusted launch boundary for issue #73 (unit 73-A). Pure functions only.
//
// Authority comes ONLY from one fixed-heading durable comment on the CONTROL issue,
// `## Launch Authorization (v1)`, authored by an actor with repository write/admin
// permission. Prose elsewhere is never authority (AGENTS.md § Execution authority
// boundary; tools/orchestration/execution-authority-gate.mjs). A launch trigger event
// is trusted only when it comes from the same repository (never a fork), from a
// write-permission actor, on the authorized control issue, and carries the nonce.
//
// Tests: node --test tools/orchestration/launch-authorization.test.mjs

export const LAUNCH_AUTHORIZATION_HEADING = "## Launch Authorization (v1)";
export const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);

export function hasWritePermission(permission) {
  return typeof permission === "string" && WRITE_PERMISSIONS.has(permission.toLowerCase());
}

// Pure. Reads `- **Field:** value` bullets into a map keyed by field name.
export function parseBoldBullets(body) {
  const fields = new Map();
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const m = /^\s*[-*]\s+\*\*([^*:]+):\*\*\s*(.*?)\s*$/.exec(line);
    if (m && !fields.has(m[1].trim())) fields.set(m[1].trim(), m[2].trim());
  }
  return fields;
}

function parseIssueRef(value) {
  const m = /^#?(\d+)$/.exec(String(value ?? "").trim());
  return m ? Number(m[1]) : null;
}

function firstNonBlankLine(body) {
  return String(body ?? "").split(/\r?\n/).find((l) => l.trim() !== "")?.trim();
}

// comments: [{ id, body, authorPermission }]. authorPermission is the repository
// permission of the comment author as read back from GitHub, never self-declared text.
// Returns { status: "AUTHORIZED" | "NONE" | "AMBIGUOUS", authorization?, reason }.
export function parseLaunchAuthorization(comments, { controlIssue } = {}) {
  if (!Number.isInteger(controlIssue) || controlIssue <= 0) {
    return { status: "NONE", reason: "controlIssue must be a positive integer" };
  }
  const valid = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    if (firstNonBlankLine(c?.body) !== LAUNCH_AUTHORIZATION_HEADING) continue;
    if (!hasWritePermission(c.authorPermission)) continue; // untrusted author: not authority
    const f = parseBoldBullets(c.body);
    if (parseIssueRef(f.get("Control issue")) !== controlIssue) continue;
    const executionIssue = parseIssueRef(f.get("Execution issue"));
    const objective = f.get("Authorized objective");
    const authorizedBy = f.get("Authorized by");
    const nonce = f.get("Nonce");
    if (!executionIssue || !objective || !authorizedBy || !nonce || !/^[A-Za-z0-9._-]{8,}$/.test(nonce)) continue;
    valid.push({ commentId: c.id, controlIssue, executionIssue, objective, authorizedBy, nonce });
  }
  if (valid.length === 0) return { status: "NONE", reason: "no valid Launch Authorization comment" };
  const distinct = new Set(valid.map((a) => `${a.nonce}|${a.executionIssue}|${a.objective}`));
  if (distinct.size > 1) {
    return { status: "AMBIGUOUS", reason: "multiple conflicting Launch Authorization comments" };
  }
  return { status: "AUTHORIZED", authorization: valid[0], reason: "single valid authorization" };
}

// event: { name, action, actor, actorPermission, isFork, isPullRequest, issueNumber,
//          commentBody, inputs }. Returns { trusted, reason }.
// Comment trigger form: `/ldl launch <nonce>` as the first line. workflow_dispatch
// supplies the nonce via inputs.nonce. Fails closed on any missing or unexpected field.
export function verifyTrustedTrigger(event, { authorization } = {}) {
  const no = (reason) => ({ trusted: false, reason });
  if (!authorization || !authorization.nonce) return no("no launch authorization");
  if (!event || typeof event !== "object") return no("no event");
  if (event.isFork !== false) return no("fork or unknown-origin event");
  if (!hasWritePermission(event.actorPermission)) return no("actor lacks write permission");
  let nonce;
  if (event.name === "issue_comment") {
    if (event.action !== "created") return no("only created comments trigger");
    if (event.isPullRequest !== false) return no("PR comments never trigger");
    if (event.issueNumber !== authorization.controlIssue) return no("comment is not on the authorized control issue");
    const m = /^\/ldl launch\s+(\S+)\s*$/.exec(firstNonBlankLine(event.commentBody) ?? "");
    nonce = m?.[1];
  } else if (event.name === "workflow_dispatch") {
    if (Number(event.inputs?.control_issue) !== authorization.controlIssue) return no("dispatch targets a different control issue");
    nonce = event.inputs?.nonce;
  } else {
    return no(`event ${String(event.name)} is not a launch trigger`);
  }
  if (nonce !== authorization.nonce) return no("nonce does not match the authorization");
  return { trusted: true, reason: "trusted actor, same-repo event, matching nonce" };
}
