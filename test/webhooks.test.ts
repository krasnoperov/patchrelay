import assert from "node:assert/strict";
import test from "node:test";
import { resolveProject, triggerEventAllowed } from "../src/project-resolution.js";
import type { AppConfig, LinearWebhookPayload } from "../src/types.js";
import { normalizeWebhook } from "../src/webhooks.js";

test("normalizeWebhook extracts launch metadata directly from an issue webhook payload", () => {
  const payload: LinearWebhookPayload = {
    action: "update",
    type: "Issue",
    createdAt: "2026-03-08T12:00:00.000Z",
    webhookTimestamp: Date.now(),
    updatedFrom: {
      labels: [],
    },
    data: {
      id: "issue_123",
      identifier: "ENG-123",
      title: "Fix webhook branch naming",
      url: "https://linear.app/example/issue/ENG-123/fix-webhook-branch-naming",
      team: {
        id: "team_1",
        key: "ENG",
      },
      labels: [
        { name: "patchrelay" },
        { name: "backend" },
      ],
    },
  };

  const normalized = normalizeWebhook({
    webhookId: "delivery_1",
    payload,
  });

  assert.equal(normalized.issue.id, "issue_123");
  assert.equal(normalized.issue.identifier, "ENG-123");
  assert.equal(normalized.issue.title, "Fix webhook branch naming");
  assert.equal(normalized.issue.teamKey, "ENG");
  assert.deepEqual(normalized.issue.labelNames, ["patchrelay", "backend"]);
  assert.equal(normalized.triggerEvent, "labelChanged");
});

test("resolveProject matches a project using webhook metadata only", () => {
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
      format: "json",
    },
    database: {
      path: "/tmp/patchrelay.sqlite",
      wal: true,
    },
    linear: {
      webhookSecret: "secret",
    },
    runner: {
      zmxBin: "zmx",
      gitBin: "git",
      launch: {
        shell: "codex",
        args: ["exec", "{prompt}"],
      },
    },
    projects: [
      {
        id: "alpha",
        repoPath: "/repos/alpha",
        worktreeRoot: "/worktrees/alpha",
        workflowFile: "/repos/alpha/docs/workflow.md",
        linearTeamIds: ["OPS"],
        allowLabels: ["alpha"],
        triggerEvents: ["issueCreated"],
        branchPrefix: "alpha",
      },
      {
        id: "patchrelay",
        repoPath: "/repos/patchrelay",
        worktreeRoot: "/worktrees/patchrelay",
        workflowFile: "/repos/patchrelay/docs/workflow.md",
        linearTeamIds: ["ENG"],
        allowLabels: ["patchrelay"],
        triggerEvents: ["issueCreated", "labelChanged"],
        branchPrefix: "patchrelay",
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
        labels: [],
      },
      data: {
        id: "issue_999",
        identifier: "ENG-999",
        title: "Launch Codex from webhook",
        team: {
          key: "ENG",
        },
        labels: [{ name: "patchrelay" }],
      },
    },
  });

  const project = resolveProject(config, normalized.issue);
  assert.equal(project?.id, "patchrelay");
  assert.equal(triggerEventAllowed(project!, normalized.triggerEvent), true);
});
