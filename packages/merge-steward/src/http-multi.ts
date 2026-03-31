import fastify from "fastify";
import rawBody from "fastify-raw-body";
import type { Logger } from "pino";
import { z } from "zod";
import type { ServiceGitHubAuthStatus } from "./admin-types.ts";
import type { DiscoveredRepoSettings } from "./github-repo-discovery.ts";
import type { MergeStewardService } from "./service.ts";
import type { StewardConfig } from "./config.ts";
import { verifySignature, normalizeWebhook, processWebhookEvent } from "./webhook-handler.ts";

interface RepoInstance {
  config: StewardConfig;
  service: MergeStewardService;
}

const enqueueBody = z.object({
  prNumber: z.number().int(),
  branch: z.string().min(1),
  headSha: z.string().min(1),
  issueKey: z.string().optional(),
  priority: z.number().int().optional(),
});

const updateHeadBody = z.object({
  headSha: z.string().min(1),
});

const watchQuery = z.object({
  eventLimit: z.coerce.number().int().min(1).max(200).optional(),
});

const detailQuery = z.object({
  eventLimit: z.coerce.number().int().min(1).max(500).optional(),
});

const discoverRepoBody = z.object({
  repoFullName: z.string().min(1),
  baseBranch: z.string().min(1).optional(),
});

