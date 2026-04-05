import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { Logger } from "pino";
import {
  CodexAppServerClient,
  extractCodexRpcErrorMessage,
  isCodexThreadMaterializingError,
  resolveCodexAppServerLaunch,
} from "../src/codex-app-server.ts";

class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly approvalResponses: Array<{ id: string; decision: string }> = [];

  constructor(private readonly scenario: string) {
    super();

    let buffer = "";
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) {
          break;
        }
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }
        this.handleMessage(JSON.parse(line) as Record<string, unknown>);
      }
    });
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.emit("close", null, signal);
    return true;
  }

  private sendStdout(message: Record<string, unknown>): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  private handleMessage(message: Record<string, unknown>): void {
    if (message.method === "initialize") {
      this.sendStdout({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          serverInfo: {
            name: "fake-codex",
            version: "0.0.1",
          },
        },
      });
      return;
    }

    if (message.method === "initialized") {
      this.sendStdout({
        jsonrpc: "2.0",
        id: "approval-1",
        method: "item/commandExecution/requestApproval",
        params: {
          command: "npm test",
        },
      });
      return;
    }

    if (message.id === "approval-1") {
      const decision = String((message.result as Record<string, unknown> | undefined)?.decision ?? "");
      this.approvalResponses.push({ id: "approval-1", decision });
      if (decision.startsWith("accept")) {
        this.sendStdout({
          jsonrpc: "2.0",
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
          },
        });
      }
      return;
    }

    if (message.method === "thread/start") {
      if (this.scenario === "pending-close") {
        setTimeout(() => {
          this.emit("close", 7, null);
        }, 10);
        return;
      }
      if (this.scenario === "malformed-stdout") {
        this.stdout.write("Authorization: Bearer secret-token\n");
        return;
      }
      if (this.scenario === "stderr-secret") {
        this.stderr.write("Authorization: Bearer secret-token\n");
      }

      this.sendStdout({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          thread: buildThread("thread-1", ((message.params as Record<string, unknown>)?.cwd as string | undefined) ?? "/tmp/worktree"),
        },
      });
      return;
    }

    if (message.method === "thread/resume") {
      const params = (message.params as Record<string, unknown>) ?? {};
      this.sendStdout({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          thread: buildThread(String(params.threadId), (params.cwd as string | undefined) ?? "/tmp/resumed"),
        },
      });
      return;
    }

    if (message.method === "thread/fork") {
      const params = (message.params as Record<string, unknown>) ?? {};
      this.sendStdout({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          thread: buildThread("thread-forked", (params.cwd as string | undefined) ?? "/tmp/forked"),
        },
      });
      return;
    }

    if (message.method === "turn/start") {
      this.sendStdout({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          turn: {
            id: "turn-2",
            status: "inProgress",
          },
        },
      });
      return;
    }

    if (message.method === "turn/steer") {
      this.sendStdout({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          ok: true,
        },
      });
      return;
    }

    if (message.method === "thread/read") {
      if (this.scenario === "read-timeout") {
        return;
      }
      if (this.scenario === "error-response") {
        this.sendStdout({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            message: "thread read failed",
          },
        });
        return;
      }

      const params = (message.params as Record<string, unknown>) ?? {};
      this.sendStdout({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          thread: buildThread(String(params.threadId), "/tmp/read"),
        },
      });
      return;
    }

    if (message.method === "thread/list") {
      this.sendStdout({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          data: [buildThread("thread-1"), buildThread("thread-2", "/tmp/other")],
        },
      });
    }
  }
}

function buildThread(id: string, cwd = "/tmp/worktree") {
  return {
    id,
    preview: "PatchRelay stage",
    cwd,
    status: "idle",
    path: `${cwd}/thread.json`,
    turns: [
      {
        id: "turn-1",
        status: "completed",
        items: [{ type: "agentMessage", id: "assistant-1", text: "Hello from fake codex." }],
      },
    ],
  };
}

function createCaptureLogger() {
  const entries: Array<{ level: "info" | "warn" | "error" | "debug"; bindings: Record<string, unknown>; message: string }> = [];
  const logger = {
    fatal(bindings: Record<string, unknown>, message: string) {
      entries.push({ level: "error", bindings, message });
    },
    error(bindings: Record<string, unknown>, message: string) {
      entries.push({ level: "error", bindings, message });
    },
    warn(bindings: Record<string, unknown>, message: string) {
      entries.push({ level: "warn", bindings, message });
    },
    info(bindings: Record<string, unknown>, message: string) {
      entries.push({ level: "info", bindings, message });
    },
    debug(bindings: Record<string, unknown>, message: string) {
      entries.push({ level: "debug", bindings, message });
    },
    trace() {},
    silent() {},
    child() {
      return logger;
    },
    level: "debug",
  } as unknown as Logger;
  return { logger, entries };
}

function createClient(
  scenario: string,
  approvalPolicy: "never" | "on-request" | "on-failure" | "untrusted" = "never",
  logger: Logger = createCaptureLogger().logger,
) {
  const child = new FakeChildProcess(scenario);
  const client = new CodexAppServerClient(
    {
      bin: process.execPath,
      args: ["unused"],
      sourceBashrc: false,
      requestTimeoutMs: 50,
      approvalPolicy,
      sandboxMode: "danger-full-access",
      persistExtendedHistory: false,
      serviceName: "patchrelay-test",
    },
    logger,
    (() => child) as never,
  );
  return { client, child };
}

