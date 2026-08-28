#!/usr/bin/env node
// Flags any GitHub Issue carrying more than one priority-horizon label (priority:now /
// priority:soon / priority:later / priority:wishes). Priority horizons are meant to be
// mutually exclusive — see docs/priority-horizons.md, which replaced the retired Burn
// Order (issue #192). GitHub has no native mutually-exclusive label group, so this script
// is the "obvious detection" mechanism .github/workflows/priority-labels.yml runs on every
// `labeled` event.
//
// Usage:
//   node tools/check-priority-labels.mjs            scans every open issue
//   node tools/check-priority-labels.mjs <number>    checks just that issue
//
// Requires `gh` authenticated against this repository. Exits non-zero and lists every
// conflict on failure.

import { execFileSync } from "node:child_process";

const PRIORITY_PREFIX = "priority:";

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8" });
}

function priorityLabelsOf(issue) {
  return issue.labels.map((l) => l.name).filter((name) => name.startsWith(PRIORITY_PREFIX));
}

// Pages through every open issue via the REST issues endpoint rather than a single
// gh issue list --limit call, so a repository with more than one page of open issues
// cannot silently truncate the scan and report a false OK. The endpoint also returns
// pull requests, which carry no `priority:*` label anyway but are filtered out here to
// keep the report scoped to actual issues.
function listAllOpenIssues() {
  const issues = [];
  for (let page = 1; ; page++) {
    const raw = gh(["api", `repos/{owner}/{repo}/issues?state=open&per_page=100&page=${page}`]);
    const batch = JSON.parse(raw);
    if (batch.length === 0) break;
    for (const item of batch) {
      if (!item.pull_request) issues.push(item);
    }
    if (batch.length < 100) break;
  }
  return issues;
}

const arg = process.argv[2];
let issues;

if (arg) {
  if (!/^\d+$/.test(arg)) {
    console.error("usage: node tools/check-priority-labels.mjs [issue-number]");
    process.exit(2);
  }
  const raw = gh(["issue", "view", arg, "--json", "number,title,labels,state"]);
  issues = [JSON.parse(raw)];
} else {
  issues = listAllOpenIssues();
}

const conflicts = issues
  .map((issue) => ({ issue, priorityLabels: priorityLabelsOf(issue) }))
  .filter(({ priorityLabels }) => priorityLabels.length > 1);

if (conflicts.length > 0) {
  console.error("Priority-horizon label check FAILED:");
  for (const { issue, priorityLabels } of conflicts) {
    console.error(`  #${issue.number} "${issue.title}" carries multiple priority labels: ${priorityLabels.join(", ")}`);
  }
  console.error("\nAn Issue may carry at most one priority:* label. Remove the stale one — see docs/priority-horizons.md.");
  process.exit(1);
}

console.log(
  arg
    ? `OK: issue #${arg} carries at most one priority-horizon label.`
    : `OK: all ${issues.length} open issue(s) carry at most one priority-horizon label each.`,
);
