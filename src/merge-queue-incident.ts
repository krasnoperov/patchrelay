import type { NormalizedGitHubEvent } from "./github-types.ts";
import { safeJsonParse } from "./utils.ts";

export interface QueueEvictionIncidentContext {
  version?: number;
  failureClass?: string;
  baseSha?: string;
  prHeadSha?: string;
  queuePosition?: number;
  baseBranch?: string;
  branch?: string;
  issueKey?: string | null;
  conflictFiles?: string[];
  failedChecks?: Array<{ name: string; conclusion: string; url?: string }>;
  retryHistory?: Array<{ at: string; baseSha: string; outcome: string }>;
}

export interface QueueRepairContext {
  failureReason: "queue_eviction";
  checkName?: string;
  checkUrl?: string;
  incidentId?: string;
  incidentUrl?: string;
  incidentTitle?: string;
  incidentSummary?: string;
  incidentContext?: QueueEvictionIncidentContext;
}

export function buildQueueRepairContextFromEvent(
  event: Pick<
    NormalizedGitHubEvent,
    "checkName" | "checkUrl" | "checkDetailsUrl" | "checkOutputTitle" | "checkOutputSummary" | "checkOutputText"
  >,
): QueueRepairContext {
  const payload = parseQueueEvictionPayload(event.checkOutputText);
  const incidentUrl = event.checkDetailsUrl ?? payload?.incidentUrl;
  return {
    failureReason: "queue_eviction",
    ...(event.checkName ? { checkName: event.checkName } : {}),
    ...(event.checkUrl ? { checkUrl: event.checkUrl } : {}),
    ...(payload?.incidentId ? { incidentId: payload.incidentId } : {}),
    ...(incidentUrl ? { incidentUrl } : {}),
    ...(event.checkOutputTitle ? { incidentTitle: event.checkOutputTitle } : {}),
    ...(event.checkOutputSummary ? { incidentSummary: event.checkOutputSummary } : {}),
    ...(payload?.incidentContext ? { incidentContext: payload.incidentContext } : {}),
  };
}

export function parseStoredQueueRepairContext(json?: string): QueueRepairContext | undefined {
  if (!json) return undefined;
  const parsed = safeJsonParse<Record<string, unknown>>(json);
  if (!parsed || typeof parsed !== "object") return undefined;
  if (parsed.failureReason !== "queue_eviction") return undefined;
  const incidentContext = normalizeIncidentContext(parsed.incidentContext);
  return {
    failureReason: "queue_eviction",
    ...(typeof parsed.checkName === "string" ? { checkName: parsed.checkName } : {}),
    ...(typeof parsed.checkUrl === "string" ? { checkUrl: parsed.checkUrl } : {}),
    ...(typeof parsed.incidentId === "string" ? { incidentId: parsed.incidentId } : {}),
    ...(typeof parsed.incidentUrl === "string" ? { incidentUrl: parsed.incidentUrl } : {}),
    ...(typeof parsed.incidentTitle === "string" ? { incidentTitle: parsed.incidentTitle } : {}),
    ...(typeof parsed.incidentSummary === "string" ? { incidentSummary: parsed.incidentSummary } : {}),
    ...(incidentContext ? { incidentContext } : {}),
  };
}

function parseQueueEvictionPayload(text?: string): {
  incidentId?: string;
  incidentUrl?: string;
  incidentContext?: QueueEvictionIncidentContext;
} | undefined {
  if (!text) return undefined;
  const parsed = safeJsonParse<Record<string, unknown>>(text);
  if (!parsed || typeof parsed !== "object") return undefined;

  const incidentContext = normalizeIncidentContext(parsed.incidentContext ?? parsed);
  if (!incidentContext && typeof parsed.incidentId !== "string" && typeof parsed.incidentUrl !== "string") {
    return undefined;
  }

  return {
    ...(typeof parsed.incidentId === "string" ? { incidentId: parsed.incidentId } : {}),
    ...(typeof parsed.incidentUrl === "string" ? { incidentUrl: parsed.incidentUrl } : {}),
    ...(incidentContext ? { incidentContext } : {}),
  };
}

function normalizeIncidentContext(value: unknown): QueueEvictionIncidentContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const failedChecks = Array.isArray(record.failedChecks)
    ? record.failedChecks
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => {
        const check = entry as Record<string, unknown>;
        if (typeof check.name !== "string" || typeof check.conclusion !== "string") return undefined;
        return {
          name: check.name,
          conclusion: check.conclusion,
          ...(typeof check.url === "string" ? { url: check.url } : {}),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : undefined;
  const retryHistory = Array.isArray(record.retryHistory)
    ? record.retryHistory
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => {
        const retry = entry as Record<string, unknown>;
        if (typeof retry.at !== "string" || typeof retry.baseSha !== "string" || typeof retry.outcome !== "string") {
          return undefined;
        }
        return {
          at: retry.at,
          baseSha: retry.baseSha,
          outcome: retry.outcome,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : undefined;
  const conflictFiles = Array.isArray(record.conflictFiles)
    ? record.conflictFiles.filter((entry): entry is string => typeof entry === "string")
    : undefined;

  const normalized: QueueEvictionIncidentContext = {
    ...(typeof record.version === "number" ? { version: record.version } : {}),
    ...(typeof record.failureClass === "string" ? { failureClass: record.failureClass } : {}),
    ...(typeof record.baseSha === "string" ? { baseSha: record.baseSha } : {}),
    ...(typeof record.prHeadSha === "string" ? { prHeadSha: record.prHeadSha } : {}),
    ...(typeof record.queuePosition === "number" ? { queuePosition: record.queuePosition } : {}),
    ...(typeof record.baseBranch === "string" ? { baseBranch: record.baseBranch } : {}),
    ...(typeof record.branch === "string" ? { branch: record.branch } : {}),
    ...(typeof record.issueKey === "string" || record.issueKey === null ? { issueKey: record.issueKey as string | null } : {}),
    ...(conflictFiles?.length ? { conflictFiles } : {}),
    ...(failedChecks?.length ? { failedChecks } : {}),
    ...(retryHistory?.length ? { retryHistory } : {}),
  };

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}
