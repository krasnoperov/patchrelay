import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentSessionPlan, buildAgentSessionPlanForIssue } from "../src/agent-session-plan.ts";
import { buildAgentSessionExternalUrls } from "../src/agent-session-presentation.ts";
import { buildGitHubStateActivity, buildRunCompletedActivity } from "../src/linear-session-reporting.ts";
import type { AppConfig } from "../src/types.ts";

function createConfig(): AppConfig {
  return {
    server: {
      bind: "127.0.0.1",
      port: 3000,
      publicBaseUrl: "https://patchrelay.example.com",
      healthPath: "/healthz",
      readinessPath: "/readyz",
    },
    ingress: {
      linearWebhookPath: "/webhooks/linear",
      githubWebhookPath: "/webhooks/github",
      maxBodyBytes: 1024 * 1024,
      maxTimestampSkewSeconds: 300,
    },
    logging: {
      level: "info",
      format: "logfmt",
      filePath: "/tmp/patchrelay.log",
    },
    database: {
      path: "/tmp/patchrelay.sqlite",
      wal: true,
    },
    linear: {
      webhookSecret: "webhook-secret",
      graphqlUrl: "https://linear.example/graphql",
      tokenEncryptionKey: "token-encryption-key",
      oauth: {
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "https://patchrelay.example.com/oauth/linear/callback",
        scopes: ["read", "write"],
        actor: "user",
      },
    },
    operatorApi: {
      enabled: false,
    },
    runner: {
      gitBin: "git",
      codex: {
        bin: "codex",
        args: [],
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
        persistExtendedHistory: false,
      },
    },
    projects: [],
  };
}

test("agent session plans reflect queued, review, and repair states", () => {
  assert.deepEqual(
    buildAgentSessionPlan({
      factoryState: "delegated",
      pendingRunType: "implementation",
    }),
    [
      { content: "Prepare workspace", status: "inProgress" },
      { content: "Implement or update branch", status: "pending" },
      { content: "Await review", status: "pending" },
      { content: "Land change", status: "pending" },
    ],
  );

  assert.deepEqual(
    buildAgentSessionPlan({
      factoryState: "repairing_ci",
      activeRunType: "ci_repair",
      ciRepairAttempts: 2,
    }),
    [
      { content: "Prepare workspace", status: "completed" },
      { content: "Implement or update branch", status: "completed" },
      { content: "Repair failing checks (attempt 2)", status: "inProgress" },
      { content: "Return to merge flow", status: "pending" },
    ],
  );

  assert.deepEqual(
    buildAgentSessionPlanForIssue({
      factoryState: "awaiting_queue",
      ciRepairAttempts: 1,
      queueRepairAttempts: 0,
    }),
    [
      { content: "Prepare workspace", status: "completed" },
      { content: "Implement or update branch", status: "completed" },
      { content: "Review approved", status: "completed" },
      { content: "Queued for merge", status: "inProgress" },
    ],
  );
});

test("GitHub state activities keep repair work active instead of erroring", () => {
  const repairingCi = buildGitHubStateActivity("repairing_ci", {
    triggerEvent: "check_failed",
    checkName: "lint",
  } as never);
  assert.deepEqual(repairingCi, {
    type: "action",
    action: "Repairing",
    parameter: "CI failure: lint",
  });

  const changesRequested = buildGitHubStateActivity("changes_requested", {
    triggerEvent: "review_changes_requested",
    reviewerName: "Ada",
  } as never);
  assert.deepEqual(changesRequested, {
    type: "action",
    action: "Addressing",
    parameter: "review feedback from Ada",
  });
});

test("run completion activity summarizes the next visible milestone", () => {
  const activity = buildRunCompletedActivity({
    runType: "implementation",
    completionSummary: "Implemented the API endpoint and pushed the branch.",
    postRunState: "pr_open",
    prNumber: 42,
  });

  assert.deepEqual(activity, {
    type: "response",
    body: "Implementation completed.\n\nPR #42 is ready for review.\n\nImplemented the API endpoint and pushed the branch.",
  });
});

test("session external urls include both status and pull request links", () => {
  const urls = buildAgentSessionExternalUrls(createConfig(), {
    issueKey: "USE-42",
    prUrl: "https://github.com/example/repo/pull/42",
  });

  assert.equal(urls?.length, 2);
  assert.deepEqual(urls?.[1], {
    label: "Pull request",
    url: "https://github.com/example/repo/pull/42",
  });
  assert.match(urls?.[0]?.url ?? "", /agent\/session\/USE-42\?token=/);
});
