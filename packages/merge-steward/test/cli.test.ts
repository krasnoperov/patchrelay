import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.ts";
import { SqliteStore } from "../src/db/sqlite-store.ts";
import type { QueueEntry } from "../src/types.ts";

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

test("merge-steward help shows grouped repo, service, and queue commands", async () => {
  const stdout = createBufferStream();
  assert.equal(await runCli([], { stdout: stdout.stream, stderr: createBufferStream().stream }), 0);
  const text = stdout.read();
  assert.match(text, /attach <id> <owner\/repo>/);
  assert.match(text, /service status <id>/);
  assert.match(text, /queue show --repo <id>/);
});

test("merge-steward init and repo commands manage bootstrap state with explicit service actions", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "merge-steward-cli-"));
  const configHome = path.join(baseDir, ".config");
  const stateHome = path.join(baseDir, ".state");
  const dataHome = path.join(baseDir, ".share");
  const systemdDir = path.join(baseDir, "systemd");

  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: stateHome,
        XDG_DATA_HOME: dataHome,
        MERGE_STEWARD_SYSTEMD_DIR: systemdDir,
      },
      async () => {
        const commands: string[] = [];
        const runCommand = async (command: string, args: string[]) => {
          commands.push([command, ...args].join(" "));
          return { exitCode: 0, stdout: "", stderr: "" };
        };

        const initOut = createBufferStream();
        assert.equal(
          await runCli(["init", "queue.example.com"], {
            stdout: initOut.stream,
            stderr: createBufferStream().stream,
            runCommand,
          }),
          0,
        );
        assert.match(initOut.read(), /Config directory:/);
        assert.match(initOut.read(), /Webhook URL: https:\/\/queue\.example\.com\/webhooks\/github/);
        assert.deepEqual(commands, ["sudo systemctl daemon-reload"]);

        const repoOut = createBufferStream();
        assert.equal(
          await runCli(["attach", "app", "owner/repo", "--base-branch", "main", "--required-check", "test,lint"], {
            stdout: repoOut.stream,
            stderr: createBufferStream().stream,
            runCommand,
          }),
          0,
        );
        assert.match(repoOut.read(), /Attached repo app for owner\/repo/);
        assert.match(repoOut.read(), /Restarted merge-steward\.service/);
        assert.deepEqual(commands.slice(1), [
          "sudo systemctl reload-or-restart merge-steward.service",
        ]);

        const listOut = createBufferStream();
        assert.equal(await runCli(["repos", "--json"], { stdout: listOut.stream, stderr: createBufferStream().stream }), 0);
        const repos = JSON.parse(listOut.read()) as { repos: Array<Record<string, unknown>> };
        assert.strictEqual(repos.repos.length, 1);
        assert.strictEqual(repos.repos[0]!.repoId, "app");
        assert.strictEqual(repos.repos[0]!.repoFullName, "owner/repo");

        const inspectOut = createBufferStream();
        assert.equal(await runCli(["repos", "app", "--json"], { stdout: inspectOut.stream, stderr: createBufferStream().stream }), 0);
        const inspected = JSON.parse(inspectOut.read()) as Record<string, unknown>;
        assert.equal(inspected.repoId, "app");
        assert.equal(inspected.repoFullName, "owner/repo");
        assert.equal(inspected.webhookUrl, "https://queue.example.com/webhooks/github");

        const statusOut = createBufferStream();
        assert.equal(
          await runCli(["service", "status", "--json"], {
            stdout: statusOut.stream,
            stderr: createBufferStream().stream,
            runCommand: async (_command, _args) => ({
              exitCode: 0,
              stdout: [
                "Id=merge-steward.service",
                "LoadState=loaded",
                "UnitFileState=enabled",
                "ActiveState=active",
                "SubState=running",
                "ExecMainPID=9001",
              ].join("\n"),
              stderr: "",
            }),
          }),
          0,
        );
        const serviceStatus = JSON.parse(statusOut.read()) as Record<string, unknown>;
        assert.equal(serviceStatus.unit, "merge-steward.service");
        assert.equal((serviceStatus.systemd as Record<string, unknown>).ActiveState, "active");
      },
    );

    const repoConfig = readFileSync(path.join(configHome, "merge-steward", "repos", "app.json"), "utf8");
    assert.match(repoConfig, /"repoFullName": "owner\/repo"/);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("merge-steward attach fails cleanly before init", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "merge-steward-cli-no-init-"));
  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: path.join(baseDir, ".config"),
        XDG_STATE_HOME: path.join(baseDir, ".state"),
        XDG_DATA_HOME: path.join(baseDir, ".share"),
        MERGE_STEWARD_SYSTEMD_DIR: path.join(baseDir, "systemd"),
      },
      async () => {
        const stderr = createBufferStream();
        assert.equal(
          await runCli(["attach", "app", "owner/repo"], {
            stdout: createBufferStream().stream,
            stderr: stderr.stream,
            runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
          }),
          1,
        );
        assert.match(stderr.read(), /merge-steward home is not initialized/);
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("merge-steward queue commands inspect the local database when the service is unavailable", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "merge-steward-queue-"));
  const configHome = path.join(baseDir, ".config");
  const stateHome = path.join(baseDir, ".state");
  const dataHome = path.join(baseDir, ".share");

  try {
    await withEnv(
      {
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: stateHome,
        XDG_DATA_HOME: dataHome,
        MERGE_STEWARD_SYSTEMD_DIR: path.join(baseDir, "systemd"),
      },
      async () => {
        const runCommand = async () => ({ exitCode: 0, stdout: "", stderr: "" });
        assert.equal(await runCli(["init", "queue.example.com"], { stdout: createBufferStream().stream, stderr: createBufferStream().stream, runCommand }), 0);
        assert.equal(await runCli(["attach", "app", "owner/repo"], { stdout: createBufferStream().stream, stderr: createBufferStream().stream, runCommand }), 0);

        const store = new SqliteStore(path.join(stateHome, "merge-steward", "app.sqlite"));
        const entry: QueueEntry = {
          id: "entry-1",
          repoId: "app",
          prNumber: 42,
          branch: "feature/queue",
          headSha: "abc123",
          baseSha: "def456",
          status: "queued",
          position: 1,
          priority: 0,
          generation: 0,
          ciRunId: null,
          ciRetries: 0,
          retryAttempts: 0,
          maxRetries: 2,
          lastFailedBaseSha: null,
          issueKey: "APP-42",
          specBranch: null,
          specSha: null,
          specBasedOn: null,
          enqueuedAt: "2026-03-28T10:00:00.000Z",
          updatedAt: "2026-03-28T10:00:00.000Z",
        };
        store.insert(entry);
        store.close();

        const statusOut = createBufferStream();
        assert.equal(await runCli(["queue", "status", "--repo", "app", "--json"], { stdout: statusOut.stream, stderr: createBufferStream().stream }), 0);
        const status = JSON.parse(statusOut.read()) as Record<string, unknown>;
        assert.equal(status.source, "database");
        assert.equal(((status.summary as { active?: number }).active ?? 0), 1);
        assert.equal(((status.entries as Array<{ prNumber: number }>)[0] as { prNumber: number }).prNumber, 42);

        const inspectOut = createBufferStream();
        assert.equal(
          await runCli(["queue", "show", "--repo", "app", "--pr", "42", "--json"], {
            stdout: inspectOut.stream,
            stderr: createBufferStream().stream,
          }),
          0,
        );
        const detail = JSON.parse(inspectOut.read()) as Record<string, unknown>;
        assert.equal(((detail.entry as { id?: string }).id ?? ""), "entry-1");
        assert.equal((((detail.events as Array<{ toStatus: string }>)[0] as { toStatus: string }).toStatus), "queued");
      },
    );
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
