import { z } from "zod";
import type { AppConfig } from "../types.ts";
import type { PatchRelayService } from "../service.ts";
import {
  buildFactoryProjects,
  type QueueObservation,
  type ReviewObservation,
} from "./model.ts";
import type { FactorySnapshot, FactorySource } from "./types.ts";

const queueHealthSchema = z.object({
  repos: z.array(z.object({ repoId: z.string(), repoFullName: z.string() })),
});
const queueSchema = z.object({
  entries: z.array(
    z.object({
      prNumber: z.number(),
      headSha: z.string(),
      status: z.string(),
      position: z.number(),
      updatedAt: z.string(),
      prTitle: z.string().nullish(),
    }),
  ),
});
const reviewSchema = z.object({
  attempts: z.array(
    z.object({
      repoFullName: z.string(),
      prNumber: z.number(),
      headSha: z.string(),
      status: z.string(),
      conclusion: z.string().optional(),
      updatedAt: z.string(),
      stale: z.boolean().optional(),
    }),
  ),
});

export interface FactoryConnections {
  mergeStewardUrl?: string | undefined;
  reviewQuillUrl?: string | undefined;
}

export function createFactorySnapshotReader(
  config: AppConfig,
  service: Pick<PatchRelayService, "listTrackedIssues" | "getReadiness">,
  connections: FactoryConnections,
  fetcher: typeof fetch = fetch,
) {
  let cached: FactorySnapshot | undefined;
  let inFlight: Promise<FactorySnapshot> | undefined;
  let cachedAt = 0;

  async function readJson(base: string, path: string): Promise<unknown> {
    const response = await fetcher(`${base.replace(/\/$/, "")}${path}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok)
      throw new Error(`Service returned HTTP ${response.status}`);
    return response.json();
  }

  async function read(): Promise<FactorySnapshot> {
    const sources: FactorySource[] = [];
    let queues: QueueObservation[] = [];
    let reviews: ReviewObservation[] = [];
    await Promise.all([
      (async () => {
        const source: FactorySource = {
          id: "queue",
          name: "Merge-steward",
          state: "unconfigured",
          detail: "Queue service is not configured",
        };
        sources.push(source);
        if (!connections.mergeStewardUrl) return;
        try {
          const base = connections.mergeStewardUrl;
          const health = queueHealthSchema.parse(
            await readJson(base, "/health"),
          );
          const results = await Promise.allSettled(
            health.repos.map(async (repo) => {
              const snapshot = queueSchema.parse(
                await readJson(
                  base,
                  `/repos/${encodeURIComponent(repo.repoId)}/queue/watch`,
                ),
              );
              return snapshot.entries.map((entry) => ({
                ...entry,
                repo: repo.repoFullName,
                title: entry.prTitle ?? undefined,
              }));
            }),
          );
          queues = results.flatMap((result) =>
            result.status === "fulfilled" ? result.value : [],
          );
          const failed = results.filter(
            (result) => result.status === "rejected",
          ).length;
          source.state = failed ? "unavailable" : "connected";
          source.detail = failed
            ? `${failed} repository queues unavailable; showing available observations`
            : "Queue positions from merge-steward";
        } catch {
          source.state = "unavailable";
          source.detail =
            "Cannot read merge-steward; queue positions are unknown";
        }
      })(),
      (async () => {
        const source: FactorySource = {
          id: "review",
          name: "Review-quill",
          state: "unconfigured",
          detail: "Using PatchRelay's GitHub review observations",
        };
        sources.push(source);
        if (!connections.reviewQuillUrl) return;
        try {
          const snapshot = reviewSchema.parse(
            await readJson(connections.reviewQuillUrl, "/watch"),
          );
          reviews = snapshot.attempts
            .filter((attempt) => !attempt.stale)
            .map((attempt) => ({ ...attempt, repo: attempt.repoFullName }));
          source.state = "connected";
          source.detail = "Review observations matched to the current PR head";
        } catch {
          source.state = "unavailable";
          source.detail =
            "Cannot read review-quill; using PatchRelay's observations";
        }
      })(),
    ]);
    const readiness = service.getReadiness();
    const issues = service.listTrackedIssues();
    return {
      generatedAt: new Date().toISOString(),
      projects: buildFactoryProjects(config.projects, issues, queues, reviews),
      sources: [
        {
          id: "patchrelay",
          name: "PatchRelay",
          state: readiness.ready ? "connected" : "unavailable",
          detail: readiness.ready
            ? "Reading the local issue store"
            : "Service is not ready; showing stored observations",
        },
        {
          id: "linear",
          name: "Linear",
          state: readiness.linearConnected ? "connected" : "unavailable",
          detail: "Connection state reported by PatchRelay",
        },
        {
          id: "github",
          name: "GitHub / CI",
          state: "observed",
          detail:
            "Stored GitHub webhook observations; not a live GitHub health check",
        },
        ...sources.sort((a, b) => a.id.localeCompare(b.id)),
      ],
    };
  }
  return async (): Promise<FactorySnapshot> => {
    if (cached && Date.now() - cachedAt < 4000) return cached;
    inFlight ??= read()
      .then((snapshot) => {
        cached = snapshot;
        cachedAt = Date.now();
        return snapshot;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}
