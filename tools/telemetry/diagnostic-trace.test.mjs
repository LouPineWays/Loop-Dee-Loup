// Tests for tools/telemetry/diagnostic-trace.mjs — issue #310's opt-in diagnostic-trace
// extractor for orchestration proving/debug sessions.
//
// Mirrors this directory's existing convention (see transcript.test.mjs): builds
// synthetic transcript lines matching Claude Code's real on-disk shape rather than
// mocking the filesystem, and exercises the exported pure functions directly plus one
// end-to-end CLI subprocess run.
//
// Run with:
//   node --test tools/telemetry/diagnostic-trace.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildDiagnosticTrace,
  extractDiagnosticTrace,
  classifyPreDispatch,
} from "./diagnostic-trace.mjs";

const DIAGNOSTIC_TRACE_MJS = join(process.cwd(), "tools", "telemetry", "diagnostic-trace.mjs");

function assistantLine({ ts, sessionId = "sess-fixture", content }) {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    sessionId,
    message: { role: "assistant", content },
  });
}

function bashToolUse(id, command) {
  return { type: "tool_use", id, name: "Bash", input: { command } };
}

function taskToolUse(id, { prompt, subagentType = "general-purpose" }) {
  return { type: "tool_use", id, name: "Task", input: { prompt, subagent_type: subagentType } };
}

function textBlock(text) {
  return { type: "text", text };
}

test("buildDiagnosticTrace: clean split-control sequence — control read then immediate reference-only dispatch", () => {
  const lines = [
    JSON.parse(
      assistantLine({
        ts: "2026-09-03T10:00:00.000Z",
        content: [textBlock("Reading the control issue."), bashToolUse("t1", "gh issue view 311 --json body")],
      }),
    ),
    JSON.parse(
      assistantLine({
        ts: "2026-09-03T10:00:05.000Z",
        content: [taskToolUse("t2", { prompt: "Dispatch by reference: execution #310, control #311, route: implementation worker." })],
      }),
    ),
  ];

  const trace = buildDiagnosticTrace(lines, { controlIssue: 311, executionIssue: 310 });

  assert.equal(trace.control_issue, 311);
  assert.equal(trace.execution_issue, 310);
  assert.equal(trace.diagnostic_mode, true);
  assert.equal(trace.session, "sess-fixture");
  assert.equal(trace.first_dispatch_ms, 5000);
  assert.equal(trace.execution_issue_read_by_controller_before_dispatch, false);
  assert.deepEqual(trace.pre_dispatch_events, [{ kind: "issue_read", ref: "#311" }]);
  assert.equal(trace.dispatch_prompt.reference_only, true);
  assert.ok(trace.dispatch_prompt.chars > 0);
  assert.deepEqual(trace.dispatch_prompt.worker_references.sort(), ["#310", "#311"]);

  const classification = classifyPreDispatch(trace);
  assert.equal(classification.status, "clean");
  assert.deepEqual(classification.reasons, []);
});

test("buildDiagnosticTrace: regression sequence — thick execution issue read before dispatch is surfaced", () => {
  const lines = [
    JSON.parse(
      assistantLine({
        ts: "2026-09-03T10:00:00.000Z",
        content: [textBlock("I should check the execution issue's own decomposition shape first."), bashToolUse("t1", "gh issue view 310 --json body,title")],
      }),
    ),
    JSON.parse(
      assistantLine({
        ts: "2026-09-03T10:00:30.000Z",
        content: [bashToolUse("t2", "git status")],
      }),
    ),
    JSON.parse(
      assistantLine({
        ts: "2026-09-03T10:01:00.000Z",
        content: [taskToolUse("t3", { prompt: "Implement execution issue #310 as follows: ..." })],
      }),
    ),
  ];

  const trace = buildDiagnosticTrace(lines, { controlIssue: 311, executionIssue: 310, annotate: true });

  assert.equal(trace.execution_issue_read_by_controller_before_dispatch, true);
  assert.deepEqual(trace.pre_dispatch_events, [{ kind: "issue_read", ref: "#310" }, { kind: "git_status" }]);
  assert.equal(trace.first_dispatch_ms, 60000);

  const classification = classifyPreDispatch(trace);
  assert.equal(classification.status, "violation");
  assert.ok(classification.reasons.some((r) => r.includes("read by the controller before")));

  // The clean and regression traces must be mechanically distinguishable from each
  // other using only their structural fields (#310 acceptance criteria).
  assert.notEqual(trace.execution_issue_read_by_controller_before_dispatch, false);

  // A small, bounded, truncated annotation is captured only because this specific
  // violation was detected — not unconditionally.
  assert.equal(trace.annotations.length, 1);
  assert.equal(trace.annotations[0].reason, "execution_issue_read_before_dispatch");
  assert.ok(trace.annotations[0].text.length <= 241);
});

