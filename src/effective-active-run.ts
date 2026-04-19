import type { RunRecord, RunStatus } from "./db-types.ts";

function isActiveRunStatus(status: RunStatus | undefined): boolean {
  return status === "queued" || status === "running";
}

export function hasDetachedActiveLatestRun(params: {
  activeRunId?: number | undefined;
  latestRun?: Pick<RunRecord, "id" | "status"> | undefined;
}): boolean {
  return params.activeRunId === undefined
    && params.latestRun !== undefined
    && isActiveRunStatus(params.latestRun.status);
}

export function resolveEffectiveActiveRun<T extends Pick<RunRecord, "id" | "status">>(params: {
  activeRun?: T | undefined;
  latestRun?: T | undefined;
}): T | undefined {
  if (params.activeRun) return params.activeRun;
  if (params.latestRun && isActiveRunStatus(params.latestRun.status)) return params.latestRun;
  return undefined;
}
