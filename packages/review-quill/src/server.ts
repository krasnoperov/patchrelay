import { readFileSync } from "node:fs";
import fastify from "fastify";
import rawBody from "fastify-raw-body";
import pino from "pino";
import { loadConfig } from "./config.ts";
import { getDefaultConfigPath, getReviewQuillPathLayout } from "./runtime-paths.ts";
import { ensureDir } from "./utils.ts";
import { SqliteStore } from "./db/sqlite-store.ts";
import { resolveGitHubAuthConfig, createGitHubAppTokenManager, resolveAppSlug, type GitHubAppTokenManager } from "./github-auth.ts";
import { GitHubClient } from "./github-client.ts";
import { ReviewRunner } from "./review-runner.ts";
import { ReviewQuillService } from "./service.ts";
import { normalizeWebhook, verifySignature } from "./webhook-handler.ts";

export async function startServer(configPath = process.env.REVIEW_QUILL_CONFIG ?? getDefaultConfigPath()): Promise<void> {
  const layout = getReviewQuillPathLayout();
  await ensureDir(layout.stateDir);
  await ensureDir(layout.dataDir);
  const config = loadConfig(configPath);
  const logger = pino({ level: config.logging.level });

  const auth = resolveGitHubAuthConfig();
  if (auth.mode !== "app") {
    throw new Error("Review Quill requires GitHub App auth. Set REVIEW_QUILL_GITHUB_APP_ID and REVIEW_QUILL_GITHUB_APP_PRIVATE_KEY.");
  }

  const tokenManager = createGitHubAppTokenManager(auth.credentials, config.repositories.map((repo) => repo.repoFullName), logger.child({ component: "github-auth" }));
  await tokenManager.start();
  let appSlug: string | undefined;
  try {
    appSlug = await resolveAppSlug(auth.credentials);
  } catch {
    logger.warn("Could not resolve GitHub App slug for review-quill");
  }

  const store = new SqliteStore(config.database.path);
  const github = new GitHubClient({
    currentTokenForRepo: (repoFullName?: string) => tokenManager.currentTokenForRepo(repoFullName),
  });
  const runner = new ReviewRunner(config, logger.child({ component: "review-runner" }));
  const service = new ReviewQuillService(config, store, github, runner, logger.child({ component: "service" }), appSlug);

  const app = fastify({ loggerInstance: logger, disableRequestLogging: true });
  await app.register(rawBody, { runFirst: true });

  app.get("/health", async () => ({
    ok: true,
    service: "review-quill",
    repos: config.repositories.map((repo) => repo.repoFullName),
  }));

  app.get("/admin/runtime/auth", async () => ({
    mode: auth.mode,
    ready: true,
    appId: auth.credentials.appId,
    installationMode: auth.credentials.installationId ? "pinned" : "per_repo",
    appSlug,
    webhookSecretSource: config.secretSources["review-quill-webhook-secret"],
  }));

  app.get("/attempts", async () => ({
    attempts: service.listAttempts(),
  }));

  app.get("/attempts/:attemptId", async (request, reply) => {
    const attemptId = Number((request.params as { attemptId: string }).attemptId);
    if (!Number.isInteger(attemptId) || attemptId <= 0) {
      return reply.status(400).send({ ok: false, error: "invalid_attempt_id" });
    }
    const detail = await service.getAttemptDetail(attemptId);
    if (!detail) {
      return reply.status(404).send({ ok: false, error: "attempt_not_found" });
    }
    return detail;
  });

  app.get("/watch", async () => service.getWatchSnapshot());

  app.post("/admin/reconcile", async (request) => {
    const repoFullName = typeof (request.body as { repoFullName?: unknown } | undefined)?.repoFullName === "string"
      ? (request.body as { repoFullName: string }).repoFullName
      : undefined;
    const started = await service.triggerReconcile(repoFullName);
    return {
      ok: true,
      started,
      ...(repoFullName ? { repoFullName } : {}),
      runtime: service.getWatchSnapshot().runtime,
    };
  });

  app.post("/webhooks/github", { config: { rawBody: true } }, async (request, reply) => {
    const rawBody = (request as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(request.body));
    const webhookSecret = (() => {
      const serviceEnv = process.env.REVIEW_QUILL_WEBHOOK_SECRET;
      if (serviceEnv) return serviceEnv;
      try {
        const credDir = process.env.CREDENTIALS_DIRECTORY;
        return credDir ? readFileSync(`${credDir}/review-quill-webhook-secret`, "utf8").trim() : undefined;
      } catch {
        return undefined;
      }
    })();
    if (webhookSecret) {
      const signature = request.headers["x-hub-signature-256"];
      if (!verifySignature(rawBody, webhookSecret, typeof signature === "string" ? signature : undefined)) {
        return reply.status(401).send({ ok: false, error: "invalid_signature" });
      }
    }

    const deliveryId = typeof request.headers["x-github-delivery"] === "string" ? request.headers["x-github-delivery"] : undefined;
    const eventType = typeof request.headers["x-github-event"] === "string" ? request.headers["x-github-event"] : undefined;
    if (!eventType) {
      return reply.status(400).send({ ok: false, error: "missing_event_type" });
    }
    const payload = request.body as Record<string, unknown>;
    const normalized = normalizeWebhook(eventType, payload);
    if (!normalized) {
      if (deliveryId && !store.isWebhookDuplicate(deliveryId)) {
        store.recordWebhook(deliveryId, eventType);
        store.markWebhookProcessed(deliveryId, "ignored_event");
      }
      return { ok: true, ignored: true };
    }
    if (deliveryId) {
      if (store.isWebhookDuplicate(deliveryId)) return { ok: true, duplicate: true };
      store.recordWebhook(deliveryId, eventType, normalized.repoFullName);
    }
    await service.triggerReconcile(normalized.repoFullName);
    if (deliveryId) {
      store.markWebhookProcessed(deliveryId);
    }
    return { ok: true, repo: normalized.repoFullName };
  });

  const shutdown = async () => {
    await service.stop();
    tokenManager.stop();
    store.close();
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  await app.listen({ host: config.server.bind, port: config.server.port });
  logger.info({ bind: config.server.bind, port: config.server.port }, "review-quill listening");
  await service.start();
}