test("buildDiagnosticTrace: no pre-dispatch reads at all is also a clean trace", () => {
  const lines = [
    JSON.parse(
      assistantLine({
        ts: "2026-09-03T10:00:00.000Z",
        content: [taskToolUse("t1", { prompt: "See #310." })],
      }),
    ),
  ];
  const trace = buildDiagnosticTrace(lines, { controlIssue: 311, executionIssue: 310 });
  assert.equal(trace.execution_issue_read_by_controller_before_dispatch, false);
  assert.deepEqual(trace.pre_dispatch_events, []);
  assert.equal(classifyPreDispatch(trace).status, "clean");
});

test("classifyPreDispatch: a transcript with no subagent dispatch at all is indeterminate, never clean (Stage 2 audit finding, PR #317)", () => {
  // An interrupted/truncated/pre-dispatch-only session: the controller read the
  // control issue but never actually dispatched a worker. This must not be reported
  // as a positive "clean" proof of the required control-read -> dispatch sequence,
  // since that sequence never completed.
  const lines = [
    JSON.parse(assistantLine({ ts: "2026-09-03T10:00:00.000Z", content: [bashToolUse("t1", "gh issue view 311")] })),
    JSON.parse(assistantLine({ ts: "2026-09-03T10:00:05.000Z", content: [bashToolUse("t2", "git status")] })),
    // ...session ends here; no Task tool_use ever appears.
  ];
  const trace = buildDiagnosticTrace(lines, { controlIssue: 311, executionIssue: 310 });
  assert.equal(trace.dispatch_prompt, null);
  assert.deepEqual(trace.dispatch_events, []);

  const classification = classifyPreDispatch(trace);
  assert.equal(classification.status, "indeterminate");
  assert.notEqual(classification.status, "clean");
  assert.ok(classification.reasons.length > 0);

  // Also true for a completely empty transcript.
  assert.equal(classifyPreDispatch(buildDiagnosticTrace([], { controlIssue: 311 })).status, "indeterminate");

  // And for a minimal reloaded/hand-built trace with no dispatch_events array at all
  // (e.g. an older or partial saved artifact a fresh reviewer might load).
  assert.equal(classifyPreDispatch({ execution_issue_read_by_controller_before_dispatch: false }).status, "indeterminate");
});

test("classifyPreDispatch: a known violation is reported as 'violation' even when no dispatch ever happened (Stage 1 finding, PR #319)", () => {
  // An interrupted session that DID read the execution issue pre-dispatch, then never
  // reached a Task dispatch at all — the real trace this mechanism's own #310/#311
  // proving session produced. The proven violation must not be swallowed by the
  // no-dispatch "indeterminate" path: it is known bad evidence regardless of whether a
  // dispatch later occurred.
  const lines = [
    JSON.parse(assistantLine({ ts: "2026-09-03T10:00:00.000Z", content: [bashToolUse("t1", "gh issue view 311")] })),
    JSON.parse(assistantLine({ ts: "2026-09-03T10:00:05.000Z", content: [bashToolUse("t2", "gh issue view 310 --json body")] })),
    // ...session ends here; no Task tool_use ever appears.
  ];
  const trace = buildDiagnosticTrace(lines, { controlIssue: 311, executionIssue: 310 });
  assert.equal(trace.execution_issue_read_by_controller_before_dispatch, true);
  assert.equal(trace.dispatch_prompt, null);
  assert.deepEqual(trace.dispatch_events, []);

  const classification = classifyPreDispatch(trace);
  assert.equal(classification.status, "violation");
  assert.notEqual(classification.status, "indeterminate");
  assert.ok(classification.reasons.some((r) => r.includes("read by the controller before")));
});

test("buildDiagnosticTrace: execution_issue_read flag is null (not false) when no execution issue was supplied", () => {
  const lines = [
    JSON.parse(assistantLine({ ts: "2026-09-03T10:00:00.000Z", content: [bashToolUse("t1", "gh issue view 311")] })),
    JSON.parse(assistantLine({ ts: "2026-09-03T10:00:05.000Z", content: [taskToolUse("t2", { prompt: "go" })] })),
  ];
  const trace = buildDiagnosticTrace(lines, { controlIssue: 311 });
  assert.equal(trace.execution_issue_read_by_controller_before_dispatch, null);
});

