import type { StageEventQueryStoreProvider } from "./stage-event-ports.ts";
import type { IssueWorkflowWebhookStoreProvider } from "./workflow-ports.ts";
import type { StageAgentActivityPublisher } from "./stage-agent-activity-publisher.ts";
import type { StageTurnInputDispatcher } from "./stage-turn-input-dispatcher.ts";
import { triggerEventAllowed } from "./project-resolution.ts";
import type { NormalizedEvent, ProjectConfig, TrackedIssueRecord, WorkflowStage } from "./types.ts";
import { listRunnableStates, resolveWorkflowStage } from "./workflow-policy.ts";

function trimPrompt(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export class AgentSessionWebhookHandler {
  constructor(
    private readonly stores: IssueWorkflowWebhookStoreProvider & StageEventQueryStoreProvider,
    private readonly turnInputDispatcher: StageTurnInputDispatcher,
    private readonly agentActivity: StageAgentActivityPublisher,
  ) {}

  async handle(params: {
    normalized: NormalizedEvent;
    project: ProjectConfig;
    issue: TrackedIssueRecord | undefined;
    desiredStage: WorkflowStage | undefined;
    delegatedToPatchRelay: boolean;
  }): Promise<void> {
    const { normalized, project, issue, desiredStage, delegatedToPatchRelay } = params;
    if (!normalized.agentSession?.id) {
      return;
    }

    const promptBody = trimPrompt(normalized.agentSession.promptBody);
    const promptContext = trimPrompt(normalized.agentSession.promptContext);
    const activeStageRun = issue?.activeStageRunId ? this.stores.issueWorkflows.getStageRun(issue.activeStageRunId) : undefined;
    const runnableWorkflow = normalized.issue?.stateName ? resolveWorkflowStage(project, normalized.issue.stateName) : undefined;

    if (normalized.triggerEvent === "agentSessionCreated") {
      if (!delegatedToPatchRelay) {
        if (activeStageRun) {
          await this.agentActivity.publishForSession(project.id, normalized.agentSession.id, {
            type: "thought",
            body: `PatchRelay is already running the ${activeStageRun.stage} workflow for this issue. Delegate it to PatchRelay if you want automation to own the workflow, or keep replying here to steer the active run.`,
          });
          return;
        }

        const body = runnableWorkflow
          ? `PatchRelay received your mention. Delegate the issue to PatchRelay to start the ${runnableWorkflow} workflow from the current \`${normalized.issue?.stateName}\` state.`
          : `PatchRelay received your mention, but the issue is not in a runnable workflow state yet. Move it to one of: ${listRunnableStates(project).join(", ")}, then delegate it to PatchRelay.`;
        await this.agentActivity.publishForSession(project.id, normalized.agentSession.id, {
          type: "elicitation",
          body,
        });
        return;
      }

      if (!desiredStage && !activeStageRun) {
        const runnableStates = listRunnableStates(project).join(", ");
        await this.agentActivity.publishForSession(project.id, normalized.agentSession.id, {
          type: "elicitation",
          body: `PatchRelay is delegated, but the issue is not in a runnable workflow state. Move it to one of: ${runnableStates}.`,
        });
        return;
      }

      if (desiredStage) {
        await this.agentActivity.publishForSession(project.id, normalized.agentSession.id, {
          type: "thought",
          body: `PatchRelay received the delegation and is preparing the ${desiredStage} workflow.`,
        });
        return;
      }

      if (activeStageRun) {
        await this.agentActivity.publishForSession(project.id, normalized.agentSession.id, {
          type: "thought",
          body: `PatchRelay is already running the ${activeStageRun.stage} workflow for this issue.`,
        });
      }
      return;
    }

    if (normalized.triggerEvent !== "agentPrompted") {
      return;
    }

    if (!triggerEventAllowed(project, normalized.triggerEvent)) {
      return;
    }

    if (activeStageRun && promptBody) {
      this.stores.stageEvents.enqueueTurnInput({
        stageRunId: activeStageRun.id,
        ...(activeStageRun.threadId ? { threadId: activeStageRun.threadId } : {}),
        ...(activeStageRun.turnId ? { turnId: activeStageRun.turnId } : {}),
        source: `linear-agent-prompt:${normalized.agentSession.id}:${normalized.webhookId}`,
        body: ["New Linear agent prompt received while you are working.", "", promptBody].join("\n"),
      });
      await this.turnInputDispatcher.flush(activeStageRun, {
        ...(issue?.issueKey ? { issueKey: issue.issueKey } : {}),
        failureMessage: "Failed to deliver queued Linear agent prompt to active Codex turn",
      });
      await this.agentActivity.publishForSession(project.id, normalized.agentSession.id, {
        type: "thought",
        body: `PatchRelay routed your follow-up instructions into the active ${activeStageRun.stage} workflow.`,
      });
      return;
    }

    if (!delegatedToPatchRelay && (promptBody || promptContext)) {
      const body = runnableWorkflow
        ? `PatchRelay received your prompt. Delegate the issue to PatchRelay to start the ${runnableWorkflow} workflow from the current \`${normalized.issue?.stateName}\` state.`
        : `PatchRelay received your prompt, but the issue is not in a runnable workflow state yet. Move it to one of: ${listRunnableStates(project).join(", ")}, then delegate it to PatchRelay.`;
      await this.agentActivity.publishForSession(project.id, normalized.agentSession.id, {
        type: "elicitation",
        body,
      });
      return;
    }

    if (!activeStageRun && desiredStage) {
      await this.agentActivity.publishForSession(project.id, normalized.agentSession.id, {
        type: "thought",
        body: `PatchRelay received your prompt and is preparing the ${desiredStage} workflow.`,
      });
      return;
    }

    if (!activeStageRun && !desiredStage && (promptBody || promptContext)) {
      const runnableStates = listRunnableStates(project).join(", ");
      await this.agentActivity.publishForSession(project.id, normalized.agentSession.id, {
        type: "elicitation",
        body: `PatchRelay received your prompt, but the issue is not in a runnable workflow state yet. Move it to one of: ${runnableStates}.`,
      });
    }
  }
}
