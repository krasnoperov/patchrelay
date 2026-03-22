import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveProject, triggerEventAllowed } from "../src/project-resolution.ts";
import type { AppConfig, IssueMetadata } from "../src/types.ts";
import {
  listAllowedTransitionTargets,
  listRunnableStates,
  resolveDefaultTransitionTarget,
  resolveWorkflowStage,
  resolveWorkflowStageCandidate,
  selectWorkflowDefinition,
} from "../src/workflow-policy.ts";

function createWorkflows(repoPath: string) {
  return [
    {
      id: "development",
      whenState: "Start",
      activeState: "Implementing",
      workflowFile: path.join(repoPath, "DEVELOPMENT_WORKFLOW.md"),
    },
    {
      id: "review",
      whenState: "Review",
      activeState: "Reviewing",
      workflowFile: path.join(repoPath, "REVIEW_WORKFLOW.md"),
    },
    {
      id: "deploy",
      whenState: "Deploy",
      activeState: "Deploying",
      workflowFile: path.join(repoPath, "DEPLOY_WORKFLOW.md"),
    },
    {
      id: "cleanup",
      whenState: "Cleanup",
      activeState: "Cleaning Up",
      workflowFile: path.join(repoPath, "CLEANUP_WORKFLOW.md"),
    },
  ];
}

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
      githubWebhookPath: "/webhooks/github",
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
        workflows: createWorkflows("/repos/alpha"),
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
        workflows: createWorkflows("/repos/usertold"),
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

test("resolveWorkflowStageCandidate matches configured stage ids and workflow labels", () => {
  const project = createConfig().projects[0]!;

  assert.equal(resolveWorkflowStageCandidate(project, "development"), "development");
  assert.equal(resolveWorkflowStageCandidate(project, "Reviewing"), "review");
  assert.equal(resolveWorkflowStageCandidate(project, "deploy"), "deploy");
  assert.equal(resolveWorkflowStageCandidate(project, "missing"), undefined);
});

test("default workflow policy resolves forward transitions from configured stage order", () => {
  const project = createConfig().projects[0]!;

  assert.equal(resolveDefaultTransitionTarget(project, "development"), "review");
  assert.equal(resolveDefaultTransitionTarget(project, "review"), "deploy");
  assert.equal(resolveDefaultTransitionTarget(project, "deploy"), "cleanup");
  assert.equal(resolveDefaultTransitionTarget(project, "cleanup"), "done");
});

test("default workflow policy allows forward moves, loop-backs, and terminal escalation", () => {
  const project = createConfig().projects[0]!;

  assert.deepEqual(listAllowedTransitionTargets(project, "development"), ["human_needed", "review"]);
  assert.deepEqual(listAllowedTransitionTargets(project, "review"), ["human_needed", "deploy", "development"]);
  assert.deepEqual(listAllowedTransitionTargets(project, "deploy"), ["human_needed", "cleanup", "review", "development"]);
});

test("workflow selection chooses a repo-defined workflow from labels and resolves stages within it", () => {
  const project = createConfig().projects[0]!;
  project.workflowDefinitions = [
    {
      id: "feature",
      stages: createWorkflows("/repos/alpha").slice(0, 3),
    },
    {
      id: "docs",
      stages: [
        {
          id: "write",
          whenState: "Start",
          activeState: "Writing",
          workflowFile: "/repos/alpha/.patchrelay/workflows/DOCS_WRITE.md",
        },
        {
          id: "publish",
          whenState: "Publish",
          activeState: "Publishing",
          workflowFile: "/repos/alpha/.patchrelay/workflows/DOCS_PUBLISH.md",
        },
      ],
    },
  ];
  project.workflowSelection = {
    defaultWorkflowId: "feature",
    byLabel: [{ label: "docs", workflowId: "docs" }],
  };
  project.workflows = project.workflowDefinitions[0]!.stages;

  assert.equal(selectWorkflowDefinition(project, { labelNames: ["docs"] })?.id, "docs");
  assert.equal(resolveWorkflowStage(project, "Start", { issue: { labelNames: ["docs"] } }), "write");
  assert.deepEqual(listRunnableStates(project, { issue: { labelNames: ["docs"] } }), ["Start", "Publish"]);
  assert.equal(resolveDefaultTransitionTarget(project, "write", "docs"), "publish");
});

test("resolveProject matches a single configured project only when routing constraints match", () => {
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

test("resolveProject returns undefined when a single configured project does not match routing constraints", () => {
  const config = createConfig();
  const issue: IssueMetadata = {
    id: "issue_999",
    identifier: "OPS-999",
    title: "Launch app-server workflow",
    teamKey: "OPS",
    stateName: "Start",
    labelNames: ["platform"],
  };

  assert.equal(resolveProject(config, issue), undefined);
});

test("resolveProject returns undefined when routing is ambiguous", () => {
  const config = createConfig();
  config.projects.push({
    ...config.projects[1]!,
    id: "usertold-copy",
    repoPath: "/repos/usertold-copy",
    worktreeRoot: "/worktrees/usertold-copy",
    workflows: createWorkflows("/repos/usertold-copy"),
  });

  const issue: IssueMetadata = {
    id: "issue_1000",
    identifier: "USE-1000",
    teamKey: "USE",
    labelNames: [],
  };

  assert.equal(resolveProject(config, issue), undefined);
});
