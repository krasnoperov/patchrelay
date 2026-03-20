import type { ProjectConfig, StageReport, StageRunRecord, WorkflowStage, WorkspaceRecord } from "./types.ts";
import { safeJsonParse } from "./utils.ts";
import type { WorkflowTransitionTarget } from "./workflow-policy.ts";
import { listAllowedTransitionTargets, listWorkflowStageIds, resolveWorkflowStageCandidate } from "./workflow-policy.ts";

export interface ParsedStageHandoff {
  sourceText: string;
  summaryLines: string[];
  nextLikelyStageText?: string;
  nextAttention?: string;
  resolvedNextStage?: WorkflowTransitionTarget;
  suggestsHumanNeeded: boolean;
}

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function stripListPrefix(value: string): string {
  return value.replace(/^[-*•]\s+/, "").replace(/^\d+\.\s+/, "").trim();
}

function resolveTerminalTarget(value: string | undefined): WorkflowTransitionTarget | undefined {
  const normalized = normalize(value)?.replace(/[\s_-]+/g, "");
  if (!normalized) {
    return undefined;
  }

  if (["done", "complete", "completed", "shipped", "ship"].includes(normalized)) {
    return "done";
  }
  if (["humanneeded", "humaninput", "needsinput", "unclear", "unknown", "blocked", "ambiguous"].includes(normalized)) {
    return "human_needed";
  }
  return undefined;
}

export function resolveWorkflowTarget(project: ProjectConfig, value?: string): WorkflowTransitionTarget | undefined {
  return resolveWorkflowTargetForDefinition(project, value);
}

export function resolveWorkflowTargetForDefinition(
  project: ProjectConfig,
  value?: string,
  workflowDefinitionId?: string,
): WorkflowTransitionTarget | undefined {
  return resolveWorkflowStageCandidate(project, value, workflowDefinitionId) ?? resolveTerminalTarget(value);
}

function summarizeSignalsHumanNeeded(lines: string[]): boolean {
  const joined = normalize(lines.join(" "));
  if (!joined) {
    return false;
  }

  return ["blocked", "unclear", "ambiguous", "human input", "human needed", "need human", "cannot determine"].some((token) =>
    joined.includes(token),
  );
}

export function parseStageHandoff(
  project: ProjectConfig,
  assistantMessages: string[],
  workflowDefinitionId?: string,
): ParsedStageHandoff | undefined {
  // Scan all messages (latest first) for a stage result section
  const allMessages = [...assistantMessages].reverse().filter((m) => typeof m === "string" && m.trim().length > 0);
  if (allMessages.length === 0) {
    return undefined;
  }

  // Prefer the message that contains an explicit "Stage result" marker
  const messageWithMarker = allMessages.find((m) => /^#{0,3}\s*stage result\s*:?\s*$/im.test(m));
  const latestMessage = messageWithMarker ?? allMessages[0]!;

  const lines = latestMessage
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  const markerIndex = lines.findIndex((line) => /^#{0,3}\s*stage result\s*:?\s*$/i.test(line.trim()));
  const relevantLines = (markerIndex >= 0 ? lines.slice(markerIndex + 1) : lines)
    .map((line) => stripListPrefix(line.trim()))
    .filter(Boolean);
  if (relevantLines.length === 0) {
    return undefined;
  }

  const summaryLines: string[] = [];
  let nextLikelyStageText: string | undefined;
  let nextAttention: string | undefined;
  for (const line of relevantLines) {
    const nextStageMatch = line.replace(/\*\*/g, "").match(/^next(?:\s+likely)?\s+stage\s*:\s*[`"']?\s*(.+?)\s*[`"']?\s*$/i);
    if (nextStageMatch) {
      nextLikelyStageText = nextStageMatch[1]?.trim();
      continue;
    }

    const attentionMatch = line.match(/^(next attention|what to watch|watch carefully|pay attention|human attention)\s*:\s*(.+)$/i);
    if (attentionMatch) {
      nextAttention = attentionMatch[2]?.trim();
      continue;
    }

    summaryLines.push(line);
  }

  const resolvedNextStage = resolveWorkflowTargetForDefinition(project, nextLikelyStageText, workflowDefinitionId);
  return {
    sourceText: latestMessage,
    summaryLines,
    ...(nextLikelyStageText ? { nextLikelyStageText } : {}),
    ...(nextAttention ? { nextAttention } : {}),
    suggestsHumanNeeded: summarizeSignalsHumanNeeded(summaryLines),
    ...(resolvedNextStage ? { resolvedNextStage } : {}),
  };
}

export function extractPriorStageHandoff(
  project: ProjectConfig,
  stageRun: StageRunRecord | undefined,
  workflowDefinitionId?: string,
): ParsedStageHandoff | undefined {
  if (!stageRun?.reportJson) {
    return undefined;
  }

  const report = safeJsonParse<StageReport>(stageRun.reportJson);
  return report ? parseStageHandoff(project, report.assistantMessages, workflowDefinitionId) : undefined;
}

export function buildCarryForwardPrompt(params: {
  project: ProjectConfig;
  currentStage: WorkflowStage;
  workflowDefinitionId?: string;
  previousStageRun?: StageRunRecord;
  workspace?: Pick<WorkspaceRecord, "branchName" | "worktreePath">;
  stageHistory: StageRunRecord[];
}): string | undefined {
  const availableStages = listWorkflowStageIds(params.project, params.workflowDefinitionId);
  const attemptNumber = params.stageHistory.filter((stageRun) => stageRun.stage === params.currentStage).length + 1;
  const recentHistory = params.stageHistory.slice(-4).map((stageRun) => stageRun.stage);
  const previousHandoff = extractPriorStageHandoff(params.project, params.previousStageRun, params.workflowDefinitionId);

  const lines = [
    `Workflow stage ids: ${availableStages.join(", ")}`,
    `Allowed next targets from ${params.currentStage}: ${listAllowedTransitionTargets(params.project, params.currentStage, params.workflowDefinitionId).join(", ")}`,
    `This is attempt ${attemptNumber} for the ${params.currentStage} stage.`,
    recentHistory.length > 0 ? `Recent workflow history: ${recentHistory.join(" -> ")}` : undefined,
    params.workspace?.branchName ? `Branch: ${params.workspace.branchName}` : undefined,
    params.workspace?.worktreePath ? `Worktree: ${params.workspace.worktreePath}` : undefined,
    params.previousStageRun ? "" : undefined,
    params.previousStageRun ? "Carry-forward from the previous stage:" : undefined,
    params.previousStageRun ? `- Prior stage: ${params.previousStageRun.stage}` : undefined,
    previousHandoff?.summaryLines[0] ? `- Outcome: ${previousHandoff.summaryLines[0]}` : undefined,
    previousHandoff && previousHandoff.summaryLines.length > 1
      ? `- Key facts: ${previousHandoff.summaryLines.slice(1, 3).join(" ")}`
      : undefined,
    previousHandoff?.nextAttention ? `- Watch next: ${previousHandoff.nextAttention}` : undefined,
    params.previousStageRun?.threadId ? `- Prior thread: ${params.previousStageRun.threadId}` : undefined,
  ].filter((value): value is string => Boolean(value));

  return lines.length > 0 ? lines.join("\n") : undefined;
}
