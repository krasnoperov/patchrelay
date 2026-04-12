import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.ts";
import { formatQueueStatusText } from "../src/cli/commands/queue.ts";
import type { QueueWatchSnapshot } from "../src/types.ts";

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

function withEnv(values: Record<string, string | undefined>, run: () => Promise<void> | void): Promise<void> | void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  const restore = () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
  try {
    const result = run();
    if (result && typeof (result as Promise<void>).then === "function") {
      return (result as Promise<void>).finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

const noop = async () => ({ exitCode: 0, stdout: "", stderr: "" });

test("queue reconcile reports error when service is unreachable", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-queue-reconcile-"));
  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: path.join(baseDir, ".config"),
        XDG_STATE_HOME: path.join(baseDir, ".state"),
        XDG_DATA_HOME: path.join(baseDir, ".share"),
        MERGE_STEWARD_SYSTEMD_DIR: path.join(baseDir, "systemd"),
      },
      async () => {
        await runCli(["init", "queue.example.com"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });
        await runCli(["attach", "app", "owner/repo"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });

        const stderr = createBufferStream();
        const code = await runCli(["queue", "reconcile", "--repo", "app"], {
          stdout: createBufferStream().stream,
          stderr: stderr.stream,
        });
        assert.equal(code, 1);
        assert.match(stderr.read(), /Unable to reach the local merge-steward service for app/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("queue reconcile --json also reports error when service is unreachable", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-queue-reconcile-json-"));
  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: path.join(baseDir, ".config"),
        XDG_STATE_HOME: path.join(baseDir, ".state"),
        XDG_DATA_HOME: path.join(baseDir, ".share"),
        MERGE_STEWARD_SYSTEMD_DIR: path.join(baseDir, "systemd"),
      },
      async () => {
        await runCli(["init", "queue.example.com"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });
        await runCli(["attach", "app", "owner/repo"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });

        const stderr = createBufferStream();
        const code = await runCli(["queue", "reconcile", "--repo", "app", "--json"], {
          stdout: createBufferStream().stream,
          stderr: stderr.stream,
        });
        assert.equal(code, 1);
        assert.match(stderr.read(), /Unable to reach the local merge-steward service/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("queue show for nonexistent entry reports error", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-queue-show-missing-"));
  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: path.join(baseDir, ".config"),
        XDG_STATE_HOME: path.join(baseDir, ".state"),
        XDG_DATA_HOME: path.join(baseDir, ".share"),
        MERGE_STEWARD_SYSTEMD_DIR: path.join(baseDir, "systemd"),
      },
      async () => {
        await runCli(["init", "queue.example.com"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });
        await runCli(["attach", "app", "owner/repo"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });

        const stderr = createBufferStream();
        const code = await runCli(["queue", "show", "--repo", "app", "--pr", "999"], {
          stdout: createBufferStream().stream,
          stderr: stderr.stream,
        });
        assert.equal(code, 1);
        assert.match(stderr.read(), /Queue entry not found/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("queue status text output formats correctly with no entries", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "ms-queue-status-empty-"));
  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: path.join(baseDir, ".config"),
        XDG_STATE_HOME: path.join(baseDir, ".state"),
        XDG_DATA_HOME: path.join(baseDir, ".share"),
        MERGE_STEWARD_SYSTEMD_DIR: path.join(baseDir, "systemd"),
      },
      async () => {
        await runCli(["init", "queue.example.com"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });
        await runCli(["attach", "app", "owner/repo"], {
          stdout: createBufferStream().stream,
          stderr: createBufferStream().stream,
          runCommand: noop,
        });

        const stdout = createBufferStream();
        const code = await runCli(["queue", "status", "--repo", "app"], {
          stdout: stdout.stream,
          stderr: createBufferStream().stream,
        });
        assert.equal(code, 0);
        const text = stdout.read();
        assert.match(text, /Repo: app \(owner\/repo\)/);
        assert.match(text, /Source: database/);
        assert.match(text, /Active entries: 0/);
        assert.match(text, /Head PR: none/);
        assert.match(text, /- \(none\)/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("queue status text output surfaces failed tick errors ahead of stale queue state", () => {
  const snapshot: QueueWatchSnapshot = {
    repoId: "app",
    repoFullName: "owner/repo",
    baseBranch: "main",
    summary: {
      total: 1,
      active: 1,
      queued: 0,
      preparingHead: 1,
      validating: 0,
      merging: 0,
      merged: 0,
      evicted: 0,
      dequeued: 0,
      headEntryId: "entry-1",
      headPrNumber: 14,
    },
    runtime: {
      tickInProgress: false,
      lastTickStartedAt: "2026-04-06T16:46:05.507Z",
      lastTickCompletedAt: "2026-04-06T16:46:08.088Z",
      lastTickOutcome: "failed",
      lastTickError: "Command failed: git push\nExit code: 1\nstderr: remote rejected",
    },
    queueBlock: {
      reason: "main_broken",
      entryId: "entry-1",
      headPrNumber: 14,
      baseBranch: "main",
      baseSha: "edc495b599b6d795f5c65657f656615d9d243c8a",
      observedAt: "2026-04-06T16:26:30.217Z",
      failingChecks: [],
      pendingChecks: [{ name: "verify", conclusion: "pending", url: "https://example.test/run" }],
      missingRequiredChecks: [],
    },
    entries: [{
      id: "entry-1",
      repoId: "app",
      prNumber: 14,
      branch: "feature/queue-fix",
      headSha: "abc123",
      baseSha: "def456",
      status: "preparing_head",
      position: 1,
      priority: 0,
      generation: 0,
      ciRunId: null,
      ciRetries: 0,
      retryAttempts: 0,
      maxRetries: 2,
      lastFailedBaseSha: null,
      issueKey: null,
      specBranch: null,
      specSha: null,
      specBasedOn: null,
      enqueuedAt: "2026-04-06T16:21:37.417Z",
      updatedAt: "2026-04-06T16:25:25.481Z",
    }],
    recentEvents: [],
  };

  const text = formatQueueStatusText("service", snapshot);
  assert.match(text, /Last tick: failed/);
  assert.match(text, /Last error: Command failed: git push/);
  assert.match(text, /Queue blocked: main_broken on main @ edc495b5/);
});
