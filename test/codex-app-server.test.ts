import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { CodexAppServerClient, resolveCodexAppServerLaunch } from "../src/codex-app-server.js";

function createClient(scenario: string) {
  return new CodexAppServerClient(
    {
      bin: process.execPath,
      args: [path.resolve("test/fixtures/fake-codex-app-server.mjs"), scenario],
      sourceBashrc: false,
      approvalPolicy: "never",
      sandboxMode: "danger-full-access",
      persistExtendedHistory: false,
      serviceName: "patchrelay-test",
    },
    pino({ enabled: false }),
  );
}

test("CodexAppServerClient handles initialize, approval requests, notifications, and thread operations", async () => {
  const client = createClient("normal");
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
  const client = createClient("error-response");

  try {
    await client.start();
    await assert.rejects(() => client.readThread("thread-1"), /thread read failed/);
  } finally {
    await client.stop();
  }
});

test("CodexAppServerClient rejects pending requests when the app-server exits", async () => {
  const client = createClient("pending-close");

  try {
    await client.start();
    await assert.rejects(() => client.startThread({ cwd: "/tmp/worktree" }), /exited with code 7/);
  } finally {
    await client.stop();
  }
});
