import type {
  GitHubCiSnapshotCheckRecord,
  GitHubCiSnapshotRecord,
  GitHubFailureSource,
} from "./db-types.ts";
import type { NormalizedGitHubEvent } from "./github-types.ts";
import { execCommand, safeJsonParse, sanitizeDiagnosticText } from "./utils.ts";

export interface GitHubFailureContext {
  source: GitHubFailureSource;
  repoFullName: string;
  capturedAt: string;
  headSha?: string | undefined;
  failureSignature: string;
  checkName?: string | undefined;
  checkUrl?: string | undefined;
  checkDetailsUrl?: string | undefined;
  workflowRunId?: number | undefined;
  workflowName?: string | undefined;
  jobName?: string | undefined;
  stepName?: string | undefined;
  summary?: string | undefined;
  annotations?: string[] | undefined;
}

interface CheckRunSummary {
  id?: number;
  name?: string;
  htmlUrl?: string;
  detailsUrl?: string;
  conclusion?: string;
  outputTitle?: string;
  outputSummary?: string;
  outputText?: string;
}

interface WorkflowJobSummary {
  name?: string;
  conclusion?: string;
  stepName?: string;
}

export interface GitHubCiSnapshotResolver {
  resolve(params: {
    repoFullName: string;
    event: NormalizedGitHubEvent;
    gateCheckNames: string[];
  }): Promise<GitHubCiSnapshotRecord | undefined>;
}

const FAILED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "startup_failure",
  "action_required",
  "stale",
]);

export interface GitHubFailureContextResolver {
  resolve(params: {
    source: GitHubFailureSource;
    repoFullName: string;
    event: NormalizedGitHubEvent;
  }): Promise<GitHubFailureContext | undefined>;
}

export function createGitHubFailureContextResolver(): GitHubFailureContextResolver {
  return {
    resolve: async ({ source, repoFullName, event }) => {
      if (!repoFullName) return undefined;

      if (source === "queue_eviction") {
        const queueContext = buildFallbackFailureContext(source, repoFullName, event);
        return {
          ...queueContext,
          failureSignature: buildFailureSignature({
            source,
            headSha: queueContext.headSha,
            checkName: queueContext.checkName,
          }),
        };
      }

      const fallback = buildFallbackFailureContext(source, repoFullName, event);
      try {
        const failedCheck = await resolveFailedCheckRun(repoFullName, event);
        const workflowRunId = parseWorkflowRunId(
          failedCheck?.detailsUrl ?? failedCheck?.htmlUrl ?? event.checkDetailsUrl ?? event.checkUrl,
        );
        const workflowJob = workflowRunId
          ? await resolveWorkflowJob(repoFullName, workflowRunId, failedCheck?.name ?? event.checkName)
          : undefined;
        const annotations = failedCheck?.id
          ? await resolveAnnotations(repoFullName, failedCheck.id)
          : undefined;

        const summary = firstNonEmpty(
          annotations?.[0],
          failedCheck?.outputTitle,
          failedCheck?.outputSummary,
          event.checkOutputTitle,
          event.checkOutputSummary,
          workflowJob?.stepName ? `Failed step: ${workflowJob.stepName}` : undefined,
        );
        const checkName = firstNonEmpty(failedCheck?.name, event.checkName);
        const checkUrl = firstNonEmpty(failedCheck?.htmlUrl, event.checkUrl);
        const checkDetailsUrl = firstNonEmpty(failedCheck?.detailsUrl, event.checkDetailsUrl);
        const jobName = firstNonEmpty(workflowJob?.name, failedCheck?.name, event.checkName);
        const stepName = workflowJob?.stepName;
        return {
          source,
          repoFullName,
          capturedAt: new Date().toISOString(),
          ...(event.headSha ? { headSha: event.headSha } : {}),
          ...(checkName ? { checkName } : {}),
          ...(checkUrl ? { checkUrl } : {}),
          ...(checkDetailsUrl ? { checkDetailsUrl } : {}),
          ...(workflowRunId !== undefined ? { workflowRunId } : {}),
          ...(jobName ? { jobName } : {}),
          ...(stepName ? { stepName } : {}),
          ...(summary ? { summary } : {}),
          ...(annotations && annotations.length > 0 ? { annotations } : {}),
          failureSignature: buildFailureSignature({
            source,
            headSha: event.headSha,
            checkName,
            jobName,
            stepName,
          }),
        };
      } catch {
        return {
          ...fallback,
          failureSignature: buildFailureSignature({
            source,
            headSha: fallback.headSha,
            checkName: fallback.checkName,
            stepName: fallback.stepName,
          }),
        };
      }
    },
  };
}

