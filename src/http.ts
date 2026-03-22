import type { FastifyRequest } from "fastify";
import fastify from "fastify";
import rawBody from "fastify-raw-body";
import type { Logger } from "pino";
import { getBuildInfo } from "./build-info.ts";
import { matchesOperatorFeedEvent, type OperatorFeedQuery } from "./operator-feed.ts";
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

  }

  if (managementRoutesEnabled) {
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

      const unsubscribe = service.subscribeOperatorFeed((event) => {
        if (!matchesOperatorFeedEvent(event, feedQuery)) {
          return;
        }
        writeEvent(event);
      });
      const keepAlive = setInterval(() => {
        reply.raw.write(": keepalive\n\n");
      }, 15000);

      request.raw.on("close", () => {
        clearInterval(keepAlive);
        unsubscribe();
        reply.raw.end();
      });
    });

    app.get("/api/installations", async (_request, reply) => {
      return reply.send({ ok: true, installations: service.listLinearInstallations() });
    });

    app.get("/api/oauth/linear/start", async (request, reply) => {
      const projectId = getQueryParam(request, "projectId");
      const result = service.createLinearOAuthStart(projectId ? { projectId } : undefined);
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
    };
    activeRun?: { runType?: string; status?: string } | undefined;
    latestRun?: { runType?: string; status?: string } | undefined;
    liveThread?: { threadId?: string; threadStatus?: string } | undefined;
    runs: Array<{
      run?: { runType?: string; status?: string; startedAt?: string; endedAt?: string } | undefined;
    }>;
    generatedAt: string;
  };
}): string {
  const issueTitle = params.sessionStatus.issue.title ?? params.sessionStatus.issue.issueKey ?? params.issueKey;
  const issueUrl = params.sessionStatus.issue.issueUrl;
  const activeStage = formatStageChip(params.sessionStatus.activeRun);
  const latestStage = formatStageChip(params.sessionStatus.latestRun);
  const threadInfo = formatThread(params.sessionStatus.liveThread);
  const stagesRows = params.sessionStatus.runs.slice(-8).map((entry) => formatStageRow(entry.run)).join("");

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
      <div class="chips">
        <span class="chip"><strong>Active:</strong> ${activeStage}</span>
        <span class="chip"><strong>Latest:</strong> ${latestStage}</span>
        <span class="chip"><strong>Thread:</strong> ${threadInfo}</span>
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