test("buildDiagnosticTrace: prompt-duplication case is distinguished from reference-only using char count alone", () => {
  const shortPrompt = "Dispatch #310 by reference.";
  const longPrompt = "Implement the following in full: " + "requirement text ".repeat(60) + "#310";

  const cleanTrace = buildDiagnosticTrace(
    [JSON.parse(assistantLine({ ts: "2026-09-03T10:00:00.000Z", content: [taskToolUse("t1", { prompt: shortPrompt })] }))],
    { controlIssue: 311, executionIssue: 310, referenceThresholdChars: 100 },
  );
  const duplicatedTrace = buildDiagnosticTrace(
    [JSON.parse(assistantLine({ ts: "2026-09-03T10:00:00.000Z", content: [taskToolUse("t1", { prompt: longPrompt })] }))],
    { controlIssue: 311, executionIssue: 310, referenceThresholdChars: 100 },
  );

  assert.equal(cleanTrace.dispatch_prompt.reference_only, true);
  assert.equal(duplicatedTrace.dispatch_prompt.reference_only, false);
  assert.ok(duplicatedTrace.dispatch_prompt.chars > cleanTrace.dispatch_prompt.chars);

  assert.equal(classifyPreDispatch(cleanTrace).status, "clean");
  assert.equal(classifyPreDispatch(duplicatedTrace).status, "violation");

  // The full prompt text is never present in the trace — only its length.
  const serialized = JSON.stringify(duplicatedTrace);
  assert.ok(!serialized.includes("requirement text"));
});

test("privacy: full transcript content, prompts, and file paths never appear in the derived trace by default (annotate off)", () => {
  const secretMarker = "SUPER-SECRET-PROMPT-CONTENT-MUST-NOT-LEAK-4471";
  const lines = [
    JSON.parse(
      assistantLine({
        ts: "2026-09-03T10:00:00.000Z",
        content: [
          textBlock(`Some private reasoning mentioning ${secretMarker} that should not survive.`),
          bashToolUse("t1", `gh issue view 310 --json body # ${secretMarker}`),
        ],
      }),
    ),
    JSON.parse(
      assistantLine({
        ts: "2026-09-03T10:00:05.000Z",
        content: [taskToolUse("t2", { prompt: `${secretMarker} full reconstructed spec text #310` })],
      }),
    ),
  ];
  // annotate is NOT passed — matches every other extraction call site above and the
  // opt-in-minimal default: no reasoning excerpt is ever captured unless explicitly
  // requested.
  const trace = buildDiagnosticTrace(lines, { controlIssue: 311, executionIssue: 310 });
  const serialized = JSON.stringify(trace);
  assert.ok(!serialized.includes(secretMarker));
  assert.ok(!serialized.includes("gh issue view"));
  assert.deepEqual(trace.annotations, []);
  assert.ok(!("transcript_path" in trace));
});

test("annotate opt-in: captures only a small bounded excerpt, never the full raw tool command or full prompt", () => {
  const rawCommand = "gh issue view 310 --json body,title,comments --jq '.body' --extra-verbose-flag-with-lots-of-text";
  const fullPrompt = "Implement the following in full: " + "requirement text ".repeat(80) + "#310";
  const lines = [
    JSON.parse(
      assistantLine({
        ts: "2026-09-03T10:00:00.000Z",
        content: [textBlock("Checking the execution issue before dispatch."), bashToolUse("t1", rawCommand)],
      }),
    ),
    JSON.parse(assistantLine({ ts: "2026-09-03T10:00:05.000Z", content: [taskToolUse("t2", { prompt: fullPrompt })] })),
  ];
  const trace = buildDiagnosticTrace(lines, { controlIssue: 311, executionIssue: 310, annotate: true });
  assert.equal(trace.annotations.length, 1);
  assert.ok(trace.annotations[0].text.length <= 241);
  // The raw Bash command string (flags, exact gh invocation) is never persisted, even
  // when an annotation is captured — only the short preceding assistant text block is.
  assert.ok(!JSON.stringify(trace).includes(rawCommand));
  assert.ok(!JSON.stringify(trace).includes(fullPrompt));
});

test("fresh-review check: classifyPreDispatch reproduces the verdict from the artifact's own fields, without the transcript", () => {
  const trace = {
    session: "s1",
    control_issue: 311,
    execution_issue: 310,
    diagnostic_mode: true,
    execution_issue_read_by_controller_before_dispatch: true,
    dispatch_prompt: { chars: 40, reference_only: true, worker_references: ["#310"] },
  };
  // Round-trip through JSON, simulating a fresh reviewer loading only the saved file.
  const reloaded = JSON.parse(JSON.stringify(trace));
  const result = classifyPreDispatch(reloaded);
  assert.equal(result.status, "violation");
});

