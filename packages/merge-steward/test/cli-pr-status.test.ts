import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildPrStatusReport,
  classifyGitHubOverview,
  classifyQueueEntry,
  handlePrStatus,
} from "../src/cli/commands/pr-status.ts";
import type { PrGitHubOverview } from "../src/cli/commands/pr-github.ts";
import { parseArgs } from "../src/cli/args.ts";
import type { QueueEntry } from "../src/types.ts";
import { runCli } from "../src/cli.ts";

function createBufferStream() {
  let buffer = "";
  return {
    stream: {
      write(chunk: string): boolean {
        buffer += chunk;
        return true;
      },
    },
    read(): string {
      return buffer;
    },
  };
}

function makeEntry(status: QueueEntry["status"], overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id: "entry-1",
    repoId: "app",
    prNumber: 42,
    branch: "feat/x",
    headSha: "abc123",
    baseSha: "main-sha",
    status,
    position: 0,
    priority: 0,
    generation: 0,
    ciRunId: null,
    ciRetries: 0,
    retryAttempts: 0,
    maxRetries: 3,
    lastFailedBaseSha: null,
    issueKey: null,
    specBranch: null,
    specSha: null,
    specBasedOn: null,
    waitDetail: null,
    postMergeStatus: null,
    postMergeSha: null,
    postMergeSummary: null,
    postMergeCheckedAt: null,
    enqueuedAt: "2026-04-17T00:00:00Z",
    updatedAt: "2026-04-17T00:00:00Z",
    ...overrides,
  };
}

function makeOverview(overrides: Partial<PrGitHubOverview> = {}): PrGitHubOverview {
  return {
    number: 42,
    branch: "feat/x",
    headSha: "abc123",
    state: "OPEN",
    merged: false,
    reviewDecision: "",
    labels: [],
    checks: [],
    ...overrides,
  };
}

test("classifyQueueEntry maps merged to merged", () => {
  assert.equal(classifyQueueEntry(makeEntry("merged")), "merged");
});

test("classifyQueueEntry maps evicted to evicted", () => {
  assert.equal(classifyQueueEntry(makeEntry("evicted")), "evicted");
});

test("classifyQueueEntry maps validating to validating", () => {
  assert.equal(classifyQueueEntry(makeEntry("validating")), "validating");
});

test("classifyGitHubOverview handles merged_outside_queue", () => {
  const result = classifyGitHubOverview(makeOverview({ state: "MERGED", merged: true }));
  assert.equal(result.kind, "merged_outside_queue");
});

test("classifyGitHubOverview handles CHANGES_REQUESTED", () => {
  const result = classifyGitHubOverview(makeOverview({ reviewDecision: "CHANGES_REQUESTED" }));
  assert.equal(result.kind, "changes_requested");
});

test("classifyGitHubOverview prioritizes failing required checks over approval", () => {
  const result = classifyGitHubOverview(makeOverview({
    reviewDecision: "APPROVED",
    checks: [
      { name: "ci / test", status: "failure", required: true },
      { name: "ci / lint", status: "success", required: true },
    ],
  }));
  assert.equal(result.kind, "checks_failing");
  assert.match(result.reason ?? "", /ci \/ test/);
});

test("classifyGitHubOverview reports checks_pending when required checks are still running", () => {
  const result = classifyGitHubOverview(makeOverview({
    reviewDecision: "APPROVED",
    checks: [
      { name: "ci / test", status: "pending", required: true },
    ],
  }));
  assert.equal(result.kind, "checks_pending");
});

test("classifyGitHubOverview reports approved_clean when approved with green checks", () => {
  const result = classifyGitHubOverview(makeOverview({
    reviewDecision: "APPROVED",
    checks: [
      { name: "ci / test", status: "success", required: true },
    ],
  }));
  assert.equal(result.kind, "approved_clean");
});

