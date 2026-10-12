// Trusted launch boundary for issue #73 (unit 73-A). Pure functions only.
//
// A `## Launch Authorization (v1)` comment on the CONTROL issue, authored by an actor with
// repository write/admin permission, records a launch REQUEST (consent, target, nonce). It is
// NOT execution authority: a comment can never itself authorize repository mutation (AGENTS.md
// § Execution authority boundary; tools/orchestration/execution-authority-gate.mjs). Mutation
// authority is the current execution-authority envelope derived from the gate verdict, checked by
// launcher-step.mjs's authorizeLauncherVerdict, which also requires the verdict to name the same
// execution issue this request names. A launch trigger event is trusted only when it comes from
// the same repository (never a fork), from a write-permission actor, on the control issue named by
// the request, and carries the nonce.
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
// Returns { status: "LAUNCH_REQUESTED" | "NONE" | "AMBIGUOUS", authorization?, reason }.
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
  return { status: "LAUNCH_REQUESTED", authorization: valid[0], reason: "single valid launch request (not execution authority)" };
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

// ---------------------------------------------------------------------------------------------
// Dispatch launch request (issue #1094). An ordinary Actions "Run workflow" press carrying ONLY a
// control issue number is itself the launch REQUEST: the authenticated GitHub actor who pressed it
// is the initiator, verified against live repository permission. Nothing the caller types (execution
// issue, objective, permission, nonce) is trusted. The sole current execution issue is resolved
// from the canonical gate verdict for the control issue, and the request is bound to a unique
// request identity derived from the Actions run id. Like a comment, this is a REQUEST only: mutation
// authority still comes from the gate verdict's execution-authority envelope
// (launcher-step.mjs authorizeLauncherVerdict). The legacy comment + nonce route is unchanged.
// ---------------------------------------------------------------------------------------------

export const LAUNCH_REQUEST_HEADING = "## Launch Request (v1)";
const POSITIVE_INT = /^[1-9]\d{0,9}$/;
// The caller supplies `launchableStates`: exactly the verdict states launcher-step.mjs consumes
// (Object.keys(TRANSITIONS) plus OPEN_PATH_STATES). Injected, not imported, because launcher-step's
// import graph reaches this module. Controller-only states (e.g. PR_BREAKPOINT_NEEDS_FINALIZATION)
// and an absent allowlist are refused (fail closed).

// event: { name, action, actor, actorPermission, isFork, ref, defaultBranch, inputs }.
// Trusted only for an explicit same-repo workflow_dispatch from the repository default branch's
// code, by an actor whose CURRENT permission (read back from GitHub) is write/maintain/admin, whose
// only input is a well-formed control issue number. Returns { trusted, reason, controlIssue? }.
export function verifyDispatchLaunchRequest(event) {
  const no = (reason) => ({ trusted: false, reason });
  if (!event || typeof event !== "object") return no("no event");
  if (event.name !== "workflow_dispatch" || event.action !== "dispatch") return no("not an explicit workflow_dispatch");
  if (event.isFork !== false) return no("fork or unknown-origin event");
  if (typeof event.actor !== "string" || event.actor.trim() === "") return no("no authenticated actor");
  if (!hasWritePermission(event.actorPermission)) return no("actor lacks write permission");
  if (typeof event.defaultBranch !== "string" || event.defaultBranch === "" || event.ref !== `refs/heads/${event.defaultBranch}`) {
    return no("dispatch did not run the default-branch workflow");
  }
  const raw = event.inputs?.control_issue;
  if (typeof raw !== "string" || !POSITIVE_INT.test(raw)) {
    // Raw value must match exactly: the workflow concurrency key uses the untrimmed input.
    return no("control_issue must be a positive issue number");
  }
  return { trusted: true, reason: "write-permission actor, same-repo default-branch dispatch", controlIssue: Number(raw) };
}

// Pure. verdict: the control-plane session-entry gate's JSON for this control issue. Resolves the
// single current execution issue the verdict itself names; every reference it carries must agree
// and its control identity must be exactly the requested one. Fails closed otherwise.
export function resolveDispatchExecution(verdict, { controlIssue, launchableStates } = {}) {
  const no = (reason) => ({ status: "REFUSED", reason });
  if (!Number.isInteger(controlIssue) || controlIssue <= 0) return no("controlIssue must be a positive integer");
  if (!verdict || typeof verdict !== "object" || typeof verdict.state !== "string") return no("gate returned no verdict state");
  if (!(launchableStates instanceof Set) || !launchableStates.has(verdict.state)) return no(`control is not launchable (${verdict.state})`);
  if (!POSITIVE_INT.test(String(verdict.controlIssue ?? ""))) return no("verdict names no control issue");
  if (Number(verdict.controlIssue) !== controlIssue) return no("verdict belongs to a different control issue");
  const refs = new Set();
  for (const k of ["executionIssue", "workIssue", "issue"]) {
    if (verdict[k] == null) continue;
    if (!POSITIVE_INT.test(String(verdict[k]))) return no(`verdict ${k} is malformed`);
    refs.add(Number(verdict[k]));
  }
  if (refs.size === 0) return no("verdict names no current execution issue");
  if (refs.size > 1) return no("verdict names competing execution issues");
  const executionIssue = [...refs][0];
  if (executionIssue === controlIssue) return no("execution issue equals the control issue");
  return { status: "RESOLVED", executionIssue, state: verdict.state };
}

// Pure. The request identity is unique per Actions run (never reused across dispatches), so a
// duplicate press is a new request but a re-run of the same run keeps the same request nonce and is
// stopped as REPLAY by planClaim once settled. Shape matches parseLaunchAuthorization's output.
export function buildDispatchAuthorization({ controlIssue, executionIssue, initiator, runId } = {}) {
  if (!Number.isInteger(controlIssue) || controlIssue <= 0) return null;
  if (!Number.isInteger(executionIssue) || executionIssue <= 0) return null;
  if (typeof initiator !== "string" || initiator.trim() === "") return null;
  if (!/^\d+$/.test(String(runId ?? ""))) return null;
  return {
    commentId: null,
    controlIssue,
    executionIssue,
    objective: `Execution #${executionIssue} under control #${controlIssue}`,
    authorizedBy: initiator.trim(),
    nonce: `dispatch-${runId}`,
  };
}

// Pure. Durable, auditable record of an accepted dispatch request. Not an authorization: the
// heading differs from LAUNCH_AUTHORIZATION_HEADING, so parseLaunchAuthorization never reads it.
export function renderDispatchLaunchRecord({ authorization, attemptId, state, requestedAt } = {}) {
  return [
    LAUNCH_REQUEST_HEADING,
    "",
    "- **Source:** workflow_dispatch (control issue only)",
    `- **Initiator:** ${authorization.authorizedBy}`,
    `- **Control issue:** #${authorization.controlIssue}`,
    `- **Execution issue:** #${authorization.executionIssue}`,
    `- **Gate state:** ${String(state ?? "").replace(/[^A-Z_]/g, "")}`,
    `- **Attempt id:** ${attemptId}`,
    `- **Request nonce:** ${authorization.nonce}`,
    `- **Requested at:** ${requestedAt}`,
    "",
    "A launch request, not execution authority; mutation authority is the current gate verdict's execution-authority envelope.",
    "",
  ].join("\n");
}
