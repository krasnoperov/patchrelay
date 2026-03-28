import fastify from "fastify";
import rawBody from "fastify-raw-body";
import type { Logger } from "pino";
import { z } from "zod";
import type { MergeStewardService } from "./service.ts";
import type { StewardConfig } from "./config.ts";
import { verifySignature, normalizeWebhook, processWebhookEvent } from "./webhook-handler.ts";

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

export async function buildHttpServer(
  service: MergeStewardService,
  config: StewardConfig,
  logger: Logger,
) {
  const app = fastify({ loggerInstance: logger, disableRequestLogging: true });
  await app.register(rawBody, { runFirst: true });

  app.get("/health", async () => ({ ok: true }));

  // --- GitHub webhook endpoint ---
  app.post(config.webhookPath, {
    config: { rawBody: true },
  }, async (request, reply) => {
    if (config.webhookSecret) {
      const sig = request.headers["x-hub-signature-256"] as string | undefined;
      const body = (request as unknown as { rawBody?: Buffer }).rawBody ?? JSON.stringify(request.body);
      if (!verifySignature(body, sig, config.webhookSecret)) {
        return reply.status(401).send({ ok: false, error: "Invalid signature" });
      }
    }

    const eventType = request.headers["x-github-event"] as string | undefined;
    if (!eventType) {
      return reply.status(400).send({ ok: false, error: "Missing x-github-event header" });
    }

    const event = normalizeWebhook(eventType, request.body as Record<string, unknown>);
    if (!event) {
      return { ok: true, ignored: true };
    }

    await processWebhookEvent(event, service, {
      admissionLabel: config.admissionLabel,
      baseBranch: config.baseBranch,
      repoFullName: config.repoFullName,
    }, logger);

    return { ok: true };
  });

  app.get("/queue/status", async () => ({
    entries: service.getStatus(),
  }));

  app.get("/queue/watch", async (request) => {
    const query = watchQuery.parse(request.query ?? {});
    return service.getWatchSnapshot(
      query.eventLimit !== undefined ? { eventLimit: query.eventLimit } : undefined,
    );
  });

  app.get<{ Params: { entryId: string } }>(
    "/queue/entries/:entryId/detail",
    async (request, reply) => {
      const query = detailQuery.parse(request.query ?? {});
      const detail = service.getEntryDetail(
        request.params.entryId,
        query.eventLimit !== undefined ? { eventLimit: query.eventLimit } : undefined,
      );
      if (!detail) {
        return reply.status(404).send({ ok: false, error: "Entry not found" });
      }
      return detail;
    },
  );

  app.post("/queue/reconcile", async () => {
    const result = await service.triggerReconcile();
    return { ok: true, ...result };
  });

  app.post("/queue/enqueue", async (request, reply) => {
    const body = enqueueBody.parse(request.body);
    try {
      const params: Parameters<typeof service.enqueue>[0] = {
        prNumber: body.prNumber,
        branch: body.branch,
        headSha: body.headSha,
      };
      if (body.issueKey !== undefined) params.issueKey = body.issueKey;
      if (body.priority !== undefined) params.priority = body.priority;
      const entry = service.enqueue(params);
      return reply.status(201).send({ ok: true, entryId: entry.id });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("UNIQUE constraint")) {
        return reply.status(409).send({ ok: false, error: "Duplicate active entry for this PR" });
      }
      throw err;
    }
  });

  app.post<{ Params: { entryId: string } }>(
    "/queue/entries/:entryId/dequeue",
    async (request, reply) => {
      const ok = service.dequeueEntry(request.params.entryId);
      if (!ok) {
        return reply.status(404).send({ ok: false, error: "Entry not found" });
      }
      return { ok: true };
    },
  );

  app.post<{ Params: { entryId: string } }>(
    "/queue/entries/:entryId/update-head",
    async (request, reply) => {
      const body = updateHeadBody.parse(request.body);
      const ok = service.updateEntryHead(request.params.entryId, body.headSha);
      if (!ok) {
        return reply.status(404).send({ ok: false, error: "Entry not found" });
      }
      return { ok: true };
    },
  );

  app.get<{ Params: { incidentId: string } }>(
    "/queue/incidents/:incidentId",
    async (request, reply) => {
      const incident = service.getIncident(request.params.incidentId);
      if (!incident) {
        return reply.status(404).send({ ok: false, error: "Incident not found" });
      }
      return incident;
    },
  );

  app.get<{ Params: { entryId: string } }>(
    "/queue/entries/:entryId/incidents",
    async (request, reply) => {
      return { incidents: service.listIncidents(request.params.entryId) };
    },
  );

  return app;
}