export function createGitHubCiSnapshotResolver(): GitHubCiSnapshotResolver {
  return {
    resolve: async ({ repoFullName, event, gateCheckNames }) => {
      if (!repoFullName || !event.headSha) return undefined;
      try {
        const checks = await resolveCheckSnapshotChecks(repoFullName, event.headSha);
        return buildCiSnapshotFromChecks(checks, event, gateCheckNames);
      } catch {
        return buildFallbackCiSnapshot(event, gateCheckNames);
      }
    },
  };
}

export function parseGitHubFailureContext(value: string | undefined): GitHubFailureContext | undefined {
  if (!value) return undefined;
  return safeJsonParse<GitHubFailureContext>(value);
}

export function summarizeGitHubFailureContext(
  context: Pick<GitHubFailureContext, "checkName" | "jobName" | "stepName" | "summary"> & { source?: GitHubFailureSource | undefined } | undefined,
): string | undefined {
  if (!context) return undefined;
  if (context.source === "queue_eviction") {
    return firstNonEmpty(context.summary, context.checkName, "Queue eviction");
  }
  const lead = firstNonEmpty(context.jobName, context.checkName);
  const step = context.stepName ? `${lead ?? "CI"} -> ${context.stepName}` : lead;
  return firstNonEmpty(
    step && context.summary ? `${step}: ${context.summary}` : undefined,
    step,
    context.summary,
  );
}

function buildFallbackFailureContext(
  source: GitHubFailureSource,
  repoFullName: string,
  event: NormalizedGitHubEvent,
): Omit<GitHubFailureContext, "failureSignature"> {
  const summary = firstNonEmpty(
    event.checkOutputTitle,
    event.checkOutputSummary,
    event.checkOutputText ? sanitizeDiagnosticText(event.checkOutputText, 240) : undefined,
  );
  return {
    source,
    repoFullName,
    capturedAt: new Date().toISOString(),
    ...(event.headSha ? { headSha: event.headSha } : {}),
    ...(event.checkName ? { checkName: event.checkName } : {}),
    ...(event.checkUrl ? { checkUrl: event.checkUrl } : {}),
    ...(event.checkDetailsUrl ? { checkDetailsUrl: event.checkDetailsUrl } : {}),
    ...(event.checkName ? { jobName: event.checkName } : {}),
    ...(summary ? { summary } : {}),
  };
}

function buildFallbackCiSnapshot(
  event: NormalizedGitHubEvent,
  gateCheckNames: string[],
): GitHubCiSnapshotRecord | undefined {
  if (!event.headSha) return undefined;
  const gateCheckName = pickGateCheckName(gateCheckNames, event.checkName) ?? event.checkName;
  const gateCheckStatus = deriveCheckStatus({
    eventStatus: event.checkStatus,
    eventConclusion: event.triggerEvent === "check_passed" ? "success" : "failure",
  });
  const check = event.checkName
    ? [{
        name: event.checkName,
        status: gateCheckStatus,
        ...(event.triggerEvent === "check_passed" ? { conclusion: "success" } : { conclusion: "failure" }),
        ...(firstNonEmpty(event.checkDetailsUrl, event.checkUrl) ? { detailsUrl: firstNonEmpty(event.checkDetailsUrl, event.checkUrl) } : {}),
        ...(firstNonEmpty(event.checkOutputTitle, event.checkOutputSummary) ? { summary: firstNonEmpty(event.checkOutputTitle, event.checkOutputSummary) } : {}),
      } satisfies GitHubCiSnapshotCheckRecord]
    : [];
  return {
    headSha: event.headSha,
    ...(gateCheckName ? { gateCheckName } : {}),
    gateCheckStatus,
    failedChecks: check.filter((entry) => entry.status === "failure"),
    checks: check,
    ...(gateCheckStatus !== "pending" ? { settledAt: new Date().toISOString() } : {}),
    capturedAt: new Date().toISOString(),
  };
}

async function resolveFailedCheckRun(repoFullName: string, event: NormalizedGitHubEvent): Promise<CheckRunSummary | undefined> {
  if (!event.headSha) return undefined;
  const response = await execCommand("gh", [
    "api",
    `repos/${repoFullName}/commits/${event.headSha}/check-runs`,
    "--method", "GET",
  ], { timeoutMs: 15_000 });
  if (response.exitCode !== 0) {
    throw new Error(response.stderr || "gh api check-runs failed");
  }
  const payload = safeJsonParse<{ check_runs?: Array<Record<string, unknown>> }>(response.stdout);
  const checks = (payload?.check_runs ?? [])
    .map(mapCheckRunSummary)
    .filter((entry) => entry.conclusion && FAILED_CONCLUSIONS.has(entry.conclusion.toLowerCase()));
  return checks.find((entry) => entry.name === event.checkName)
    ?? checks.find((entry) => entry.name && event.checkName && entry.name.includes(event.checkName))
    ?? checks[0];
}

