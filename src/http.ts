import type { FastifyRequest } from "fastify";
import fastify from "fastify";
import rawBody from "fastify-raw-body";
import type { Logger } from "pino";
import { getBuildInfo } from "./build-info.ts";
import { matchesOperatorFeedEvent, type OperatorFeedEvent, type OperatorFeedQuery } from "./operator-feed.ts";
import { buildStateHistory, type StateHistoryNode } from "./cli/watch/history-builder.ts";
import { buildPatchRelayQueueObservations, buildPatchRelayStateGraph, type ObservationLine, type VisualizationNode } from "./cli/watch/state-visualization.ts";
import type { PatchRelayService } from "./service.ts";
import type { AppConfig } from "./types.ts";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string | Buffer;
  }
}

export async function buildHttpServer(config: AppConfig, service: PatchRelayService, logger: Logger) {
  const buildInfo = getBuildInfo();
  const loopbackBind = isLoopbackBind(config.server.bind);
  const managementRoutesEnabled = loopbackBind || config.operatorApi.enabled;
  const app = fastify({
    loggerInstance: logger,
    bodyLimit: config.ingress.maxBodyBytes,
    disableRequestLogging: true,
  });

  await app.register(rawBody, {
    field: "rawBody",
    global: false,
    encoding: false,
    runFirst: true,
  });

  app.get("/", async (_request, reply) => {
    return reply
      .type("text/html; charset=utf-8")
      .send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>PatchRelay</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f6f3ee;
        --panel: rgba(255, 255, 255, 0.76);
        --ink: #1f1d1a;
        --muted: #6c665d;
        --accent: #1e6a52;
        --accent-2: #d2a24c;
        --border: rgba(31, 29, 26, 0.12);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: Georgia, "Times New Roman", serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(210, 162, 76, 0.24), transparent 34%),
          radial-gradient(circle at bottom right, rgba(30, 106, 82, 0.16), transparent 28%),
          linear-gradient(135deg, #efe7db 0%, var(--bg) 48%, #f7f5f1 100%);
        display: grid;
        place-items: center;
        padding: 24px;
      }

      main {
        width: min(760px, 100%);
        background: var(--panel);
        border: 1px solid var(--border);
        border-radius: 24px;
        padding: 40px 32px;
        box-shadow: 0 30px 80px rgba(49, 42, 30, 0.12);
        backdrop-filter: blur(14px);
      }

      .eyebrow {
        margin: 0 0 12px;
        font-size: 12px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--accent);
      }

      h1 {
        margin: 0;
        font-size: clamp(40px, 8vw, 72px);
        line-height: 0.95;
        font-weight: 700;
      }

      p {
        margin: 18px 0 0;
        font-size: 18px;
        line-height: 1.6;
        color: var(--muted);
        max-width: 42rem;
      }

      .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-top: 28px;
      }

      .chip {
        display: inline-flex;
        align-items: center;
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 10px 14px;
        font-size: 14px;
        color: var(--ink);
        background: rgba(255, 255, 255, 0.7);
      }

      code {
        font-family: "SFMono-Regular", "Cascadia Code", "Fira Code", monospace;
        font-size: 0.95em;
      }

      a {
        color: var(--accent);
        text-decoration: none;
      }

      a:hover {
        text-decoration: underline;
      }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">PatchRelay</p>
      <h1>Webhook in, worktree out.</h1>
      <p>
        PatchRelay listens for signed Linear webhooks, prepares an issue-specific worktree, and orchestrates
        staged Codex runs through <code>codex app-server</code> with durable thread history and read-only reports.
      </p>
      <div class="meta">
        <span class="chip">Health: <a href="${config.server.healthPath}">${config.server.healthPath}</a></span>
        <span class="chip">Webhook: <code>${config.ingress.linearWebhookPath}</code></span>
        <span class="chip">Version: <code>${buildInfo.version}</code></span>
        <span class="chip">Commit: <code>${buildInfo.commit}</code></span>
        <span class="chip">Logs: <code>${config.logging.filePath}</code></span>
      </div>
    </main>
  </body>
