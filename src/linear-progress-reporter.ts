import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { LinearAgentActivityContent } from "./types.ts";
import { sanitizeOperatorFacingCommand, sanitizeOperatorFacingText } from "./presentation-text.ts";

const PROGRESS_THROTTLE_MS = 5_000;
const MAX_PROGRESS_TEXT_LENGTH = 220;

export class LinearProgressReporter {
  private readonly progressThrottle = new Map<number, number>();
  private readonly workingOnPublishedRuns = new Set<number>();
  private readonly agentMessageBuffers = new Map<string, string>();
  private readonly agentMessageProgressPublished = new Set<string>();

  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly emitActivity: (
      issue: IssueRecord,
      content: LinearAgentActivityContent,
      options?: { ephemeral?: boolean },
    ) => Promise<void>,
  ) {}

  maybeEmitProgress(notification: { method: string; params: Record<string, unknown> }, run: RunRecord): void {
    const issue = this.db.issues.getIssue(run.projectId, run.linearIssueId);
    if (!issue) return;

    const agentSentence = this.consumeAgentMessageSentence(notification, run);
    const workingOn = resolveWorkingOnActivity(notification, agentSentence?.sentence);
    if (workingOn && !this.workingOnPublishedRuns.has(run.id)) {
      this.workingOnPublishedRuns.add(run.id);
      void this.emitActivity(issue, workingOn);
    }

    const progress = resolveEphemeralProgressActivity(notification, agentSentence?.sentence);
    if (!progress) return;

    if (!progress.bypassThrottle) {
      const now = Date.now();
      const lastEmit = this.progressThrottle.get(run.id) ?? 0;
      if (now - lastEmit < PROGRESS_THROTTLE_MS) return;
      this.progressThrottle.set(run.id, now);
    }

    void this.emitActivity(issue, progress.activity, { ephemeral: true });
  }

  clearProgress(runId: number): void {
    this.progressThrottle.delete(runId);
    this.workingOnPublishedRuns.delete(runId);
    for (const key of this.agentMessageBuffers.keys()) {
      if (key.startsWith(`${runId}:`)) {
        this.agentMessageBuffers.delete(key);
      }
    }
    for (const key of this.agentMessageProgressPublished) {
      if (key.startsWith(`${runId}:`)) {
        this.agentMessageProgressPublished.delete(key);
      }
    }
  }

  private consumeAgentMessageSentence(
    notification: { method: string; params: Record<string, unknown> },
    run: RunRecord,
  ): { sentence: string } | undefined {
    const messageKey = resolveAgentMessageKey(notification, run);
    if (!messageKey) return undefined;
    if (this.agentMessageProgressPublished.has(messageKey)) return undefined;

    const delta = resolveAgentMessageDelta(notification);
    if (delta) {
      const previous = this.agentMessageBuffers.get(messageKey) ?? "";
      const next = `${previous}${delta}`;
      this.agentMessageBuffers.set(messageKey, next);
      const sentence = extractFirstCompletedSentence(next);
      if (!sentence) return undefined;
      this.agentMessageProgressPublished.add(messageKey);
      return { sentence };
    }

    const completedText = resolveCompletedAgentMessageText(notification);
    if (!completedText) return undefined;
    const sentence = extractFirstSentence(completedText);
    if (!sentence) return undefined;
    this.agentMessageProgressPublished.add(messageKey);
    return { sentence };
  }
}

function resolveWorkingOnActivity(
  notification: { method: string; params: Record<string, unknown> },
  agentSentence?: string,
): LinearAgentActivityContent | undefined {
  const summary = resolveWorkingOnSummary(notification) ?? agentSentence;
  if (!summary) return undefined;
  return { type: "response", body: `Working on: ${summary}` };
}

