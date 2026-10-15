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

test("dispatch form: control_issue is the only required input; nonce is optional legacy; diagnostic_only defaults off", () => {
  const inputs = onBlock.slice(onBlock.indexOf("inputs:"));
  assert.match(inputs, /control_issue:\s*\n\s+description:[^\n]*\n\s+required: true/);
  assert.match(inputs, /nonce:\s*\n\s+description:[^\n]*\n\s+required: false/);
  assert.deepEqual([...inputs.matchAll(/^ {6}(\w+):$/gm)].map((m) => m[1]), ["control_issue", "nonce", "diagnostic_only", "post_install_diagnostic", "post_install_runner", "worker_runner", "qualification_only"]);
  assert.match(inputs, /post_install_diagnostic:\s*\n\s+description:[^\n]*\n\s+type: boolean\n\s+required: false\n\s+default: false/);
  assert.match(inputs, /diagnostic_only:\s*\n\s+description:[^\n]*\n\s+type: boolean\n\s+required: false\n\s+default: false/);
  assert.match(inputs, /post_install_runner:\s*\n\s+description:[^\n]*\n\s+type: choice\n\s+required: false\n\s+default: ubuntu-latest\n\s+options:\n\s+- ubuntu-latest\n\s+- ubuntu-22\.04\n/);
  assert.match(inputs, /worker_runner:\s*\n\s+description:[^\n]*\n\s+type: choice\n\s+required: false\n\s+default: ubuntu-latest\n\s+options:\n\s+- ubuntu-latest\n\s+- ubuntu-22\.04\n/);
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
  assert.deepEqual([...jobs.matchAll(/^ {2}([\w-]+):\s*$/gm)].map((m) => m[1]), ["authorize-and-claim", "isolation-diagnostic", "post-install-isolation-diagnostic", "claude-qualification"]);
  const job = jobs.slice(jobs.indexOf("authorize-and-claim:"), jobs.indexOf("\n  isolation-diagnostic:"));
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
  // The only expression allowed after the first script is the allowlisted post-install runner ternary (issue #1150).
  const script = yml.slice(yml.indexOf("node --input-type=module"), yml.indexOf("\n  # One-shot Claude qualification entry point")).replace(/^ {4}runs-on: \$\{\{ inputs\.post_install_runner == 'ubuntu-22\.04' && 'ubuntu-22\.04' \|\| 'ubuntu-latest' \}\}$/m, "");
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
    if (args.includes("--unshare-all")) throw new Error("boom probe " + huge);
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
  assert.ok(failed.length < 2000, "FAILED line stays bounded with an oversized single-line exception: " + failed.length);
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

// Issue #1139: credential-free, no-worker hosted isolation diagnostic route in the same workflow file.
const jobsText = yml.slice(yml.indexOf("\njobs:"));
const launchJob = jobsText.slice(jobsText.indexOf("  authorize-and-claim:"), jobsText.indexOf("\n  isolation-diagnostic:"));
const diagJob = jobsText.slice(jobsText.indexOf("  isolation-diagnostic:"), jobsText.indexOf("\n  # Post-install diagnostic entry point"));
const postJob = jobsText.slice(jobsText.indexOf("  post-install-isolation-diagnostic:"), jobsText.indexOf("\n  # One-shot Claude qualification entry point"));
const qualJob = jobsText.slice(jobsText.indexOf("  claude-qualification:"));
const diagScript = () => {
  const m = /<<'DIAG'\n([\s\S]*?)\n\s*DIAG\n/.exec(diagJob);
  assert.ok(m, "diagnostic script present");
  return m[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
};
const diagCond = (job) => /\n {4}if: >-\n([\s\S]*?)\n {4}runs-on:/.exec(job)[1].replace(/\s+/g, " ");

// Evaluate the two job-level `if` expressions over a small context (the only operators used).
const evalIf = (cond, ctx) => {
  const js = cond
    .replace(/format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/g, "('refs/heads/' + ctx.default)")
    .replace(/github\.event\.issue\.pull_request == null/g, "ctx.pr === null")
    .replace(/startsWith\(github\.event\.comment\.body, '([^']*)'\)/g, "ctx.body.startsWith('$1')")
    .replace(/github\.event_name/g, "ctx.event")
    .replace(/github\.ref/g, "ctx.ref")
    .replace(/inputs\.post_install_diagnostic/g, "ctx.post")
    .replace(/inputs\.qualification_only/g, "ctx.qual")
    .replace(/inputs\.control_issue/g, "ctx.control")
    .replace(/inputs\.diagnostic_only/g, "ctx.diag");
  return new Function("ctx", `return Boolean(${js});`)(ctx);
};

test("diagnostic route: a separate job with no environment, no checkout, empty token permissions, bounded time", () => {
  assert.match(diagJob, /\n {4}permissions: \{\}\n/);
  assert.doesNotMatch(diagJob, /\n {4}environment:/);
  assert.doesNotMatch(diagJob, /secrets\.|\$\{\{\s*github\.token|GITHUB_TOKEN|GH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|LDL_WORKER/);
  assert.doesNotMatch(diagJob, /actions\/checkout|uses:/);
  assert.match(diagJob, /timeout-minutes: 10/);
  assert.doesNotMatch(diagJob, /\n\s+needs:/);
  // Exactly one step, and it only runs the embedded read-only script.
  assert.equal([...diagJob.matchAll(/^ {6}- name:/gm)].length, 1);
  // No expression interpolation reaches the script text.
  assert.doesNotMatch(diagScript(), /\$\{\{/);
});

test("diagnostic route: no pathway to launch, claim, install, worker, or GitHub write", () => {
  const code = diagScript().replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /launcher-run|launch-authorization|attempt-claim|launcher-step|control-plane-bootstrap|session-entry-gate|"gh"|"git"|"npm"|"sudo"|"apt-get"|claude|renderClaimBody|auth setup-git/i);
  assert.doesNotMatch(code, /process\.env\s*[,)}]|\.\.\.process\.env|OAUTH|TOKEN|secret/i);
  assert.doesNotMatch(code, /sysctl|apparmor_parser|aa-enforce|aa-complain|aa-disable|writeFileSync|"tee"|--share-net|SCRUB|unconfined/);
  // Children get only the allowlisted env.
  assert.match(code, /for \(const k of \["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR"\]\)/);
  for (const m of code.matchAll(/execFileSync\([^\n]*/g)) assert.match(m[0], /env: dEnv/);
  const cmds = [...code.matchAll(/(?:fact|execFileSync)\("([\w-]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(cmds)].sort(), ["aa-status", "bwrap", "dmesg", "dpkg-query", "ls", "sha256sum", "uname"]);
  // The launch job's worker path is not duplicated here; the only text shared is the read-only probe.
  assert.match(code, /if \(fact\("bwrap", \["--version"\]\) !== "unavailable"\)/);
  assert.match(code, /"--unshare-all", "--ro-bind", "\/", "\/", "--dev", "\/dev", "--proc", "\/proc", "true"/);
});

test("diagnostic route: job guards are mutually exclusive for every event/ref/input combination", () => {
  const launch = diagCond(launchJob);
  const diag = diagCond(diagJob);
  const post = diagCond(postJob);
  const events = [
    { event: "workflow_dispatch", pr: null, body: "" },
    { event: "issue_comment", pr: null, body: "/ldl launch 1 x" },
    { event: "issue_comment", pr: {}, body: "/ldl launch 1 x" },
    { event: "issue_comment", pr: null, body: "hello" },
    { event: "push", pr: null, body: "" },
  ];
  for (const e of events) for (const ref of ["refs/heads/main", "refs/heads/feature"]) for (const dg of [true, false, null]) for (const pg of [true, false, null]) {
    const ctx = { ...e, ref, default: "main", diag: dg, post: pg };
    const l = evalIf(launch, ctx);
    const d = evalIf(diag, ctx);
    const q = evalIf(post, ctx);
    assert.ok([l, d, q].filter(Boolean).length <= 1, `exclusive: ${JSON.stringify(ctx)}`);
    // Read-only diagnostic runs exactly for an explicit default-branch diagnostic_only dispatch without post-install.
    assert.equal(d, e.event === "workflow_dispatch" && dg === true && pg !== true && ref === "refs/heads/main", JSON.stringify(ctx));
    // Post-install runs exactly for an explicit default-branch post-install dispatch without diagnostic_only.
    assert.equal(q, e.event === "workflow_dispatch" && pg === true && dg !== true && ref === "refs/heads/main", JSON.stringify(ctx));
    // Ordinary launch is unchanged for every non-diagnostic request.
    if (dg !== true && pg !== true) assert.equal(l, (e.event === "workflow_dispatch" && ref === "refs/heads/main") || (e.event === "issue_comment" && e.pr === null && e.body.startsWith("/ldl launch ")), JSON.stringify(ctx));
    if (dg === true || pg === true) assert.equal(l, false, "diagnostic request never launches");
  }
});

test("diagnostic route: concurrency never shares the per-control-issue launch group", () => {
  assert.match(yml, /group: ldl-launcher-\$\{\{ inputs\.diagnostic_only && 'diagnostic' \|\| inputs\.post_install_diagnostic && 'diagnostic-post-install' \|\| github\.event\.issue\.number \|\| inputs\.control_issue \}\}/);
});

// Mock-run the embedded diagnostic script with a stubbed execFileSync/readFileSync.
const runDiag = ({ bwrap, probe = "ok", denyAll = false, partial = false } = {}) => {
  const code = diagScript().replace(/^import .*$/gm, "");
  const calls = [];
  const logs = [];
  const execFileSync = (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env });
    if (denyAll) throw new Error("denied");
    if (partial && cmd === "dpkg-query") { if (args.includes("bubblewrap")) throw new Error("not installed"); return "2.4.0"; }
    if (partial && cmd === "ls") { if (args.includes("/usr/share/apparmor/extra-profiles")) throw new Error("ENOENT"); return "bwrap-userns-restrict\nother\n"; }
    if (cmd === "bwrap" && args[0] === "--version") { if (!bwrap) throw new Error("ENOENT"); return "bubblewrap 0.9\n"; }
    if (cmd === "bwrap") { if (probe === "ok") return ""; const e = new Error("x"); e.stderr = "bwrap: setting up uid map: Permission denied\nmore"; throw e; }
    return `${cmd}-out\n`;
  };
  const readFileSync = (p) => { if (denyAll) throw new Error("EACCES"); return p === "/etc/os-release" ? "PRETTY_NAME=Ubuntu 24.04\nVERSION_ID=24.04\nX=1" : "1"; };
  const process = { env: { PATH: "/bin", HOME: "/h", GITHUB_TOKEN: "ghs_secret", CLAUDE_CODE_OAUTH_TOKEN: "sk-secret", ACTIONS_RUNTIME_TOKEN: "rt" } };
  new Function("execFileSync", "readFileSync", "process", "console", code)(execFileSync, readFileSync, process, { log: (m) => logs.push(m) });
  return { calls, out: logs.join("\n") };
};

test("diagnostic route mocks: probe passed and failed both end in a bounded fact line, never a launch", () => {
  for (const probe of ["ok", "fail"]) {
    const r = runDiag({ bwrap: true, probe });
    assert.match(r.out, /^HOSTED ISOLATION DIAGNOSTIC \(read-only, credential-free, no worker\)/);
    assert.match(r.out, probe === "ok" ? /bwrap_probe=passed/ : /bwrap_probe=failed: bwrap: setting up uid map: Permission denied/);
    assert.ok(r.out.length <= 16000);
    assert.doesNotMatch(r.out, /secret|ghs_|sk-|rt\b/);
    for (const c of r.calls) {
      assert.deepEqual(Object.keys(c.env).sort(), ["HOME", "PATH"]);
      assert.ok(["aa-status", "bwrap", "dmesg", "dpkg-query", "ls", "sha256sum", "uname"].includes(c.cmd), c.cmd);
    }
  }
});

test("diagnostic route mocks: partial failures keep the evidence that was collected (#1139 Stage 1)", () => {
  const r = runDiag({ bwrap: false, partial: true });
  assert.match(r.out, /packages=bubblewrap=unavailable apparmor=2\.4\.0;/);
  assert.match(r.out, /bwrap_profile_names=\["bwrap-userns-restrict","source-unavailable"\]/);
});

test("diagnostic route mocks: missing bwrap skips the probe with an explicit limit; denied facts are unavailable", () => {
  const r = runDiag({ bwrap: false });
  assert.match(r.out, /bwrap_probe=skipped: bwrap not installed \(this route installs nothing; not the prior post-install state\)/);
  assert.equal(r.calls.filter((c) => c.cmd === "bwrap" && c.args[0] !== "--version").length, 0);
  const d = runDiag({ denyAll: true });
  assert.match(d.out, /os=unavailable; kernel=unavailable; apparmor_restrict_unprivileged_userns=unavailable/);
  assert.match(d.out, /aa-status="unavailable"; apparmor_denied="unavailable"; bwrap_probe=skipped/);
});

// ---- Issue #1143: explicit post-install diagnostic job ----
const postScript = () => {
  const m = /<<'POSTDIAG'\n([\s\S]*?)\n\s*POSTDIAG\n/.exec(postJob);
  assert.ok(m, "post-install script present");
  return m[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
};

test("post-install route: no environment, checkout, secrets, or write permission; one step; no interpolation", () => {
  assert.match(postJob, /\n {4}permissions: \{\}\n/);
  assert.doesNotMatch(postJob, /\n {4}environment:/);
  assert.doesNotMatch(postJob, /secrets\.|\$\{\{\s*github\.token|GITHUB_TOKEN|GH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|LDL_WORKER/);
  assert.doesNotMatch(postJob, /actions\/checkout|uses:/);
  assert.doesNotMatch(postJob, /\n\s+needs:/);
  assert.equal([...postJob.matchAll(/^ {6}- name:/gm)].length, 1);
  assert.doesNotMatch(postScript(), /\$\{\{/);
  assert.match(postJob, /timeout-minutes: 20/);
});

test("post-install route: no launch/claim/worker/policy-change pathway; allowlisted env; only bubblewrap+socat installed", () => {
  const code = postScript().replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /launcher-run|launch-authorization|attempt-claim|launcher-step|control-plane-bootstrap|session-entry-gate|"gh"|"git"|"npm"|claude|renderClaimBody|auth setup-git/i);
  assert.doesNotMatch(code, /process\.env\s*[,)}]|\.\.\.process\.env|OAUTH|TOKEN|secret/i);
  assert.doesNotMatch(code, /sysctl|apparmor_parser|aa-enforce|aa-complain|aa-disable|writeFileSync|"tee"|--share-net|SCRUB|unconfined|apparmor-utils|apparmor-profiles|"cp"|"mv"|systemctl|"service"/);
  assert.match(code, /for \(const k of \["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "DEBIAN_FRONTEND"\]\)/);
  for (const m of code.matchAll(/execFileSync\([^\n]*/g)) assert.match(m[0], /env: dEnv/);
  assert.match(code, /const PKGS = \["bubblewrap", "socat"\];/);
  // sudo is used only for apt-get update and the PKGS install, never for bwrap.
  const sudos = [...code.matchAll(/execFileSync\("sudo", \[([^\]]*)\]/g)].map((m) => m[1]);
  assert.deepEqual(sudos, ['"apt-get", "update", "-qq"', '"apt-get", "install", "-y", "-qq", "--no-remove", ...PKGS']);
  assert.match(code, /const PROBE = \["--unshare-all", "--ro-bind", "\/", "\/", "--dev", "\/dev", "--proc", "\/proc", "true"\];/);
  assert.match(code, /execFileSync\("bwrap", PROBE,/);
  // Inspection precedes install.
  assert.ok(code.indexOf('"-s", "install"') < code.indexOf('"apt-get", "install", "-y"'));
  assert.ok(code.indexOf('"dpkg-deb"') < code.indexOf('"apt-get", "install", "-y"'));
});

// Mock-run: scripted command responses.
const runPost = ({ simulate = "Inst bubblewrap (0.9 Ubuntu)\nInst socat (1.8 Ubuntu)\n", contents = "./usr/bin/bwrap\n", script = "#!/bin/sh\nexit 0\n", failOn = null, probe = "ok", mutate = false, configScript = false } = {}) => {
  const code = postScript().replace(/^import .*$/gm, "");
  const calls = [];
  const logs = [];
  let installed = false;
  const files = new Map();
  const err = (m, stderr) => { const e = new Error(m); e.stderr = stderr; return e; };
  const execFileSync = (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env });
    const key = cmd === "sudo" ? "sudo:" + args[1] : cmd + ":" + (args[0] ?? "");
    if (failOn && (failOn === key || failOn === cmd)) throw err("boom", "E: simulated failure on " + key + "\nrest");
    if (cmd === "sudo" && args[1] === "install") { installed = true; return ""; }
    if (cmd === "sudo") return "";
    if (cmd === "apt-get" && args[0] === "-s") return simulate;
    if (cmd === "apt-get" && args[0] === "download") { for (const n of args.slice(1)) files.set(n + ".deb", 1); return ""; }
    if (cmd === "dpkg-deb" && args[0] === "-c") return contents;
    if (cmd === "dpkg-deb" && args[0] === "-e") return "";
    if (cmd === "bwrap" && args[0] === "--version") { if (!installed) throw new Error("ENOENT"); return "bubblewrap 0.9"; }
    if (cmd === "bwrap") { if (probe === "ok") return ""; const e = err("x", "bwrap: setting up uid map: Permission denied\nmore"); e.status = 1; throw e; }
    if (cmd === "find" && mutate && installed) return "deadbeef  /etc/apparmor.d/abstractions/base\n";
    if (cmd === "dpkg-query") return installed ? "1.0" : "unavailable";
    return cmd + "-out\n";
  };
  const readFileSync = (p) => { if (/postinst|preinst|prerm|postrm|triggers|config/.test(p)) return script; return p === "/etc/os-release" ? "PRETTY_NAME=Ubuntu 24.04\nVERSION_ID=24.04" : "1"; };
  const readdirSync = (d) => (/ctl-/.test(d) ? [configScript ? "config" : "postinst"] : [...files.keys()]);
  const mkdtempSync = () => "/tmp/ldl-debs-x";
  const join = (...a) => a.join("/");
  const createHash = () => ({ update(t) { this.t = t; return this; }, digest() { return Buffer.from(String(this.t)).toString("hex").slice(0, 16); } });
  const proc = { env: { PATH: "/bin", HOME: "/h", GITHUB_TOKEN: "ghs_secret", CLAUDE_CODE_OAUTH_TOKEN: "sk-secret" } };
  new Function("execFileSync", "readFileSync", "readdirSync", "mkdtempSync", "createHash", "tmpdir", "join", "process", "console", code)(
    execFileSync, readFileSync, readdirSync, mkdtempSync, createHash, () => "/tmp", join, proc, { log: (m) => logs.push(m) });
  return { calls, out: logs.join("\n"), logs, exitCode: proc.exitCode };
};

const sudoIdx = (r, sub) => r.calls.findIndex((c) => c.cmd === "sudo" && c.args[1] === sub);

test("post-install mocks: probe passes after a clean inspected install; bounded, no secrets, no policy change", () => {
  const r = runPost();
  assert.equal(r.logs.length, 3);
  assert.match(r.logs[0], /pre-install/);
  assert.match(r.logs[1], /post-install/);
  assert.match(r.logs[2], /install=ok \(inspected 2 package files; none reference apparmor\); policy_change=none-observed.*bwrap_probe=passed/);
  assert.ok(r.logs.every((l) => l.length <= 8000));
  assert.doesNotMatch(r.out, /secret|ghs_|sk-/);
  assert.equal(r.exitCode, undefined);
  // Inspection before install; probe after install, unprivileged.
  assert.ok(r.calls.findIndex((c) => c.cmd === "dpkg-deb") < sudoIdx(r, "install"));
  const pi = r.calls.findIndex((c) => c.cmd === "bwrap" && c.args[0] === "--unshare-all");
  assert.ok(pi > sudoIdx(r, "install"));
  assert.deepEqual(r.calls[pi].args, ["--unshare-all", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "true"]);
  for (const c of r.calls) assert.ok(!c.env || (!("GITHUB_TOKEN" in c.env) && !("CLAUDE_CODE_OAUTH_TOKEN" in c.env)));
  assert.ok(!r.calls.some((c) => c.cmd === "sudo" && c.args.includes("bwrap")));
});

test("post-install mocks: a genuine probe failure is reported as evidence with exact stderr", () => {
  const r = runPost({ probe: "fail" });
  assert.match(r.logs[2], /bwrap_probe=failed: exit=1 signal=none stderr=bwrap: setting up uid map: Permission denied \| more/);
  assert.ok(r.logs[2].length <= 2000);
  assert.equal(r.exitCode, undefined);
});

test("post-install mocks: apparmor in the plan, contents, or a maintainer script refuses BEFORE install", () => {
  for (const o of [
    { simulate: "Inst bubblewrap (1)\nInst apparmor-profiles (2)\n" },
    { contents: "./etc/apparmor.d/bwrap\n" },
    { script: "#!/bin/sh\napparmor_parser -r /etc/apparmor.d/x\n" },
    { script: "#!/bin/sh\napparmor_parser -r /etc/apparmor.d/x\n", configScript: true },
    { simulate: "Inst bubblewrap (1)\nRemv conflicting-pkg [1]\n" },
    { simulate: "Inst bubblewrap (1)\nPurg conflicting-pkg [1]\n" },
  ]) {
    const r = runPost(o);
    assert.equal(sudoIdx(r, "install"), -1, "no install attempted");
    assert.ok(!r.calls.some((c) => c.cmd === "bwrap" && c.args[0] === "--unshare-all"));
    assert.match(r.logs[2], /install=refused-before-install:.*nothing installed.*bwrap_probe=skipped: install did not complete/);
    assert.equal(r.exitCode, 1);
  }
});

test("post-install mocks: any uninspectable step refuses (simulate, download, dpkg-deb, apt update)", () => {
  for (const failOn of ["apt-get:-s", "apt-get:download", "dpkg-deb", "sudo:update"]) {
    const r = runPost({ failOn });
    assert.equal(sudoIdx(r, "install"), -1, failOn);
    assert.match(r.logs[2], /refused-before-install/);
    assert.equal(r.exitCode, 1);
  }
});

test("post-install mocks: install error is reported, probe skipped, evidence still emitted", () => {
  const r = runPost({ failOn: "sudo:install" });
  assert.match(r.logs[2], /install=failed: E: simulated failure on sudo:install.*bwrap_probe=skipped: install did not complete/);
  assert.equal(r.logs.length, 3);
  assert.equal(r.exitCode, 1);
});

test("post-install mocks: an unanticipated pre/post policy change is flagged as a boundary violation", () => {
  const r = runPost({ mutate: true });
  assert.match(r.logs[2], /policy_change=BOUNDARY VIOLATION: changed=\[[^\]]*apparmor_d_digest/);
});

test("post-install mocks: boundary violation fails the job; apt calls forbid removal; final snapshot follows the probe", () => {
  const r = runPost({ mutate: true });
  assert.equal(r.exitCode, 1);
  for (const c of r.calls.filter((c) => (c.cmd === "apt-get" && (c.args[0] === "-s" || c.args[0] === "install")) || (c.cmd === "sudo" && c.args[1] === "install"))) {
    assert.ok(c.args.includes("--no-remove"));
  }
  const probeIdx = r.calls.findIndex((c) => c.cmd === "bwrap" && c.args[0] === "--unshare-all");
  const lastDmesg = r.calls.map((c) => c.cmd).lastIndexOf("dmesg");
  assert.ok(lastDmesg > probeIdx, "post snapshot reads dmesg after the probe");
  assert.ok(r.calls.some((c) => c.cmd === "find" && c.args.includes("sha256sum")), "AppArmor dir contents are hashed");
});

// ---- Issue #1150: allowlisted ubuntu-22.04 alternate host for the post-install diagnostic ONLY ----
const runsOn = (job) => /\n {4}runs-on: ([^\n]*)\n/.exec(job)[1];
const evalRunsOn = (expr, selector) => {
  const m = /^\$\{\{ inputs\.post_install_runner == '([^']+)' && '([^']+)' \|\| '([^']+)' \}\}$/.exec(expr);
  assert.ok(m, "runs-on is the exact allowlist ternary");
  return selector === m[1] ? m[2] : m[3];
};

test("runner selector: only the post-install job selects a host; allowlist of exactly ubuntu-latest and ubuntu-22.04", () => {
  assert.equal(runsOn(diagJob), "ubuntu-latest");
  assert.equal(yml.match(/post_install_runner/g).length, 3, "declared once, referenced in its comment, used once in runs-on");
  for (const job of [launchJob, diagJob]) assert.doesNotMatch(job, /post_install_runner/);
  assert.equal([...yml.matchAll(/^\s+runs-on:/gm)].length, 4);
  assert.doesNotMatch(yml, /runs-on: \$\{\{ *inputs\.(?!(post_install_runner|worker_runner) == 'ubuntu-22\.04')/);
});

test("runner selector: default and every non-allowlisted value resolve to ubuntu-latest; only exact ubuntu-22.04 selects it", () => {
  const expr = runsOn(postJob);
  assert.equal(evalRunsOn(expr, "ubuntu-22.04"), "ubuntu-22.04");
  for (const v of ["ubuntu-latest", "", null, undefined, "ubuntu-24.04", "ubuntu-20.04", "UBUNTU-22.04", "ubuntu-22.04 ", "self-hosted", "windows-latest", "ubuntu-22.04,self-hosted", "${{ secrets.X }}"]) {
    assert.equal(evalRunsOn(expr, v), "ubuntu-latest", JSON.stringify(v));
  }
});

// ---- Issue #1163: allowlisted ubuntu-22.04 selection for the credential-bearing launch job ONLY ----
const evalWorkerRunsOn = (expr, selector, control = "1164") => {
  const m = /^\$\{\{ inputs\.worker_runner == '([^']+)' && inputs\.control_issue == '([^']+)' && '([^']+)' \|\| '([^']+)' \}\}$/.exec(expr);
  assert.ok(m, "launch runs-on is the exact allowlist ternary bound to the qualification control");
  assert.equal(m[2], "1164");
  return selector === m[1] && control === m[2] ? m[3] : m[4];
};

test("worker runner: only the launch job reads worker_runner; diagnostics and guards never do; one runs-on each", () => {
  assert.equal(yml.match(/worker_runner/g).length, 3, "declared once, referenced in its comment, used once in runs-on");
  for (const job of [diagJob, postJob]) assert.doesNotMatch(job, /worker_runner/);
  assert.doesNotMatch(runsOn(postJob), /worker_runner/);
  assert.doesNotMatch(runsOn(launchJob), /post_install_runner/);
  for (const job of [launchJob, diagJob, postJob]) assert.doesNotMatch(diagCond(job), /worker_runner|post_install_runner/);
});

test("worker runner: default, issue_comment (no inputs) and every non-allowlisted value resolve to ubuntu-latest", () => {
  const expr = runsOn(launchJob);
  assert.equal(evalWorkerRunsOn(expr, "ubuntu-22.04"), "ubuntu-22.04");
  for (const v of ["ubuntu-latest", "", null, undefined, "ubuntu-24.04", "ubuntu-20.04", "UBUNTU-22.04", "ubuntu-22.04 ", "self-hosted", "windows-latest", "ubuntu-22.04,self-hosted", "${{ secrets.X }}"]) {
    assert.equal(evalWorkerRunsOn(expr, v), "ubuntu-latest", JSON.stringify(v));
  }
  // Audit #1171: the 22.04 host is bound to the one qualification control; any other control stays on ubuntu-latest.
  for (const c of ["1163", "1165", "11640", "01164", " 1164", "", null]) {
    assert.equal(evalWorkerRunsOn(expr, "ubuntu-22.04", c), "ubuntu-latest", JSON.stringify(c));
  }
  assert.match(yml, /worker_runner:\s*\n\s+description:[^\n]*control_issue is exactly 1164/);
  assert.doesNotMatch(yml, /single-run|one qualification only/);
  // The post-install diagnostic's selector cannot pick the worker host, nor vice versa.
  assert.equal(evalWorkerRunsOn(expr, "post_install_runner"), "ubuntu-latest");
});

test("worker runner: selector leaves trust, environment, permissions, and launch guard unchanged", () => {
  assert.match(launchJob, /\n {4}environment: ldl-launcher\n/);
  assert.doesNotMatch(launchJob, /\n {4}permissions:/);
  const ctx = { event: "workflow_dispatch", pr: null, body: "", ref: "refs/heads/main", default: "main", diag: false, post: false };
  assert.equal(evalIf(diagCond(launchJob), ctx), true);
  assert.equal(evalIf(diagCond(launchJob), { ...ctx, ref: "refs/heads/feature" }), false);
  assert.equal(evalIf(diagCond(launchJob), { ...ctx, post: true }), false);
  assert.equal(evalIf(diagCond(launchJob), { ...ctx, diag: true }), false);
});

test("runner selector: does not change the job guards, so it cannot reach launch, claim, or worker paths", () => {
  assert.doesNotMatch(diagCond(launchJob), /post_install_runner/);
  assert.doesNotMatch(diagCond(diagJob), /post_install_runner/);
  assert.doesNotMatch(diagCond(postJob), /post_install_runner/);
  // A selected 22.04 post-install dispatch still runs only the post-install job and never launches.
  const ctx = { event: "workflow_dispatch", pr: null, body: "", ref: "refs/heads/main", default: "main", diag: false, post: true };
  assert.equal(evalIf(diagCond(postJob), ctx), true);
  assert.equal(evalIf(diagCond(launchJob), ctx), false);
  assert.equal(evalIf(diagCond(diagJob), ctx), false);
  // Selecting 22.04 WITHOUT the post-install flag leaves ordinary launch unchanged and runs no diagnostic.
  const launchCtx = { ...ctx, post: false };
  assert.equal(evalIf(diagCond(launchJob), launchCtx), true);
  assert.equal(evalIf(diagCond(postJob), launchCtx), false);
  // Dual-diagnostic collision still runs nothing; non-default ref still runs nothing.
  const both = { ...ctx, diag: true };
  for (const j of [launchJob, diagJob, postJob]) assert.equal(evalIf(diagCond(j), both), false);
  for (const j of [launchJob, diagJob, postJob]) assert.equal(evalIf(diagCond(j), { ...ctx, ref: "refs/heads/feature" }), false);
  // Credential-free posture of the post-install job is unchanged by the selector.
  assert.match(postJob, /\n {4}permissions: \{\}\n/);
  assert.doesNotMatch(postJob, /\n {4}environment:|secrets\.|actions\/checkout/);
  assert.match(launchJob, /\n {4}environment: ldl-launcher\n/);
});

test("runner selector: result line stays distinguishable from Actions success (probe verdict reported, not job status)", () => {
  assert.match(postScript(), /bwrap_probe=\$\{probe\}/);
  assert.match(postScript(), /os=\$\{osRelease\}; kernel=/);
});

// ---- Issue #1175: default-off, one-shot Claude qualification-only route ----
const qualScript = () => {
  const m = /<<'QUAL'\n([\s\S]*?)\n\s*QUAL\n/.exec(qualJob);
  assert.ok(m, "qualification script present");
  return m[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
};
const qualCtx = { event: "workflow_dispatch", pr: null, body: "", ref: "refs/heads/main", default: "main", diag: false, post: false, qual: true, control: "1164" };

test("qualification route: default off, distinct job, fixed 22.04 host, protected environment, least privilege", () => {
  assert.match(onBlock, /qualification_only:\s*\n\s+description:[^\n]*\n\s+type: boolean\n\s+required: false\n\s+default: false/);
  assert.match(qualJob, /\n {4}runs-on: ubuntu-22\.04\n/);
  assert.match(qualJob, /\n {4}environment: ldl-launcher\n/);
  assert.match(qualJob, /\n {4}permissions:\n {6}contents: read\n {6}issues: write\n {6}pull-requests: read\n {6}actions: read\n/);
  assert.doesNotMatch(qualJob, /contents: write|pull-requests: write/);
  assert.doesNotMatch(qualJob, /worker_runner|post_install_runner/);
  assert.match(qualJob, /uses: actions\/checkout@v4\n\s+with:\n\s+persist-credentials: false/);
  // Event-derived values reach the script only through env.
  assert.doesNotMatch(qualScript(), /\$\{\{/);
  assert.equal(qualJob.match(/secrets\.CLAUDE_CODE_OAUTH_TOKEN/g).length, 1);
});

test("qualification route: guards are mutually exclusive with launch and both diagnostics; only exact opt-in on control 1164 runs it", () => {
  const events = [{ event: "workflow_dispatch", pr: null, body: "" }, { event: "issue_comment", pr: null, body: "/ldl launch 1164 x" }, { event: "push", pr: null, body: "" }];
  for (const e of events) for (const ref of ["refs/heads/main", "refs/heads/feature"]) for (const dg of [true, false, null]) for (const pg of [true, false, null]) for (const qg of [true, false, null]) for (const control of ["1164", "1163", "11640", "01164", "", null]) {
    const ctx = { ...e, ref, default: "main", diag: dg, post: pg, qual: qg, control };
    const flags = [launchJob, diagJob, postJob, qualJob].map((j) => evalIf(diagCond(j), ctx));
    assert.ok(flags.filter(Boolean).length <= 1, `exclusive: ${JSON.stringify(ctx)}`);
    assert.equal(flags[3], e.event === "workflow_dispatch" && qg === true && dg !== true && pg !== true && control === "1164" && ref === "refs/heads/main", JSON.stringify(ctx));
    // Any qualification request never reaches worker launch or either diagnostic.
    if (qg === true) assert.deepEqual(flags.slice(0, 3), [false, false, false], JSON.stringify(ctx));
  }
  assert.equal(evalIf(diagCond(qualJob), qualCtx), true);
  // Default-off: unselected requests keep ordinary launch exactly as before.
  assert.equal(evalIf(diagCond(launchJob), { ...qualCtx, qual: false }), true);
  assert.equal(evalIf(diagCond(launchJob), { ...qualCtx, qual: undefined }), true);
});

test("qualification route: no worker/dispatch/merge pathway, no fallback, no isolation downgrade", () => {
  const code = qualScript().replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /launcher-run|launcher-step|resolveWorkerLaunch|LDL_WORKER_COMMAND|dispatchFreshWorker|"merge"|"pr"|"git"/);
  assert.doesNotMatch(code, /SUBPROCESS_ENV_SCRUB\s*[=:]\s*["']?0|sysctl|aa-complain|aa-disable|apparmor_parser|unconfined|share-net|writeFileSync|ANTHROPIC_API_KEY/);
  assert.match(code, /CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1"/);
  assert.match(code, /"--permission-mode", "dontAsk"/);
  assert.match(code, /"--disallowedTools", "Edit Write MultiEdit NotebookEdit"/);
  assert.match(code, /"--allowedTools", `Bash\(\$\{BENIGN_COMMAND\}\)`, `Bash\(\$\{EGRESS_COMMAND\}\)`,/);
  assert.match(code, /"--unshare-all", "--ro-bind", "\/", "\/", "--dev", "\/dev", "--proc", "\/proc", "true"/);
  // The credential is scrubbed from process.env before any gh/git/gate child and reaches only the claude child.
  const i = (s) => code.indexOf(s);
  assert.ok(i("delete process.env.LDL_QUAL_CLAUDE_OAUTH_TOKEN") < i("session-entry-gate"));
  assert.equal(code.match(/CLAUDE_CODE_OAUTH_TOKEN: token/g).length, 1);
  assert.doesNotMatch(code, /console\.log\([^)]*\btoken\b/);
  // Ordering: all checks and the claim precede the install/probe/claude; the record precedes the settle.
  assert.ok(i("phase: \"CLAIMED\"") < i("\"npm\", \"install\""));
  assert.ok(i("\"npm\", \"install\"") < i("iso(\"bwrap\", [\"--version\"]") && i("iso(\"bwrap\", [\"--version\"]") < i("execFileSync(\"claude\""));
  assert.ok(i("persist(executionIssue)") < i("settle(result.pass"));
});

// Mock-run the embedded qualification script.
const BENIGN = "printf 'LDL_%s_OK' \"$LDL_SMOKE_NONCE\"";
const EGRESS = "curl -sS -m 5 -o /dev/null -w CODE=%{http_code} https://example.com";
const SMOKE = "abcd1234abcd1234";
const streamOf = ({ benignOut = `LDL_${SMOKE}_OK`, egressOut = "CODE=000curl: (6) Could not resolve host", extra = [] } = {}) => [
  { message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: BENIGN } }] } },
  { message: { content: [{ type: "tool_result", tool_use_id: "t1", content: benignOut }] } },
  { message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: EGRESS } }] } },
  { message: { content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: egressOut }] }] } },
  ...extra,
].map((o) => JSON.stringify(o)).join("\n");
const goodGrant = (o = {}) => "```json\n" + JSON.stringify({ claudeQualification: { controlIssue: 1164, executionIssue: 2000, oneShot: true, scope: "claude-sandbox-child-egress-v1", host: "ubuntu-22.04", ...o } }) + "\n```";

const runQual = async (o = {}) => {
  const { verifyDispatchLaunchRequest, resolveDispatchExecution, hasWritePermission } = await import("./launch-authorization.mjs");
  const { parseAttemptClaims, planClaim, renderClaimBody, formatAttemptId, parseAttemptId } = await import("./attempt-claim.mjs");
  const code = qualScript().replace(/^import .*$/gm, "");
  const posts = [];
  const logs = [];
  const calls = [];
  let nextId = 5000;
  const comments = [...(o.comments ?? [])];
  const verdict = o.verdict ?? { state: "READY_TO_DISPATCH", controlIssue: 1164, executionIssue: 2000 };
  const execFileSync = (cmd, args, opts = {}) => {
    calls.push({ cmd, args, env: opts.env });
    const line = [cmd, ...args].join(" ");
    if (cmd === "gh" && args[0] === "auth") return "";
    if (cmd === "gh" && args[0] === "api" && args.includes("-F")) {
      if (o.failRecordPost && /Claude Qualification Result/.test(opts.input)) throw new Error("post failed");
      const id = nextId++;
      posts.push({ path: args[1], body: opts.input });
      if (args[1].endsWith("/issues/1164/comments")) {
        comments.push({ id, body: opts.input, user: { login: "github-actions[bot]" } });
        if (o.raceOnClaim && /CLAIMED/.test(opts.input)) comments.push({ id: 1, body: renderClaimBody({ attemptId: "901-1", nonce: "qualification-2000", claimedAt: "2026-01-01T00:00:00Z", runner: "github-actions", phase: "CLAIMED" }), user: { login: "github-actions[bot]" } });
      }
      return "";
    }
    if (cmd === "gh" && args.includes("--paginate")) return JSON.stringify([comments]);
    if (cmd === "gh" && /collaborators\/(.+)\/permission/.test(args[1])) return JSON.stringify({ permission: (o.perms ?? {})[/collaborators\/(.+)\/permission/.exec(args[1])[1]] ?? "admin" });
    if (cmd === "gh" && /issues\/2000$/.test(args[1])) return JSON.stringify({ state: "open", user: { login: "founder" }, body: o.packetBody ?? goodGrant(), ...(o.packet ?? {}) });
    if (cmd === "gh" && /actions\/runs/.test(args[1])) return JSON.stringify({ status: o.runStatus ?? "completed", conclusion: "failure" });
    if (cmd === "node" && args[0].includes("control-plane-bootstrap")) return JSON.stringify(verdict) + "\n";
    if (cmd === "node" && args[0] === "-e") return SMOKE;
    if (cmd === "curl") { if (o.hostCurlThrows) throw new Error("host down"); return o.hostCurl ?? "200"; }
    if (cmd === "claude") { if (o.claudeThrows) throw new Error("claude exploded"); return o.stream ?? streamOf(); }
    if (o.failAt && line.includes(o.failAt)) throw new Error(`boom ${o.failAt}`);
    return "";
  };
  const env = { EVENT_NAME: "workflow_dispatch", INPUT_CONTROL_ISSUE: "1164", INPUT_NONCE: "", ACTOR: "founder", TRIGGERING_ACTOR: "founder", EVENT_REF: "refs/heads/main", DEFAULT_BRANCH: "main", IS_FORK: "false", REPO: "o/r", RUN_ID: "900", RUN_ATTEMPT: "1", PATH: "/bin", HOME: "/h", GH_TOKEN: "ghs_secret", LDL_QUAL_CLAUDE_OAUTH_TOKEN: "sk-secret-oauth", ...(o.env ?? {}) };
  if (o.noToken) delete env.LDL_QUAL_CLAUDE_OAUTH_TOKEN;
  const proc = { env, exitCode: undefined, exit: (c) => { const e = new Error("EXIT"); e.code = c; throw e; } };
  let exit = null;
  try {
    new Function("execFileSync", "process", "console", "verifyDispatchLaunchRequest", "resolveDispatchExecution", "hasWritePermission", "parseAttemptClaims", "planClaim", "renderClaimBody", "formatAttemptId", "parseAttemptId", code)(
      execFileSync, proc, { log: (m) => logs.push(m) }, verifyDispatchLaunchRequest, resolveDispatchExecution, hasWritePermission, parseAttemptClaims, planClaim, renderClaimBody, formatAttemptId, parseAttemptId);
  } catch (e) { if (e.message !== "EXIT") throw e; exit = e.code; }
  return { posts, logs, calls, exit, exitCode: proc.exitCode, out: logs.join("\n"), claude: calls.find((c) => c.cmd === "claude") };
};
const refusedClean = (r, re) => { assert.equal(r.exit, 1); assert.match(r.out, re); assert.equal(r.claude, undefined); assert.equal(r.posts.length, 0, "no claim or record posted before authority is proven"); };

test("qualification mock: PASS only with permitted marker AND denied child egress; records redacted attributable evidence and settles once", async () => {
  const r = await runQual();
  assert.equal(r.exit, null);
  assert.equal(r.exitCode, undefined);
  assert.match(r.out, /QUALIFICATION RESULT: PASS benign=ok egress=denied/);
  assert.equal(r.posts.length, 4, "claim, record on packet, record on control, settle");
  assert.match(r.posts[0].body, /Phase:\*\* CLAIMED/);
  assert.match(r.posts[0].body, /Authorization nonce:\*\* qualification-2000/);
  assert.match(r.posts[1].path, /issues\/2000\/comments/);
  assert.match(r.posts[1].body, /Claude Qualification Result \(v1\)[\s\S]*Verdict:\*\* PASS[\s\S]*Proof packet:\*\* #2000[\s\S]*Child network egress:\*\* denied/);
  assert.match(r.posts[3].body, /Phase:\*\* DONE[\s\S]*Outcome:\*\* PASS/);
  // Credential isolation: only the claude child holds it; scrub stays on; no GitHub token or metered key reaches it.
  assert.equal(r.claude.env.CLAUDE_CODE_OAUTH_TOKEN, "sk-secret-oauth");
  assert.equal(r.claude.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "1");
  assert.equal(r.claude.env.GH_TOKEN, undefined);
  assert.equal(r.claude.env.ANTHROPIC_API_KEY, undefined);
  for (const c of r.calls.filter((x) => x.cmd !== "claude")) assert.ok(!c.env || !Object.values(c.env).some((v) => String(v).includes("sk-secret")));
  assert.ok(!JSON.stringify([r.posts, r.logs]).includes("sk-secret"));
  assert.ok(r.claude.args.includes("--disallowedTools"));
});

test("qualification mock: every refusal happens before any claim and before the credential is used", async () => {
  refusedClean(await runQual({ noToken: true }), /no worker credential/);
  refusedClean(await runQual({ env: { INPUT_CONTROL_ISSUE: "1163" } }), /valid only for control #1164/);
  refusedClean(await runQual({ env: { EVENT_NAME: "issue_comment" } }), /valid only for control #1164/);
  refusedClean(await runQual({ env: { INPUT_NONCE: "legacy-1" } }), /no launch-authorization nonce/);
  refusedClean(await runQual({ env: { IS_FORK: "true" } }), /untrusted dispatch/);
  refusedClean(await runQual({ env: { EVENT_REF: "refs/heads/feature" } }), /untrusted dispatch/);
  refusedClean(await runQual({ perms: { founder: "read" } }), /untrusted dispatch/);
  refusedClean(await runQual({ env: { TRIGGERING_ACTOR: "other" }, perms: { founder: "read", other: "admin" } }), /original dispatcher/);
  // A closed historical control or any non-READY gate state never qualifies.
  for (const state of ["BLOCKED", "NOT_READY", "NO_ACTION_YET", "READY_TO_DISPATCH_PLANNING", "AMBIGUOUS"]) refusedClean(await runQual({ verdict: { state, controlIssue: 1164, executionIssue: 2000 } }), /control not an active proof control/);
  refusedClean(await runQual({ verdict: { state: "READY_TO_DISPATCH", controlIssue: 1163, executionIssue: 2000 } }), /different control issue/);
  refusedClean(await runQual({ verdict: { state: "READY_TO_DISPATCH", controlIssue: 1164 } }), /no current execution issue/);
});

test("qualification mock: the proof packet must be open, writer-authored, and carry exactly one exact one-shot grant", async () => {
  refusedClean(await runQual({ packet: { state: "closed" } }), /not an open issue/);
  refusedClean(await runQual({ packet: { pull_request: {} } }), /not an open issue/);
  refusedClean(await runQual({ perms: { outsider: "read" }, packet: { user: { login: "outsider" } } }), /author lacks write permission/);
  for (const body of ["no grant here", goodGrant({ controlIssue: 1163 }), goodGrant({ executionIssue: 2001 }), goodGrant({ oneShot: false }), goodGrant({ scope: "other" }), goodGrant({ host: "ubuntu-latest" }), goodGrant() + "\n" + goodGrant(), "```json\n{not json\n```", "```json\n{\"executorSubstrate\":[]}\n```"]) {
    refusedClean(await runQual({ packetBody: body }), /no single exact one-shot qualification grant/);
  }
});

test("qualification mock: at most once per packet; replayed, orphaned, live and lost-race attempts never run Claude", async () => {
  const claim = (id, attempt, phase, nonce, outcome) => ({ id, user: { login: "github-actions[bot]" }, body: renderClaimForTest(attempt, nonce, phase, outcome) });
  refusedClean(await runQual({ comments: [claim(1, "800-1", "DONE", "qualification-2000", "PASS")] }), /already has a qualification attempt/);
  refusedClean(await runQual({ comments: [claim(1, "800-1", "CLAIMED", "qualification-2000")] }), /already has a qualification attempt/);
  // An ordinary live launch claim under the same control blocks (existing claim infrastructure).
  refusedClean(await runQual({ comments: [claim(1, "123-1", "CLAIMED", "dispatch-123")], runStatus: "in_progress" }), /BLOCK: a live attempt/);
  // Concurrent press: a lower-id claim for the same nonce wins; the loser settles and never runs Claude.
  const raced = await runQual({ raceOnClaim: true });
  assert.equal(raced.exit, 1);
  assert.match(raced.out, /lost the qualification claim race/);
  assert.equal(raced.claude, undefined);
  assert.match(raced.posts.at(-1).body, /Phase:\*\* DONE[\s\S]*Outcome:\*\* RACE_LOST/);
});

test("qualification mock: any non-PASS evidence is an honest NO-GO with a nonzero exit, a recorded verdict and a settled claim", async () => {
  const cases = [
    [{ stream: streamOf({ egressOut: "CODE=200" }) }, /egress=allowed/],
    [{ stream: streamOf({ egressOut: "no marker at all" }) }, /egress=undetermined/],
    [{ hostCurlThrows: true }, /egress=undetermined[\s\S]*no positive host network control/],
    [{ hostCurl: "000" }, /egress=undetermined[\s\S]*no positive host network control/],
    [{ stream: streamOf({ benignOut: "LDL_wrong_OK" }) }, /benign=failed/],
    [{ stream: "" }, /benign=failed/],
    [{ stream: streamOf({ extra: [{ message: { content: [{ type: "tool_use", id: "t3", name: "Edit", input: { file_path: "x" } }] } }] }) }, /benign=unexpected-tool/],
    [{ stream: streamOf({ extra: [{ message: { content: [{ type: "tool_use", id: "t4", name: "Bash", input: { command: "git push" } }] } }] }) }, /unexpected-tool/],
    // Issue #1175 Audit #1177: ambiguous/replayed stream evidence is NO-GO, never a surviving-last-write PASS.
    [{ stream: streamOf({ extra: [{ message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "CODE=000" }] } }] }) }, /egress=ambiguous/],
    [{ stream: JSON.stringify({ message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "CODE=200" }] } }) + "\n" + streamOf() }, /ambiguous/],
    [{ stream: streamOf({ extra: [{ message: { content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "x" } }] } }] }) }, /ambiguous/],
    [{ stream: streamOf({ extra: [{ message: { content: [{ type: "tool_result", tool_use_id: "ghost", content: "x" }] } }] }) }, /ambiguous/],
    [{ stream: streamOf({ extra: [{ message: { content: [{ type: "tool_use", name: "Bash", input: { command: BENIGN } }] } }] }) }, /ambiguous/],
    [{ claudeThrows: true }, /runtime failure: claude exploded/],
    [{ failAt: "npm install" }, /runtime failure/],
    [{ failAt: "bubblewrap socat" }, /runtime failure/],
    [{ failAt: "--unshare-all" }, /runtime failure/],
  ];
  for (const [opts, re] of cases) {
    const r = await runQual(opts);
    assert.equal(r.exitCode, 1, JSON.stringify(Object.keys(opts)));
    assert.match(r.out, /QUALIFICATION RESULT: NO-GO/);
    assert.match(r.out, re);
    assert.match(r.posts.at(-1).body, /Phase:\*\* DONE[\s\S]*Outcome:\*\* NO_GO/);
    assert.ok(r.posts.some((p) => /Verdict:\*\* NO-GO/.test(p.body)));
    // No fallback: nothing resembling a worker launch, merge, or PR call happened.
    assert.ok(!r.calls.some((c) => /launcher-run|merge/.test([c.cmd, ...c.args].join(" "))));
    assert.ok(!JSON.stringify([r.posts, r.logs]).includes("sk-secret"));
  }
  // Record persistence is a prerequisite for settlement: never settle PASS/NO_GO without durable records.
  const rf = await runQual({ failRecordPost: true });
  assert.equal(rf.exit, 1);
  assert.match(rf.out, /QUALIFICATION RECORD NOT POSTED/);
  assert.match(rf.posts.at(-1).body, /Phase:\*\* DONE[\s\S]*Outcome:\*\* RECORD_FAILED/);
  assert.ok(!rf.posts.some((p) => /Outcome:\*\* (PASS|NO_GO)/.test(p.body)));
  // A preflight failure never starts Claude with the credential.
  assert.equal((await runQual({ failAt: "--unshare-all" })).claude, undefined);
});

import { renderClaimBody as renderClaimBodyForTest } from "./attempt-claim.mjs";
function renderClaimForTest(attemptId, nonce, phase, outcome) {
  return renderClaimBodyForTest({ attemptId, nonce, claimedAt: "2026-01-01T00:00:00Z", runner: "github-actions", phase, outcome: outcome ?? null });
}
