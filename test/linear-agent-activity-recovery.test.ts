import assert from "node:assert/strict";
import test from "node:test";
import pino from "pino";
import {
  recoverLinearAgentActivityContext,
  summarizeLinearAgentActivities,
} from "../src/linear-agent-activity-recovery.ts";
import type { LinearClient, LinearClientProvider } from "../src/types.ts";

test("summarizeLinearAgentActivities builds bounded prompt context from recent activities", () => {
  const context = summarizeLinearAgentActivities([
    {
      id: "old",
      type: "thought",
      body: "older activity",
      updatedAt: "2026-05-01T09:00:00.000Z",
    },
    {
      id: "prompt",
      type: "prompt",
      body: "Please keep the existing API stable.",
      updatedAt: "2026-05-01T10:00:00.000Z",
    },
    {
      id: "response",
      type: "response",
      body: "I opened a PR and verified the focused tests.",
      updatedAt: "2026-05-01T10:05:00.000Z",
    },
  ]);

  assert.deepEqual(context, {
    linearAgentActivityContext: [
      "- thought: older activity",
      "- prompt: Please keep the existing API stable.",
      "- response: I opened a PR and verified the focused tests.",
    ].join("\n"),
    linearAgentActivityCount: 3,
  });
});

test("recoverLinearAgentActivityContext skips Linear when local human context exists", async () => {
  let called = false;
  const provider: LinearClientProvider = {
    forProject: async () => {
      called = true;
      return undefined;
    },
  };

  const context = await recoverLinearAgentActivityContext({
    linearProvider: provider,
    projectId: "project-1",
    agentSessionId: "session-1",
    context: {
      followUps: [{ type: "followup_prompt", text: "Already captured locally." }],
    },
    logger: pino({ enabled: false }),
  });

  assert.equal(context, undefined);
  assert.equal(called, false);
});

test("recoverLinearAgentActivityContext returns summarized activities and treats API failure as non-fatal", async () => {
  const provider: LinearClientProvider = {
    forProject: async () => ({
      listAgentSessionActivities: async () => [
        {
          id: "prompt",
          type: "prompt",
          body: "Retry the implementation.",
          updatedAt: "2026-05-01T10:00:00.000Z",
        },
      ],
    } as LinearClient),
  };

  const context = await recoverLinearAgentActivityContext({
    linearProvider: provider,
    projectId: "project-1",
    agentSessionId: "session-1",
    logger: pino({ enabled: false }),
  });

  assert.deepEqual(context, {
    linearAgentActivityContext: "- prompt: Retry the implementation.",
    linearAgentActivityCount: 1,
  });

  const failingProvider: LinearClientProvider = {
    forProject: async () => {
      throw new Error("Linear unavailable");
    },
  };
  const failedContext = await recoverLinearAgentActivityContext({
    linearProvider: failingProvider,
    projectId: "project-1",
    agentSessionId: "session-1",
    logger: pino({ enabled: false }),
  });

  assert.equal(failedContext, undefined);
});
