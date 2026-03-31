import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubCheckRunReporter } from "../src/github/check-run-reporter.ts";
import type { IncidentRecord, QueueEntry } from "../src/types.ts";

function makeEntry(): QueueEntry {
  return {
    id: "qe-1",
    repoId: "repo",
    prNumber: 42,
    branch: "feat/report",
    headSha: "sha-head",
    baseSha: "sha-base",
    status: "queued",
    position: 1,
    priority: 0,
    generation: 0,
    ciRunId: null,
    ciRetries: 0,
    retryAttempts: 0,
    maxRetries: 2,
    lastFailedBaseSha: null,
    issueKey: "ISSUE-42",
    specBranch: null,
    specSha: null,
    specBasedOn: null,
    enqueuedAt: "2026-03-31T00:00:00.000Z",
    updatedAt: "2026-03-31T00:00:00.000Z",
  };
}

function makeIncident(): IncidentRecord {
  return {
    id: "incident-1",
    entryId: "qe-1",
    at: "2026-03-31T00:01:00.000Z",
    failureClass: "branch_local",
    context: {
      version: 1,
      failureClass: "branch_local",
      baseSha: "sha-base",
      prHeadSha: "sha-head",
      queuePosition: 1,
      baseBranch: "main",
      branch: "feat/report",
      issueKey: "ISSUE-42",
      retryHistory: [],
      failedChecks: [{ name: "test", conclusion: "failure", url: "https://github.com/owner/repo/checks/1" }],
    },
    outcome: "open",
  };
}

test("GitHubCheckRunReporter emits the configured queue eviction check name", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-check-run-reporter-"));
  const logPath = path.join(baseDir, "gh.log");
  const ghPath = path.join(baseDir, "gh");

  try {
    writeFileSync(
      ghPath,
      `#!/bin/sh
if [ "$1" = "api" ]; then
  input=""
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--input" ]; then
      input="$arg"
      break
    fi
    prev="$arg"
  done
  {
    printf 'CMD:%s\\n' "$1"
    printf 'ARGS:%s\\n' "$*"
    printf 'BODY_BEGIN\\n'
    cat "$input"
    printf '\\nBODY_END\\n---\\n'
  } >> "$GH_LOG"
else
  {
    printf 'CMD:%s\\n' "$1"
    printf 'ARGS:%s\\n---\\n' "$*"
  } >> "$GH_LOG"
fi
exit 0
`,
      "utf8",
    );
    chmodSync(ghPath, 0o755);

    const reporter = new GitHubCheckRunReporter(
      "owner/repo",
      "127.0.0.1",
      8790,
      undefined,
      "queue",
      "custom/queue-eviction",
    );

    const previousPath = process.env.PATH;
    const previousLog = process.env.GH_LOG;
    process.env.PATH = `${baseDir}${path.delimiter}${previousPath ?? ""}`;
    process.env.GH_LOG = logPath;
    try {
      await reporter.reportEviction(makeEntry(), makeIncident());
    } finally {
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      if (previousLog === undefined) {
        delete process.env.GH_LOG;
      } else {
        process.env.GH_LOG = previousLog;
      }
    }

    const log = readFileSync(logPath, "utf8");
    const calls = log.split("\n---\n").map((chunk) => chunk.trim()).filter(Boolean);
    assert.equal(calls.length, 2);

    const apiCall = calls[0]!;
    assert.match(apiCall, /CMD:api/);
    const bodyMatch = apiCall.match(/BODY_BEGIN\n([\s\S]*)\nBODY_END$/);
    assert.ok(bodyMatch);
    const body = JSON.parse(bodyMatch?.[1] ?? "") as { name: string; output: { text: string }; details_url: string };
    assert.equal(body.name, "custom/queue-eviction");
    assert.match(body.output.text, /"version":1/);
    assert.match(body.output.text, /"incidentId":"incident-1"/);
    assert.match(body.output.text, /"incidentUrl":"http:\/\/127\.0\.0\.1:8790\/queue\/incidents\/incident-1"/);
    assert.match(body.output.text, /"baseBranch":"main"/);
    assert.match(body.output.text, /"url":"https:\/\/github\.com\/owner\/repo\/checks\/1"/);

    const editCall = calls[1]!;
    assert.match(editCall, /CMD:pr/);
    assert.match(editCall, /--remove-label queue/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