async function resolveCheckSnapshotChecks(repoFullName: string, headSha: string): Promise<GitHubCiSnapshotCheckRecord[]> {
  const response = await execCommand("gh", [
    "api",
    `repos/${repoFullName}/commits/${headSha}/check-runs`,
    "--method", "GET",
  ], { timeoutMs: 15_000 });
  if (response.exitCode !== 0) {
    throw new Error(response.stderr || "gh api check-runs failed");
  }
  const payload = safeJsonParse<{ check_runs?: Array<Record<string, unknown>> }>(response.stdout);
  return (payload?.check_runs ?? []).map(mapCiSnapshotCheck).filter((entry): entry is GitHubCiSnapshotCheckRecord => Boolean(entry));
}

async function resolveWorkflowJob(
  repoFullName: string,
  workflowRunId: number,
  preferredName?: string,
): Promise<WorkflowJobSummary | undefined> {
  const response = await execCommand("gh", [
    "api",
    `repos/${repoFullName}/actions/runs/${workflowRunId}/jobs`,
    "--method", "GET",
  ], { timeoutMs: 15_000 });
  if (response.exitCode !== 0) {
    throw new Error(response.stderr || "gh api workflow jobs failed");
  }
  const payload = safeJsonParse<{ jobs?: Array<Record<string, unknown>> }>(response.stdout);
  const jobs = (payload?.jobs ?? []).map(mapWorkflowJobSummary);
  return jobs.find((entry) => entry.name === preferredName)
    ?? jobs.find((entry) => entry.name && preferredName && entry.name.includes(preferredName))
    ?? jobs.find((entry) => entry.conclusion && FAILED_CONCLUSIONS.has(entry.conclusion.toLowerCase()))
    ?? jobs[0];
}

async function resolveAnnotations(repoFullName: string, checkRunId: number): Promise<string[]> {
  const response = await execCommand("gh", [
    "api",
    `repos/${repoFullName}/check-runs/${checkRunId}/annotations`,
    "--method", "GET",
    "-F", "per_page=20",
  ], { timeoutMs: 15_000 });
  if (response.exitCode !== 0) {
    throw new Error(response.stderr || "gh api annotations failed");
  }
  const payload = safeJsonParse<Array<Record<string, unknown>>>(response.stdout) ?? [];
  return payload
    .map((entry) => {
      const title = typeof entry.title === "string" ? entry.title.trim() : "";
      const message = typeof entry.message === "string" ? entry.message.trim() : "";
      const path = typeof entry.path === "string" ? entry.path.trim() : "";
      const rendered = [title, message, path ? `(${path})` : ""].filter(Boolean).join(": ");
      return rendered ? sanitizeDiagnosticText(rendered, 240) : undefined;
    })
    .filter((entry): entry is string => Boolean(entry));
}

function mapCheckRunSummary(row: Record<string, unknown>): CheckRunSummary {
  const output = row.output && typeof row.output === "object" ? row.output as Record<string, unknown> : undefined;
  return {
    ...(typeof row.id === "number" ? { id: row.id } : {}),
    ...(typeof row.name === "string" ? { name: row.name } : {}),
    ...(typeof row.html_url === "string" ? { htmlUrl: row.html_url } : {}),
    ...(typeof row.details_url === "string" ? { detailsUrl: row.details_url } : {}),
    ...(typeof row.conclusion === "string" ? { conclusion: row.conclusion } : {}),
    ...(typeof output?.title === "string" ? { outputTitle: output.title } : {}),
    ...(typeof output?.summary === "string" ? { outputSummary: sanitizeDiagnosticText(output.summary, 240) } : {}),
    ...(typeof output?.text === "string" ? { outputText: sanitizeDiagnosticText(output.text, 240) } : {}),
  };
}

function mapCiSnapshotCheck(row: Record<string, unknown>): GitHubCiSnapshotCheckRecord | undefined {
  if (typeof row.name !== "string" || !row.name.trim()) return undefined;
  const output = row.output && typeof row.output === "object" ? row.output as Record<string, unknown> : undefined;
  const status = deriveCheckStatus({
    apiStatus: typeof row.status === "string" ? row.status : undefined,
    apiConclusion: typeof row.conclusion === "string" ? row.conclusion : undefined,
  });
  return {
    name: row.name.trim(),
    status,
    ...(typeof row.conclusion === "string" && row.conclusion.trim() ? { conclusion: row.conclusion.trim().toLowerCase() } : {}),
    ...(typeof row.details_url === "string" && row.details_url.trim() ? { detailsUrl: row.details_url.trim() } : {}),
    ...(firstNonEmpty(
      typeof output?.title === "string" ? output.title : undefined,
      typeof output?.summary === "string" ? sanitizeDiagnosticText(output.summary, 240) : undefined,
    ) ? { summary: firstNonEmpty(
      typeof output?.title === "string" ? output.title : undefined,
      typeof output?.summary === "string" ? sanitizeDiagnosticText(output.summary, 240) : undefined,
    ) } : {}),
  };
}

