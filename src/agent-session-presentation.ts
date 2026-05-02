import type { AppConfig, LinearAgentSessionExternalUrl } from "./types.ts";
import {
  buildSessionStatusUrl,
  createSessionStatusToken,
  deriveSessionStatusSigningSecret,
} from "./public-agent-session-status.ts";

const SESSION_STATUS_TTL_SECONDS = 60 * 60 * 24 * 7;

export function buildAgentSessionExternalUrls(
  config: AppConfig,
  params: {
    issueKey?: string;
    prUrl?: string;
    activeRunId?: number;
    prReviewState?: string;
    prCheckStatus?: string;
    lastGitHubFailureSource?: string;
    lastGitHubFailureCheckName?: string;
    lastGitHubFailureCheckUrl?: string;
    lastQueueIncidentJson?: string;
  },
): LinearAgentSessionExternalUrl[] | undefined {
  const urls: LinearAgentSessionExternalUrl[] = [];
  const statusUrl = params.issueKey && config.server.publicBaseUrl
    ? buildPublicStatusUrl(config, params.issueKey)
    : undefined;

  if (statusUrl) {
    urls.push({
      label: "PatchRelay status",
      url: statusUrl,
    });
  }

  if (params.prUrl) {
    urls.push({
      label: "Pull request",
      url: params.prUrl,
    });
  }

  const reviewQuillUrl = buildReviewQuillUrl(params);
  if (reviewQuillUrl) {
    urls.push({
      label: "Review-quill status",
      url: reviewQuillUrl,
    });
  }

  const mergeStewardUrl = buildMergeStewardUrl(params);
  if (mergeStewardUrl) {
    urls.push({
      label: "Merge-steward queue",
      url: mergeStewardUrl,
    });
  }

  if (statusUrl && params.activeRunId !== undefined) {
    urls.push({
      label: "Active run",
      url: withFragment(statusUrl, "current-view"),
    });
  }

  return urls.length > 0 ? urls : undefined;
}

function buildPublicStatusUrl(config: AppConfig, issueKey: string): string | undefined {
  if (!config.server.publicBaseUrl) return undefined;
  const token = createSessionStatusToken({
    issueKey,
    secret: deriveSessionStatusSigningSecret(config.linear.tokenEncryptionKey),
    ttlSeconds: SESSION_STATUS_TTL_SECONDS,
  });

  return buildSessionStatusUrl({
    publicBaseUrl: config.server.publicBaseUrl,
    issueKey,
    token: token.token,
  });
}

function buildReviewQuillUrl(params: {
  prUrl?: string;
  prReviewState?: string;
  prCheckStatus?: string;
  lastGitHubFailureCheckName?: string;
  lastGitHubFailureCheckUrl?: string;
}): string | undefined {
  if (isReviewQuillCheck(params.lastGitHubFailureCheckName) && params.lastGitHubFailureCheckUrl) {
    return params.lastGitHubFailureCheckUrl;
  }

  if (!params.prUrl || !hasReviewQuillContext(params)) {
    return undefined;
  }

  return `${trimTrailingSlash(params.prUrl)}/checks`;
}

function buildMergeStewardUrl(params: {
  lastGitHubFailureSource?: string;
  lastGitHubFailureCheckName?: string;
  lastGitHubFailureCheckUrl?: string;
  lastQueueIncidentJson?: string;
}): string | undefined {
  const incidentUrl = parseQueueIncidentUrl(params.lastQueueIncidentJson);
  if (incidentUrl) return incidentUrl;

  if (
    params.lastGitHubFailureSource === "queue_eviction"
    || isMergeStewardCheck(params.lastGitHubFailureCheckName)
  ) {
    return params.lastGitHubFailureCheckUrl;
  }

  return undefined;
}

function hasReviewQuillContext(params: {
  prReviewState?: string;
  prCheckStatus?: string;
  lastGitHubFailureCheckName?: string;
}): boolean {
  if (isReviewQuillCheck(params.lastGitHubFailureCheckName)) return true;
  const reviewState = normalizeState(params.prReviewState);
  if (reviewState === "review_required" || reviewState === "changes_requested" || reviewState === "commented") {
    return true;
  }
  return normalizeState(params.prCheckStatus).includes("review");
}

function isReviewQuillCheck(checkName: string | undefined): boolean {
  return normalizeState(checkName).includes("review_quill");
}

function isMergeStewardCheck(checkName: string | undefined): boolean {
  return normalizeState(checkName).includes("merge_steward");
}

function parseQueueIncidentUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const incidentUrl = (parsed as { incidentUrl?: unknown }).incidentUrl;
    return typeof incidentUrl === "string" && incidentUrl.trim() ? incidentUrl.trim() : undefined;
  } catch {
    return undefined;
  }
}

function withFragment(url: string, fragment: string): string {
  const parsed = new URL(url);
  parsed.hash = fragment;
  return parsed.toString();
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeState(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[-/\s]+/g, "_");
}