test("extractCodexRpcErrorMessage unwraps JSON-RPC error payloads", () => {
  const error = new Error(JSON.stringify({
    code: -32600,
    message: "thread thread-1 is not materialized yet; includeTurns is unavailable before first user message",
  }));

  assert.equal(
    extractCodexRpcErrorMessage(error),
    "thread thread-1 is not materialized yet; includeTurns is unavailable before first user message",
  );
  assert.equal(isCodexThreadMaterializingError(error), true);
});

test("CodexAppServerClient handles initialize, approval requests, notifications, and thread operations", async () => {
  const { client, child } = createClient("normal");
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  client.on("notification", (notification) => {
    notifications.push(notification);
  });

  try {
    await client.start();

    const started = await client.startThread({ cwd: "/tmp/worktree" });
    assert.equal(started.id, "thread-1");
    assert.equal(started.cwd, "/tmp/worktree");
    assert.equal(started.path, "/tmp/worktree/thread.json");

    const resumed = await client.resumeThread("thread-existing", "/tmp/resumed");
    assert.equal(resumed.id, "thread-existing");
    assert.equal(resumed.cwd, "/tmp/resumed");

    const forked = await client.forkThread("thread-1", "/tmp/forked");
    assert.equal(forked.id, "thread-forked");
    assert.equal(forked.cwd, "/tmp/forked");

    const turn = await client.startTurn({
      threadId: "thread-1",
      cwd: "/tmp/worktree",
      input: "Continue the issue lifecycle.",
    });
    assert.deepEqual(turn, {
      threadId: "thread-1",
      turnId: "turn-2",
      status: "inProgress",
    });

    await client.steerTurn({
      threadId: "thread-1",
      turnId: "turn-2",
      input: "Please incorporate a new Linear comment.",
    });

    const thread = await client.readThread("thread-1");
    assert.equal(thread.id, "thread-1");
    assert.equal(thread.cwd, "/tmp/read");
    assert.equal(thread.turns[0]?.items[0]?.type, "agentMessage");

    const threads = await client.listThreads();
    assert.equal(threads.length, 2);
    assert.equal(threads[1]?.id, "thread-2");

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(child.approvalResponses, [{ id: "approval-1", decision: "acceptForSession" }]);
    assert.deepEqual(notifications, [
      {
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
        },
      },
    ]);
  } finally {
    await client.stop();
  }
});

test("resolveCodexAppServerLaunch can wrap codex in a shell that sources bashrc", () => {
  assert.deepEqual(
    resolveCodexAppServerLaunch({
      bin: "codex",
      args: ["app-server"],
      shellBin: "/bin/bash",
      sourceBashrc: true,
      approvalPolicy: "never",
      sandboxMode: "danger-full-access",
      persistExtendedHistory: false,
    }),
    {
      command: "/bin/bash",
      args: ["-lc", 'source ~/.bashrc >/dev/null 2>&1 || true; exec "$0" "$@"', "codex", "app-server"],
    },
  );
});

test("CodexAppServerClient rejects JSON-RPC error responses", async () => {
  const { client } = createClient("error-response");

  try {
    await client.start();
    await assert.rejects(() => client.readThread("thread-1"), /thread read failed/);
  } finally {
    await client.stop();
  }
});

test("CodexAppServerClient times out hung requests and remains usable afterward", async () => {
  const { client } = createClient("read-timeout");

  try {
    await client.start();
    await assert.rejects(() => client.readThread("thread-1"), /timed out after 50ms/);

    const threads = await client.listThreads();
    assert.equal(threads.length, 2);
    assert.equal(threads[0]?.id, "thread-1");
  } finally {
    await client.stop();
  }
});

test("CodexAppServerClient rejects pending requests when the app-server exits", async () => {
  const { client } = createClient("pending-close");

  try {
    await client.start();
    await assert.rejects(() => client.startThread({ cwd: "/tmp/worktree" }), /exited with code 7/);
  } finally {
    await client.stop();
  }
});

test("CodexAppServerClient rejects server approval requests when policy is not accept-all", async () => {
  const { client, child } = createClient("normal", "on-request");
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  client.on("notification", (notification) => {
    notifications.push(notification);
  });

  try {
    await client.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(child.approvalResponses, [{ id: "approval-1", decision: "rejectForSession" }]);
    assert.deepEqual(notifications, []);
  } finally {
    await client.stop();
  }
});

test("CodexAppServerClient rejects malformed stdout with sanitized diagnostics", async () => {
  const { logger, entries } = createCaptureLogger();
  const { client } = createClient("malformed-stdout", "never", logger);

  try {
    await client.start();
    await assert.rejects(() => client.startThread({ cwd: "/tmp/worktree" }), /Codex app-server emitted invalid JSON/);

    const parseLog = entries.find((entry) => entry.message === "Failed to parse Codex app-server stdout message");
    assert.ok(parseLog);
    assert.equal(parseLog?.level, "error");
    assert.equal(parseLog?.bindings.output, "Authorization: Bearer [redacted]");
  } finally {
    await client.stop();
  }
});

test("CodexAppServerClient sanitizes stderr diagnostics before logging them", async () => {
  const { logger, entries } = createCaptureLogger();
  const { client } = createClient("stderr-secret", "never", logger);

  try {
    await client.start();
    await client.startThread({ cwd: "/tmp/worktree" });

    const stderrLog = entries.find((entry) => entry.message === "Codex app-server stderr");
    assert.ok(stderrLog);
    assert.equal(stderrLog?.bindings.output, "Authorization: Bearer [redacted]");
  } finally {
    await client.stop();
  }
});