test("classifyGitHubOverview falls back to not_queued when nothing else applies", () => {
  const result = classifyGitHubOverview(makeOverview({
    reviewDecision: "REVIEW_REQUIRED",
    checks: [{ name: "ci", status: "success", required: true }],
  }));
  assert.equal(result.kind, "not_queued");
});

test("buildPrStatusReport: queue merged returns exit 0 terminal", () => {
  const report = buildPrStatusReport({
    repoId: "app",
    repoFullName: "owner/app",
    prNumber: 42,
    queueEntry: makeEntry("merged"),
  });
  assert.equal(report.kind, "merged");
  assert.equal(report.exitCode, 0);
  assert.equal(report.terminal, true);
});

test("buildPrStatusReport: queue evicted returns exit 2 terminal", () => {
  const report = buildPrStatusReport({
    repoId: "app",
    repoFullName: "owner/app",
    prNumber: 42,
    queueEntry: makeEntry("evicted"),
  });
  assert.equal(report.kind, "evicted");
  assert.equal(report.exitCode, 2);
  assert.equal(report.terminal, true);
});

test("buildPrStatusReport: queue queued returns exit 3 non-terminal", () => {
  const report = buildPrStatusReport({
    repoId: "app",
    repoFullName: "owner/app",
    prNumber: 42,
    queueEntry: makeEntry("queued"),
  });
  assert.equal(report.kind, "queued");
  assert.equal(report.exitCode, 3);
  assert.equal(report.terminal, false);
});

test("buildPrStatusReport: github approved_clean returns exit 0", () => {
  const report = buildPrStatusReport({
    repoId: "app",
    repoFullName: "owner/app",
    prNumber: 42,
    github: makeOverview({
      reviewDecision: "APPROVED",
      checks: [{ name: "ci", status: "success", required: true }],
    }),
  });
  assert.equal(report.kind, "approved_clean");
  assert.equal(report.exitCode, 0);
});

function withAttachedConfig<T>(run: () => Promise<T>): Promise<T> {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-pr-status-"));
  const configHome = path.join(baseDir, ".config");
  const stateHome = path.join(baseDir, ".state");
  const dataHome = path.join(baseDir, ".share");
  mkdirSync(configHome, { recursive: true });
  mkdirSync(stateHome, { recursive: true });
  mkdirSync(dataHome, { recursive: true });
  const repoConfigDir = path.join(configHome, "merge-steward", "repos");
  mkdirSync(repoConfigDir, { recursive: true });
  writeFileSync(path.join(configHome, "merge-steward", "merge-steward.json"), JSON.stringify({
    server: { bind: "127.0.0.1", port_base: 9900, public_base_url: "https://ms.example.com" },
  }), "utf8");
  writeFileSync(path.join(repoConfigDir, "app.json"), JSON.stringify({
    repoId: "app",
    repoFullName: "owner/app",
    baseBranch: "main",
    clonePath: path.join(baseDir, "clone"),
    server: { bind: "127.0.0.1", port: 9901 },
    database: { path: path.join(baseDir, "queue.sqlite"), wal: true },
    logging: { level: "info" },
  }), "utf8");

  const previous: Record<string, string | undefined> = {
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  };
  process.env.XDG_CONFIG_HOME = configHome;
  process.env.XDG_STATE_HOME = stateHome;
  process.env.XDG_DATA_HOME = dataHome;
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(baseDir, { recursive: true, force: true });
  };
  return run().finally(restore) as Promise<T>;
}

test("handlePrStatus uses fetchGitHub fallback when queue has no entry", async () => {
  await withAttachedConfig(async () => {
    const stdout = createBufferStream();
    const code = await handlePrStatus({
      parsed: parseArgs(["pr", "status", "--repo", "app", "--pr", "42", "--json"]),
      stdout: stdout.stream,
      resolveCommand: async () => ({ exitCode: 127, stdout: "", stderr: "not used" }),
      fetchGitHub: async (repoFullName, prNumber) => {
        assert.equal(repoFullName, "owner/app");
        assert.equal(prNumber, 42);
        return {
          number: 42,
          branch: "feat/x",
          headSha: "abc",
          state: "OPEN",
          merged: false,
          reviewDecision: "APPROVED",
          labels: ["queue"],
          checks: [{ name: "ci", status: "success", required: true }],
        };
      },
    });
    assert.equal(code, 0);
    const payload = JSON.parse(stdout.read());
    assert.equal(payload.kind, "approved_clean");
    assert.equal(payload.source, "github");
  });
});

