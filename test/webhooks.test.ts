import assert from "node:assert/strict";
import test from "node:test";
import { resolveProject, triggerEventAllowed } from "../src/project-resolution.js";
import type { AppConfig, LinearWebhookPayload } from "../src/types.js";
import { normalizeWebhook } from "../src/webhooks.js";

test("normalizeWebhook extracts issue metadata from a Linear issue webhook", () => {
  const payload: LinearWebhookPayload = {
    action: "update",
    type: "Issue",
    createdAt: "2026-03-08T12:00:00.000Z",
    webhookTimestamp: Date.now(),
    updatedFrom: {
      stateId: "state_start",
    },
    data: {
      id: "issue_123",
      identifier: "USE-123",
      title: "Track app-server threads",
      url: "https://linear.app/example/issue/USE-123",
      team: {
        id: "team_1",
        key: "USE",
      },
      labels: [{ name: "backend" }],
      state: {
        name: "Start",
      },
    },
  };

  const normalized = normalizeWebhook({
    webhookId: "delivery_1",
    payload,
  });

  assert.equal(normalized.issue.id, "issue_123");
  assert.equal(normalized.issue.identifier, "USE-123");
  assert.equal(normalized.issue.title, "Track app-server threads");
  assert.equal(normalized.issue.teamKey, "USE");
  assert.equal(normalized.issue.stateName, "Start");
  assert.deepEqual(normalized.issue.labelNames, ["backend"]);
  assert.equal(normalized.triggerEvent, "statusChanged");
});

test("normalizeWebhook extracts nested issue metadata from comment webhooks and label nodes", () => {
  const payload: LinearWebhookPayload = {
    action: "create",
    type: "Comment",
    createdAt: "2026-03-08T12:00:00.000Z",
    webhookTimestamp: Date.now(),
    data: {
      issue: {
        id: "issue_comment",
        identifier: "USE-124",
        title: "Comment-triggered routing",
        team: {
          id: "team_1",
          key: "USE",
        },
        labels: {
          nodes: [{ name: "ops" }, { name: "cloudflare" }],
        },
        state: {
          id: "state_review",
          name: "Review",
          type: "started",
        },
      },
    },
  };

  const normalized = normalizeWebhook({
    webhookId: "delivery_comment",
    payload,
  });

  assert.equal(normalized.issue.id, "issue_comment");
  assert.equal(normalized.issue.identifier, "USE-124");
  assert.equal(normalized.issue.teamId, "team_1");
  assert.equal(normalized.issue.stateId, "state_review");
  assert.deepEqual(normalized.issue.labelNames, ["ops", "cloudflare"]);
  assert.equal(normalized.triggerEvent, "commentCreated");
});

test("resolveProject matches by issue key prefix and team", () => {
  const config: AppConfig = {
    server: {
      bind: "127.0.0.1",
      port: 8787,
      healthPath: "/health",
    },
    ingress: {
      linearWebhookPath: "/webhooks/linear",
      maxBodyBytes: 262144,
      maxTimestampSkewSeconds: 60,
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
      webhookSecret: "secret",
      graphqlUrl: "https://linear.example/graphql",
    },
    runner: {
      gitBin: "git",
      codex: {
        bin: "codex",
        args: ["app-server"],
        approvalPolicy: "never",
        sandboxMode: "danger-full-access",
        persistExtendedHistory: true,
      },
    },
    projects: [
      {
        id: "alpha",
        repoPath: "/repos/alpha",
        worktreeRoot: "/worktrees/alpha",
        workflowFiles: {
          development: "/repos/alpha/DEVELOPMENT_WORKFLOW.md",
          review: "/repos/alpha/REVIEW_WORKFLOW.md",
          deploy: "/repos/alpha/DEPLOY_WORKFLOW.md",
          cleanup: "/repos/alpha/CLEANUP_WORKFLOW.md",
        },
        workflowStatuses: {
          development: "Start",
          review: "Review",
          deploy: "Deploy",
          developmentActive: "Implementing",
          reviewActive: "Reviewing",
          deployActive: "Deploying",
        },
        issueKeyPrefixes: ["ALPHA"],
        linearTeamIds: ["OPS"],
        allowLabels: ["alpha"],
        triggerEvents: ["statusChanged"],
        branchPrefix: "alpha",
      },
      {
        id: "usertold",
        repoPath: "/repos/usertold",
        worktreeRoot: "/worktrees/usertold",
        workflowFiles: {
          development: "/repos/usertold/DEVELOPMENT_WORKFLOW.md",
          review: "/repos/usertold/REVIEW_WORKFLOW.md",
          deploy: "/repos/usertold/DEPLOY_WORKFLOW.md",
          cleanup: "/repos/usertold/CLEANUP_WORKFLOW.md",
        },
        workflowStatuses: {
          development: "Start",
          review: "Review",
          deploy: "Deploy",
          developmentActive: "Implementing",
          reviewActive: "Reviewing",
          deployActive: "Deploying",
        },
        issueKeyPrefixes: ["USE"],
        linearTeamIds: ["USE"],
        allowLabels: [],
        triggerEvents: ["statusChanged"],
        branchPrefix: "use",
      },
    ],
  };

  const normalized = normalizeWebhook({
    webhookId: "delivery_2",
    payload: {
      action: "update",
      type: "Issue",
      createdAt: "2026-03-08T12:00:00.000Z",
      webhookTimestamp: Date.now(),
      updatedFrom: {
        stateId: "state_start",
      },
      data: {
        id: "issue_999",
        identifier: "USE-999",
        title: "Launch app-server workflow",
        team: {
          key: "USE",
        },
        labels: [{ name: "platform" }],
        state: {
          name: "Start",
        },
      },
    },
  });

  const project = resolveProject(config, normalized.issue);
  assert.equal(project?.id, "usertold");
  assert.equal(triggerEventAllowed(project!, normalized.triggerEvent), true);
});
