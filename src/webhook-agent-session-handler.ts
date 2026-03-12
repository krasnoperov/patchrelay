import { createHash } from "node:crypto";
import type { IssueControlStoreProvider, ObligationStoreProvider, RunLeaseStoreProvider } from "./ledger-ports.ts";
import type { StageTurnInputStoreProvider } from "./stage-event-ports.ts";
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
    private readonly stores: IssueWorkflowWebhookStoreProvider &
      StageTurnInputStoreProvider &
      IssueControlStoreProvider &
      ObligationStoreProvider &
      RunLeaseStoreProvider,
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
    const issueControl = normalized.issue ? this.stores.issueControl.getIssueControl(project.id, normalized.issue.id) : undefined;
    const activeRunLease = issueControl?.activeRunLeaseId !== undefined ? this.stores.runLeases.getRunLease(issueControl.activeRunLeaseId) : undefined;
    const activeStageRun = issue?.activeStageRunId ? this.stores.issueWorkflows.getStageRun(issue.activeStageRunId) : undefined;
    const activeStage = activeRunLease?.stage ?? activeStageRun?.stage;
    const runnableWorkflow = normalized.issue?.stateName ? resolveWorkflowStage(project, normalized.issue.stateName) : undefined;

    if (normalized.triggerEvent === "agentSessionCreated") {
      if (!delegatedToPatchRelay) {
        if (activeStage) {
          await this.agentActivity.publishForSession(project.id, normalized.agentSession.id, {
            type: "thought",
            body: `PatchRelay is already running the ${activeStage} workflow for this issue. Delegate it to PatchRelay if you want automation to own the workflow, or keep replying here to steer the active run.`,
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

      if (!desiredStage && !activeStage) {
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

      if (activeStage) {
        await this.agentActivity.publishForSession(project.id, normalized.agentSession.id, {
          type: "thought",
          body: `PatchRelay is already running the ${activeStage} workflow for this issue.`,
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

    if (activeRunLease && promptBody) {
      const dedupeKey = buildPromptDedupeKey(normalized.agentSession.id, promptBody);
      if (
        issueControl?.activeRunLeaseId !== undefined &&
        this.stores.obligations.getObligationByDedupeKey({
          runLeaseId: issueControl.activeRunLeaseId,
          kind: "deliver_turn_input",
          dedupeKey,
        })
      ) {
        return;
      }

      const promptInput = ["New Linear agent prompt received while you are working.", "", promptBody].join("\n");
      const source = `linear-agent-prompt:${normalized.agentSession.id}:${normalized.webhookId}`;
      const obligationId = this.enqueueObligation(
        project.id,
        normalized.issue!.id,
        activeStageRun?.id,
        activeRunLease.threadId,
        activeRunLease.turnId,
        source,
        promptInput,
        dedupeKey,
      );
      if (activeStageRun) {
        const queuedInputId = this.stores.stageEvents.enqueueTurnInput({
          stageRunId: activeStageRun.id,
          ...(activeRunLease.threadId ? { threadId: activeRunLease.threadId } : {}),
          ...(activeRunLease.turnId ? { turnId: activeRunLease.turnId } : {}),
          source,
          body: promptInput,
        });
        if (obligationId !== undefined) {
          this.stores.obligations.updateObligationPayloadJson(
            obligationId,
            JSON.stringify({
              body: promptInput,
              queuedInputId,
              stageRunId: activeStageRun.id,
            }),
          );
        }
      }
      const flushResult = await this.turnInputDispatcher.flush(
        {
          id: activeStageRun?.id ?? 0,
          projectId: project.id,
          linearIssueId: normalized.issue!.id,
          ...(activeRunLease.threadId ? { threadId: activeRunLease.threadId } : {}),
          ...(activeRunLease.turnId ? { turnId: activeRunLease.turnId } : {}),
        },
        {
          ...(issue?.issueKey ? { issueKey: issue.issueKey } : {}),
          failureMessage: "Failed to deliver queued Linear agent prompt to active Codex turn",
        },
      );
      await this.agentActivity.publishForSession(project.id, normalized.agentSession.id, {
        type: "thought",
        body:
          obligationId !== undefined && flushResult.deliveredObligationIds.includes(obligationId)
            ? `PatchRelay routed your follow-up instructions into the active ${activeRunLease.stage} workflow.`
            : `PatchRelay queued your follow-up instructions for delivery into the active ${activeRunLease.stage} workflow.`,
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

  private enqueueObligation(
    projectId: string,
    linearIssueId: string,
    stageRunId: number | undefined,
    threadId: string | undefined,
    turnId: string | undefined,
    source: string,
    promptBody: string,
    dedupeKey: string,
  ): number | undefined {
    const activeRunLeaseId = this.stores.issueControl.getIssueControl(projectId, linearIssueId)?.activeRunLeaseId;
    if (activeRunLeaseId === undefined) {
      return undefined;
    }

    const obligation = this.stores.obligations.enqueueObligation({
      projectId,
      linearIssueId,
      kind: "deliver_turn_input",
      source,
      payloadJson: JSON.stringify({
        body: promptBody,
        ...(stageRunId !== undefined ? { stageRunId } : {}),
      }),
      runLeaseId: activeRunLeaseId,
      ...(threadId ? { threadId } : {}),
      ...(turnId ? { turnId } : {}),
      dedupeKey,
    });
    return obligation.id;
  }
}

function buildPromptDedupeKey(agentSessionId: string, promptBody: string): string {
  return `linear-agent-prompt:${agentSessionId}:${hashBody(promptBody)}`;
}

function hashBody(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
