import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { buildHttpServer } from "../src/http.js";
import type { AppConfig } from "../src/types.js";

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
        workflowFiles: {
          development: path.join(baseDir, "DEVELOPMENT_WORKFLOW.md"),
          review: path.join(baseDir, "REVIEW_WORKFLOW.md"),
          deploy: path.join(baseDir, "DEPLOY_WORKFLOW.md"),
          cleanup: path.join(baseDir, "CLEANUP_WORKFLOW.md"),
        },
        workflowStatuses: {
          development: "Start",
          review: "Review",
          deploy: "Deploy",
          developmentActive: "Implementing",
          reviewActive: "Reviewing",
          deployActive: "Deploying",
          cleanup: "Cleanup",
          humanNeeded: "Human Needed",
          done: "Done",
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

test("health endpoint includes build version metadata from the built artifact", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-http-"));
  const originalCwd = process.cwd();

  try {
    mkdirSync(path.join(baseDir, "dist"), { recursive: true });
    writeFileSync(
      path.join(baseDir, "dist/build-info.json"),
      `${JSON.stringify(
        {
          service: "patchrelay",
          version: "0.1.0-test",
          commit: "abc123def456",
          builtAt: "2026-03-09T08:55:00.000Z",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    process.chdir(baseDir);

    const config = createConfig(baseDir);
    const app = await buildHttpServer(
      config,
      {
        acceptWebhook: async () => ({ status: 200, body: { ok: true } }),
        getReadiness: () => ({ ready: true, codexStarted: true }),
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
      service: "patchrelay",
      version: "0.1.0-test",
      commit: "abc123def456",
      builtAt: "2026-03-09T08:55:00.000Z",
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
      service: "patchrelay",
      version: "0.1.0-test",
      commit: "abc123def456",
    });

    const home = await app.inject({
      method: "GET",
      url: "/",
    });
    assert.match(home.body, /codex app-server/);
    assert.doesNotMatch(home.body, /api\/issues\/:issueKey\/report/);

    await app.close();
  } finally {
    process.chdir(originalCwd);
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
    const app = await buildHttpServer(
      config,
      {
        acceptWebhook: async ({ webhookId }) => ({
          status: 202,
          body: { ok: true, webhookId },
        }),
        getReadiness: () => ({ ready: false, codexStarted: false, startupError: "codex offline" }),
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
        getActiveStageStatus: async (issueKey: string) =>
          issueKey === "USE-42"
            ? {
                issue: { issueKey: "USE-42" },
                stageRun: { id: 8, stage: "review", status: "running" },
                liveThread: { threadId: "thread-1", threadStatus: "running" },
              }
            : undefined,
        getStageEvents: async (issueKey: string, stageRunId: number) =>
          issueKey === "USE-42" && stageRunId === 8
            ? {
                issue: { issueKey: "USE-42" },
                stageRun: { id: 8, stage: "review", status: "running" },
                events: [{ id: 1, method: "turn/started" }],
              }
            : undefined,
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
      stageRun: { id: 8, stage: "review", status: "running" },
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
    assert.deepEqual(missingLive.json(), { ok: false, reason: "active_stage_not_found" });

    const events = await app.inject({
      method: "GET",
      url: "/api/issues/USE-42/stages/8/events",
      headers: {
        authorization: "Bearer operator-token",
      },
    });
    assert.equal(events.statusCode, 200);
    assert.deepEqual(events.json(), {
      ok: true,
      issue: { issueKey: "USE-42" },
      stageRun: { id: 8, stage: "review", status: "running" },
      events: [{ id: 1, method: "turn/started" }],
    });

    const missingEvents = await app.inject({
      method: "GET",
      url: "/api/issues/USE-42/stages/999/events",
      headers: {
        authorization: "Bearer operator-token",
      },
    });
    assert.equal(missingEvents.statusCode, 404);
    assert.deepEqual(missingEvents.json(), { ok: false, reason: "stage_run_not_found" });

    await app.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("internal operator routes stay disabled by default", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-http-disabled-"));

  try {
    const config = createConfig(baseDir);
    const app = await buildHttpServer(
      config,
      {
        acceptWebhook: async () => ({ status: 200, body: { ok: true } }),
        getReadiness: () => ({ ready: true, codexStarted: true }),
      } as never,
      pino({ enabled: false }),
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/issues/USE-42",
    });
    assert.equal(response.statusCode, 404);

    await app.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("http exposes OAuth setup and callback routes when Linear OAuth is configured", async () => {
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
        getReadiness: () => ({ ready: true, codexStarted: true }),
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

    const setup = await app.inject({
      method: "GET",
      url: "/setup",
    });
    assert.equal(setup.statusCode, 200);
    assert.match(setup.body, /Workspace One/);
    assert.match(setup.body, /Connect Linear/);

    const oauthStart = await app.inject({
      method: "GET",
      url: "/auth/linear/start?projectId=usertold",
    });
    assert.equal(oauthStart.statusCode, 302);
    assert.equal(oauthStart.headers.location, "https://linear.app/oauth/authorize?state=state-1");

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
        getReadiness: () => ({ ready: true, codexStarted: true }),
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
        linkProjectInstallation: (projectId: string, installationId: number) => ({ projectId, installationId }),
        unlinkProjectInstallation: () => undefined,
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

    const link = await app.inject({
      method: "POST",
      url: "/api/projects/usertold/installation",
      headers: {
        authorization: "Bearer operator-token",
      },
      payload: {
        installationId: 7,
      },
    });
    assert.equal(link.statusCode, 200);
    assert.deepEqual(link.json().link, { projectId: "usertold", installationId: 7 });

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
        getReadiness: () => ({ ready: true, codexStarted: true }),
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
        linkProjectInstallation: (projectId: string, installationId: number) => ({ projectId, installationId }),
        unlinkProjectInstallation: () => undefined,
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

    const link = await app.inject({
      method: "POST",
      url: "/api/projects/usertold/installation",
      payload: {
        installationId: 7,
      },
    });
    assert.equal(link.statusCode, 200);
    assert.deepEqual(link.json().link, { projectId: "usertold", installationId: 7 });

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
        getReadiness: () => ({ ready: true, codexStarted: true }),
        listLinearInstallations: () => [],
        createLinearOAuthStart: () => ({
          state: "state-remote",
          authorizeUrl: "https://linear.app/oauth/authorize?state=state-remote",
          redirectUri: config.linear.oauth!.redirectUri,
        }),
        linkProjectInstallation: (projectId: string, installationId: number) => ({ projectId, installationId }),
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

    const unauthenticatedLink = await app.inject({
      method: "POST",
      url: "/api/projects/usertold/installation",
      payload: {
        installationId: 7,
      },
    });
    assert.equal(unauthenticatedLink.statusCode, 401);
    assert.deepEqual(unauthenticatedLink.json(), { ok: false, reason: "operator_auth_required" });

    const authenticatedLink = await app.inject({
      method: "POST",
      url: "/api/projects/usertold/installation",
      headers: {
        authorization: "Bearer operator-token",
      },
      payload: {
        installationId: 7,
      },
    });
    assert.equal(authenticatedLink.statusCode, 200);
    assert.deepEqual(authenticatedLink.json().link, { projectId: "usertold", installationId: 7 });

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
        getReadiness: () => ({ ready: true, codexStarted: true }),
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
