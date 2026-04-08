import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentSessionPlan, buildAgentSessionPlanForIssue } from "../src/agent-session-plan.ts";
import { buildAgentSessionExternalUrls } from "../src/agent-session-presentation.ts";
import { buildGitHubStateActivity, buildRunCompletedActivity, summarizeIssueStateForLinear } from "../src/linear-session-reporting.ts";
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
      { content: "Implementing", status: "pending" },
      { content: "Awaiting verification", status: "pending" },
      { content: "Merge", status: "pending" },
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
      { content: "Implementing", status: "completed" },
      { content: "Repairing checks (attempt 2)", status: "inProgress" },
      { content: "Merge", status: "pending" },
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
      { content: "Implementing", status: "completed" },
      { content: "Verification passed", status: "completed" },
      { content: "Awaiting merge", status: "inProgress" },
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

test("run completion activity unwraps shell-wrapped verification commands", () => {
  const activity = buildRunCompletedActivity({
    runType: "implementation",
    completionSummary:
      "Verification passed with `/bin/bash -lc 'npm run test:ui:local -- tests/ui/app-shell.spec.ts tests/ui/game-flow.spec.ts'`.",
    postRunState: "pr_open",
    prNumber: 42,
  });

  assert.deepEqual(activity, {
    type: "response",
    body:
      "Implementation completed.\n\nPR #42 is ready for review.\n\nVerification passed with `npm run test:ui:local -- tests/ui/app-shell.spec.ts tests/ui/game-flow.spec.ts`.",
  });
});

test("linear summaries prefer session state over factory state", () => {
  assert.equal(
    summarizeIssueStateForLinear({
      factoryState: "awaiting_queue",
      sessionState: "waiting_input",
      waitingReason: "Waiting for a merge queue retry.",
      prNumber: 7,
      prState: "open",
      prReviewState: "approved",
      prCheckStatus: "passed",
    }),
    "Waiting for a merge queue retry.",
  );

  assert.equal(
    summarizeIssueStateForLinear({
      factoryState: "pr_open",
      sessionState: "running",
      waitingReason: "PatchRelay is finalizing a published PR",
      prNumber: 8,
      prState: "open",
      prReviewState: "approved",
      prCheckStatus: "passed",
    }),
    "PatchRelay is finalizing a published PR",
  );
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
