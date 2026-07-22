import assert from "node:assert/strict";
import test from "node:test";
import type { Writable } from "node:stream";
import { runCli } from "../src/cli/index.ts";
import type { CliDataAccess } from "../src/cli/data.ts";
import type { AppConfig } from "../src/types.ts";

function output() {
  let value = "";
  const stream = { write(chunk: string | Uint8Array) { value += String(chunk); return true; } } as Writable;
  return { stream, read: () => value };
}

const config = {
  server: { bind: "127.0.0.1", port: 8787, healthPath: "/health" },
} as AppConfig;

test("status ISSUE explains current ownership and compact Codex activity", async () => {
  const stdout = output();
  const data = {
    db: {},
    getIssueStatus: async () => ({
      issue: { issueKey: "INV-810", title: "Simplify observability", phase: "implementing", currentLinearState: "In Progress" },
      activeRun: { id: 5412, runType: "implementation", status: "running", startedAt: new Date().toISOString(), threadId: "thread-1" },
      liveThread: {
        threadId: "thread-1",
        threadStatus: "running",
        latestAgentMessage: "Removing duplicate transcript storage.",
        latestPlan: "Run tests",
        activeCommand: "pnpm test",
        commandCount: 3,
        fileChangeCount: 4,
        toolCallCount: 1,
      },
      activity: { at: new Date().toISOString(), kind: "command_started", summary: "pnpm test" },
      runs: [],
      generatedAt: new Date().toISOString(),
    }),
  } as unknown as CliDataAccess;

  assert.equal(await runCli(["status", "INV-810"], { config, data, stdout: stdout.stream, stderr: output().stream }), 0);
  assert.match(stdout.read(), /Owner\s+PatchRelay \/ Codex \(confirmed live\)/);
  assert.match(stdout.read(), /Removing duplicate transcript storage/);
  assert.match(stdout.read(), /3 commands · 4 file changes · 1 tool calls/);
});

test("logs ISSUE filters the service journal and supports JSON", async () => {
  const stdout = output();
  const calls: string[][] = [];
  assert.equal(await runCli(["logs", "INV-810", "--lines", "25", "--json"], {
    config,
    stdout: stdout.stream,
    stderr: output().stream,
    runCommand: async (command, args) => {
      calls.push([command, ...args]);
      return { exitCode: 0, stdout: "2026-07-22 issue_key=INV-810 turn started\n", stderr: "" };
    },
  }), 0);
  assert.deepEqual(calls[0], ["sudo", "journalctl", "-u", "patchrelay.service", "-n", "25", "-o", "short-iso", "--grep", "INV-810", "--no-pager"]);
  assert.equal(JSON.parse(stdout.read()).issueKey, "INV-810");
});
