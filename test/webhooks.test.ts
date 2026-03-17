import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolveProject, triggerEventAllowed, trustedActorAllowed } from "../src/project-resolution.ts";
import type { AppConfig, LinearWebhookPayload } from "../src/types.ts";
import { normalizeWebhook } from "../src/webhooks.ts";

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

test("normalizeWebhook treats delegate object updates as delegateChanged", () => {
  const payload: LinearWebhookPayload = {
    action: "update",
    type: "Issue",
    createdAt: "2026-03-10T12:00:00.000Z",
    webhookTimestamp: Date.now(),
    updatedFrom: {
      delegate: {
        id: "previous_delegate",
      } as unknown as Record<string, unknown>,
    },
    data: {
      id: "issue_delegate",
      identifier: "USE-123",
      title: "Delegate via object payload",
      delegate: {
        id: "app_user_1",
        name: "PatchRelay",
      },
      team: {
        id: "team_1",
        key: "USE",
      },
      state: {
        name: "Start",
      },
    },
  };

  const normalized = normalizeWebhook({
    webhookId: "delivery_delegate_object",
    payload,
  });

  assert.equal(normalized.triggerEvent, "delegateChanged");
  assert.equal(normalized.issue?.delegateId, "app_user_1");
});

test("normalizeWebhook extracts nested issue metadata from comment webhooks and label nodes", () => {
  const payload: LinearWebhookPayload = {
    action: "create",
    type: "Comment",
    createdAt: "2026-03-08T12:00:00.000Z",
    webhookTimestamp: Date.now(),
    actor: {
      id: "user_1",
      name: "Alex Operator",
      email: "alex@example.com",
      type: "User",
    } as unknown as Record<string, unknown>,
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
  assert.deepEqual(normalized.actor, {
    id: "user_1",
    name: "Alex Operator",
    email: "alex@example.com",
    type: "User",
  });
  assert.equal(normalized.triggerEvent, "commentCreated");
});

test("normalizeWebhook extracts agent session context from delegation webhooks", () => {
  const payload: LinearWebhookPayload = {
    action: "created",
    type: "AgentSessionEvent",
    createdAt: "2026-03-08T12:00:00.000Z",
    webhookTimestamp: Date.now(),
    actor: {
      id: "user_2",
      name: "Taylor Operator",
      email: "taylor@example.com",
      type: "User",
    } as unknown as Record<string, unknown>,
    data: {
      promptContext: "<issue identifier=\"USE-125\"><title>Implement agent delegation</title></issue>",
      agentSession: {
        id: "session_1",
        issue: {
          id: "issue_agent",
          identifier: "USE-125",
          title: "Implement agent delegation",
          delegateId: "app_user_1",
          delegate: {
            id: "app_user_1",
            name: "PatchRelay",
          },
          team: {
            id: "team_1",
            key: "USE",
          },
          state: {
            id: "state_start",
            name: "Start",
            type: "started",
          },
        },
      },
    },
  };

  const normalized = normalizeWebhook({
    webhookId: "delivery_agent_session",
    payload,
  });

  assert.equal(normalized.triggerEvent, "agentSessionCreated");
  assert.equal(normalized.issue.id, "issue_agent");
  assert.equal(normalized.issue.delegateId, "app_user_1");
  assert.equal(normalized.agentSession?.id, "session_1");
  assert.equal(
    normalized.agentSession?.promptContext,
    "<issue identifier=\"USE-125\"><title>Implement agent delegation</title></issue>",
  );
});

test("normalizeWebhook tolerates top-level agent session webhook fields", () => {
  const payload: LinearWebhookPayload = {
    action: "created",
    type: "AgentSession",
    createdAt: "2026-03-08T12:00:00.000Z",
    webhookTimestamp: Date.now(),
    agentSession: {
      id: "session_top_level",
      issue: {
        id: "issue_agent_top_level",
        identifier: "USE-125",
        title: "Implement top-level agent delegation",
        delegate: {
          id: "app_user_1",
          name: "PatchRelay",
        },
        team: {
          id: "team_1",
          key: "USE",
        },
        state: {
          id: "state_start",
          name: "Start",
          type: "started",
        },
      },
    } as unknown as Record<string, unknown>,
    promptContext: "Please start implementation.",
  } as unknown as LinearWebhookPayload;

  const normalized = normalizeWebhook({
    webhookId: "delivery_agent_session_top_level",
    payload,
  });

  assert.equal(normalized.triggerEvent, "agentSessionCreated");
  assert.equal(normalized.issue?.id, "issue_agent_top_level");
  assert.equal(normalized.issue?.delegateId, "app_user_1");
  assert.equal(normalized.agentSession?.id, "session_top_level");
  assert.equal(normalized.agentSession?.promptContext, "Please start implementation.");
});

test("normalizeWebhook extracts nested issue metadata from root agent thread comments", () => {
  const payload: LinearWebhookPayload = {
    action: "create",
    type: "Comment",
    createdAt: "2026-03-17T09:50:10.508Z",
    webhookTimestamp: Date.now(),
    data: {
      id: "comment_root",
      body: "This thread is for an agent session with patchrelay.",
      commentThread: {
        issue: {
          id: "issue_agent_thread",
          identifier: "USE-200",
          title: "Agent thread root comment",
          team: {
            id: "team_1",
            key: "USE",
          },
          state: {
            id: "state_start",
            name: "Start",
          },
        },
      },
    },
  };

  const normalized = normalizeWebhook({
    webhookId: "delivery_agent_thread_comment",
    payload,
  });

  assert.equal(normalized.issue?.id, "issue_agent_thread");
  assert.equal(normalized.issue?.identifier, "USE-200");
  assert.equal(normalized.comment?.id, "comment_root");
  assert.equal(normalized.triggerEvent, "commentCreated");
});

test("normalizeWebhook accepts installation permission change webhooks without issue metadata", () => {
  const payload: LinearWebhookPayload = {
    action: "teamAccessChanged",
    type: "PermissionChange",
    createdAt: "2026-03-10T12:00:00.000Z",
    webhookTimestamp: Date.now(),
    data: {
      organizationId: "org_1",
      oauthClientId: "oauth-client-1",
      appUserId: "app_user_1",
      addedTeamIds: ["team_added"],
      removedTeamIds: ["team_removed"],
      canAccessAllPublicTeams: false,
    },
  };

  const normalized = normalizeWebhook({
    webhookId: "delivery_permission_change",
    payload,
  });

  assert.equal(normalized.triggerEvent, "installationPermissionsChanged");
  assert.equal(normalized.issue, undefined);
  assert.deepEqual(normalized.installation, {
    organizationId: "org_1",
    oauthClientId: "oauth-client-1",
    appUserId: "app_user_1",
    canAccessAllPublicTeams: false,
    addedTeamIds: ["team_added"],
    removedTeamIds: ["team_removed"],
  });
});

test("normalizeWebhook extracts issue metadata from app-user notifications when available", () => {
  const payload: LinearWebhookPayload = {
    action: "create",
    type: "AppUserNotification",
    createdAt: "2026-03-10T12:00:00.000Z",
    webhookTimestamp: Date.now(),
    data: {
      appUserId: "app_user_1",
      notification: {
        type: "issueNewComment",
        issue: {
          id: "issue_notification",
          identifier: "USE-126",
          title: "Inbox notification fallback",
          team: {
            id: "team_1",
            key: "USE",
          },
          state: {
            name: "Review",
          },
        },
      },
    },
  };

  const normalized = normalizeWebhook({
    webhookId: "delivery_app_notification",
    payload,
  });

  assert.equal(normalized.triggerEvent, "appUserNotification");
  assert.equal(normalized.issue?.identifier, "USE-126");
  assert.equal(normalized.installation?.notificationType, "issueNewComment");
  assert.equal(normalized.installation?.appUserId, "app_user_1");
});

test("resolveProject matches by issue key prefix and team", () => {
  const config: AppConfig = {
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

test("trustedActorAllowed matches ids, emails, names, and trusted email domains", () => {
  const project = {
    id: "usertold",
    repoPath: "/repos/usertold",
    worktreeRoot: "/worktrees/usertold",
    workflows: createWorkflows("/repos/usertold"),
    issueKeyPrefixes: ["USE"],
    linearTeamIds: ["USE"],
    allowLabels: [],
    trustedActors: {
      ids: ["user_1"],
      names: ["Owner Name"],
      emails: ["owner@example.com"],
      emailDomains: ["trusted.example.com"],
    },
    triggerEvents: ["statusChanged"],
    branchPrefix: "use",
  };

  assert.equal(trustedActorAllowed(project, { id: "user_1" }), true);
  assert.equal(trustedActorAllowed(project, { name: "owner name" }), true);
  assert.equal(trustedActorAllowed(project, { email: "OWNER@example.com" }), true);
  assert.equal(trustedActorAllowed(project, { email: "teammate@trusted.example.com" }), true);
  assert.equal(trustedActorAllowed(project, { email: "intruder@elsewhere.example" }), false);
  assert.equal(trustedActorAllowed(project, undefined), false);
});
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