function mapWorkflowJobSummary(row: Record<string, unknown>): WorkflowJobSummary {
  const steps = Array.isArray(row.steps) ? row.steps.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object") : [];
  const failedStep = steps.find((entry) => {
    const conclusion = typeof entry.conclusion === "string" ? entry.conclusion.toLowerCase() : "";
    return FAILED_CONCLUSIONS.has(conclusion);
  });
  const informativeStep = failedStep ?? steps.findLast((entry) => typeof entry.name === "string");
  return {
    ...(typeof row.name === "string" ? { name: row.name } : {}),
    ...(typeof row.conclusion === "string" ? { conclusion: row.conclusion } : {}),
    ...(typeof informativeStep?.name === "string" ? { stepName: informativeStep.name } : {}),
  };
}

function parseWorkflowRunId(url: string | undefined): number | undefined {
  if (!url) return undefined;
  const match = url.match(/\/actions\/runs\/(\d+)/);
  return match ? Number(match[1]) : undefined;
}

function buildCiSnapshotFromChecks(
  checks: GitHubCiSnapshotCheckRecord[],
  event: NormalizedGitHubEvent,
  gateCheckNames: string[],
): GitHubCiSnapshotRecord {
  const gateCheck = findGateCheck(checks, gateCheckNames, event.checkName);
  const gateCheckName = gateCheck?.name ?? pickGateCheckName(gateCheckNames, event.checkName) ?? event.checkName;
  const gateCheckStatus = gateCheck?.status ?? deriveCheckStatus({
    eventStatus: event.checkStatus,
    eventConclusion: event.triggerEvent === "check_passed" ? "success" : "failure",
  });
  const failedChecks = checks.filter((entry) => entry.status === "failure");
  return {
    headSha: event.headSha,
    ...(gateCheckName ? { gateCheckName } : {}),
    gateCheckStatus,
    failedChecks,
    checks,
    ...(gateCheckStatus !== "pending" ? { settledAt: new Date().toISOString() } : {}),
    capturedAt: new Date().toISOString(),
  };
}

function findGateCheck(
  checks: GitHubCiSnapshotCheckRecord[],
  gateCheckNames: string[],
  fallbackCheckName?: string,
): GitHubCiSnapshotCheckRecord | undefined {
  const exactNames = gateCheckNames.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (exactNames.length > 0) {
    const exact = checks.find((entry) => exactNames.includes(entry.name.trim().toLowerCase()));
    if (exact) return exact;
  }
  if (!fallbackCheckName) return undefined;
  const fallback = fallbackCheckName.trim().toLowerCase();
  return checks.find((entry) => entry.name.trim().toLowerCase() === fallback);
}

function pickGateCheckName(gateCheckNames: string[], fallbackCheckName?: string): string | undefined {
  return gateCheckNames.find((entry) => entry.trim().length > 0)?.trim()
    ?? fallbackCheckName?.trim();
}

function deriveCheckStatus(params: {
  apiStatus?: string | undefined;
  apiConclusion?: string | undefined;
  eventStatus?: string | undefined;
  eventConclusion?: string | undefined;
}): "pending" | "success" | "failure" {
  const status = params.apiStatus?.trim().toLowerCase();
  if (status === "queued" || status === "in_progress" || status === "requested" || status === "waiting" || status === "pending") {
    return "pending";
  }
  const conclusion = params.apiConclusion?.trim().toLowerCase()
    ?? params.eventConclusion?.trim().toLowerCase()
    ?? params.eventStatus?.trim().toLowerCase();
  if (conclusion === "success" || conclusion === "neutral" || conclusion === "skipped") {
    return "success";
  }
  if (conclusion && FAILED_CONCLUSIONS.has(conclusion)) {
    return "failure";
  }
  return status === "completed" ? "failure" : "pending";
}

function buildFailureSignature(parts: {
  source: GitHubFailureSource;
  headSha?: string | undefined;
  checkName?: string | undefined;
  jobName?: string | undefined;
  stepName?: string | undefined;
}): string {
  return [
    parts.source,
    parts.headSha ?? "unknown-sha",
    parts.jobName ?? parts.checkName ?? "unknown-check",
    parts.stepName ?? "unknown-step",
  ].join("::");
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim();
}
