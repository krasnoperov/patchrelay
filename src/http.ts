import type { FastifyRequest } from "fastify";
import fastify from "fastify";
import rawBody from "fastify-raw-body";
import type { Logger } from "pino";
import { getBuildInfo } from "./build-info.js";
import type { AppConfig } from "./types.js";
import { PatchRelayService } from "./service.js";

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: string | Buffer;
  }
}

export async function buildHttpServer(config: AppConfig, service: PatchRelayService, logger: Logger) {
  const buildInfo = getBuildInfo();
  const loopbackBind = isLoopbackBind(config.server.bind);
  const localOAuthPagesEnabled = Boolean(config.linear.oauth) && loopbackBind;
  const managementRoutesEnabled = Boolean(config.linear.oauth) && (loopbackBind || config.operatorApi.enabled);
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

  if (localOAuthPagesEnabled) {
    app.get("/auth/linear/start", async (request, reply) => {
      const projectId = getQueryParam(request, "projectId");
      const result = service.createLinearOAuthStart(projectId ? { projectId } : undefined);
      return reply.redirect(result.authorizeUrl);
    });

    app.get("/setup", async (_request, reply) => {
      const installations = service.listLinearInstallations();
      const projects: Array<{ id: string; installationId?: number }> = config.projects.map((project) => {
        const linked = installations.find((entry) => entry.linkedProjects.includes(project.id));
        return {
          id: project.id,
          ...(linked?.installation?.id ? { installationId: linked.installation.id } : {}),
        };
      });

      return reply
        .type("text/html; charset=utf-8")
        .send(renderSetupPage(config, installations, projects));
    });
  }

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
      const result = await service.getActiveStageStatus(issueKey);
      if (!result) {
        return reply.code(404).send({ ok: false, reason: "active_stage_not_found" });
      }
      return reply.send({ ok: true, ...result });
    });

    app.get("/api/issues/:issueKey/stages/:stageRunId/events", async (request, reply) => {
      const { issueKey, stageRunId } = request.params as { issueKey: string; stageRunId: string };
      const result = await service.getStageEvents(issueKey, Number(stageRunId));
      if (!result) {
        return reply.code(404).send({ ok: false, reason: "stage_run_not_found" });
      }
      return reply.send({ ok: true, ...result });
    });

  }

  if (managementRoutesEnabled) {
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

    app.post("/api/projects/:projectId/installation", async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const rawInstallationId = (request.body as { installationId?: number | string | null } | undefined)?.installationId;
      const installationId =
        rawInstallationId === null || rawInstallationId === "null" || rawInstallationId === ""
          ? undefined
          : Number(rawInstallationId);
      if (rawInstallationId !== null && rawInstallationId !== "null" && rawInstallationId !== "") {
        if (typeof installationId !== "number" || !Number.isFinite(installationId) || installationId <= 0) {
          return reply.code(400).send({ ok: false, reason: "invalid_installation_id" });
        }
      }

      try {
        const link =
          installationId === undefined ? service.unlinkProjectInstallation(projectId) : service.linkProjectInstallation(projectId, installationId);
        return reply.send({ ok: true, link });
      } catch (error) {
        return reply
          .code(404)
          .send({ ok: false, reason: "link_failed", message: error instanceof Error ? error.message : String(error) });
      }
    });

    app.delete("/api/projects/:projectId/installation", async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      try {
        service.unlinkProjectInstallation(projectId);
        return reply.send({ ok: true });
      } catch (error) {
        return reply
          .code(404)
          .send({ ok: false, reason: "link_failed", message: error instanceof Error ? error.message : String(error) });
      }
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

function renderSetupPage(
  config: AppConfig,
  installations: Array<{ installation: ReturnType<PatchRelayService["listLinearInstallations"]>[number]["installation"]; linkedProjects: string[] }>,
  projects: Array<{ id: string; installationId?: number }>,
): string {
  const installItems = installations
    .map((entry) => {
      const installation = entry.installation;
      const name = installation?.workspaceName ?? installation?.actorName ?? `Installation #${installation?.id ?? "unknown"}`;
      const links = entry.linkedProjects.length > 0 ? `Linked projects: ${entry.linkedProjects.join(", ")}` : "Not linked";
      return `<li><strong>${escapeHtml(name)}</strong><br><span>${escapeHtml(links)}</span></li>`;
    })
    .join("");

  const projectItems = projects
    .map(
      (project) =>
        `<li><strong>${escapeHtml(project.id)}</strong> - ${
          project.installationId ? "linked" : "not linked"
        } - <a href="/auth/linear/start?projectId=${encodeURIComponent(project.id)}">Connect Linear</a></li>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>PatchRelay Setup</title>
  </head>
  <body>
    <main>
      <h1>PatchRelay Setup</h1>
      <p>Linear OAuth redirect: <code>${escapeHtml(config.linear.oauth?.redirectUri ?? "not configured")}</code></p>
      <h2>Projects</h2>
      <ul>${projectItems || "<li>No projects configured.</li>"}</ul>
      <h2>Installations</h2>
      <ul>${installItems || "<li>No Linear installations connected yet.</li>"}</ul>
    </main>
  </body>
</html>`;
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