test("extractDiagnosticTrace reads a real transcript file from disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-diagnostic-trace-test-"));
  try {
    const transcriptPath = join(dir, "s-1.jsonl");
    writeFileSync(
      transcriptPath,
      [
        assistantLine({ ts: "2026-09-03T10:00:00.000Z", sessionId: "s-1", content: [bashToolUse("t1", "gh issue view 311")] }),
        assistantLine({ ts: "2026-09-03T10:00:02.000Z", sessionId: "s-1", content: [taskToolUse("t2", { prompt: "#310 by reference" })] }),
      ].join("\n") + "\n",
      "utf8",
    );
    const trace = extractDiagnosticTrace(transcriptPath, { controlIssue: 311, executionIssue: 310 });
    assert.equal(trace.session, "s-1");
    assert.equal(trace.first_dispatch_ms, 2000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: refuses to run without --diagnostic-mode and writes nothing (explicit opt-in only)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-diagnostic-trace-cli-"));
  try {
    const transcriptPath = join(dir, "s-1.jsonl");
    writeFileSync(transcriptPath, assistantLine({ ts: "2026-09-03T10:00:00.000Z", content: [] }) + "\n", "utf8");
    const outPath = join(dir, "out.json");
    const result = spawnSync(
      process.execPath,
      [DIAGNOSTIC_TRACE_MJS, "--transcript", transcriptPath, "--control-issue", "311", "--out", outPath, "--no-index"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 2);
    assert.ok(!existsSync(outPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: explicit --diagnostic-mode invocation writes the artifact and appends a bounded index entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-diagnostic-trace-cli-"));
  try {
    const transcriptPath = join(dir, "s-1.jsonl");
    writeFileSync(
      transcriptPath,
      [
        assistantLine({ ts: "2026-09-03T10:00:00.000Z", sessionId: "s-1", content: [bashToolUse("t1", "gh issue view 311")] }),
        assistantLine({ ts: "2026-09-03T10:00:03.000Z", sessionId: "s-1", content: [taskToolUse("t2", { prompt: "#310 by reference" })] }),
      ].join("\n") + "\n",
      "utf8",
    );
    const outPath = join(dir, "trace.json");
    const indexPath = join(dir, "index.json");
    const result = spawnSync(
      process.execPath,
      [
        DIAGNOSTIC_TRACE_MJS,
        "--transcript",
        transcriptPath,
        "--diagnostic-mode",
        "--control-issue",
        "311",
        "--execution-issue",
        "310",
        "--out",
        outPath,
        "--index",
        indexPath,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(outPath));
    const written = JSON.parse(readFileSync(outPath, "utf8"));
    assert.equal(written.control_issue, 311);
    assert.equal(written.execution_issue, 310);

    // Bounded-discovery manifest: enough metadata to decide relevance without opening
    // the artifact (issue #310's telemetry-battery integration requirement).
    assert.ok(existsSync(indexPath));
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    assert.equal(index.length, 1);
    assert.equal(index[0].control_issue, 311);
    assert.equal(index[0].execution_issue, 310);
    assert.equal(index[0].pre_dispatch_status, "clean");
    assert.ok(typeof index[0].created_at === "string");
    // The index never carries prompt/reasoning content, only coarse identifiers.
    assert.ok(!("dispatch_prompt" in index[0]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: a second run appends to the same index rather than overwriting it (bounded multi-trace discovery)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ldl-diagnostic-trace-cli-"));
  try {
    const indexPath = join(dir, "index.json");
    for (const [session, issue] of [["s-1", 310], ["s-2", 320]]) {
      const transcriptPath = join(dir, `${session}.jsonl`);
      writeFileSync(
        transcriptPath,
        assistantLine({ ts: "2026-09-03T10:00:00.000Z", sessionId: session, content: [taskToolUse("t1", { prompt: `#${issue}` })] }) + "\n",
        "utf8",
      );
      const result = spawnSync(
        process.execPath,
        [
          DIAGNOSTIC_TRACE_MJS,
          "--transcript",
          transcriptPath,
          "--diagnostic-mode",
          "--control-issue",
          "300",
          "--execution-issue",
          String(issue),
          "--out",
          join(dir, `${session}.json`),
          "--index",
          indexPath,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
    }
    const index = JSON.parse(readFileSync(indexPath, "utf8"));
    assert.equal(index.length, 2);
    assert.deepEqual(index.map((e) => e.execution_issue).sort(), [310, 320]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
