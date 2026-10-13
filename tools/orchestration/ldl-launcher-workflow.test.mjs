// Static inspection of .github/workflows/ldl-launcher.yml (issue #1094): the control-issue-only
// workflow_dispatch request keeps the workflow's trust posture. No YAML dependency: textual checks.
//
// Tests: node --test tools/orchestration/ldl-launcher-workflow.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const yml = readFileSync(new URL("../../.github/workflows/ldl-launcher.yml", import.meta.url), "utf8");
const onBlock = yml.slice(yml.indexOf("\non:") + 1, yml.indexOf("\npermissions:"));

test("triggers: issue_comment and workflow_dispatch only; no PR or fork-reachable trigger", () => {
  assert.match(onBlock, /issue_comment:/);
  assert.match(onBlock, /workflow_dispatch:/);
  assert.doesNotMatch(onBlock, /pull_request|pull_request_target|workflow_run|schedule|push:/);
});

test("dispatch form: control_issue is the only required input; nonce is optional legacy", () => {
  const inputs = onBlock.slice(onBlock.indexOf("inputs:"));
  assert.match(inputs, /control_issue:\s*\n\s+description:[^\n]*\n\s+required: true/);
  assert.match(inputs, /nonce:\s*\n\s+description:[^\n]*\n\s+required: false/);
  assert.deepEqual([...inputs.matchAll(/^ {6}(\w+):$/gm)].map((m) => m[1]), ["control_issue", "nonce"]);
});

test("dispatch trust: actor permission, default-branch ref, fork flag come from event context and the module", () => {
  for (const s of ["github.triggering_actor", "github.ref", "github.event.repository.default_branch", "github.event.repository.fork"]) {
    assert.ok(yml.includes(s), s);
  }
  assert.match(yml, /verifyDispatchLaunchRequest/);
  assert.match(yml, /resolveDispatchExecution/);
  assert.match(yml, /collaborators\/\$\{login\}\/permission/);
  // The execution issue is never read from an input.
  assert.doesNotMatch(yml, /inputs\.(execution|objective|actor|permission)/i);
});

