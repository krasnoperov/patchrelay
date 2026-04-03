import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, afterEach, beforeEach } from "node:test";
import { GitHubActionsRunner } from "../src/github/actions-runner.ts";

/**
 * Stub `gh` CLI that returns canned check-run JSON based on the SHA
 * passed in the URL.  Maps SHA → JSON array via env var GH_CHECKS_MAP
 * (JSON object keyed by SHA).
 */
function buildGhStub(checksMap: Record<string, unknown[]>): string {
  // Shell script that extracts the SHA from the API URL and returns the
  // matching check-runs array from the encoded map.
  return `#!/usr/bin/env node
const url = process.argv.find(a => a.includes('/check-runs'));
if (!url) { process.exit(1); }
const sha = url.split('/commits/')[1]?.split('/')[0];
const map = JSON.parse(process.env.GH_CHECKS_MAP || '{}');
const runs = map[sha];
if (!runs) { process.stdout.write('[]'); process.exit(0); }
process.stdout.write(JSON.stringify(runs));
`;
}

describe("GitHubActionsRunner.getStatus", () => {
  let baseDir: string;
  let prevPath: string | undefined;
  let prevMap: string | undefined;

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), "ms-actions-runner-"));
    prevPath = process.env.PATH;
    prevMap = process.env.GH_CHECKS_MAP;
  });

  afterEach(() => {
    process.env.PATH = prevPath;
    delete process.env.GH_CHECKS_MAP;
    if (prevMap !== undefined) process.env.GH_CHECKS_MAP = prevMap;
    rmSync(baseDir, { recursive: true, force: true });
  });

  function setup(checksMap: Record<string, unknown[]>): GitHubActionsRunner {
    const ghPath = path.join(baseDir, "gh");
    writeFileSync(ghPath, buildGhStub(checksMap), "utf8");
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${baseDir}${path.delimiter}${prevPath ?? ""}`;
    process.env.GH_CHECKS_MAP = JSON.stringify(checksMap);
    return new GitHubActionsRunner("owner/repo", ["Tests"]);
  }

  it("reports pass when required check succeeds", async () => {
    const runner = setup({
      abc123: [{ name: "Tests", status: "completed", conclusion: "success" }],
    });
    assert.strictEqual(await runner.getStatus("sha:abc123"), "pass");
  });

  it("reports fail when required check fails", async () => {
    const runner = setup({
      abc123: [{ name: "Tests", status: "completed", conclusion: "failure" }],
    });
    assert.strictEqual(await runner.getStatus("sha:abc123"), "fail");
  });

  it("reports pending when required check is still running", async () => {
    const runner = setup({
      abc123: [{ name: "Tests", status: "in_progress", conclusion: null }],
    });
    assert.strictEqual(await runner.getStatus("sha:abc123"), "pending");
  });

  it("treats skipped required check as FAIL, not pass", async () => {
    const runner = setup({
      abc123: [{ name: "Tests", status: "completed", conclusion: "skipped" }],
    });
    // This is the critical fix: a required check that was skipped means
    // the CI workflow didn't actually run tests on the spec branch.
    assert.strictEqual(await runner.getStatus("sha:abc123"), "fail");
  });

  it("treats neutral conclusion as pass", async () => {
    const runner = setup({
      abc123: [{ name: "Tests", status: "completed", conclusion: "neutral" }],
    });
    assert.strictEqual(await runner.getStatus("sha:abc123"), "pass");
  });

  it("reports pending when no check-runs exist yet", async () => {
    const runner = setup({ abc123: [] });
    assert.strictEqual(await runner.getStatus("sha:abc123"), "pending");
  });

  it("ignores irrelevant checks and reports pending when required is missing", async () => {
    const runner = setup({
      abc123: [{ name: "Lint", status: "completed", conclusion: "success" }],
    });
    assert.strictEqual(await runner.getStatus("sha:abc123"), "pending");
  });

  it("fails when gate job succeeds but underlying check is skipped (MAF-49 scenario)", async () => {
    // This reproduces the exact bug: "Tests" gate job succeeds, but the
    // actual "Build & UI Tests" job was skipped on the spec branch.
    const runner = new GitHubActionsRunner("owner/repo", ["Tests", "Build & UI Tests"]);
    const ghPath = path.join(baseDir, "gh");
    writeFileSync(ghPath, buildGhStub({
      abc123: [
        { name: "Tests", status: "completed", conclusion: "success" },
        { name: "Build & UI Tests", status: "completed", conclusion: "skipped" },
      ],
    }), "utf8");
    chmodSync(ghPath, 0o755);
    process.env.PATH = `${baseDir}${path.delimiter}${prevPath ?? ""}`;
    process.env.GH_CHECKS_MAP = JSON.stringify({
      abc123: [
        { name: "Tests", status: "completed", conclusion: "success" },
        { name: "Build & UI Tests", status: "completed", conclusion: "skipped" },
      ],
    });

    assert.strictEqual(await runner.getStatus("sha:abc123"), "fail");
  });
});
