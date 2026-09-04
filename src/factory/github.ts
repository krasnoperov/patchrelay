import { z } from "zod";
import { execCommand } from "../utils.ts";

export const RECENT_WORK_MS = 7 * 24 * 60 * 60 * 1000;
const schema = z.array(z.object({
  number: z.number(), title: z.string(), state: z.enum(["open", "closed"]),
  head: z.object({ sha: z.string() }), draft: z.boolean(),
  updated_at: z.string(), merged_at: z.string().nullable(),
}));
export type FactoryPullRequest = z.infer<typeof schema>[number];
export interface FactoryRepositoryPrs {
  repo: string;
  available: boolean;
  prs: FactoryPullRequest[];
}

// Use the service's existing, rotating gh authentication. Cache repository reads
// separately from the five-second service stream, including failures.
export function createFactoryGitHubReader(run = execCommand, now = Date.now) {
  const cache = new Map<string, { at: number; value: FactoryRepositoryPrs }>();
  async function readRepo(repo: string): Promise<FactoryRepositoryPrs> {
    const cached = cache.get(repo);
    if (cached && now() - cached.at < 60_000) return cached.value;
    let value: FactoryRepositoryPrs;
    try {
      const prs: FactoryPullRequest[] = [];
      const cutoff = now() - RECENT_WORK_MS;
      for (const state of ["open", "closed"]) {
        for (let page = 1; ; page++) {
          const result = await run("gh", ["api", `repos/${repo}/pulls?state=${state}&sort=updated&direction=desc&per_page=100&page=${page}`], { timeoutMs: 10_000 });
          if (result.exitCode !== 0) throw new Error("GitHub read failed");
          const batch = schema.parse(JSON.parse(result.stdout));
          prs.push(...batch.filter(pr => pr.state === "open" || (pr.merged_at && Date.parse(pr.merged_at) >= cutoff)));
          // Closed results are sorted by updated_at: a recent merge cannot have
          // an older updated_at, so stop without scanning the repository history.
          if (batch.length < 100 || (state === "closed" && batch.every(pr => Date.parse(pr.updated_at) < cutoff))) break;
        }
      }
      value = { repo, available: true, prs };
    } catch {
      // Do not turn an old eviction into a current alert when GitHub is unavailable.
      value = { repo, available: false, prs: [] };
    }
    cache.set(repo, { at: now(), value });
    return value;
  }
  return async (repos: string[]): Promise<FactoryRepositoryPrs[]> => {
    const remaining = [...new Set(repos)];
    const results: FactoryRepositoryPrs[] = [];
    await Promise.all(Array.from({ length: Math.min(3, remaining.length) }, async () => {
      for (let repo = remaining.shift(); repo; repo = remaining.shift()) results.push(await readRepo(repo));
    }));
    return results;
  };
}