test("non-default-ref dispatch guard is hygiene; secret is environment-scoped (Audit #1096, #1097 Stage 1)", () => {
  // Exactly one job; its `if` is evaluated before checkout or any step, so a dispatch selected on
  // a non-default ref never runs repository code or touches a credential.
  const jobs = yml.slice(yml.indexOf("\njobs:"));
  assert.deepEqual([...jobs.matchAll(/^ {2}([\w-]+):\s*$/gm)].map((m) => m[1]), ["authorize-and-claim"]);
  const job = jobs.slice(jobs.indexOf("authorize-and-claim:"));
  const guard = /\n {4}if: >-\n([\s\S]*?)\n {4}runs-on:/.exec(job);
  assert.ok(guard, "job-level if precedes runs-on and steps");
  assert.ok(job.indexOf("\n    if: >-") < job.indexOf("steps:"));
  const cond = guard[1].replace(/\s+/g, " ");
  assert.match(cond, /github\.event_name == 'workflow_dispatch' && github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  // The dispatch clause is the ref-guarded one only: no bare workflow_dispatch disjunct remains.
  const dispatchClauses = cond.split("||").filter((c) => c.includes("'workflow_dispatch'"));
  assert.equal(dispatchClauses.length, 1);
  assert.match(dispatchClauses[0], /github\.ref ==/);
  // Checkout does not select a ref other than the (default-branch) triggering one.
  assert.doesNotMatch(yml, /uses: actions\/checkout@v4\n\s+with:\n(?:\s+[a-z-]+:[^\n]*\n)*?\s+ref:/);
  // The guard is hygiene only; the real boundary is the default-branch-restricted environment.
  assert.match(job, /\n {4}environment: ldl-launcher\n/);
  assert.match(yml, /not a trust boundary/);
  assert.doesNotMatch(yml, /Trust boundary \(Audit/);
  // The credential-bearing steps all live inside the guarded job (no step before the guard).
  assert.ok(job.indexOf("steps:") > job.indexOf("if: >-"));
});

test("event-derived values reach the script only through env; no secret echoed; least privilege kept", () => {
  const script = yml.slice(yml.indexOf("node --input-type=module"));
  assert.doesNotMatch(script, /\$\{\{/);
  assert.doesNotMatch(script, /console\.log\([^)]*(workerToken|launchToken|OAUTH)/);
  assert.match(yml, /^permissions:\n {2}contents: write\n {2}pull-requests: write\n {2}issues: write\n {2}actions: read\n/m);
  assert.match(yml, /persist-credentials: false/);
});

test("request record precedes the claim; the claim is settled only after the supervisor returns", () => {
  const i = (s) => yml.indexOf(s);
  assert.ok(i("renderDispatchLaunchRecord({") < i("const body = renderClaimBody"));
  assert.ok(i("const body = renderClaimBody") < i("\"tools/orchestration/launcher-run.mjs\""));
  assert.ok(i("\"tools/orchestration/launcher-run.mjs\"") < i('phase: "DONE"'));
});

test("embedded script is syntactically valid", () => {
  const m = /node --input-type=module <<'JS'\n([\s\S]*?)\n\s*JS\n/.exec(yml);
  assert.ok(m);
  const dedented = m[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
  const dir = mkdtempSync(join(tmpdir(), "ldl-wf-"));
  const f = join(dir, "script.mjs");
  writeFileSync(f, dedented);
  execFileSync(process.execPath, ["--check", f]);
});

// Issue #1102: GitHub's string IS_FORK must reach verifyDispatchLaunchRequest as Boolean false only
// for the exact value "false" (live run 38279182565 was refused as a fork because the mapping was inverted).
const forkExpr = (src) => {
  const m = /isFork:\s*(env\.IS_FORK[^,]*),/.exec(src);
  assert.ok(m, "isFork mapping present");
  return m[1];
};
const trustedFor = async (src, isForkEnv) => {
  const { verifyDispatchLaunchRequest } = await import("./launch-authorization.mjs");
  const env = isForkEnv === undefined ? {} : { IS_FORK: isForkEnv };
  const isFork = new Function("env", `return (${forkExpr(src)});`)(env);
  return verifyDispatchLaunchRequest({
    name: "workflow_dispatch", action: "dispatch", actor: "someone", actorPermission: "admin", isFork,
    ref: "refs/heads/main", defaultBranch: "main", inputs: { control_issue: "395" },
  }).trusted;
};

test("fork flag normalization: only exact \"false\" is trusted; everything else fails closed", async () => {
  assert.equal(await trustedFor(yml, "false"), true);
  for (const bad of ["true", "", undefined, "False", "0", "no", " false", "garbage"]) {
    assert.equal(await trustedFor(yml, bad), false, `IS_FORK=${JSON.stringify(bad)}`);
  }
});

test("fork flag normalization regression: the old inversion and a trust-by-default mapping are caught", async () => {
  const inverted = yml.replace('env.IS_FORK !== "false"', 'env.IS_FORK === "false"');
  assert.notEqual(inverted, yml);
  assert.equal(await trustedFor(inverted, "false"), false);
  const permissive = yml.replace('env.IS_FORK !== "false"', 'env.IS_FORK === "true"');
  assert.equal(await trustedFor(permissive, "garbage"), true); // would be wrongly trusted: the suite above rejects it
});

// Issue #1108: runner isolation preflight (bubblewrap/socat + functional probe) before the worker.
const iso = (src) => {
  const a = src.indexOf("// Runner isolation preflight");
  const b = src.indexOf("if (!requestMode) execFileSync(\"gh\", [\"auth\", \"setup-git\"]");
  assert.ok(a > 0 && b > a, "preflight block present");
  return src.slice(a, b);
};

test("isolation preflight: ordered after claim and CLI install, before the worker launch", () => {
  const i = (s) => yml.indexOf(s);
  assert.ok(i("const body = renderClaimBody") < i("Runner isolation preflight"));
  assert.ok(i("@anthropic-ai/claude-code@2.1.285") < i("Runner isolation preflight"));
  assert.ok(i("Runner isolation preflight") < i("\"tools/orchestration/launcher-run.mjs\""));
  assert.ok(i("RUNNER ISOLATION PREFLIGHT FAILED") < i("\"tools/orchestration/launcher-run.mjs\""));
});

test("isolation preflight: installs bubblewrap+socat, then a functional unprivileged bwrap probe", () => {
  const b = iso(yml);
  assert.match(b, /"apt-get", "install", "-y", "-qq", "bubblewrap", "socat"/);
  assert.match(b, /iso\("bwrap", \["--version"\]/);
  assert.match(b, /iso\("socat", \["-V"\]/);
  const probe = /iso\("bwrap", \["--unshare-all"[^\n]*\n/.exec(b);
  assert.ok(probe, "functional bwrap probe");
  assert.doesNotMatch(probe[0], /sudo/);
  assert.ok(b.indexOf("apt-get\", \"install") < b.indexOf("--unshare-all"));
});

test("isolation preflight: credential-free env, timeouts, fail closed by dropping the credential", () => {
  const b = iso(yml);
  assert.match(b, /const isoEnv = \{\};[\s\S]*?for \(const k of \["PATH"[^\]]*\]\)/);
  assert.doesNotMatch(b.slice(b.indexOf("const isoEnv"), b.indexOf("const iso =")), /GH_TOKEN|GITHUB_TOKEN|\.\.\.process\.env/);
  assert.match(b, /timeout/);
  assert.match(b, /RUNNER ISOLATION PREFLIGHT FAILED[\s\S]*launchToken = undefined;/);
  assert.doesNotMatch(b, /console\.log\([^)]*(workerToken|launchToken)/);
});

test("isolation preflight: never weakens isolation (no scrub disable, sysctl, AppArmor change)", () => {
  assert.doesNotMatch(yml, /SUBPROCESS_ENV_SCRUB\s*[=:]\s*["']?0/);
  const b = iso(yml).replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(b, /sysctl|aa-complain|aa-disable|apparmor_parser|unconfined|userns_clone=1|restrict_unprivileged_userns=0/i);
  assert.doesNotMatch(b, /writeFileSync|"tee"/);
  // The only AppArmor reference is a read-only diagnostic.
  assert.match(b, /readFileSync\("\/proc\/sys\/kernel\/apparmor_restrict_unprivileged_userns"/);
});

// Mutation cases: exercise the extracted block with a mocked execFileSync.
const runPreflight = (failAt) => {
  const b = iso(yml);
  const calls = [];
  const logs = [];
  const execFileSync = (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (failAt && calls.at(-1).includes(failAt)) throw new Error(`boom ${failAt}\nmore`);
    return "";
  };
  const readFileSync = () => "1";
  const process = { env: { PATH: "x", LDL_WORKER_CLAUDE_OAUTH_TOKEN: "secret" } };
  const fn = new Function("execFileSync", "readFileSync", "process", "console", "let launchToken = 'tok'; if (true) { if (launchToken) {\n" + b + "\nreturn launchToken;");
  const result = fn(execFileSync, readFileSync, process, { log: (m) => logs.push(m) });
  return { result, calls, logs };
};

test("isolation preflight mocks: success keeps the credential; any step failure drops it with a specific diagnosis", () => {
  const ok = runPreflight();
  assert.equal(ok.result, "tok");
  assert.match(ok.logs.join("\n"), /PREFLIGHT PASSED/);
  for (const failAt of ["apt-get install", "bwrap --version", "socat -V", "--unshare-all"]) {
    const r = runPreflight(failAt);
    assert.equal(r.result, undefined, failAt);
    assert.match(r.logs.join("\n"), /RUNNER ISOLATION PREFLIGHT FAILED: boom/);
    assert.doesNotMatch(r.logs.join("\n"), /secret|tok\b/);
  }
});

// Issue #1118 unit C (#1120 Q1=A): read-only diagnostics on the trusted failed-preflight path only.
const diagCode = () => {
  const b = iso(yml);
  const at = b.indexOf("// Read-only host diagnostics");
  assert.ok(at > 0, "diagnostics block present");
  const endMarker = "apparmor_denied=${capJson(denied, 4000)}`;";
  const end = b.indexOf(endMarker, at);
  assert.ok(end > at, "diagnostics block end");
  return { all: b, diag: b.slice(at, end + endMarker.length), before: b.slice(0, at), after: b.slice(end + endMarker.length) };
};

test("isolation diagnostics: only in the failure path, after the unchanged FAILED line and credential drop", () => {
  const { all, diag, before, after } = diagCode();
  assert.ok(all.indexOf("RUNNER ISOLATION PREFLIGHT PASSED") < all.indexOf("} catch (e) {"));
  assert.ok(all.indexOf("} catch (e) {") < all.indexOf("RUNNER ISOLATION DIAGNOSTICS"));
  assert.doesNotMatch(before.slice(0, before.indexOf("} catch (e) {")), /DIAGNOSTICS|dmesg|aa-status/);
  assert.match(before, /RUNNER ISOLATION PREFLIGHT FAILED/);
  assert.match(all, /iso\("bwrap", \["--unshare-all", "--ro-bind", "\/", "\/", "--dev", "\/dev", "--proc", "\/proc", "true"\], 30000\)/);
  assert.match(all, /launchToken = undefined;[^\n]*\n\s*\/\/ Read-only host diagnostics/);
  assert.doesNotMatch(after.split("} else {")[0], /launchToken/);
  assert.ok(diag.length > 0);
});

test("isolation diagnostics: credential-free env, read-only commands, no capture of env/secrets or host logs", () => {
  const { diag } = diagCode();
  const code = diag.replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /env: isoEnv/);
  assert.doesNotMatch(code, /process\.env|workerToken|launchToken|OAUTH|GITHUB_TOKEN|secret/i);
  assert.doesNotMatch(code, /"sudo"|\benv\b\s*"|printenv|"cat"|journalctl|syslog|\/var\/log/);
  const cmds = [...code.matchAll(/fact\("([\w-]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(cmds)].sort(), ["aa-status", "dmesg", "dpkg-query", "ls", "sha256sum", "uname"]);
  // No profile load/copy/remove, sysctl/userns change, share-net, scrub disable, or writes.
  assert.doesNotMatch(code, /apparmor_parser|aa-enforce|aa-complain|aa-disable|sysctl|\bcp\b|\bmv\b|\brm\b|writeFileSync|"tee"|--share-net|SCRUB|userns_clone|restrict_unprivileged_userns=0/);
});

test("isolation diagnostics mocks: emitted only on failure; unavailable facts tolerated; no credential in output", () => {
  const ok = runPreflight();
  assert.doesNotMatch(ok.logs.join("\n"), /DIAGNOSTICS/);
  const r = runPreflight("--unshare-all");
  const out = r.logs.join("\n");
  assert.equal(r.result, undefined);
  assert.match(out, /RUNNER ISOLATION PREFLIGHT FAILED: boom/);
  assert.match(out, /RUNNER ISOLATION DIAGNOSTICS \(read-only\)/);
  assert.doesNotMatch(out, /secret|\btok\b/);
  // Every diagnostic command ran with a credential-free env (mock records only args; check source).
  assert.doesNotMatch(r.calls.join("\n"), /sudo (?!apt-get|npm)/);
});

test("isolation diagnostics mocks: permission-denied or absent facts become unavailable, not failures", () => {
  const b = iso(yml);
  const logs = [];
  const execFileSync = (cmd, args) => {
    if (["--unshare-all"].some((x) => args.includes(x))) throw new Error("boom probe");
    if (["dmesg", "aa-status", "sha256sum", "ls", "dpkg-query"].includes(cmd)) throw new Error("denied");
    if (cmd === "uname") return "6.8.0-test\n";
    return "";
  };
  const readFileSync = (p) => { if (p.includes("userns")) return "1"; throw new Error("ENOENT"); };
  const fn = new Function("execFileSync", "readFileSync", "process", "console", "let launchToken = 'tok'; if (true) { if (launchToken) {\n" + b + "\nreturn launchToken;");
  const result = fn(execFileSync, readFileSync, { env: { PATH: "x", LDL_WORKER_CLAUDE_OAUTH_TOKEN: "secret" } }, { log: (m) => logs.push(m) });
  assert.equal(result, undefined);
  const d = logs.find((l) => l.includes("DIAGNOSTICS"));
  assert.match(d, /os=unavailable/);
  assert.match(d, /kernel=6\.8\.0-test/);
  assert.match(d, /aa-status="unavailable"/);
  assert.match(d, /apparmor_denied="unavailable"/);
  assert.match(d, /bwrap_profile_names="unavailable"/);
  assert.match(d, /bwrap-userns-restrict=unavailable/);
});

test("isolation diagnostics mocks: denial lines beyond a 4 KB dmesg prefix are still found; env excludes job token", () => {
  const b = iso(yml);
  const logs = [];
  const envs = [];
  const big = "x kernel noise line\n".repeat(1000) + 'audit: apparmor="DENIED" operation="userns_create" comm="bwrap"\n';
  const execFileSync = (cmd, args, opts) => {
    envs.push(opts && opts.env);
    if (args.includes("--unshare-all")) throw new Error("boom probe");
    if (cmd === "dmesg") return big;
    return "";
  };
  const readFileSync = (p) => { if (p.includes("userns")) return "1"; throw new Error("ENOENT"); };
  const fn = new Function("execFileSync", "readFileSync", "process", "console", "let launchToken = 'tok'; if (true) { if (launchToken) {\n" + b + "\nreturn launchToken;");
  fn(execFileSync, readFileSync, { env: { PATH: "x", GH_TOKEN: "ghs_job", GITHUB_TOKEN: "ghs_job2", LDL_WORKER_CLAUDE_OAUTH_TOKEN: "secret" } }, { log: (m) => logs.push(m) });
  const d = logs.find((l) => l.includes("DIAGNOSTICS"));
  assert.match(d, /apparmor_denied=\["audit: apparmor=\\"DENIED\\"[^\]]*bwrap/);
  for (const e of envs.filter(Boolean)) assert.deepEqual(Object.keys(e), ["PATH"]);
});

test("isolation diagnostics mocks: oversized os-release, userns and fact values keep the whole diagnostics line bounded", () => {
  const b = iso(yml);
  const logs = [];
  const huge = "Z".repeat(500000);
  const execFileSync = (cmd, args) => {
    if (args.includes("--unshare-all")) throw new Error("boom probe");
    return huge;
  };
  const readFileSync = (p) => {
    if (p.includes("userns")) return huge;
    if (p.includes("os-release")) return "PRETTY_NAME=" + huge + "\nVERSION_ID=" + huge + "\n";
    throw new Error("ENOENT");
  };
  const fn = new Function("execFileSync", "readFileSync", "process", "console", "let launchToken = 'tok'; if (true) { if (launchToken) {\n" + b + "\nreturn launchToken;");
  fn(execFileSync, readFileSync, { env: { PATH: "x" } }, { log: (m) => logs.push(m) });
  const d = logs.find((l) => l.includes("DIAGNOSTICS"));
  assert.ok(d.length <= 16000, "diagnostics line " + d.length + " exceeds cap");
  const failed = logs.find((l) => l.includes("PREFLIGHT FAILED"));
  assert.ok(failed.length < 2000, "FAILED line stays bounded");
  assert.ok(!/Z{4001}/.test(d), "no run beyond the per-value cap");
});

test("isolation diagnostics mocks: oversized earlier fields never starve the trailing apparmor_denied evidence (#1118)", () => {
  const b = iso(yml);
  const logs = [];
  const longName = "bwrap-" + "n".repeat(390);
  const execFileSync = (cmd, args) => {
    if (args.includes("--unshare-all")) throw new Error("boom probe");
    if (cmd === "ls") return Array.from({ length: 40 }, () => longName).join("\n");
    if (cmd === "aa-status") return "A".repeat(500000);
    if (cmd === "dpkg-query") return "P".repeat(500000);
    if (cmd === "dmesg") return 'apparmor="DENIED" operation="userns_create" profile="bwrap-userns-restrict"';
    return "x";
  };
  const readFileSync = () => { throw new Error("ENOENT"); };
  const fn = new Function("execFileSync", "readFileSync", "process", "console", "let launchToken = 'tok'; if (true) { if (launchToken) {\n" + b + "\nreturn launchToken;");
  fn(execFileSync, readFileSync, { env: { PATH: "x" } }, { log: (m) => logs.push(m) });
  const d = logs.find((l) => l.includes("DIAGNOSTICS"));
  assert.ok(d.length <= 16000);
  assert.match(d, /apparmor_denied=\["apparmor=\\"DENIED\\"[^\]]*userns_create/);
});
