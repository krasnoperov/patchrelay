import type { Logger } from "pino";
import type { LinearAgentActivitySnapshot, LinearClientProvider } from "./types.ts";

const ACTIVITY_RECOVERY_LIMIT = 20;
const MAX_CONTEXT_ACTIVITIES = 8;
const MAX_ACTIVITY_TEXT_LENGTH = 500;

function trimBounded(value: string, maxLength = MAX_ACTIVITY_TEXT_LENGTH): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

function hasRecoveredContext(context?: Record<string, unknown>): boolean {
  return typeof context?.linearAgentActivityContext === "string" && context.linearAgentActivityContext.trim().length > 0;
}

function hasLocalHumanContext(context?: Record<string, unknown>): boolean {
  if (hasRecoveredContext(context)) return true;
  for (const key of ["promptContext", "promptBody", "operatorPrompt", "userComment"]) {
    const value = context?.[key];
    if (typeof value === "string" && value.trim().length > 0) return true;
  }
  if (!Array.isArray(context?.followUps)) return false;
  return context.followUps.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const text = (entry as Record<string, unknown>).text;
    return typeof text === "string" && text.trim().length > 0;
  });
}

function activitySortKey(activity: LinearAgentActivitySnapshot): number {
  const parsed = activity.updatedAt ? Date.parse(activity.updatedAt) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function describeActivity(activity: LinearAgentActivitySnapshot): string | undefined {
  const type = activity.type?.trim() || "activity";
  const body = typeof activity.body === "string" ? trimBounded(activity.body) : "";
  if (body) {
    return `${type}: ${body}`;
  }

  if (activity.action || activity.parameter || activity.result) {
    const action = activity.action ? trimBounded(activity.action, 120) : "action";
    const parameter = activity.parameter ? ` ${trimBounded(activity.parameter, 180)}` : "";
    const result = activity.result ? ` -> ${trimBounded(activity.result, 180)}` : "";
    return `${type}: ${action}${parameter}${result}`;
  }

  return undefined;
}

export function summarizeLinearAgentActivities(
  activities: LinearAgentActivitySnapshot[],
): Record<string, unknown> | undefined {
  const lines = [...activities]
    .sort((left, right) => activitySortKey(left) - activitySortKey(right))
    .map(describeActivity)
    .filter((line): line is string => Boolean(line))
    .slice(-MAX_CONTEXT_ACTIVITIES);

  if (lines.length === 0) return undefined;
  return {
    linearAgentActivityContext: lines.map((line) => `- ${line}`).join("\n"),
    linearAgentActivityCount: lines.length,
  };
}

export async function recoverLinearAgentActivityContext(params: {
  linearProvider: LinearClientProvider;
  projectId: string;
  agentSessionId?: string | undefined;
  context?: Record<string, unknown> | undefined;
  issueKey?: string | undefined;
  logger: Logger;
}): Promise<Record<string, unknown> | undefined> {
  if (!params.agentSessionId || hasLocalHumanContext(params.context)) {
    return undefined;
  }

  try {
    const linear = await params.linearProvider.forProject(params.projectId);
    if (!linear?.listAgentSessionActivities) {
      return undefined;
    }
    const activities = await linear.listAgentSessionActivities(params.agentSessionId, {
      first: ACTIVITY_RECOVERY_LIMIT,
    });
    return summarizeLinearAgentActivities(activities);
  } catch (error) {
    params.logger.warn(
      {
        issueKey: params.issueKey,
        agentSessionId: params.agentSessionId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to recover Linear agent activity context",
    );
    return undefined;
  }
}
