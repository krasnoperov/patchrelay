import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentSessionPlan, buildAgentSessionPlanForIssue } from "../src/agent-session-plan.ts";
import { buildAgentSessionExternalUrls } from "../src/agent-session-presentation.ts";
import {
  buildGitHubStateActivity,
  buildReviewRoundStartedActivity,
  buildRunCompletedActivity,
  summarizeIssueStateForLinear,
} from "../src/linear-session-reporting.ts";
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

test("agent session plans reflect implementation, review, checks, queue, and merge states", () => {
  assert.deepEqual(
    buildAgentSessionPlan({
      factoryState: "delegated",
      pendingRunType: "implementation",
    }),
    [
      { content: "Prepare workspace", status: "inProgress" },
      { content: "Implementing", status: "pending" },
      { content: "Fresh head pushed", status: "pending" },
      { content: "Merge", status: "pending" },
    ],
  );

  assert.deepEqual(
    buildAgentSessionPlan({
      factoryState: "changes_requested",
      activeRunType: "review_fix",
    }),
    [
      { content: "Prepare workspace", status: "completed" },
      { content: "Addressing requested changes", status: "inProgress" },
      { content: "Fresh head pushed", status: "pending" },
      { content: "Merge", status: "pending" },
    ],
  );

  assert.deepEqual(
    buildAgentSessionPlan({
      factoryState: "pr_open",
      prReviewState: "review_required",
      prCheckStatus: "success",
    }),
    [
      { content: "Prepare workspace", status: "completed" },
      { content: "Implementing", status: "completed" },
      { content: "Awaiting review", status: "inProgress" },
      { content: "Merge", status: "pending" },
    ],
  );

  assert.deepEqual(
    buildAgentSessionPlan({
      factoryState: "pr_open",
      prReviewState: "approved",
      prCheckStatus: "pending",
    }),
    [
      { content: "Prepare workspace", status: "completed" },
      { content: "Implementing", status: "completed" },
      { content: "Awaiting checks", status: "inProgress" },
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
      { content: "Fresh head pushed", status: "completed" },
      { content: "Verification passed", status: "completed" },
      { content: "Awaiting queue", status: "inProgress" },
    ],
  );

  assert.deepEqual(
    buildAgentSessionPlan({
      factoryState: "repairing_queue",
      activeRunType: "queue_repair",
      queueRepairAttempts: 3,
    }),
    [
      { content: "Prepare workspace", status: "completed" },
      { content: "Implementing", status: "completed" },
      { content: "Verification passed", status: "completed" },
      { content: "Repairing merge (attempt 3)", status: "inProgress" },
    ],
  );

  assert.deepEqual(
    buildAgentSessionPlan({
      factoryState: "done",
    }),
    [
      { content: "Prepare workspace", status: "completed" },
      { content: "Fresh head pushed", status: "completed" },
      { content: "Verification passed", status: "completed" },
      { content: "Merged", status: "completed" },
    ],
  );

  assert.deepEqual(
    buildAgentSessionPlanForIssue({
      factoryState: "delegated",
      issueClass: "orchestration",
      ciRepairAttempts: 0,
      queueRepairAttempts: 0,
    }),
    [
      { content: "Review umbrella goal and child set", status: "inProgress" },
      { content: "Wait for or inspect child progress", status: "pending" },
      { content: "Audit delivered outcome", status: "pending" },
      { content: "Close umbrella or create follow-up work", status: "pending" },
    ],
  );
});

test("GitHub state activities keep repair work active instead of erroring", () => {
  const repairingCi = buildGitHubStateActivity("repairing_ci", {
    triggerEvent: "check_failed",
    checkName: "lint",
  } as never);
  assert.equal(repairingCi, undefined);

  const changesRequested = buildGitHubStateActivity("changes_requested", {
    triggerEvent: "review_changes_requested",
    reviewerName: "Ada",
  } as never);
  assert.equal(changesRequested, undefined);
});

test("run completion activity reports PR publication concisely", () => {
  const activity = buildRunCompletedActivity({
    runType: "implementation",
    completionSummary: "Ready for review.",
    postRunState: "pr_open",
    prNumber: 42,
  });

  assert.deepEqual(activity, {
    type: "response",
    body: "PR #42 opened: Ready for review.",
  });
});

