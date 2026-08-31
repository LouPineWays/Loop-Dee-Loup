#!/usr/bin/env node
// Fixture double for the real `claude` CLI binary, used only by
// execution-boundary-probe.test.mjs. Emits canned `--output-format stream-json` lines on
// stdout so spawnAndCapture's parsing logic can be exercised deterministically, without
// spawning a real Claude Code process or touching any network/auth surface.
//
// Usage: node fake-cli.mjs <mode>
//   normal     one init line + one successful result line, exit 0
//   subagent   like normal, but the result's modelUsage carries two distinct models
//   error      init line + an is_error result line, exit 1
//   no-result  only an init line, exit 0 (process ends without ever emitting a result)
//   hang       an init line, then never exits on its own (for kill-after-ms tests)

const mode = process.argv[2] || "normal";

function initLine(sessionId) {
  return JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, cwd: process.cwd(), model: "claude-sonnet-5" });
}

function resultLine(overrides) {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1234,
    duration_api_ms: 900,
    num_turns: 1,
    result: "fixture response text - must never be persisted by the probe",
    session_id: "fixture-session-normal",
    total_cost_usd: 0.0123,
    usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 5 },
    modelUsage: {
      "claude-sonnet-5": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 5, cacheCreationInputTokens: 0, costUSD: 0.0123 },
    },
    ...overrides,
  });
}

switch (mode) {
  case "normal":
    console.log(initLine("fixture-session-normal"));
    console.log(resultLine({}));
    process.exit(0);
    break;
  case "subagent":
    console.log(initLine("fixture-session-subagent"));
    console.log(JSON.stringify({ type: "assistant", parent_tool_use_id: "toolu_1", session_id: "fixture-session-subagent" }));
    console.log(
      resultLine({
        session_id: "fixture-session-subagent",
        modelUsage: {
          "claude-sonnet-5": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 5, cacheCreationInputTokens: 0, costUSD: 0.01 },
          "claude-haiku-4-5": { inputTokens: 200, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.002 },
        },
      }),
    );
    process.exit(0);
    break;
  case "error":
    console.log(initLine("fixture-session-error"));
    console.log(resultLine({ subtype: "error_during_execution", is_error: true, session_id: "fixture-session-error" }));
    process.exit(1);
    break;
  case "no-result":
    console.log(initLine("fixture-session-no-result"));
    process.exit(0);
    break;
  case "hang":
    console.log(initLine("fixture-session-hang"));
    setInterval(() => {}, 1000);
    break;
  default:
    process.exit(2);
}
