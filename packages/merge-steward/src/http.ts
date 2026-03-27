import fastify from "fastify";
import type { Logger } from "pino";
import { z } from "zod";
import type { MergeStewardService } from "./service.ts";

const enqueueBody = z.object({
  prNumber: z.number().int(),
  branch: z.string().min(1),
  headSha: z.string().min(1),
  issueKey: z.string().optional(),
  worktreePath: z.string().optional(),
  priority: z.number().int().optional(),
});

const updateHeadBody = z.object({
  headSha: z.string().min(1),
});

export async function buildHttpServer(
  service: MergeStewardService,
  logger: Logger,
) {
  const app = fastify({ loggerInstance: logger, disableRequestLogging: true });

  app.get("/health", async () => ({ ok: true }));

  app.get("/queue/status", async () => ({
    entries: service.getStatus(),
  }));

  app.post("/queue/enqueue", async (request, reply) => {
    const body = enqueueBody.parse(request.body);
    try {
      const params: Parameters<typeof service.enqueue>[0] = {
        prNumber: body.prNumber,
        branch: body.branch,
        headSha: body.headSha,
      };
      if (body.issueKey !== undefined) params.issueKey = body.issueKey;
      if (body.worktreePath !== undefined) params.worktreePath = body.worktreePath;
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