test("run completion activity unwraps shell-wrapped verification commands in publish comments", () => {
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
      "PR #42 opened: Verification passed with `npm run test:ui:local -- tests/ui/app-shell.spec.ts tests/ui/game-flow.spec.ts`.",
  });
});

test("run completion activity appends durable PR URL and strips assistant PR fragments", () => {
  const activity = buildRunCompletedActivity({
    runType: "implementation",
    completionSummary:
      "Implemented the Lyria provider, exposed it in web and CLI, and verified the audio tests. PR: https://github.",
    postRunState: "pr_open",
    prNumber: 116,
    prUrl: "https://github.com/krasnoperov/inventory/pull/116",
  });

  assert.deepEqual(activity, {
    type: "response",
    body:
      "PR #116 opened: Implemented the Lyria provider, exposed it in web and CLI, and verified the audio tests.\n\nPR: https://github.com/krasnoperov/inventory/pull/116",
  });
});

test("run completion activity strips repo-local absolute paths from publish comments", () => {
  const activity = buildRunCompletedActivity({
    runType: "review_fix",
    completionSummary:
      "Updated [sessionSchema.ts](</home/alv/.local/share/patchrelay/worktrees/example/TST-58/src/frontend/app/sessionSchema.ts>) and `/home/alv/projects/patchrelay/tmp/debug.log`, then pushed a new head.",
    postRunState: "pr_open",
    prNumber: 42,
  });

  assert.deepEqual(activity, {
    type: "response",
    body: [
      "Review fix completed.",
      "",
      "Addressed:",
      "- Updated `sessionSchema.ts` and `local path omitted`.",
    ].join("\n"),
  });
});

test("run completion activity suppresses routine branch upkeep chatter", () => {
  const activity = buildRunCompletedActivity({
    runType: "branch_upkeep",
    completionSummary: "Rebased the PR branch onto the latest origin/main.",
    postRunState: "pr_open",
    prNumber: 52,
  });

  assert.equal(activity, undefined);
});

test("run completion activity keeps repair comments concise and human-facing", () => {
  const reviewFix = buildRunCompletedActivity({
    runType: "review_fix",
    completionSummary: "Fixed the mobile header regression and pushed a new head.",
    postRunState: "pr_open",
    prNumber: 50,
  });
  assert.deepEqual(reviewFix, {
    type: "response",
    body: [
      "Review fix completed.",
      "",
      "Addressed:",
      "- Fixed the mobile header regression.",
    ].join("\n"),
  });

  const queueRepair = buildRunCompletedActivity({
    runType: "queue_repair",
    completionSummary: "Resolved the merge conflict and force-pushed the repaired branch.",
    postRunState: "pr_open",
    prNumber: 50,
  });
  assert.deepEqual(queueRepair, {
    type: "response",
    body: "Resolved the merge conflict.",
  });
});

test("review round activities summarize reviewer and captured comments without commit hashes", () => {
  assert.deepEqual(
    buildReviewRoundStartedActivity({
      round: 2,
      reviewerName: "reviewer",
      commentCount: 3,
      headSha: "abcdef123456",
    }),
    {
      type: "action",
      action: "Review round",
      parameter: "2 from @reviewer; 3 inline comments captured",
    },
  );

  assert.deepEqual(
    buildRunCompletedActivity({
      runType: "review_fix",
      completionSummary: "Addressed the requested changes and pushed.",
      postRunState: "pr_open",
      prNumber: 50,
      reviewRound: 2,
    }),
    {
      type: "response",
      body: [
        "Review round 2 completed.",
        "",
        "Addressed:",
        "- Addressed the requested changes.",
      ].join("\n"),
    },
  );
});

test("linear summaries prefer session state over factory state", () => {
  assert.equal(
    summarizeIssueStateForLinear({
      factoryState: "awaiting_queue",
      sessionState: "waiting_input",
      waitingReason: "Waiting for a merge queue retry.",
      prNumber: 7,
      delegatedToPatchRelay: true,
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
      delegatedToPatchRelay: true,
      prState: "open",
      prReviewState: "approved",
      prCheckStatus: "passed",
    }),
    "PatchRelay is finalizing a published PR",
  );
});