</html>`);
  });

  app.get(config.server.healthPath, async () => ({
    ok: true,
    service: buildInfo.service,
    version: buildInfo.version,
    commit: buildInfo.commit,
    builtAt: buildInfo.builtAt,
  }));

  app.get(config.server.readinessPath, async (_request, reply) => {
    const readiness = service.getReadiness();
    return reply.code(readiness.ready ? 200 : 503).send({
      ok: readiness.ready,
      ...readiness,
      service: buildInfo.service,
      version: buildInfo.version,
      commit: buildInfo.commit,
    });
  });

  app.post(
    config.ingress.linearWebhookPath,
    {
      config: {
        rawBody: true,
      },
    },
    async (request, reply) => {
      const rawBody = typeof request.rawBody === "string" ? Buffer.from(request.rawBody) : request.rawBody;
      if (!rawBody) {
        return reply.code(400).send({ ok: false, reason: "missing_raw_body" });
      }

      const webhookId = getHeader(request, "linear-delivery");
      if (!webhookId) {
        return reply.code(400).send({ ok: false, reason: "missing_delivery_header" });
      }

      const result = await service.acceptWebhook({
        webhookId,
        headers: request.headers,
        rawBody,
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.post(
    config.ingress.githubWebhookPath,
    {
      config: {
        rawBody: true,
      },
    },
    async (request, reply) => {
      const rawBody = typeof request.rawBody === "string" ? Buffer.from(request.rawBody) : request.rawBody;
      if (!rawBody) {
        return reply.code(400).send({ ok: false, reason: "missing_raw_body" });
      }

      const deliveryId = getHeader(request, "x-github-delivery");
      if (!deliveryId) {
        return reply.code(400).send({ ok: false, reason: "missing_delivery_header" });
      }

      const eventType = getHeader(request, "x-github-event");
      if (!eventType) {
        return reply.code(400).send({ ok: false, reason: "missing_event_type" });
      }

      const signature = getHeader(request, "x-hub-signature-256") ?? "";

      const result = await service.acceptGitHubWebhook({
        deliveryId,
        eventType,
        signature,
        rawBody,
      });
      return reply.code(result.status).send(result.body);
    },
  );

  app.get("/agent/session/:issueKey", async (request, reply) => {
    const issueKey = (request.params as { issueKey: string }).issueKey;
    const token = getQueryParam(request, "token");
    if (!token) {
      return reply
        .code(401)
        .type("text/html; charset=utf-8")
        .send(renderAgentSessionStatusErrorPage("Missing access token."));
    }

    const status = await service.getPublicAgentSessionStatus({ issueKey, token });
    if (status.status === "invalid_token") {
      return reply
        .code(401)
        .type("text/html; charset=utf-8")
        .send(renderAgentSessionStatusErrorPage("The access token is invalid or expired."));
    }
    if (status.status === "issue_not_found") {
      return reply
        .code(404)
        .type("text/html; charset=utf-8")
        .send(renderAgentSessionStatusErrorPage("Issue status is not available."));
    }

    return reply
      .type("text/html; charset=utf-8")
      .send(
        renderAgentSessionStatusPage({
          issueKey,
          expiresAt: status.expiresAt,
          sessionStatus: status.sessionStatus as Parameters<typeof renderAgentSessionStatusPage>[0]["sessionStatus"],
        }),
      );
  });

  if (config.operatorApi.enabled) {
    app.addHook("onRequest", async (request, reply) => {
      if (!request.url.startsWith("/api/")) {
        return;
      }
      if (!isAuthorizedOperatorRequest(request, config)) {
        return reply.code(401).send({ ok: false, reason: "operator_auth_required" });
      }
    });
  }

  if (managementRoutesEnabled) {
    app.get("/api/issues/:issueKey", async (request, reply) => {
      const issueKey = (request.params as { issueKey: string }).issueKey;
      const result = await service.getIssueOverview(issueKey);
      if (!result) {
        return reply.code(404).send({ ok: false, reason: "issue_not_found" });
      }
      return reply.send({ ok: true, ...result });
    });

    app.get("/api/issues/:issueKey/report", async (request, reply) => {
      const issueKey = (request.params as { issueKey: string }).issueKey;
      const result = await service.getIssueReport(issueKey);
      if (!result) {
        return reply.code(404).send({ ok: false, reason: "issue_not_found" });
      }
      return reply.send({ ok: true, ...result });
    });

    app.get("/api/issues/:issueKey/timeline", async (request, reply) => {
      const issueKey = (request.params as { issueKey: string }).issueKey;
      const result = await service.getIssueTimeline(issueKey);
      if (!result) {
        return reply.code(404).send({ ok: false, reason: "issue_not_found" });
      }
      return reply.send({ ok: true, ...result });
    });

    app.get("/api/issues/:issueKey/live", async (request, reply) => {
      const issueKey = (request.params as { issueKey: string }).issueKey;
      const result = await service.getActiveRunStatus(issueKey);
      if (!result) {
        return reply.code(404).send({ ok: false, reason: "active_run_not_found" });
      }
      return reply.send({ ok: true, ...result });
    });

    app.get("/api/issues/:issueKey/runs/:runId/events", async (request, reply) => {
      const { issueKey, runId } = request.params as { issueKey: string; runId: string };
      const result = await service.getRunEvents(issueKey, Number(runId));
      if (!result) {
        return reply.code(404).send({ ok: false, reason: "run_not_found" });
      }
      return reply.send({ ok: true, ...result });
    });

    app.get("/api/issues/:issueKey/session-url", async (request, reply) => {
      const issueKey = (request.params as { issueKey: string }).issueKey;
      const ttlSeconds = getPositiveIntegerQueryParam(request, "ttlSeconds");
      const issue = await service.getIssueOverview(issueKey);
      if (!issue) {
        return reply.code(404).send({ ok: false, reason: "issue_not_found" });
      }

      const link = service.createPublicAgentSessionStatusLink(issueKey, ttlSeconds ? { ttlSeconds } : undefined);
      if (!link) {
        return reply.code(503).send({ ok: false, reason: "public_base_url_not_configured" });
      }

      return reply.send({ ok: true, ...link });
    });

    app.post("/api/issues/:issueKey/retry", async (request, reply) => {
      const issueKey = (request.params as { issueKey: string }).issueKey;
      const result = service.retryIssue(issueKey);
      if (!result) {
        return reply.code(404).send({ ok: false, reason: "issue_not_found" });
      }
      if ("error" in result) {
        return reply.code(409).send({ ok: false, reason: result.error });
      }
      return reply.send({ ok: true, ...result });
    });

    app.post("/api/issues/:issueKey/prompt", async (request, reply) => {
      const issueKey = (request.params as { issueKey: string }).issueKey;
      const body = request.body as { text?: string } | undefined;
      const text = body?.text;
      if (!text || typeof text !== "string") {
        return reply.code(400).send({ ok: false, reason: "missing text field" });
      }
      const result = await service.promptIssue(issueKey, text);
      if (!result) {
        return reply.code(404).send({ ok: false, reason: "issue_not_found" });
      }
      if ("error" in result) {
        return reply.code(409).send({ ok: false, reason: result.error });
      }
      return reply.send({ ok: true, ...result });
    });

    app.post("/api/issues/:issueKey/stop", async (request, reply) => {
      const issueKey = (request.params as { issueKey: string }).issueKey;
      const result = await service.stopIssue(issueKey);
      if (!result) {
        return reply.code(404).send({ ok: false, reason: "issue_not_found" });
      }
      if ("error" in result) {
        return reply.code(409).send({ ok: false, reason: result.error });
      }
      return reply.send({ ok: true, ...result });
    });

    app.get("/api/feed", async (request, reply) => {
      const feedQuery: OperatorFeedQuery = {
        limit: getPositiveIntegerQueryParam(request, "limit") ?? 50,
        ...readFeedQueryFilters(request),
      };
      if (getQueryParam(request, "follow") !== "1") {
        return reply.send({ ok: true, events: service.listOperatorFeed(feedQuery) });
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });

      const writeEvent = (event: unknown) => {
        reply.raw.write(`event: feed\n`);
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      for (const event of service.listOperatorFeed(feedQuery)) {
        writeEvent(event);
      }

      const cleanup = () => {
        clearInterval(keepAlive);
        unsubscribe();
        if (!reply.raw.destroyed) reply.raw.end();
      };

      const unsubscribe = service.subscribeOperatorFeed((event) => {
        if (!matchesOperatorFeedEvent(event, feedQuery)) {
          return;
        }
        writeEvent(event);
      });
      const keepAlive = setInterval(() => {
        reply.raw.write(": keepalive\n\n");
      }, 15000);

      reply.raw.on("error", cleanup);
      request.raw.on("close", cleanup);
    });

    app.get("/api/watch", async (request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });

      const writeSse = (eventType: string, data: unknown) => {
        reply.raw.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      // Send initial issue snapshot
      writeSse("issues", service.listTrackedIssues());

      // Stream operator feed events
      const issueFilter = getQueryParam(request, "issue");
      const unsubscribeFeed = service.subscribeOperatorFeed((event) => {
        if (issueFilter && event.issueKey !== issueFilter) {
          return;
        }
        writeSse("feed", event);
      });

      // When filtered to a specific issue, also stream codex notifications
      const unsubscribeCodex = issueFilter
        ? service.subscribeCodexNotifications((event) => {
            if (event.issueKey !== issueFilter) {
              return;
            }
            writeSse("codex", { method: event.method, params: event.params });
          })
        : undefined;

      const cleanup = () => {
        clearInterval(keepAlive);
        unsubscribeFeed();
        unsubscribeCodex?.();
        if (!reply.raw.destroyed) reply.raw.end();
      };

      const keepAlive = setInterval(() => {
        reply.raw.write(": keepalive\n\n");
      }, 15000);

      reply.raw.on("error", cleanup);
      request.raw.on("close", cleanup);
    });

    app.get("/api/installations", async (_request, reply) => {
      return reply.send({ ok: true, installations: service.listLinearInstallations() });
    });

    app.get("/api/oauth/linear/start", async (request, reply) => {
      const projectId = getQueryParam(request, "projectId");
      const result = await service.createLinearOAuthStart(projectId ? { projectId } : undefined);
      return reply.send({ ok: true, ...result });
    });

    app.get("/api/oauth/linear/state/:state", async (request, reply) => {
      const { state } = request.params as { state: string };
      const result = service.getLinearOAuthStateStatus(state);
      if (!result) {
        return reply.code(404).send({ ok: false, reason: "oauth_state_not_found" });
      }
      return reply.send({ ok: true, ...result });
    });
  }

  app.get("/oauth/linear/callback", async (request, reply) => {
    const code = getQueryParam(request, "code");
    const state = getQueryParam(request, "state");
    if (!code || !state) {
      return reply.code(400).type("text/html; charset=utf-8").send(renderOAuthResult("Missing code or state."));
    }

    try {
      const installation = await service.completeLinearOAuth({ code, state });
      return reply
        .type("text/html; charset=utf-8")
        .send(renderOAuthResult(`Connected Linear installation #${installation.id}. You can close this window.`));
    } catch (error) {
      return reply
        .code(400)
        .type("text/html; charset=utf-8")
        .send(renderOAuthResult(error instanceof Error ? error.message : String(error)));
    }
  });

  app.addHook("onResponse", async (request, reply) => {
    if (reply.statusCode < 500) {
      return;
    }

    request.log.error(
      {
        reqId: request.id,
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTime: reply.elapsedTime,
      },
      "request failed",
    );
  });

  return app;
}

function getHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function isAuthorizedOperatorRequest(request: FastifyRequest, config: AppConfig): boolean {
  if (isLoopbackBind(config.server.bind)) {
    return true;
  }

  if (!config.operatorApi.bearerToken) {
    return true;
  }

  const auth = getHeader(request, "authorization");
  return auth === `Bearer ${config.operatorApi.bearerToken}`;
}

function isLoopbackBind(bind: string): boolean {
  return bind === "127.0.0.1" || bind === "::1" || bind === "localhost";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function getQueryParam(request: FastifyRequest, key: string): string | undefined {
  const value = (request.query as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : undefined;
}

function readFeedQueryFilters(request: FastifyRequest): Omit<OperatorFeedQuery, "limit" | "afterId"> {
  const issueKey = getQueryParam(request, "issue")?.trim() || undefined;
  const projectId = getQueryParam(request, "project")?.trim() || undefined;
  const kind = (getQueryParam(request, "kind")?.trim() || undefined) as OperatorFeedQuery["kind"];
  const stage = getQueryParam(request, "stage")?.trim() || undefined;
  const status = getQueryParam(request, "status")?.trim() || undefined;
  const workflowId = getQueryParam(request, "workflow")?.trim() || undefined;
  return {
    ...(issueKey ? { issueKey } : {}),
    ...(projectId ? { projectId } : {}),
    ...(kind ? { kind } : {}),
    ...(stage ? { stage } : {}),
    ...(status ? { status } : {}),
    ...(workflowId ? { workflowId } : {}),
  };
}

function getPositiveIntegerQueryParam(request: FastifyRequest, key: string): number | undefined {
  const value = getQueryParam(request, key);
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function renderOAuthResult(message: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>PatchRelay OAuth</title>
    <style>
      body { font-family: Georgia, "Times New Roman", serif; background: #f6f3ee; color: #1f1d1a; margin: 0; padding: 32px; }
      main { max-width: 640px; margin: 10vh auto; background: rgba(255,255,255,0.82); border: 1px solid rgba(31,29,26,0.12); border-radius: 20px; padding: 32px; }
      p { font-size: 18px; line-height: 1.6; }
    </style>
  </head>
  <body>
    <main>
      <h1>PatchRelay</h1>
      <p>${escapeHtml(message)}</p>
    </main>
  </body>
</html>`;
}

function renderAgentSessionStatusErrorPage(message: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>PatchRelay Agent Status</title>
    <style>
      body { font-family: Georgia, "Times New Roman", serif; background: #f7f4ef; color: #1f1d1a; margin: 0; padding: 32px; }
      main { max-width: 720px; margin: 10vh auto; background: rgba(255,255,255,0.86); border: 1px solid rgba(31,29,26,0.12); border-radius: 20px; padding: 32px; box-shadow: 0 28px 80px rgba(49,42,30,0.10); }
      p { font-size: 18px; line-height: 1.6; color: #4d483f; }
    </style>
  </head>
  <body>
    <main>
      <h1>PatchRelay Agent Session</h1>
      <p>${escapeHtml(message)}</p>
    </main>
  </body>
</html>`;
}

function renderAgentSessionStatusPage(params: {
  issueKey: string;
  expiresAt: string;
  sessionStatus: {
    issue: {
      issueKey?: string;
      title?: string;
      issueUrl?: string;
      currentLinearState?: string;
      factoryState?: string;
      prNumber?: number;
      prUrl?: string;
      prState?: string;
      prReviewState?: string;
      prCheckStatus?: string;
      ciRepairAttempts?: number;
      queueRepairAttempts?: number;
      queueProtocol?: {
        repoFullName?: string | null;
        baseBranch?: string | null;
        admissionLabel?: string | null;
        evictionCheckName?: string | null;
        lastFailureSource?: string | null;
        lastFailureCheckName?: string | null;
        lastFailureCheckUrl?: string | null;
        lastFailureAt?: string | null;
        lastQueueSignalAt?: string | null;
        lastIncidentId?: string | null;
        lastIncidentUrl?: string | null;
        lastIncidentFailureClass?: string | null;
        lastIncidentSummary?: string | null;
      } | undefined;
    };
    activeRun?: { runType?: string; status?: string } | undefined;
    latestRun?: { runType?: string; status?: string } | undefined;
    liveThread?: {
      threadId?: string;
      threadStatus?: string;
      latestTurnId?: string;
      latestTurnStatus?: string;
      latestAgentMessage?: string;
      latestPlan?: string;
      activeCommand?: string;
      commandCount?: number;
      fileChangeCount?: number;
      toolCallCount?: number;
    } | undefined;
    latestReportSummary?: {
      assistantMessageCount?: number;
      commandCount?: number;
      fileChangeCount?: number;
      toolCallCount?: number;
      latestAssistantMessage?: string | null;
    } | undefined;
    feedEvents?: Array<{
      id?: number;
      at: string;
      level?: string;
      kind?: string;
      summary?: string;
      detail?: string;
      issueKey?: string;
      projectId?: string;
      stage?: string;
      status?: string;
      workflowId?: string;
      nextStage?: string;
    }> | undefined;
    activeRunId?: number | null;
    runs: Array<{
      run?: { id?: number; runType?: string; status?: string; startedAt?: string; endedAt?: string } | undefined;
      report?: {
        assistantMessages?: string[];
        commands?: unknown[];
        fileChanges?: unknown[];
      } | undefined;
    }>;
    generatedAt: string;
  };
}): string {
  const issueTitle = params.sessionStatus.issue.title ?? params.sessionStatus.issue.issueKey ?? params.issueKey;
  const issueUrl = params.sessionStatus.issue.issueUrl;
  const prUrl = params.sessionStatus.issue.prUrl;
  const prLabel = params.sessionStatus.issue.prNumber ? `#${params.sessionStatus.issue.prNumber}` : undefined;
  const activeStage = formatStageChip(params.sessionStatus.activeRun);
  const latestStage = formatStageChip(params.sessionStatus.latestRun);
  const threadInfo = formatThread(params.sessionStatus.liveThread);
  const stagesRows = params.sessionStatus.runs.slice(-8).map((entry) => formatStageRow(entry.run)).join("");
  const latestAgentMessage = params.sessionStatus.liveThread?.latestAgentMessage ?? params.sessionStatus.latestReportSummary?.latestAssistantMessage ?? "No agent summary yet.";
  const latestPlan = params.sessionStatus.liveThread?.latestPlan ?? "No live plan available.";
  const activeCommand = params.sessionStatus.liveThread?.activeCommand ?? "idle";
  const commandCount = params.sessionStatus.liveThread?.commandCount ?? params.sessionStatus.latestReportSummary?.commandCount ?? 0;
  const fileChangeCount = params.sessionStatus.liveThread?.fileChangeCount ?? params.sessionStatus.latestReportSummary?.fileChangeCount ?? 0;
  const toolCallCount = params.sessionStatus.liveThread?.toolCallCount ?? params.sessionStatus.latestReportSummary?.toolCallCount ?? 0;
  const factoryState = params.sessionStatus.issue.factoryState ?? "unknown";
  const linearState = params.sessionStatus.issue.currentLinearState ?? "unknown";
  const prState = params.sessionStatus.issue.prState ?? "unknown";
  const reviewState = params.sessionStatus.issue.prReviewState ?? "unknown";
  const checkState = params.sessionStatus.issue.prCheckStatus ?? "unknown";
  const ciAttempts = params.sessionStatus.issue.ciRepairAttempts ?? 0;
  const queueAttempts = params.sessionStatus.issue.queueRepairAttempts ?? 0;
  const queueProtocol = params.sessionStatus.issue.queueProtocol;
  const history = buildPublicStateHistory({
    currentFactoryState: factoryState,
    activeRunId: params.sessionStatus.activeRunId ?? null,
    ...(params.sessionStatus.feedEvents ? { feedEvents: params.sessionStatus.feedEvents } : {}),
    runs: params.sessionStatus.runs,
  });
  const graph = buildPatchRelayStateGraph(history, factoryState);
  const queueObservations = buildPatchRelayQueueObservations({
    factoryState,
    ...(params.sessionStatus.activeRun?.runType ? { activeRunType: params.sessionStatus.activeRun.runType } : {}),
    ...(params.sessionStatus.issue.prNumber !== undefined ? { prNumber: params.sessionStatus.issue.prNumber } : {}),
    ...(params.sessionStatus.issue.prReviewState ? { prReviewState: params.sessionStatus.issue.prReviewState } : {}),
  }, normalizeFeedEvents(params.sessionStatus.feedEvents));
  const pathHtml = renderStatePath(history, factoryState);
  const graphHtml = renderStateGraph(graph.main, graph.prLoops, graph.queueLoop, graph.exits);
  const observationsHtml = renderObservationList(queueObservations);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>PatchRelay Agent Session ${escapeHtml(params.issueKey)}</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f5f1e8;
        --panel: rgba(255,255,255,0.84);
        --ink: #1f1d1a;
        --muted: #5b554b;
        --accent: #1f6d57;
        --line: rgba(31,29,26,0.15);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Georgia, "Times New Roman", serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(184, 139, 68, 0.22), transparent 36%),
          radial-gradient(circle at bottom right, rgba(31, 109, 87, 0.16), transparent 30%),
          linear-gradient(150deg, #eee3cf 0%, var(--bg) 52%, #f8f6f1 100%);
        padding: 24px;
      }
      main {
        width: min(920px, 100%);
        margin: 0 auto;
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 22px;
        padding: 32px;
        box-shadow: 0 30px 86px rgba(49,42,30,0.12);
      }
      h1 { margin: 0; font-size: clamp(34px, 7vw, 52px); line-height: 1.05; }
      p { color: var(--muted); font-size: 17px; line-height: 1.6; margin: 12px 0 0; }
      a { color: var(--accent); text-decoration: none; }
      a:hover { text-decoration: underline; }
      .chips { display: flex; flex-wrap: wrap; gap: 10px; margin: 20px 0 6px; }
      .chip { border: 1px solid var(--line); border-radius: 999px; padding: 9px 14px; background: rgba(255,255,255,0.74); font-size: 14px; }
      .section { margin-top: 24px; padding-top: 18px; border-top: 1px solid var(--line); }
      .section h2 { margin: 0; font-size: 22px; }
      .grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); margin-top: 14px; }
      .card { border: 1px solid var(--line); border-radius: 18px; background: rgba(255,255,255,0.56); padding: 16px; }
      .card h3 { margin: 0 0 10px; font-size: 16px; }
      .graph-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
      .graph-connector { color: var(--muted); }
      .node { display: inline-flex; border-radius: 999px; padding: 6px 10px; font-size: 13px; border: 1px solid var(--line); background: rgba(255,255,255,0.72); }
      .node.current { border-color: rgba(31,109,87,0.45); background: rgba(31,109,87,0.12); color: #164c3d; }
      .node.visited { border-color: rgba(31,109,87,0.28); color: #275546; }
      .node.upcoming { color: #6f695f; }
      .path-list, .observation-list { margin: 0; padding-left: 18px; color: var(--muted); }
      .path-list li, .observation-list li { margin-top: 8px; }
      .tone-warn { color: #8d5c10; }
      .tone-success { color: #1f6d57; }
      .tone-info { color: var(--muted); }
      table { width: 100%; border-collapse: collapse; margin-top: 14px; }
      th, td { text-align: left; border-bottom: 1px solid var(--line); padding: 10px 8px; vertical-align: top; }
      th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #5f594e; }
      td { font-size: 15px; color: #2a2622; }
      code { font-family: "SFMono-Regular", "Cascadia Code", "Fira Code", monospace; font-size: 0.95em; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(issueTitle)}</h1>
      <p>PatchRelay read-only agent session status for <code>${escapeHtml(params.issueKey)}</code>.</p>
      ${issueUrl ? `<p><a href="${escapeHtml(issueUrl)}" target="_blank" rel="noopener noreferrer">Open issue in Linear</a></p>` : ""}
      ${prUrl ? `<p><a href="${escapeHtml(prUrl)}" target="_blank" rel="noopener noreferrer">Open pull request ${escapeHtml(prLabel ?? "")}</a></p>` : ""}
      <div class="chips">
        <span class="chip"><strong>Factory:</strong> <code>${escapeHtml(factoryState)}</code></span>
        <span class="chip"><strong>Linear:</strong> <code>${escapeHtml(linearState)}</code></span>
        <span class="chip"><strong>Active:</strong> ${activeStage}</span>
        <span class="chip"><strong>Latest:</strong> ${latestStage}</span>
        <span class="chip"><strong>Thread:</strong> ${threadInfo}</span>
      </div>
      <div class="section">
        <h2>Current View</h2>
        <table>
          <tbody>
            <tr><th>Pull request</th><td>${escapeHtml(prLabel ?? "none")} (${escapeHtml(prState)})</td></tr>
            <tr><th>Review</th><td>${escapeHtml(reviewState)}</td></tr>
            <tr><th>Checks</th><td>${escapeHtml(checkState)}</td></tr>
            <tr><th>Queue label</th><td><code>${escapeHtml(queueProtocol?.admissionLabel ?? "queue")}</code></td></tr>
            <tr><th>Queue check</th><td><code>${escapeHtml(queueProtocol?.evictionCheckName ?? "merge-steward/queue")}</code></td></tr>
            <tr><th>Last queue signal</th><td><code>${escapeHtml(queueProtocol?.lastQueueSignalAt ?? queueProtocol?.lastFailureAt ?? "none")}</code></td></tr>
            <tr><th>Last queue incident</th><td>${queueProtocol?.lastIncidentUrl
              ? `<a href="${escapeHtml(queueProtocol.lastIncidentUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(queueProtocol.lastIncidentId ?? queueProtocol.lastIncidentUrl)}</a>`
              : escapeHtml(queueProtocol?.lastIncidentId ?? "none")}</td></tr>
            <tr><th>Queue failure class</th><td><code>${escapeHtml(queueProtocol?.lastIncidentFailureClass ?? "unknown")}</code></td></tr>
            <tr><th>Queue incident summary</th><td>${escapeHtml(queueProtocol?.lastIncidentSummary ?? "none")}</td></tr>
            <tr><th>Latest plan</th><td>${escapeHtml(latestPlan)}</td></tr>
            <tr><th>Active command</th><td><code>${escapeHtml(activeCommand)}</code></td></tr>
            <tr><th>Latest summary</th><td>${escapeHtml(latestAgentMessage)}</td></tr>
          </tbody>
        </table>
      </div>
      <div class="chips">
        <span class="chip"><strong>Commands:</strong> ${escapeHtml(String(commandCount))}</span>
        <span class="chip"><strong>File changes:</strong> ${escapeHtml(String(fileChangeCount))}</span>
        <span class="chip"><strong>Tool calls:</strong> ${escapeHtml(String(toolCallCount))}</span>
        <span class="chip"><strong>CI repairs:</strong> ${escapeHtml(String(ciAttempts))}</span>
        <span class="chip"><strong>Queue repairs:</strong> ${escapeHtml(String(queueAttempts))}</span>
      </div>
      <div class="section">
        <h2>State Path</h2>
        <div class="grid">
          <div class="card">
            <h3>Native Graph</h3>
            ${graphHtml}
          </div>
          <div class="card">
            <h3>Queue Observation</h3>
            ${observationsHtml}
          </div>
        </div>
        <div class="card" style="margin-top: 18px;">
          <h3>Observed Path</h3>
          ${pathHtml}
        </div>
      </div>
      <div class="section">
        <h2>Recent Stages</h2>
        <table>
          <thead>
            <tr>
              <th>Stage</th>
              <th>Status</th>
              <th>Started</th>
              <th>Ended</th>
            </tr>
          </thead>
          <tbody>
            ${stagesRows || '<tr><td colspan="4">No completed stage runs yet.</td></tr>'}
          </tbody>
        </table>
      </div>
      <p>Snapshot generated at <code>${escapeHtml(params.sessionStatus.generatedAt)}</code>. Link valid until <code>${escapeHtml(params.expiresAt)}</code>.</p>
    </main>
  </body>
</html>`;
}

function formatStageChip(
  run:
    | {
        runType?: string;
        status?: string;
      }
    | undefined,
): string {
  if (!run) {
    return "none";
  }
  const runType = run.runType ?? "unknown";
  const status = run.status ?? "unknown";
  return `<code>${escapeHtml(runType)}</code> (${escapeHtml(status)})`;
}

function formatThread(
  liveThread:
    | {
        threadId?: string;
        threadStatus?: string;
      }
    | undefined,
): string {
  if (!liveThread) {
    return "idle";
  }
  const threadId = liveThread.threadId ?? "unknown";
  const status = liveThread.threadStatus ?? "unknown";
  return `<code>${escapeHtml(threadId)}</code> (${escapeHtml(status)})`;
}

function formatStageRow(
  run:
    | {
        id?: number;
        runType?: string;
        status?: string;
        startedAt?: string;
        endedAt?: string;
      }
    | undefined,
): string {
  if (!run) {
    return '<tr><td colspan="4">Unknown run record</td></tr>';
  }
  const runType = run.runType ?? "unknown";
  const status = run.status ?? "unknown";
  const startedAt = run.startedAt ?? "-";
  const endedAt = run.endedAt ?? "-";
  return `<tr><td><code>${escapeHtml(runType)}</code></td><td>${escapeHtml(status)}</td><td><code>${escapeHtml(
    startedAt,
  )}</code></td><td><code>${escapeHtml(endedAt)}</code></td></tr>`;
}

function normalizeFeedEvents(
  feedEvents:
    | Array<{
        id?: number;
        at: string;
        level?: string;
        kind?: string;
        summary?: string;
        detail?: string;
        issueKey?: string;
        projectId?: string;
        stage?: string;
        status?: string;
        workflowId?: string;
        nextStage?: string;
      }>
    | undefined,
): OperatorFeedEvent[] {
  return (feedEvents ?? []).map((event, index) => ({
    id: event.id ?? -(index + 1),
    at: event.at,
    level: event.level === "warn" || event.level === "error" ? event.level : "info",
    kind: event.kind === "service"
      || event.kind === "webhook"
      || event.kind === "agent"
      || event.kind === "comment"
      || event.kind === "stage"
      || event.kind === "turn"
      || event.kind === "workflow"
      || event.kind === "hook"
      || event.kind === "github"
      || event.kind === "linear"
      ? event.kind
      : "service",
    summary: event.summary ?? "",
    ...(event.detail ? { detail: event.detail } : {}),
    ...(event.issueKey ? { issueKey: event.issueKey } : {}),
    ...(event.projectId ? { projectId: event.projectId } : {}),
    ...(event.stage ? { stage: event.stage } : {}),
    ...(event.status ? { status: event.status } : {}),
    ...(event.workflowId ? { workflowId: event.workflowId } : {}),
    ...(event.nextStage ? { nextStage: event.nextStage } : {}),
  }));
}

function buildPublicStateHistory(params: {
  currentFactoryState: string;
  activeRunId: number | null;
  feedEvents?: Array<{
    id?: number;
    at: string;
    level?: string;
    kind?: string;
    summary?: string;
    detail?: string;
    issueKey?: string;
    projectId?: string;
    stage?: string;
    status?: string;
    workflowId?: string;
    nextStage?: string;
  }>;
  runs: Array<{
    run?: { id?: number; runType?: string; status?: string; startedAt?: string; endedAt?: string } | undefined;
    report?: {
      assistantMessages?: string[];
      commands?: unknown[];
      fileChanges?: unknown[];
    } | undefined;
  }>;
}): StateHistoryNode[] {
  const runs = params.runs.flatMap((entry, index) => {
    if (!entry.run?.runType || !entry.run?.status || !entry.run?.startedAt) {
      return [];
    }
    return [{
      id: entry.run.id ?? index + 1,
      runType: entry.run.runType,
      status: entry.run.status,
      startedAt: entry.run.startedAt,
      endedAt: entry.run.endedAt,
      ...(entry.report ? {
        report: {
          runType: entry.run.runType,
          status: entry.run.status,
          prompt: "",
          assistantMessages: entry.report.assistantMessages ?? [],
          plans: [],
          reasoning: [],
          commands: (entry.report.commands ?? []) as Array<{ command: string; cwd: string; status: string; exitCode?: number }>,
          fileChanges: (entry.report.fileChanges ?? []) as Array<{ path: string; changeType: string }>,
          toolCalls: [],
          eventCounts: {},
        },
      } : {}),
    }];
  });

  return buildStateHistory(
    runs,
    normalizeFeedEvents(params.feedEvents),
    params.currentFactoryState,
    params.activeRunId,
  );
}

function renderStateGraph(
  main: VisualizationNode[],
  prLoops: VisualizationNode[],
  queueLoop: VisualizationNode[],
  exits: VisualizationNode[],
): string {
  return [
    renderGraphRow("main", main, true),
    renderGraphRow("pr loops", prLoops, false),
    renderGraphRow("queue loop", queueLoop, false),
    renderGraphRow("exits", exits, false),
  ].join("");
}

function renderGraphRow(label: string, nodes: VisualizationNode[], withConnectors: boolean): string {
  const items = nodes.map((node, index) => {
    const connector = withConnectors && index > 0 ? '<span class="graph-connector">→</span>' : "";
    return `${connector}<span class="node ${escapeHtml(node.status)}">${escapeHtml(node.label)}</span>`;
  }).join("");
  return `<div class="graph-row"><strong>${escapeHtml(label)}:</strong> ${items}</div>`;
}

function renderObservationList(observations: ObservationLine[]): string {
  if (observations.length === 0) {
    return '<p>No queue observation is available yet.</p>';
  }
  return `<ul class="observation-list">${observations.map((observation) =>
    `<li class="tone-${escapeHtml(observation.tone)}">${escapeHtml(observation.text)}</li>`).join("")}</ul>`;
}

function renderStatePath(history: StateHistoryNode[], currentFactoryState: string): string {
  if (history.length === 0) {
    return `<p>Current native state: <code>${escapeHtml(currentFactoryState)}</code>.</p>`;
  }
  const items: string[] = [];
  for (const node of history) {
    items.push(`<li><code>${escapeHtml(node.state)}</code>${node.reason ? ` — ${escapeHtml(node.reason)}` : ""}${node.isCurrent ? " (current)" : ""}</li>`);
    for (const trip of node.sideTrips) {
      const returnText = trip.returnState ? ` → ${trip.returnedAt ? escapeHtml(trip.returnState) : escapeHtml(trip.returnState)}` : "";
      items.push(`<li><code>${escapeHtml(trip.state)}</code> side trip${trip.reason ? ` — ${escapeHtml(trip.reason)}` : ""}${returnText ? ` ${returnText}` : ""}</li>`);
    }
  }
  return `<ul class="path-list">${items.join("")}</ul>`;
}
