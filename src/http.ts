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
  const app = fastify({
    loggerInstance: logger,
    bodyLimit: config.ingress.maxBodyBytes,
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
        PatchRelay listens for signed Linear webhooks, prepares an issue-specific worktree, and launches
        autonomous Codex runs through <code>zmx</code> on this machine.
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

  return app;
}

function getHeader(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}
