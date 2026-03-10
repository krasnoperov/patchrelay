import assert from "node:assert/strict";
import test from "node:test";
import { resolveProject, triggerEventAllowed } from "../src/project-resolution.ts";
import type { AppConfig, IssueMetadata } from "../src/types.ts";
import { resolveWorkflowStage } from "../src/workflow-policy.ts";

function createConfig(): AppConfig {
  return {
    server: {
      bind: "127.0.0.1",
      port: 8787,
      healthPath: "/health",
      readinessPath: "/ready",
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
      oauth: {
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
        scopes: ["read", "write"],
        actor: "user",
      },
      tokenEncryptionKey: "test-encryption-key",
    },
    operatorApi: {
      enabled: false,
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
          cleanup: "Cleanup",
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
          cleanup: "Cleanup",
        },
        issueKeyPrefixes: ["USE"],
        linearTeamIds: ["USE"],
        allowLabels: [],
        triggerEvents: ["statusChanged"],
        branchPrefix: "use",
      },
    ],
  };
}

test("resolveWorkflowStage maps configured Linear states to workflow stages", () => {
  const project = createConfig().projects[0]!;

  assert.equal(resolveWorkflowStage(project, "Start"), "development");
  assert.equal(resolveWorkflowStage(project, "review"), "review");
  assert.equal(resolveWorkflowStage(project, "DEPLOY"), "deploy");
  assert.equal(resolveWorkflowStage(project, "Cleanup"), "cleanup");
  assert.equal(resolveWorkflowStage(project, "Blocked"), undefined);
});

test("resolveProject matches a single configured project and allows its trigger event", () => {
  const config = createConfig();
  const issue: IssueMetadata = {
    id: "issue_999",
    identifier: "USE-999",
    title: "Launch app-server workflow",
    teamKey: "USE",
    stateName: "Start",
    labelNames: ["platform"],
  };

  const project = resolveProject(config, issue);
  assert.equal(project?.id, "usertold");
  assert.equal(triggerEventAllowed(project!, "statusChanged"), true);
});

test("resolveProject returns undefined when routing is ambiguous", () => {
  const config = createConfig();
  config.projects.push({
    ...config.projects[1]!,
    id: "usertold-copy",
    repoPath: "/repos/usertold-copy",
    worktreeRoot: "/worktrees/usertold-copy",
    workflowFiles: {
      development: "/repos/usertold-copy/DEVELOPMENT_WORKFLOW.md",
      review: "/repos/usertold-copy/REVIEW_WORKFLOW.md",
      deploy: "/repos/usertold-copy/DEPLOY_WORKFLOW.md",
      cleanup: "/repos/usertold-copy/CLEANUP_WORKFLOW.md",
    },
  });

  const issue: IssueMetadata = {
    id: "issue_1000",
    identifier: "USE-1000",
    teamKey: "USE",
    labelNames: [],
  };

  assert.equal(resolveProject(config, issue), undefined);
});