test("merge-steward pr status --wait loops until github reports terminal state", async () => {
  await withAttachedConfig(async () => {
    const stdout = createBufferStream();
    let call = 0;
    let slept = 0;
    let timeMs = 1_000;
    const code = await handlePrStatus({
      parsed: parseArgs(["pr", "status", "--repo", "app", "--pr", "42", "--wait", "--json", "--poll", "1"]),
      stdout: stdout.stream,
      resolveCommand: async () => ({ exitCode: 127, stdout: "", stderr: "unused" }),
      fetchGitHub: async () => {
        call += 1;
        if (call < 3) {
          return {
            number: 42,
            branch: "feat/x",
            headSha: "abc",
            state: "OPEN",
            merged: false,
            reviewDecision: "REVIEW_REQUIRED",
            labels: [],
            checks: [{ name: "ci", status: "pending", required: true }],
          };
        }
        return {
          number: 42,
          branch: "feat/x",
          headSha: "abc",
          state: "OPEN",
          merged: false,
          reviewDecision: "APPROVED",
          labels: [],
          checks: [{ name: "ci", status: "success", required: true }],
        };
      },
      now: () => timeMs,
      sleep: async (ms: number) => {
        slept += 1;
        timeMs += ms;
      },
    });
    assert.equal(code, 0);
    assert.equal(call, 3);
    assert.ok(slept >= 2, `expected >=2 sleeps, got ${slept}`);
  });
});

test("merge-steward pr status --wait times out with exit 4", async () => {
  await withAttachedConfig(async () => {
    const stdout = createBufferStream();
    let timeMs = 1_000;
    const code = await handlePrStatus({
      parsed: parseArgs(["pr", "status", "--repo", "app", "--pr", "42", "--wait", "--json", "--timeout", "2", "--poll", "1"]),
      stdout: stdout.stream,
      resolveCommand: async () => ({ exitCode: 127, stdout: "", stderr: "unused" }),
      fetchGitHub: async () => ({
        number: 42,
        branch: "feat/x",
        headSha: "abc",
        state: "OPEN",
        merged: false,
        reviewDecision: "REVIEW_REQUIRED",
        labels: [],
        checks: [{ name: "ci", status: "pending", required: true }],
      }),
      now: () => timeMs,
      sleep: async (ms: number) => {
        timeMs += ms;
      },
    });
    assert.equal(code, 4);
    const payload = JSON.parse(stdout.read());
    assert.equal(payload.timedOut, true);
  });
});

test("merge-steward pr status smoke: JSON output and exit code via runCli", async () => {
  await withAttachedConfig(async () => {
    const stdout = createBufferStream();
    const code = await runCli(
      ["pr", "status", "--repo", "app", "--pr", "42", "--json"],
      {
        stdout: stdout.stream,
        stderr: createBufferStream().stream,
        resolveCommand: async (command, args) => {
          if (command === "gh" && args[0] === "pr" && args[1] === "view") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                number: 42,
                headRefName: "feat/x",
                headRefOid: "abc",
                state: "OPEN",
                reviewDecision: "CHANGES_REQUESTED",
                labels: [],
                statusCheckRollup: [],
              }),
              stderr: "",
            };
          }
          return { exitCode: 127, stdout: "", stderr: "unknown" };
        },
      },
    );
    assert.equal(code, 2);
    const payload = JSON.parse(stdout.read());
    assert.equal(payload.kind, "changes_requested");
  });
});
