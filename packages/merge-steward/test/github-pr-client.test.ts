import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { GitHubPRClient } from "../src/github/pr-client.ts";

test("GitHubPRClient listChecks uses the REST check-runs API via head sha", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-gh-pr-client-"));
  const ghPath = path.join(baseDir, "gh");
  const logPath = path.join(baseDir, "gh.log");

  try {
    writeFileSync(
      ghPath,
      `#!/bin/sh
echo "$*" >> "$GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '{"number":101,"headRefName":"feature","headRefOid":"sha-101","reviewDecision":"APPROVED","state":"OPEN"}'
  exit 0
fi
if [ "$1" = "api" ]; then
  printf '[{"name":"Tests","status":"completed","conclusion":"success","html_url":"https://github.com/owner/repo/checks/1"},{"name":"AI Review","status":"completed","conclusion":"skipped","html_url":"https://github.com/owner/repo/checks/2"}]'
  exit 0
fi
exit 1
`,
      "utf8",
    );
    chmodSync(ghPath, 0o755);

    const previousPath = process.env.PATH;
    const previousLog = process.env.GH_LOG;
    process.env.PATH = `${baseDir}${path.delimiter}${previousPath ?? ""}`;
    process.env.GH_LOG = logPath;
    try {
      const client = new GitHubPRClient("owner/repo");
      const status = await client.getStatus(101);
      assert.equal(status.reviewDecision, "APPROVED");
      assert.equal(status.reviewApproved, true);
      const checks = await client.listChecks(101);
      assert.deepEqual(checks, [
        { name: "Tests", conclusion: "success", url: "https://github.com/owner/repo/checks/1" },
        { name: "AI Review", conclusion: "success", url: "https://github.com/owner/repo/checks/2" },
      ]);
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
    assert.match(log, /pr view 101 --repo owner\/repo --json number,headRefName,headRefOid,reviewDecision,state/);
    assert.match(log, /api repos\/owner\/repo\/commits\/sha-101\/check-runs --jq \.check_runs/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
