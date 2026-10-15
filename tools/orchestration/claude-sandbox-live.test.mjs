// Issue #1184: credential-free LIVE proof that the pinned Claude CLI, launched with the launcher's actual sandbox
// settings, runs a permitted Bash command but cannot egress from the Bash child, while an unsandboxed control can.
// Opt-in (LDL_LIVE_CLAUDE_SANDBOX_PROOF=1; needs the `claude` CLI, bubblewrap, socat and host network). No account
// or credential is used: the CLI talks to a local scripted Messages-API mock with a dummy key and an empty HOME.
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeSandboxArgs, claudeSmokeArgv, claudeWorkerArgv } from "./launcher-run.mjs";

const live = process.env.LDL_LIVE_CLAUDE_SANDBOX_PROOF === "1";
const BIN = process.env.LDL_CLAUDE_BIN || "claude";
const BENIGN = "printf 'LDL_%s_OK' \"$LDL_SMOKE_NONCE\"";
const EGRESS = "curl -sS -m 5 -o /dev/null -w CODE=%{http_code} https://example.com";

const mockApi = (commands) => new Promise((resolve) => {
  const sse = (res, blocks, stop) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const w = (e, d) => res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`);
    w("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "claude-mock", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    blocks.forEach((b, i) => {
      const start = b.type === "text" ? { type: "text", text: "" } : { type: "tool_use", id: b.id, name: b.name, input: {} };
      w("content_block_start", { type: "content_block_start", index: i, content_block: start });
      w("content_block_delta", { type: "content_block_delta", index: i, delta: b.type === "text" ? { type: "text_delta", text: b.text } : { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
      w("content_block_stop", { type: "content_block_stop", index: i });
    });
    w("message_delta", { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 1 } });
    w("message_stop", { type: "message_stop" });
    res.end();
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      let j = {};
      try { j = JSON.parse(body); } catch { /* non-JSON side request */ }
      if (!req.url.startsWith("/v1/messages")) { res.writeHead(200, { "content-type": "application/json" }); return res.end("{}"); }
      if (!(j.tools ?? []).some((t) => t.name === "Bash")) return sse(res, [{ type: "text", text: "ok" }], "end_turn");
      const done = (j.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content.filter((c) => c.type === "tool_result") : [])).length;
      if (done < commands.length) return sse(res, [{ type: "tool_use", id: `toolu_${done}`, name: "Bash", input: commands[done] }], "tool_use");
      return sse(res, [{ type: "text", text: "DONE" }], "end_turn");
    });
  }).listen(0, "127.0.0.1", () => resolve(server));
});

const runClaude = async (settingsArgs, commands, { hideBwrap = false } = {}) => {
  const server = await mockApi(commands);
  const dir = mkdtempSync(join(tmpdir(), "ldl-sandbox-live-"));
  const env = { PATH: process.env.PATH, HOME: dir, CLAUDE_CONFIG_DIR: join(dir, ".claude"), TMPDIR: dir, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: "sk-dummy-credential-free", NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1", CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1", LDL_SMOKE_NONCE: "n0nce" };
  for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS"]) if (process.env[k]) env[k] = process.env[k];
  if (hideBwrap) env.PATH = "/nonexistent-ldl-path"; // no bubblewrap resolvable: the backend is unavailable
  const argv = ["-p", "--permission-mode", "dontAsk", ...settingsArgs, "--allowedTools", `Bash(${BENIGN})`, `Bash(${EGRESS})`, "--disallowedTools", "Edit Write MultiEdit NotebookEdit", "--max-turns", "6", "--output-format", "stream-json", "--verbose"];
  const bin = hideBwrap ? process.execPath : BIN;
  const args = hideBwrap ? [spawnSync("which", [BIN], { encoding: "utf8" }).stdout.trim() || BIN, ...argv] : argv;
  const out = await new Promise((resolve) => {
    const c = spawn(bin, args, { cwd: dir, env, stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    c.stdout.on("data", (d) => { buf += d; });
    const t = setTimeout(() => c.kill("SIGKILL"), 120000);
    c.on("close", (code) => { clearTimeout(t); resolve({ code, buf }); });
    c.stdin.end("run the commands\n");
  });
  server.close();
  const results = out.buf.split("\n").flatMap((l) => { try { return JSON.parse(l)?.message?.content ?? []; } catch { return []; } }).filter((p) => p.type === "tool_result").map((p) => (typeof p.content === "string" ? p.content : (p.content ?? []).map((x) => x.text ?? "").join("")));
  return { ...out, results };
};
const twoCommands = [{ command: BENIGN }, { command: EGRESS }];
const codeOf = (r) => /CODE=(\d{3})/.exec(r ?? "")?.[1];

test("live (credential-free): unsandboxed host and child reach the endpoint (positive control, reproduces #1180)", { skip: !live }, async () => {
  const host = spawnSync("curl", ["-sS", "-m", "10", "-o", "/dev/null", "-w", "%{http_code}", "https://example.com"], { encoding: "utf8" }).stdout;
  assert.match(host, /^[23]\d\d$/, "host reaches the endpoint");
  const r = await runClaude([], twoCommands);
  assert.equal(r.results[0], "LDL_n0nce_OK");
  assert.equal(codeOf(r.results[1]), "200", "without the sandbox settings the child egress is allowed");
});

for (const [name, args] of [["smoke", claudeSmokeArgv()], ["worker", claudeWorkerArgv()], ["qualification", ["--settings", claudeSandboxArgs([])[1]]]]) {
  test(`live (credential-free): ${name} sandbox settings run the permitted command and deny child egress`, { skip: !live }, async () => {
    const i = args.indexOf("--settings");
    const r = await runClaude(["--settings", args[i + 1]], twoCommands);
    assert.equal(r.results[0], "LDL_n0nce_OK");
    assert.equal(codeOf(r.results[1]), "000", "child egress denied");
  });
}

test("live (credential-free): sandbox escape request and unavailable backend fail closed", { skip: !live }, async () => {
  const settings = claudeSandboxArgs([]);
  const esc = await runClaude(settings, [{ command: EGRESS, dangerouslyDisableSandbox: true }]);
  assert.equal(codeOf(esc.results[0]), "000", "dangerouslyDisableSandbox does not lift the sandbox");
  const down = await runClaude(settings, twoCommands, { hideBwrap: true });
  assert.deepEqual(down.results, [], "no Bash command executes without a sandbox backend");
  assert.notEqual(down.code, 0);
});

test("live (credential-free): malformed --settings fails closed with no Bash execution", { skip: !live }, async () => {
  for (const bad of ["{not json", '{"sandbox":{"enabled":false}}']) {
    const r = await runClaude(["--settings", bad], twoCommands);
    assert.deepEqual(r.results, [], `no Bash command executes with malformed settings ${bad}`);
    assert.notEqual(r.code, 0, `the CLI exits nonzero for malformed settings ${bad}`);
  }
});