function resolveEphemeralProgressActivity(
  notification: { method: string; params: Record<string, unknown> },
  agentSentence?: string,
): { activity: LinearAgentActivityContent; bypassThrottle?: boolean } | undefined {
  if (notification.method === "item/started") {
    const item = notification.params.item as Record<string, unknown> | undefined;
    if (!item) return undefined;
    const type = typeof item.type === "string" ? item.type : undefined;

    if (type === "commandExecution") {
      const cmd = item.command;
      const cmdStr = Array.isArray(cmd)
        ? sanitizeOperatorFacingCommand(cmd.map((part) => String(part)).join(" "))
        : sanitizeOperatorFacingCommand(typeof cmd === "string" ? cmd : undefined);
      return { activity: { type: "action", action: "Running", parameter: truncateProgressText(cmdStr ?? "command", 120) } };
    }
    if (type === "mcpToolCall") {
      const server = typeof item.server === "string" ? item.server : "";
      const tool = typeof item.tool === "string" ? item.tool : "";
      return { activity: { type: "action", action: "Using", parameter: `${server}/${tool}` } };
    }
    if (type === "dynamicToolCall") {
      const tool = typeof item.tool === "string" ? item.tool : "tool";
      return { activity: { type: "action", action: "Using", parameter: tool } };
    }
  }

  if (agentSentence) {
    return {
      activity: { type: "thought", body: agentSentence },
      bypassThrottle: true,
    };
  }

  return undefined;
}

function resolveWorkingOnSummary(notification: { method: string; params: Record<string, unknown> }): string | undefined {
  if (notification.method !== "turn/plan/updated") {
    return undefined;
  }
  const plan = notification.params.plan;
  if (!Array.isArray(plan)) return undefined;

  const ranked = plan
    .map((entry) => entry as Record<string, unknown>)
    .filter((entry) => typeof entry.step === "string" && entry.step.trim().length > 0)
    .sort((a, b) => rankPlanStatus(a.status) - rankPlanStatus(b.status));
  const first = ranked[0];
  return summarizeProgressSentence(typeof first?.step === "string" ? first.step : undefined);
}

function rankPlanStatus(status: unknown): number {
  return status === "inProgress" ? 0
    : status === "pending" ? 1
    : status === "completed" ? 2
    : 3;
}

function resolveAgentMessageKey(
  notification: { method: string; params: Record<string, unknown> },
  run: RunRecord,
): string | undefined {
  if (notification.method === "item/agentMessage/delta") {
    const itemId = typeof notification.params.itemId === "string" ? notification.params.itemId : undefined;
    return itemId ? `${run.id}:${itemId}` : undefined;
  }
  if (notification.method === "item/completed") {
    const item = notification.params.item as Record<string, unknown> | undefined;
    const itemId = typeof item?.id === "string" ? item.id : undefined;
    const itemType = typeof item?.type === "string" ? item.type : undefined;
    return itemId && itemType === "agentMessage" ? `${run.id}:${itemId}` : undefined;
  }
  return undefined;
}

function resolveAgentMessageDelta(notification: { method: string; params: Record<string, unknown> }): string | undefined {
  if (notification.method !== "item/agentMessage/delta") {
    return undefined;
  }
  return typeof notification.params.delta === "string" ? notification.params.delta : undefined;
}

function resolveCompletedAgentMessageText(notification: { method: string; params: Record<string, unknown> }): string | undefined {
  if (notification.method !== "item/completed") {
    return undefined;
  }
  const item = notification.params.item as Record<string, unknown> | undefined;
  if (!item || item.type !== "agentMessage") return undefined;
  return typeof item.text === "string" ? item.text : undefined;
}

function extractFirstSentence(text: string | undefined): string | undefined {
  const sanitized = sanitizeOperatorFacingText(text)?.replace(/\s+/g, " ").trim();
  if (!sanitized) return undefined;
  const match = sanitized.match(/^(.+?[.!?])(?:\s|$)/);
  return truncateProgressText((match?.[1] ?? sanitized).trim(), MAX_PROGRESS_TEXT_LENGTH);
}

function extractFirstCompletedSentence(text: string | undefined): string | undefined {
  const sanitized = sanitizeOperatorFacingText(text)?.replace(/\s+/g, " ").trim();
  if (!sanitized) return undefined;
  const match = sanitized.match(/^(.+?[.!?])(?:\s|$)/);
  return match?.[1] ? truncateProgressText(match[1].trim(), MAX_PROGRESS_TEXT_LENGTH) : undefined;
}

function summarizeProgressSentence(text: string | undefined): string | undefined {
  const summary = extractFirstSentence(text);
  if (!summary) return undefined;
  return summary.endsWith(".") || summary.endsWith("!") || summary.endsWith("?") ? summary : `${summary}.`;
}

function truncateProgressText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3).trimEnd()}...`;
}