export async function buildMultiRepoHttpServer(options: {
  instances: Map<string, RepoInstance>;
  webhookSecret: string | undefined;
  githubAdmin: {
    getStatus(): ServiceGitHubAuthStatus;
    discoverRepoSettings(params: { repoFullName: string; baseBranch?: string }): Promise<DiscoveredRepoSettings>;
  };
  logger: Logger;
}) {
  const { instances, webhookSecret, githubAdmin, logger } = options;

  // Build a repoId → instance lookup for the /repos/:repoId routes.
  const byRepoId = new Map<string, RepoInstance>();
  for (const inst of instances.values()) {
    byRepoId.set(inst.config.repoId, inst);
  }

  const app = fastify({ loggerInstance: logger, disableRequestLogging: true });
  await app.register(rawBody, { runFirst: true });

  // --- Health ---
  app.get("/health", async () => ({
    ok: true,
    repos: [...instances.entries()].map(([fullName, inst]) => ({
      repoId: inst.config.repoId,
      repoFullName: fullName,
    })),
  }));

  app.get("/admin/runtime/auth", async () => githubAdmin.getStatus());

  app.post("/admin/github/discover", async (request, reply) => {
    const body = discoverRepoBody.parse(request.body);
    try {
      const discovery = await githubAdmin.discoverRepoSettings({
        repoFullName: body.repoFullName,
        ...(body.baseBranch ? { baseBranch: body.baseBranch } : {}),
      });
      return { ok: true, discovery };
    } catch (error) {
      return reply.status(503).send({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // --- Single webhook endpoint for all repos ---
  app.post("/webhooks/github", {
    config: { rawBody: true },
  }, async (request, reply) => {
    if (webhookSecret) {
      const sig = request.headers["x-hub-signature-256"] as string | undefined;
      const body = (request as unknown as { rawBody?: Buffer }).rawBody ?? JSON.stringify(request.body);
      if (!verifySignature(body, sig, webhookSecret)) {
        return reply.status(401).send({ ok: false, error: "Invalid signature" });
      }
    }

    const eventType = request.headers["x-github-event"] as string | undefined;
    if (!eventType) {
      return reply.status(400).send({ ok: false, error: "Missing x-github-event header" });
    }

    const payload = request.body as Record<string, unknown>;
    const repo = payload.repository as Record<string, unknown> | undefined;
    const repoFullName = typeof repo?.full_name === "string" ? repo.full_name : undefined;
    if (!repoFullName) {
      return { ok: true, ignored: true };
    }

    const instance = instances.get(repoFullName);
    if (!instance) {
      return { ok: true, ignored: true, reason: "unknown_repo" };
    }

    const event = normalizeWebhook(eventType, payload);
    if (!event) {
      return { ok: true, ignored: true };
    }

    await processWebhookEvent(event, instance.service, {
      admissionLabel: instance.config.admissionLabel,
      baseBranch: instance.config.baseBranch,
      repoFullName: instance.config.repoFullName,
      github: instance.service.githubApi,
    }, logger);

    return { ok: true, repo: repoFullName };
  });

  // --- Per-repo queue endpoints under /repos/:repoId ---

  function getRepo(repoId: string) {
    return byRepoId.get(repoId);
  }

  app.get<{ Params: { repoId: string } }>(
    "/repos/:repoId/queue/status",
    async (request, reply) => {
      const inst = getRepo(request.params.repoId);
      if (!inst) return reply.status(404).send({ ok: false, error: "Repo not found" });
      return { entries: inst.service.getStatus() };
    },
  );

  app.get<{ Params: { repoId: string } }>(
    "/repos/:repoId/queue/watch",
    async (request, reply) => {
      const inst = getRepo(request.params.repoId);
      if (!inst) return reply.status(404).send({ ok: false, error: "Repo not found" });
      const query = watchQuery.parse(request.query ?? {});
      return inst.service.getWatchSnapshot(
        query.eventLimit !== undefined ? { eventLimit: query.eventLimit } : undefined,
      );
    },
  );

  app.get<{ Params: { repoId: string; entryId: string } }>(
    "/repos/:repoId/queue/entries/:entryId/detail",
    async (request, reply) => {
      const inst = getRepo(request.params.repoId);
      if (!inst) return reply.status(404).send({ ok: false, error: "Repo not found" });
      const query = detailQuery.parse(request.query ?? {});
      const detail = inst.service.getEntryDetail(
        request.params.entryId,
        query.eventLimit !== undefined ? { eventLimit: query.eventLimit } : undefined,
      );
      if (!detail) return reply.status(404).send({ ok: false, error: "Entry not found" });
      return detail;
    },
  );

  app.post<{ Params: { repoId: string } }>(
    "/repos/:repoId/queue/reconcile",
    async (request, reply) => {
      const inst = getRepo(request.params.repoId);
      if (!inst) return reply.status(404).send({ ok: false, error: "Repo not found" });
      const result = await inst.service.triggerReconcile();
      return { ok: true, ...result };
    },
  );

  app.post<{ Params: { repoId: string } }>(
    "/repos/:repoId/queue/enqueue",
    async (request, reply) => {
      const inst = getRepo(request.params.repoId);
      if (!inst) return reply.status(404).send({ ok: false, error: "Repo not found" });
      const body = enqueueBody.parse(request.body);
      try {
        const params: Parameters<typeof inst.service.enqueue>[0] = {
          prNumber: body.prNumber,
          branch: body.branch,
          headSha: body.headSha,
        };
        if (body.issueKey !== undefined) params.issueKey = body.issueKey;
        if (body.priority !== undefined) params.priority = body.priority;
        const entry = inst.service.enqueue(params);
        return reply.status(201).send({ ok: true, entryId: entry.id });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("UNIQUE constraint")) {
          return reply.status(409).send({ ok: false, error: "Duplicate active entry for this PR" });
        }
        throw err;
      }
    },
  );

  app.post<{ Params: { repoId: string; entryId: string } }>(
    "/repos/:repoId/queue/entries/:entryId/dequeue",
    async (request, reply) => {
      const inst = getRepo(request.params.repoId);
      if (!inst) return reply.status(404).send({ ok: false, error: "Repo not found" });
      const ok = inst.service.dequeueEntry(request.params.entryId);
      if (!ok) return reply.status(404).send({ ok: false, error: "Entry not found" });
      return { ok: true };
    },
  );

  app.post<{ Params: { repoId: string; entryId: string } }>(
    "/repos/:repoId/queue/entries/:entryId/update-head",
    async (request, reply) => {
      const inst = getRepo(request.params.repoId);
      if (!inst) return reply.status(404).send({ ok: false, error: "Repo not found" });
      const body = updateHeadBody.parse(request.body);
      const ok = inst.service.updateEntryHead(request.params.entryId, body.headSha);
      if (!ok) return reply.status(404).send({ ok: false, error: "Entry not found" });
      return { ok: true };
    },
  );

  app.get<{ Params: { repoId: string; incidentId: string } }>(
    "/repos/:repoId/queue/incidents/:incidentId",
    async (request, reply) => {
      const inst = getRepo(request.params.repoId);
      if (!inst) return reply.status(404).send({ ok: false, error: "Repo not found" });
      const incident = inst.service.getIncident(request.params.incidentId);
      if (!incident) return reply.status(404).send({ ok: false, error: "Incident not found" });
      return incident;
    },
  );

  app.get<{ Params: { repoId: string; entryId: string } }>(
    "/repos/:repoId/queue/entries/:entryId/incidents",
    async (request, reply) => {
      const inst = getRepo(request.params.repoId);
      if (!inst) return reply.status(404).send({ ok: false, error: "Repo not found" });
      return { incidents: inst.service.listIncidents(request.params.entryId) };
    },
  );

  return app;
}
