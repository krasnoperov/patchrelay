import type { CodexThreadItem, CodexThreadSummary, StageReport, StageRunRecord, ThreadEventRecord, TrackedIssueRecord } from "./types.ts";

export function extractStageSummary(report: StageReport): Record<string, unknown> {
  return {
    assistantMessageCount: report.assistantMessages.length,
    commandCount: report.commands.length,
    fileChangeCount: report.fileChanges.length,
    toolCallCount: report.toolCalls.length,
    latestAssistantMessage: report.assistantMessages.at(-1) ?? null,
  };
}

export function summarizeCurrentThread(thread: CodexThreadSummary): {
  threadId: string;
  threadStatus: string;
  latestTurnId?: string;
  latestTurnStatus?: string;
  latestAgentMessage?: string;
} {
  const latestTurn = thread.turns.at(-1);
  const latestAgentMessage = latestTurn?.items
    .filter((item): item is Extract<CodexThreadItem, { type: "agentMessage" }> => item.type === "agentMessage")
    .at(-1)?.text;

  return {
    threadId: thread.id,
    threadStatus: thread.status,
    ...(latestTurn ? { latestTurnId: latestTurn.id, latestTurnStatus: latestTurn.status } : {}),
    ...(latestAgentMessage ? { latestAgentMessage } : {}),
  };
}

export function buildStageReport(
  stageRun: StageRunRecord,
  issue: TrackedIssueRecord,
  thread: CodexThreadSummary,
  eventCounts: Record<string, number>,
): StageReport {
  const assistantMessages: string[] = [];
  const plans: string[] = [];
  const reasoning: string[] = [];
  const commands: StageReport["commands"] = [];
  const fileChanges: Array<Record<string, unknown>> = [];
  const toolCalls: StageReport["toolCalls"] = [];

  for (const turn of thread.turns) {
    for (const rawItem of turn.items as CodexThreadItem[]) {
      const item = rawItem as CodexThreadItem & Record<string, unknown>;
      if (item.type === "agentMessage" && typeof item.text === "string") {
        assistantMessages.push(item.text);
      } else if (item.type === "plan" && typeof item.text === "string") {
        plans.push(item.text);
      } else if (item.type === "reasoning" && Array.isArray(item.summary) && Array.isArray(item.content)) {
        reasoning.push(...(item.summary as string[]), ...(item.content as string[]));
      } else if (item.type === "commandExecution" && typeof item.command === "string" && typeof item.cwd === "string") {
        commands.push({
          command: item.command,
          cwd: item.cwd,
          status: typeof item.status === "string" ? item.status : "unknown",
          ...(typeof item.exitCode === "number" || item.exitCode === null
            ? { exitCode: item.exitCode as number | null }
            : {}),
          ...(typeof item.durationMs === "number" || item.durationMs === null
            ? { durationMs: item.durationMs as number | null }
            : {}),
        });
      } else if (item.type === "fileChange" && Array.isArray(item.changes)) {
        fileChanges.push(...(item.changes as Array<Record<string, unknown>>));
      } else if (item.type === "mcpToolCall" && typeof item.server === "string" && typeof item.tool === "string") {
        toolCalls.push({
          type: "mcp",
          name: `${item.server}/${item.tool}`,
          status: typeof item.status === "string" ? item.status : "unknown",
          ...(typeof item.durationMs === "number" || item.durationMs === null
            ? { durationMs: item.durationMs as number | null }
            : {}),
        });
      } else if (item.type === "dynamicToolCall" && typeof item.tool === "string") {
        toolCalls.push({
          type: "dynamic",
          name: item.tool,
          status: typeof item.status === "string" ? item.status : "unknown",
          ...(typeof item.durationMs === "number" || item.durationMs === null
            ? { durationMs: item.durationMs as number | null }
            : {}),
        });
      }
    }
  }

  return {
    ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
    stage: stageRun.stage,
    status: stageRun.status,
    ...(stageRun.threadId ? { threadId: stageRun.threadId } : {}),
    ...(stageRun.parentThreadId ? { parentThreadId: stageRun.parentThreadId } : {}),
    ...(stageRun.turnId ? { turnId: stageRun.turnId } : {}),
    prompt: stageRun.promptText,
    workflowFile: stageRun.workflowFile,
    assistantMessages,
    plans,
    reasoning,
    commands,
    fileChanges,
    toolCalls,
    eventCounts,
  };
}

export function buildFailedStageReport(
  stageRun: Pick<StageRunRecord, "stage" | "promptText" | "workflowFile">,
  status: StageRunRecord["status"],
  options?: {
    threadId?: string;
    turnId?: string;
  },
): StageReport {
  return {
    stage: stageRun.stage,
    status,
    ...(options?.threadId ? { threadId: options.threadId } : {}),
    ...(options?.turnId ? { turnId: options.turnId } : {}),
    prompt: stageRun.promptText,
    workflowFile: stageRun.workflowFile,
    assistantMessages: [],
    plans: [],
    reasoning: [],
    commands: [],
    fileChanges: [],
    toolCalls: [],
    eventCounts: {},
  };
}

export function countEventMethods(events: ThreadEventRecord[]): Record<string, number> {
  return events.reduce<Record<string, number>>((counts, event) => {
    counts[event.method] = (counts[event.method] ?? 0) + 1;
    return counts;
  }, {});
}

export function resolveStageRunStatus(params: Record<string, unknown>): StageRunRecord["status"] {
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

export function buildPendingMaterializationThread(
  stageRun: Pick<StageRunRecord, "threadId" | "turnId">,
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
