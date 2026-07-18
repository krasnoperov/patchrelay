import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerClient, CodexJsonRpcError } from "../src/codex-app-server.ts";
import { REVIEW_VERDICT_JSON_SCHEMA } from "../src/review-verdict-schema.ts";

test("CodexAppServerClient wires outputSchema into turn/start", async () => {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = new CodexAppServerClient({
    bin: "codex",
    args: ["app-server"],
    outputSchema: true,
    approvalPolicy: "never",
    sandboxMode: "danger-full-access",
  }, {} as never);
  (client as unknown as {
    sendRequest: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  }).sendRequest = async (method, params) => {
    requests.push({ method, params });
    return { turn: { id: "turn-1", status: "running" } };
  };

  await client.startTurn({
    threadId: "thread-1",
    cwd: "/tmp/worktree",
    input: "review",
    outputSchema: REVIEW_VERDICT_JSON_SCHEMA as unknown as Record<string, unknown>,
  });

  assert.equal(requests[0]?.method, "turn/start");
  assert.deepEqual(requests[0]?.params.outputSchema, REVIEW_VERDICT_JSON_SCHEMA);
});

test("CodexJsonRpcError preserves error code, message, and data", () => {
  const error = CodexJsonRpcError.fromPayload({
    code: -32602,
    message: "Unknown parameter outputSchema",
    data: { parameter: "outputSchema" },
  });

  assert.equal(error.code, -32602);
  assert.equal(error.message, "Unknown parameter outputSchema");
  assert.deepEqual(error.data, { parameter: "outputSchema" });
});

test("CodexAppServerClient routes notifications and unsubscribe stops delivery", () => {
  const client = new CodexAppServerClient({
    bin: "codex",
    args: ["app-server"],
    outputSchema: true,
    approvalPolicy: "never",
    sandboxMode: "danger-full-access",
  }, {} as never);
  const received: unknown[] = [];
  const unsubscribe = client.subscribeNotifications((notification) => received.push(notification));
  const internals = client as unknown as { stdoutBuffer: string; drainMessages(): void };

  internals.stdoutBuffer = `${JSON.stringify({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1" } },
  })}\n`;
  internals.drainMessages();
  unsubscribe();
  internals.stdoutBuffer = `${JSON.stringify({ method: "turn/started", params: { threadId: "thread-1" } })}\n`;
  internals.drainMessages();

  assert.deepEqual(received, [{
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1" } },
  }]);
});
