import type { CodexThreadItem, CodexThreadSummary, StageReport } from "./codex-types.ts";
import { getThreadTurns } from "./codex-thread-utils.ts";
import type { RunRecord, TrackedIssueRecord } from "./db-types.ts";

export function extractStageSummary(report: StageReport): Record<string, unknown> {
  return {
    commandCount: report.commandCount,
    fileChangeCount: report.fileChangeCount,
    toolCallCount: report.toolCallCount,
    latestAssistantMessage: report.latestAssistantMessage ?? null,
  };
}

export function summarizeCurrentThread(thread: CodexThreadSummary): {
  threadId: string;
  threadStatus: string;
  latestTurnId?: string;
  latestTurnStatus?: string;
  latestAgentMessage?: string;
  latestPlan?: string;
  activeCommand?: string;
  commandCount: number;
  fileChangeCount: number;
  toolCallCount: number;
} {
  const turns = getThreadTurns(thread);
  const latestTurn = turns.at(-1);
  const latestAgentMessage = latestTurn?.items
    .filter((item): item is Extract<CodexThreadItem, { type: "agentMessage" }> => item.type === "agentMessage")
    .at(-1)?.text;
  const latestPlan = latestTurn?.items
    .filter((item): item is Extract<CodexThreadItem, { type: "plan" }> => item.type === "plan")
    .at(-1)?.text;
  const activeCommand = latestTurn?.items
    .filter((item): item is Extract<CodexThreadItem, { type: "commandExecution" }> => item.type === "commandExecution")
    .filter((item) => item.status === "inProgress" || item.status === "running")
    .at(-1)?.command;
  let commandCount = 0;
  let fileChangeCount = 0;
  let toolCallCount = 0;

  for (const turn of turns) {
    for (const item of turn.items as CodexThreadItem[]) {
      if (item.type === "commandExecution") {
        commandCount += 1;
      } else if (item.type === "fileChange" && Array.isArray(item.changes)) {
        fileChangeCount += item.changes.length;
      } else if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
        toolCallCount += 1;
      }
    }
  }

  return {
    threadId: thread.id,
    threadStatus: thread.status,
    commandCount,
    fileChangeCount,
    toolCallCount,
    ...(latestTurn ? { latestTurnId: latestTurn.id, latestTurnStatus: latestTurn.status } : {}),
    ...(latestAgentMessage ? { latestAgentMessage } : {}),
    ...(latestPlan ? { latestPlan } : {}),
    ...(activeCommand ? { activeCommand } : {}),
  };
}

export function buildStageReport(
  run: RunRecord,
  issue: TrackedIssueRecord,
  thread: CodexThreadSummary,
): StageReport {
  let latestAssistantMessage: string | undefined;
  let latestPlan: string | undefined;
  let commandCount = 0;
  let fileChangeCount = 0;
  let toolCallCount = 0;

  for (const turn of getThreadTurns(thread)) {
    for (const rawItem of turn.items as CodexThreadItem[]) {
      const item = rawItem as CodexThreadItem & Record<string, unknown>;
      if (item.type === "agentMessage" && typeof item.text === "string") {
        latestAssistantMessage = compactProjectionText(item.text);
      } else if (item.type === "plan" && typeof item.text === "string") {
        latestPlan = compactProjectionText(item.text);
      } else if (item.type === "commandExecution") {
        commandCount += 1;
      } else if (item.type === "fileChange" && Array.isArray(item.changes)) {
        fileChangeCount += item.changes.length;
      } else if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
        toolCallCount += 1;
      }
    }
  }

  return {
    ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
    runType: run.runType,
    status: run.status,
    ...(run.threadId ? { threadId: run.threadId } : {}),
    ...(run.parentThreadId ? { parentThreadId: run.parentThreadId } : {}),
    ...(run.turnId ? { turnId: run.turnId } : {}),
    ...(latestAssistantMessage ? { latestAssistantMessage } : {}),
    ...(latestPlan ? { latestPlan } : {}),
    commandCount,
    fileChangeCount,
    toolCallCount,
  };
}

function compactProjectionText(value: string, maxLength = 2_000): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength).trimEnd()}...`;
}

export function buildFailedStageReport(
  run: Pick<RunRecord, "runType" | "promptText">,
  status: string,
  options?: {
    threadId?: string;
    turnId?: string;
  },
): StageReport {
  return {
    runType: run.runType,
    status,
    ...(options?.threadId ? { threadId: options.threadId } : {}),
    ...(options?.turnId ? { turnId: options.turnId } : {}),
    commandCount: 0,
    fileChangeCount: 0,
    toolCallCount: 0,
  };
}

export function resolveRunCompletionStatus(params: Record<string, unknown>): "completed" | "failed" {
  const turn = params.turn;
  if (!turn || typeof turn !== "object") {
    return "failed";
  }

  const status = String((turn as Record<string, unknown>).status ?? "failed");
  return status === "completed" ? "completed" : "failed";
}

export function extractTurnId(params: Record<string, unknown>): string | undefined {
  const turn = params.turn;
  if (!turn || typeof turn !== "object") {
    return undefined;
  }

  const id = (turn as Record<string, unknown>).id;
  return typeof id === "string" ? id : undefined;
}

export const FAILED_TURN_FAILURE_REASON = "Codex reported the turn completed in a failed state";

// Keeps the generic prefix (existing queries and tests key on it) and appends
// the real Codex error so a capacity outage is distinguishable from a genuine
// failure in the persisted run record.
export function buildFailedTurnFailureReason(errorMessage: string | undefined): string {
  const trimmed = errorMessage?.trim();
  return trimmed ? `${FAILED_TURN_FAILURE_REASON}: ${trimmed}` : FAILED_TURN_FAILURE_REASON;
}

export function extractTurnErrorMessage(params: Record<string, unknown>): string | undefined {
  const turn = params.turn;
  if (!turn || typeof turn !== "object") {
    return undefined;
  }

  const error = (turn as Record<string, unknown>).error;
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" && message.trim() ? message : undefined;
}

export function buildPendingMaterializationThread(
  stageRun: Pick<RunRecord, "threadId" | "turnId">,
  error: Error,
): CodexThreadSummary {
  return {
    id: stageRun.threadId ?? "pending-thread",
    preview: "",
    cwd: "",
    status: "pending-materialization",
    turns: [
      {
        id: stageRun.turnId ?? "pending-turn",
        status: "inProgress",
        error: {
          message: error.message,
        },
        items: [],
      },
    ],
  };
}