test("linear summaries describe closed historical PRs as non-merged completion", () => {
  assert.equal(
    summarizeIssueStateForLinear({
      factoryState: "done",
      prNumber: 193,
      prState: "closed",
    }),
    "Completed without merging PR #193.",
  );
});

test("linear summaries describe closed PR replacement work explicitly", () => {
  assert.equal(
    summarizeIssueStateForLinear({
      factoryState: "implementing",
      prNumber: 194,
      prState: "closed",
      delegatedToPatchRelay: true,
    }),
    "Replacing closed PR #194 with a fresh PR.",
  );
});

test("linear summaries describe paused undelegated PR-backed states explicitly", () => {
  assert.equal(
    summarizeIssueStateForLinear({
      factoryState: "pr_open",
      sessionState: "idle",
      delegatedToPatchRelay: false,
      prNumber: 41,
      prState: "open",
      prReviewState: "review_required",
      prCheckStatus: "success",
    }),
    "PR #41 is awaiting review while PatchRelay is paused.",
  );

  assert.equal(
    summarizeIssueStateForLinear({
      factoryState: "changes_requested",
      sessionState: "idle",
      delegatedToPatchRelay: false,
      prNumber: 42,
      prState: "open",
      prReviewState: "changes_requested",
      prCheckStatus: "success",
    }),
    "PR #42 has requested changes while PatchRelay is paused.",
  );

  assert.equal(
    summarizeIssueStateForLinear({
      factoryState: "awaiting_queue",
      sessionState: "idle",
      delegatedToPatchRelay: false,
      prNumber: 43,
      prState: "open",
      prReviewState: "approved",
      prCheckStatus: "success",
    }),
    "PR #43 is approved and awaiting merge while PatchRelay is paused.",
  );
});

test("linear summaries describe paused undelegated no-PR states explicitly", () => {
  assert.equal(
    summarizeIssueStateForLinear({
      factoryState: "delegated",
      sessionState: "idle",
      delegatedToPatchRelay: false,
      prState: undefined,
      prReviewState: undefined,
      prCheckStatus: undefined,
    }),
    "PatchRelay is queued to start work, but automation is paused.",
  );

  assert.equal(
    summarizeIssueStateForLinear({
      factoryState: "implementing",
      sessionState: "idle",
      delegatedToPatchRelay: false,
      prState: undefined,
      prReviewState: undefined,
      prCheckStatus: undefined,
    }),
    "Implementation is paused because the issue is undelegated.",
  );
});

test("session external urls include status, pull request, review, queue, and active run links", () => {
  const urls = buildAgentSessionExternalUrls(createConfig(), {
    issueKey: "USE-42",
    prUrl: "https://github.com/example/repo/pull/42",
    activeRunId: 7,
    prReviewState: "review_required",
    lastGitHubFailureSource: "queue_eviction",
    lastGitHubFailureCheckName: "merge-steward/queue",
    lastGitHubFailureCheckUrl: "https://github.com/example/repo/actions/runs/42",
    lastQueueIncidentJson: JSON.stringify({
      incidentUrl: "https://queue.example.com/incidents/42",
    }),
  });

  assert.equal(urls?.length, 5);
  assert.equal(urls?.[0]?.label, "PatchRelay status");
  assert.match(urls?.[0]?.url ?? "", /agent\/session\/USE-42\?token=/);
  assert.deepEqual(urls?.[1], {
    label: "Pull request",
    url: "https://github.com/example/repo/pull/42",
  });
  assert.deepEqual(urls?.[2], {
    label: "Review-quill status",
    url: "https://github.com/example/repo/pull/42/checks",
  });
  assert.deepEqual(urls?.[3], {
    label: "Merge-steward queue",
    url: "https://queue.example.com/incidents/42",
  });
  assert.equal(urls?.[4]?.label, "Active run");
  assert.match(urls?.[4]?.url ?? "", /agent\/session\/USE-42\?token=.*#current-view$/);
});
