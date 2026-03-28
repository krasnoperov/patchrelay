import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { getBuildInfo } from "../src/build-info.ts";
import { buildHttpServer } from "../src/http.ts";
import { createSessionStatusToken, deriveSessionStatusSigningSecret } from "../src/public-agent-session-status.ts";
import type { AppConfig } from "../src/types.ts";


function createConfig(baseDir: string): AppConfig {
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
      filePath: path.join(baseDir, "patchrelay.log"),
    },
    database: {
      path: path.join(baseDir, "patchrelay.sqlite"),
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
        serviceName: "patchrelay-test",
      },
    },
    projects: [
      {
        id: "usertold",
        repoPath: path.join(baseDir, "repo"),
        worktreeRoot: path.join(baseDir, "worktrees"),
        issueKeyPrefixes: ["USE"],
        linearTeamIds: ["USE"],
        allowLabels: [],
        triggerEvents: ["statusChanged"],
        branchPrefix: "use",
      },
    ],
  };
}

test("health endpoint includes build version metadata from the built artifact", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-http-"));
  const buildInfo = getBuildInfo();

  try {
    const config = createConfig(baseDir);
    const app = await buildHttpServer(
      config,
      {
        acceptWebhook: async () => ({ status: 200, body: { ok: true } }),
        getReadiness: () => ({ ready: true, codexStarted: true, linearConnected: true }),
        getIssueOverview: async () => undefined,
        getIssueReport: async () => undefined,
      } as never,
      pino({ enabled: false }),
    );

    const response = await app.inject({
      method: "GET",
      url: config.server.healthPath,
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      ok: true,
      service: buildInfo.service,
      version: buildInfo.version,
      commit: buildInfo.commit,
      builtAt: buildInfo.builtAt,
    });

    const readiness = await app.inject({
      method: "GET",
      url: config.server.readinessPath,
    });
    assert.equal(readiness.statusCode, 200);
    assert.deepEqual(readiness.json(), {
      ok: true,
      ready: true,
      codexStarted: true,
      linearConnected: true,
      service: buildInfo.service,
      version: buildInfo.version,
      commit: buildInfo.commit,
    });

    const home = await app.inject({
      method: "GET",
      url: "/",
    });
    assert.match(home.body, /codex app-server/);
    assert.doesNotMatch(home.body, /api\/issues\/:issueKey\/report/);

    await app.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("http routes handle webhook validation and issue/report/live/events lookups", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-http-routes-"));

  try {
    const config = {
      ...createConfig(baseDir),
      server: {
        ...createConfig(baseDir).server,
        bind: "0.0.0.0",
      },
      operatorApi: {
        enabled: true,
        bearerToken: "operator-token",
      },
    };
    const feedQueries: Array<Record<string, unknown>> = [];
    const app = await buildHttpServer(
      config,
      {
        acceptWebhook: async ({ webhookId }) => ({
          status: 202,
          body: { ok: true, webhookId },
        }),
        getReadiness: () => ({ ready: false, codexStarted: false, linearConnected: false, startupError: "codex offline" }),
        getIssueOverview: async (issueKey: string) =>
          issueKey === "USE-42"
            ? {
                issue: { issueKey: "USE-42" },
                latestStageRun: { id: 7, stage: "development", status: "completed" },
              }
            : undefined,
        getIssueReport: async (issueKey: string) =>
          issueKey === "USE-42"
            ? {
                issue: { issueKey: "USE-42" },
                stages: [{ stageRun: { id: 7, stage: "development", status: "completed" } }],
              }
            : undefined,
        getActiveRunStatus: async (issueKey: string) =>
          issueKey === "USE-42"
            ? {
                issue: { issueKey: "USE-42" },
                run: { id: 8, runType: "review", status: "running" },
                liveThread: { threadId: "thread-1", threadStatus: "running" },
              }
            : undefined,
        getRunEvents: async (issueKey: string, runId: number) =>
          issueKey === "USE-42" && runId === 8
            ? {
                issue: { issueKey: "USE-42" },
                run: { id: 8, runType: "review", status: "running" },
                events: [{ id: 1, method: "turn/started" }],
              }
            : undefined,
        listOperatorFeed: (
          {
            limit,
            issueKey,
            projectId,
            kind,
            stage,
            status,
            workflowId,
          }: {
            limit?: number;
            issueKey?: string;
            projectId?: string;
            kind?: string;
            stage?: string;
            status?: string;
            workflowId?: string;
          } = {},
        ) => {
          feedQueries.push({ limit, issueKey, projectId, kind, stage, status, workflowId });
          return [
            {
              id: 2,
              at: "2026-03-13T12:00:00.000Z",
              level: "info",
              kind: "workflow",
              issueKey: "USE-42",
              projectId: "usertold",
              stage: "development",
              workflowId: "default",
              nextStage: "review",
              status: "transition_chosen",
              summary: `Chose development -> review${limit ? ` (${limit})` : ""}`,
            },
            {
              id: 3,
              at: "2026-03-13T12:00:00.000Z",
              level: "info",
              kind: "stage",
              issueKey: "USE-42",
              projectId: "usertold",
              stage: "review",
              workflowId: "default",
              status: "running",
              summary: "Started review workflow",
            },
            {
              id: 4,
              at: "2026-03-13T12:01:00.000Z",
              level: "warn",
              kind: "comment",
              issueKey: "OPS-7",
              projectId: "ops",
              status: "delivery_failed",
              summary: "Could not deliver follow-up comment",
            },
          ].filter(
            (event) =>
              (!issueKey || event.issueKey === issueKey) &&
              (!projectId || event.projectId === projectId) &&
              (!kind || event.kind === kind) &&
              (!stage || event.stage === stage) &&
              (!status || event.status === status) &&
              (!workflowId || event.workflowId === workflowId),
          );
        },
        subscribeOperatorFeed: () => () => undefined,
      } as never,
      pino({ enabled: false }),
    );

    const readiness = await app.inject({
      method: "GET",
      url: config.server.readinessPath,
    });
    assert.equal(readiness.statusCode, 503);
    assert.equal(readiness.json().ok, false);
    assert.equal(readiness.json().ready, false);
    assert.equal(readiness.json().codexStarted, false);
    assert.equal(readiness.json().startupError, "codex offline");
    assert.equal(readiness.json().service, "patchrelay");
    assert.equal(typeof readiness.json().version, "string");
    assert.equal(typeof readiness.json().commit, "string");

    const missingHeader = await app.inject({
      method: "POST",
      url: config.ingress.linearWebhookPath,
      payload: { ok: true },
    });
    assert.equal(missingHeader.statusCode, 400);
    assert.deepEqual(missingHeader.json(), { ok: false, reason: "missing_delivery_header" });

    const acceptedWebhook = await app.inject({
      method: "POST",
      url: config.ingress.linearWebhookPath,
      headers: {
        "content-type": "application/json",
        "linear-delivery": "delivery-1",
      },
      payload: { ok: true },
    });
    assert.equal(acceptedWebhook.statusCode, 202);
    assert.deepEqual(acceptedWebhook.json(), { ok: true, webhookId: "delivery-1" });

    const unauthorizedOverview = await app.inject({
      method: "GET",
      url: "/api/issues/USE-42",
    });
    assert.equal(unauthorizedOverview.statusCode, 401);
    assert.deepEqual(unauthorizedOverview.json(), { ok: false, reason: "operator_auth_required" });

    const overview = await app.inject({
      method: "GET",
      url: "/api/issues/USE-42",
      headers: {
        authorization: "Bearer operator-token",
      },
    });
    assert.equal(overview.statusCode, 200);
    assert.deepEqual(overview.json(), {
      ok: true,
      issue: { issueKey: "USE-42" },
      latestStageRun: { id: 7, stage: "development", status: "completed" },
    });

    const missingOverview = await app.inject({
      method: "GET",
      url: "/api/issues/USE-404",
      headers: {
        authorization: "Bearer operator-token",
      },
    });
    assert.equal(missingOverview.statusCode, 404);
    assert.deepEqual(missingOverview.json(), { ok: false, reason: "issue_not_found" });

    const report = await app.inject({
      method: "GET",
      url: "/api/issues/USE-42/report",
      headers: {
        authorization: "Bearer operator-token",
      },
    });
    assert.equal(report.statusCode, 200);
    assert.deepEqual(report.json(), {
      ok: true,
      issue: { issueKey: "USE-42" },
      stages: [{ stageRun: { id: 7, stage: "development", status: "completed" } }],
    });

    const live = await app.inject({
      method: "GET",
      url: "/api/issues/USE-42/live",
      headers: {
        authorization: "Bearer operator-token",
      },
    });
    assert.equal(live.statusCode, 200);
    assert.deepEqual(live.json(), {
      ok: true,
      issue: { issueKey: "USE-42" },
      run: { id: 8, runType: "review", status: "running" },
      liveThread: { threadId: "thread-1", threadStatus: "running" },
    });

    const missingLive = await app.inject({
      method: "GET",
      url: "/api/issues/USE-404/live",
      headers: {
        authorization: "Bearer operator-token",
      },
    });
    assert.equal(missingLive.statusCode, 404);
    assert.deepEqual(missingLive.json(), { ok: false, reason: "active_run_not_found" });

    const events = await app.inject({
      method: "GET",
      url: "/api/issues/USE-42/runs/8/events",
      headers: {
        authorization: "Bearer operator-token",
      },
    });
    assert.equal(events.statusCode, 200);
    assert.deepEqual(events.json(), {
      ok: true,
      issue: { issueKey: "USE-42" },
      run: { id: 8, runType: "review", status: "running" },
      events: [{ id: 1, method: "turn/started" }],
    });

    const feed = await app.inject({
      method: "GET",
      url: "/api/feed?limit=10",
      headers: {
        authorization: "Bearer operator-token",
      },
    });
    assert.equal(feed.statusCode, 200);
    assert.deepEqual(feed.json(), {
      ok: true,
      events: [
        {
          id: 2,
          at: "2026-03-13T12:00:00.000Z",
          level: "info",
          kind: "workflow",
          issueKey: "USE-42",
          projectId: "usertold",
          stage: "development",
          workflowId: "default",
          nextStage: "review",
          status: "transition_chosen",
          summary: "Chose development -> review (10)",
        },
        {
          id: 3,
          at: "2026-03-13T12:00:00.000Z",
          level: "info",
          kind: "stage",
          issueKey: "USE-42",
          projectId: "usertold",
          stage: "review",
          workflowId: "default",
          status: "running",
          summary: "Started review workflow",
        },
        {
          id: 4,
          at: "2026-03-13T12:01:00.000Z",
          level: "warn",
          kind: "comment",
          issueKey: "OPS-7",
          projectId: "ops",
          status: "delivery_failed",
          summary: "Could not deliver follow-up comment",
        },
      ],
    });

    const filteredFeed = await app.inject({
      method: "GET",
      url: "/api/feed?issue=OPS-7&project=ops",
      headers: {
        authorization: "Bearer operator-token",
      },
    });
    assert.equal(filteredFeed.statusCode, 200);
    assert.deepEqual(filteredFeed.json(), {
      ok: true,
      events: [
        {
          id: 4,
          at: "2026-03-13T12:01:00.000Z",
          level: "warn",
          kind: "comment",
          issueKey: "OPS-7",
          projectId: "ops",
          status: "delivery_failed",
          summary: "Could not deliver follow-up comment",
        },
      ],
    });

    const workflowFeed = await app.inject({
      method: "GET",
      url: "/api/feed?kind=workflow&stage=development&status=transition_chosen&workflow=default",
      headers: {
        authorization: "Bearer operator-token",
      },
    });
    assert.equal(workflowFeed.statusCode, 200);
    assert.deepEqual(workflowFeed.json(), {
      ok: true,
      events: [
        {
          id: 2,
          at: "2026-03-13T12:00:00.000Z",
          level: "info",
          kind: "workflow",
          issueKey: "USE-42",
          projectId: "usertold",
          stage: "development",
          workflowId: "default",
          nextStage: "review",
          status: "transition_chosen",
          summary: "Chose development -> review (50)",
        },
      ],
    });
    assert.deepEqual(feedQueries.at(-1), {
      limit: 50,
      issueKey: undefined,
      projectId: undefined,
      kind: "workflow",
      stage: "development",
      status: "transition_chosen",
      workflowId: "default",
    });

    const missingEvents = await app.inject({
      method: "GET",
      url: "/api/issues/USE-42/runs/999/events",
      headers: {
        authorization: "Bearer operator-token",
      },
    });
    assert.equal(missingEvents.statusCode, 404);
    assert.deepEqual(missingEvents.json(), { ok: false, reason: "run_not_found" });

    await app.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("public agent session status page validates token and exposes operator session URL helper", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-http-public-session-"));
  try {
    const baseConfig = createConfig(baseDir);
    const config: AppConfig = {
      ...baseConfig,
      server: {
        ...baseConfig.server,
        bind: "0.0.0.0",
        publicBaseUrl: "https://patchrelay.example.com",
      },
      operatorApi: {
        enabled: true,
        bearerToken: "operator-token",
      },
    };
    const signingSecret = deriveSessionStatusSigningSecret(config.linear.tokenEncryptionKey);
    const validToken = createSessionStatusToken({
      issueKey: "USE-42",
      secret: signingSecret,
      nowMs: Date.UTC(2026, 2, 17, 12, 0, 0),
      ttlSeconds: 3600,
    }).token;

    const app = await buildHttpServer(
      config,
      {
        acceptWebhook: async () => ({ status: 200, body: { ok: true } }),
        getReadiness: () => ({ ready: true, codexStarted: true, linearConnected: true }),
        getIssueOverview: async (issueKey: string) => (issueKey === "USE-42" ? { issue: { issueKey: "USE-42" } } : undefined),
        getPublicAgentSessionStatus: async ({ issueKey, token }: { issueKey: string; token: string }) => {
          if (token === "bad") {
            return { status: "invalid_token" };
          }
          if (issueKey === "USE-404") {
            return { status: "issue_not_found" };
          }
          return {
            status: "ok",
            issueKey,
            expiresAt: "2026-03-17T13:00:00.000Z",
            sessionStatus: {
              issue: {
                issueKey,
                title: "Implement API endpoint",
                issueUrl: "https://linear.app/example/issue/USE-42",
                factoryState: "awaiting_queue",
                prNumber: 42,
                prReviewState: "approved",
              },
              activeRun: { runType: "implementation", status: "running" },
              latestRun: { runType: "review_fix", status: "completed" },
              liveThread: { threadId: "thread-1", threadStatus: "running" },
              activeRunId: 1,
              feedEvents: [
                {
                  id: 1,
                  at: "2026-03-17T12:00:00.000Z",
                  level: "info",
                  kind: "stage",
                  stage: "implementation",
                  status: "starting",
                  summary: "Starting implementation run",
                },
                {
                  id: 2,
                  at: "2026-03-17T12:05:00.000Z",
                  level: "info",
                  kind: "github",
                  stage: "pr_open",
                  status: "pr_opened",
                  summary: "GitHub: pr_opened",
                },
                {
                  id: 3,
                  at: "2026-03-17T12:09:00.000Z",
                  level: "info",
                  kind: "github",
                  stage: "awaiting_queue",
                  status: "review_approved",
                  summary: "GitHub: review_approved",
                },
              ],
              runs: [{
                run: { id: 1, runType: "implementation", status: "running", startedAt: "2026-03-17T12:00:00.000Z" },
                report: {
                  assistantMessages: ["Opened the PR and waiting for queue hand-off."],
                  commands: [],
                  fileChanges: [],
                },
              }],
              generatedAt: "2026-03-17T12:10:00.000Z",
            },
          };
        },
        createPublicAgentSessionStatusLink: (issueKey: string) => ({
          issueKey,
          expiresAt: "2026-03-17T13:00:00.000Z",
          url: `https://patchrelay.example.com/agent/session/${issueKey}?token=${validToken}`,
        }),
      } as never,
      pino({ enabled: false }),
    );

    const missingToken = await app.inject({
      method: "GET",
      url: "/agent/session/USE-42",
    });
    assert.equal(missingToken.statusCode, 401);
    assert.match(missingToken.body, /Missing access token/);

    const invalidToken = await app.inject({
      method: "GET",
      url: "/agent/session/USE-42?token=bad",
    });
    assert.equal(invalidToken.statusCode, 401);
    assert.match(invalidToken.body, /invalid or expired/);

    const notFound = await app.inject({
      method: "GET",
      url: `/agent/session/USE-404?token=${encodeURIComponent(validToken)}`,
    });
    assert.equal(notFound.statusCode, 404);
    assert.match(notFound.body, /not available/);

    const page = await app.inject({
      method: "GET",
      url: `/agent/session/USE-42?token=${encodeURIComponent(validToken)}`,
    });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Implement API endpoint/);
    assert.match(page.body, /State Path/);
    assert.match(page.body, /Queue Observation/);
    assert.match(page.body, /awaiting_queue/);
    assert.match(page.body, /Recent Stages/);
    assert.match(page.body, /thread-1/);

    const unauthorizedHelper = await app.inject({
      method: "GET",
      url: "/api/issues/USE-42/session-url",
    });
    assert.equal(unauthorizedHelper.statusCode, 401);

    const helper = await app.inject({
      method: "GET",
      url: "/api/issues/USE-42/session-url?ttlSeconds=1200",
      headers: {
        authorization: "Bearer operator-token",
      },
    });
    assert.equal(helper.statusCode, 200);
    assert.equal(helper.json().ok, true);
    assert.equal(helper.json().issueKey, "USE-42");
    assert.match(helper.json().url, /agent\/session\/USE-42\?token=/);

    await app.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("issue routes are available on loopback without explicit operator API", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-http-loopback-"));

  try {
    const config = createConfig(baseDir);
    const app = await buildHttpServer(
      config,
      {
        acceptWebhook: async () => ({ status: 200, body: { ok: true } }),
        getReadiness: () => ({ ready: true, codexStarted: true, linearConnected: true }),
        getIssueOverview: async () => undefined,
      } as never,
      pino({ enabled: false }),
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/issues/USE-42",
    });
    // Route exists (management routes on loopback) but issue not found
    assert.equal(response.statusCode, 404);

    await app.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("loopback OAuth setup routes stay available for local setup", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-http-oauth-"));

  try {
    const config = {
      ...createConfig(baseDir),
      linear: {
        ...createConfig(baseDir).linear,
        oauth: {
          clientId: "client-id",
          clientSecret: "client-secret",
          redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
          scopes: ["read", "write"],
          actor: "app" as const,
        },
        tokenEncryptionKey: "secret",
      },
      operatorApi: {
        enabled: true,
        bearerToken: "operator-token",
      },
    };

    const app = await buildHttpServer(
      config,
      {
        acceptWebhook: async () => ({ status: 200, body: { ok: true } }),
        getReadiness: () => ({ ready: true, codexStarted: true, linearConnected: true }),
        listLinearInstallations: () => [
          {
            installation: { id: 1, workspaceName: "Workspace One" },
            linkedProjects: ["usertold"],
          },
        ],
        createLinearOAuthStart: () => ({
          state: "state-1",
          authorizeUrl: "https://linear.app/oauth/authorize?state=state-1",
          redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
        }),
        completeLinearOAuth: async () => ({ id: 1, workspaceName: "Workspace One" }),
      } as never,
      pino({ enabled: false }),
    );

    const oauthApi = await app.inject({
      method: "GET",
      url: "/api/oauth/linear/start",
      headers: {
        authorization: "Bearer operator-token",
      },
    });
    assert.equal(oauthApi.statusCode, 200);
    assert.equal(oauthApi.json().authorizeUrl, "https://linear.app/oauth/authorize?state=state-1");

    const callback = await app.inject({
      method: "GET",
      url: "/oauth/linear/callback?code=abc&state=state-1",
    });
    assert.equal(callback.statusCode, 200);
    assert.match(callback.body, /Connected Linear installation/);

    await app.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("http OAuth and installation routes support setup flows", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-http-oauth-"));

  try {
    const baseConfig = createConfig(baseDir);
    const config: AppConfig = {
      ...baseConfig,
      operatorApi: {
        enabled: true,
        bearerToken: "operator-token",
      },
      linear: {
        ...baseConfig.linear,
        tokenEncryptionKey: "encryption-key",
        oauth: {
          clientId: "client-id",
          clientSecret: "client-secret",
          redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
          scopes: ["read", "write"],
          actor: "user",
        },
      },
    };

    const app = await buildHttpServer(
      config,
      {
        acceptWebhook: async () => ({ status: 200, body: { ok: true } }),
        getReadiness: () => ({ ready: true, codexStarted: true, linearConnected: true }),
        listLinearInstallations: () => [
          {
            installation: { id: 7, workspaceName: "Acme" },
            linkedProjects: ["usertold"],
          },
        ],
        createLinearOAuthStart: ({ projectId }: { projectId?: string }) => ({
          state: "state-1",
          authorizeUrl: `https://linear.app/oauth/authorize?state=state-1&projectId=${projectId ?? ""}`,
          redirectUri: config.linear.oauth!.redirectUri,
        }),
        completeLinearOAuth: async () => ({ id: 8, workspaceName: "Beta" }),
      } as never,
      pino({ enabled: false }),
    );

    const start = await app.inject({
      method: "GET",
      url: "/api/oauth/linear/start?projectId=usertold",
      headers: {
        authorization: "Bearer operator-token",
      },
    });
    assert.equal(start.statusCode, 200);
    assert.equal(start.json().state, "state-1");

    const list = await app.inject({
      method: "GET",
      url: "/api/installations",
      headers: {
        authorization: "Bearer operator-token",
      },
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().installations[0].installation.workspaceName, "Acme");

    const callback = await app.inject({
      method: "GET",
      url: "/oauth/linear/callback?code=code-1&state=state-1",
    });
    assert.equal(callback.statusCode, 200);
    assert.match(callback.body, /Connected Linear installation #8/);

    await app.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("http OAuth start returns reused installation details when a project can link locally", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-http-oauth-reuse-"));

  try {
    const baseConfig = createConfig(baseDir);
    const config: AppConfig = {
      ...baseConfig,
      operatorApi: {
        enabled: true,
        bearerToken: "operator-token",
      },
    };

    const app = await buildHttpServer(
      config,
      {
        acceptWebhook: async () => ({ status: 200, body: { ok: true } }),
        getReadiness: () => ({ ready: true, codexStarted: true, linearConnected: true }),
        listLinearInstallations: () => [],
        createLinearOAuthStart: ({ projectId }: { projectId?: string }) => ({
          completed: true,
          reusedExisting: true,
          projectId: projectId ?? "usertold",
          installation: { id: 7, workspaceName: "Acme" },
        }),
      } as never,
      pino({ enabled: false }),
    );

    const start = await app.inject({
      method: "GET",
      url: "/api/oauth/linear/start?projectId=usertold",
      headers: {
        authorization: "Bearer operator-token",
      },
    });
    assert.equal(start.statusCode, 200);
    assert.deepEqual(start.json(), {
      ok: true,
      completed: true,
      reusedExisting: true,
      projectId: "usertold",
      installation: { id: 7, workspaceName: "Acme" },
    });

    await app.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("localhost operator OAuth APIs stay usable without a bearer token when operator API is enabled", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-http-local-operator-"));

  try {
    const baseConfig = createConfig(baseDir);
    const config: AppConfig = {
      ...baseConfig,
      operatorApi: {
        enabled: true,
      },
      linear: {
        ...baseConfig.linear,
        tokenEncryptionKey: "encryption-key",
        oauth: {
          clientId: "client-id",
          clientSecret: "client-secret",
          redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
          scopes: ["read", "write"],
          actor: "user",
        },
      },
    };

    const app = await buildHttpServer(
      config,
      {
        acceptWebhook: async () => ({ status: 200, body: { ok: true } }),
        getReadiness: () => ({ ready: true, codexStarted: true, linearConnected: true }),
        listLinearInstallations: () => [
          {
            installation: { id: 7, workspaceName: "Acme" },
            linkedProjects: [],
          },
        ],
        createLinearOAuthStart: ({ projectId }: { projectId?: string }) => ({
          state: "state-local",
          authorizeUrl: `https://linear.app/oauth/authorize?state=state-local&projectId=${projectId ?? ""}`,
          redirectUri: config.linear.oauth!.redirectUri,
        }),
      } as never,
      pino({ enabled: false }),
    );

    const start = await app.inject({
      method: "GET",
      url: "/api/oauth/linear/start?projectId=usertold",
    });
    assert.equal(start.statusCode, 200);
    assert.equal(start.json().state, "state-local");

    const list = await app.inject({
      method: "GET",
      url: "/api/installations",
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().installations[0].installation.workspaceName, "Acme");

    await app.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("remote operator OAuth APIs require bearer auth when operator API is enabled", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-http-remote-operator-"));

  try {
    const baseConfig = createConfig(baseDir);
    const config: AppConfig = {
      ...baseConfig,
      server: {
        ...baseConfig.server,
        bind: "0.0.0.0",
      },
      operatorApi: {
        enabled: true,
        bearerToken: "operator-token",
      },
      linear: {
        ...baseConfig.linear,
        tokenEncryptionKey: "encryption-key",
        oauth: {
          clientId: "client-id",
          clientSecret: "client-secret",
          redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
          scopes: ["read", "write"],
          actor: "user",
        },
      },
    };

    const app = await buildHttpServer(
      config,
      {
        acceptWebhook: async () => ({ status: 200, body: { ok: true } }),
        getReadiness: () => ({ ready: true, codexStarted: true, linearConnected: true }),
        listLinearInstallations: () => [],
        createLinearOAuthStart: () => ({
          state: "state-remote",
          authorizeUrl: "https://linear.app/oauth/authorize?state=state-remote",
          redirectUri: config.linear.oauth!.redirectUri,
        }),
      } as never,
      pino({ enabled: false }),
    );

    const unauthenticatedStart = await app.inject({
      method: "GET",
      url: "/api/oauth/linear/start?projectId=usertold",
    });
    assert.equal(unauthenticatedStart.statusCode, 401);
    assert.deepEqual(unauthenticatedStart.json(), { ok: false, reason: "operator_auth_required" });

    const authenticatedStart = await app.inject({
      method: "GET",
      url: "/api/oauth/linear/start?projectId=usertold",
      headers: {
        authorization: "Bearer operator-token",
      },
    });
    assert.equal(authenticatedStart.statusCode, 200);
    assert.equal(authenticatedStart.json().state, "state-remote");

    const unauthenticatedList = await app.inject({
      method: "GET",
      url: "/api/installations",
    });
    assert.equal(unauthenticatedList.statusCode, 401);
    assert.deepEqual(unauthenticatedList.json(), { ok: false, reason: "operator_auth_required" });

    await app.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("http exposes OAuth state polling for CLI-driven OAuth completion", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-http-oauth-state-"));

  try {
    const baseConfig = createConfig(baseDir);
    const config: AppConfig = {
      ...baseConfig,
      linear: {
        ...baseConfig.linear,
        tokenEncryptionKey: "encryption-key",
        oauth: {
          clientId: "client-id",
          clientSecret: "client-secret",
          redirectUri: "http://127.0.0.1:8787/oauth/linear/callback",
          scopes: ["read", "write"],
          actor: "user",
        },
      },
    };

    const app = await buildHttpServer(
      config,
      {
        acceptWebhook: async () => ({ status: 200, body: { ok: true } }),
        getReadiness: () => ({ ready: true, codexStarted: true, linearConnected: true }),
        listLinearInstallations: () => [],
        createLinearOAuthStart: () => ({
          state: "state-1",
          authorizeUrl: "https://linear.app/oauth/authorize?state=state-1",
          redirectUri: config.linear.oauth!.redirectUri,
        }),
        getLinearOAuthStateStatus: (state: string) =>
          state === "state-1"
            ? {
                state,
                status: "completed",
                projectId: "usertold",
                installation: { id: 9, workspaceName: "Workspace Nine" },
              }
            : undefined,
      } as never,
      pino({ enabled: false }),
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/oauth/linear/state/state-1",
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      ok: true,
      state: "state-1",
      status: "completed",
      projectId: "usertold",
      installation: { id: 9, workspaceName: "Workspace Nine" },
    });

    const missing = await app.inject({
      method: "GET",
      url: "/api/oauth/linear/state/missing",
    });
    assert.equal(missing.statusCode, 404);
    assert.deepEqual(missing.json(), { ok: false, reason: "oauth_state_not_found" });

    await app.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
