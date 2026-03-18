import type { IssueControlStoreProvider, ObligationStoreProvider } from "./ledger-ports.ts";
import type { LinearInstallationStoreProvider } from "./installation-ports.ts";
import type { IssueWorkflowCoordinatorProvider, IssueWorkflowQueryStoreProvider } from "./workflow-ports.ts";
import { triggerEventAllowed } from "./project-resolution.ts";
import type { AgentSessionMetadata, NormalizedEvent, ProjectConfig, StageRunRecord, TrackedIssueRecord, WorkflowStage } from "./types.ts";
import { resolveWorkflowStage, selectWorkflowDefinition } from "./workflow-policy.ts";

function trimPrompt(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export interface RecordedWebhookIssueState {
  issue: TrackedIssueRecord | undefined;
  activeStageRun: StageRunRecord | undefined;
  desiredStage: WorkflowStage | undefined;
  delegatedToPatchRelay: boolean;
  launchInput: string | undefined;
}

export class WebhookDesiredStageRecorder {
  constructor(
    private readonly stores: IssueWorkflowCoordinatorProvider &
      IssueWorkflowQueryStoreProvider &
      LinearInstallationStoreProvider &
      IssueControlStoreProvider &
      ObligationStoreProvider,
  ) {}

  record(project: ProjectConfig, normalized: NormalizedEvent, options?: { eventReceiptId?: number }): RecordedWebhookIssueState {
    const normalizedIssue = normalized.issue;
    if (!normalizedIssue) {
      return {
        issue: undefined,
        activeStageRun: undefined,
        desiredStage: undefined,
        delegatedToPatchRelay: false,
        launchInput: undefined,
      };
    }

    const issue = this.stores.issueWorkflows.getTrackedIssue(project.id, normalizedIssue.id);
    const issueControl = this.stores.issueControl.getIssueControl(project.id, normalizedIssue.id);
    const activeStageRun =
      issueControl?.activeRunLeaseId !== undefined ? this.stores.issueWorkflows.getStageRun(issueControl.activeRunLeaseId) : undefined;
    const delegatedToPatchRelay = this.isDelegatedToPatchRelay(project, normalized);
    const stageAllowed = triggerEventAllowed(project, normalized.triggerEvent);
    const selectedWorkflowId = this.resolveSelectedWorkflowId(project, normalized, issue, activeStageRun, delegatedToPatchRelay);
    const desiredStage = this.resolveDesiredStage(project, normalized, issue, activeStageRun, delegatedToPatchRelay, selectedWorkflowId);
    const launchInput = this.resolveLaunchInput(normalized.agentSession);
    const activeAgentSessionId =
      normalized.agentSession?.id ??
      (!activeStageRun && (desiredStage || (normalized.triggerEvent === "delegateChanged" && !delegatedToPatchRelay)) ? null : undefined);
    const refreshedIssue = this.stores.workflowCoordinator.recordDesiredStage({
      projectId: project.id,
      linearIssueId: normalizedIssue.id,
      ...(normalizedIssue.identifier ? { issueKey: normalizedIssue.identifier } : {}),
      ...(normalizedIssue.title ? { title: normalizedIssue.title } : {}),
      ...(normalizedIssue.url ? { issueUrl: normalizedIssue.url } : {}),
      ...(normalizedIssue.stateName ? { currentLinearState: normalizedIssue.stateName } : {}),
      ...(selectedWorkflowId !== undefined ? { selectedWorkflowId } : {}),
      ...(desiredStage ? { desiredStage } : {}),
      ...(options?.eventReceiptId !== undefined ? { desiredReceiptId: options.eventReceiptId } : {}),
      ...(activeAgentSessionId !== undefined ? { activeAgentSessionId } : {}),
      lastWebhookAt: new Date().toISOString(),
    });

    if (launchInput && !activeStageRun && delegatedToPatchRelay && stageAllowed) {
      this.stores.obligations.enqueueObligation({
        projectId: project.id,
        linearIssueId: normalizedIssue.id,
        kind: "deliver_turn_input",
        source: `linear-agent-launch:${normalized.agentSession?.id ?? normalized.webhookId}`,
        payloadJson: JSON.stringify({
          body: launchInput,
        }),
      });
    }

    return {
      issue: refreshedIssue ?? issue,
      activeStageRun,
      desiredStage,
      delegatedToPatchRelay,
      launchInput,
    };
  }

  isDelegatedToPatchRelay(project: ProjectConfig, normalized: NormalizedEvent): boolean {
    const normalizedIssue = normalized.issue;
    if (!normalizedIssue) {
      return false;
    }

    const installation = this.stores.linearInstallations.getLinearInstallationForProject(project.id);
    if (!installation?.actorId) {
      return false;
    }
    return normalizedIssue.delegateId === installation.actorId;
  }

  private resolveDesiredStage(
    project: ProjectConfig,
    normalized: NormalizedEvent,
    issue: TrackedIssueRecord | undefined,
    activeStageRun: StageRunRecord | undefined,
    delegatedToPatchRelay: boolean,
    selectedWorkflowId: string | null | undefined,
  ): WorkflowStage | undefined {
    const normalizedIssue = normalized.issue;
    if (!normalizedIssue) {
      return undefined;
    }

    if (normalized.triggerEvent !== "agentSessionCreated" && normalized.triggerEvent !== "agentPrompted") {
      return undefined;
    }

    if (!delegatedToPatchRelay || !triggerEventAllowed(project, normalized.triggerEvent)) {
      return undefined;
    }

    const desiredStage = resolveWorkflowStage(project, normalizedIssue.stateName, {
      ...(selectedWorkflowId ? { workflowDefinitionId: selectedWorkflowId } : {}),
    });
    if (!desiredStage) {
      return undefined;
    }

    if (activeStageRun && desiredStage === activeStageRun.stage) {
      return undefined;
    }
    if (issue?.desiredStage && desiredStage === issue.desiredStage) {
      return undefined;
    }
    return desiredStage;
  }

  private resolveSelectedWorkflowId(
    project: ProjectConfig,
    normalized: NormalizedEvent,
    issue: TrackedIssueRecord | undefined,
    activeStageRun: StageRunRecord | undefined,
    delegatedToPatchRelay: boolean,
  ): string | null | undefined {
    if (activeStageRun) {
      return issue?.selectedWorkflowId;
    }

    if (normalized.triggerEvent !== "agentSessionCreated" && normalized.triggerEvent !== "agentPrompted") {
      return issue?.selectedWorkflowId;
    }

    if (!delegatedToPatchRelay || !triggerEventAllowed(project, normalized.triggerEvent) || !normalized.issue) {
      return issue?.selectedWorkflowId;
    }

    const selectedWorkflow = selectWorkflowDefinition(project, normalized.issue);
    if (selectedWorkflow) {
      return selectedWorkflow.id;
    }

    return null;
  }

  private resolveLaunchInput(agentSession: AgentSessionMetadata | undefined): string | undefined {
    const promptBody = trimPrompt(agentSession?.promptBody);
    if (promptBody) {
      return ["New Linear agent input received.", "", promptBody].join("\n");
    }

    const promptContext = trimPrompt(agentSession?.promptContext);
    if (promptContext) {
      return ["Linear provided this initial agent context.", "", promptContext].join("\n");
    }

    return undefined;
  }

}
