import type { IssueControlStoreProvider, ObligationStoreProvider } from "./ledger-ports.ts";
import type { LinearInstallationStoreProvider } from "./installation-ports.ts";
import type { IssueWorkflowCoordinatorProvider, IssueWorkflowQueryStoreProvider } from "./workflow-ports.ts";
import { triggerEventAllowed } from "./project-resolution.ts";
import type { AgentSessionMetadata, NormalizedEvent, ProjectConfig, StageRunRecord, TrackedIssueRecord, WorkflowStage } from "./types.ts";
import { resolveWorkflowStage } from "./workflow-policy.ts";

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
    const desiredStage = this.resolveDesiredStage(project, normalized, issue, activeStageRun, delegatedToPatchRelay);
    const launchInput = this.resolveLaunchInput(normalized.agentSession);
    const refreshedIssue = this.stores.workflowCoordinator.recordDesiredStage({
      projectId: project.id,
      linearIssueId: normalizedIssue.id,
      ...(normalizedIssue.identifier ? { issueKey: normalizedIssue.identifier } : {}),
      ...(normalizedIssue.title ? { title: normalizedIssue.title } : {}),
      ...(normalizedIssue.url ? { issueUrl: normalizedIssue.url } : {}),
      ...(normalizedIssue.stateName ? { currentLinearState: normalizedIssue.stateName } : {}),
      ...(desiredStage ? { desiredStage } : {}),
      ...(options?.eventReceiptId !== undefined ? { desiredReceiptId: options.eventReceiptId } : {}),
      ...(normalized.agentSession?.id ? { activeAgentSessionId: normalized.agentSession.id } : {}),
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
  ): WorkflowStage | undefined {
    const normalizedIssue = normalized.issue;
    if (!normalizedIssue) {
      return undefined;
    }

    const stageAllowed = triggerEventAllowed(project, normalized.triggerEvent);
    let desiredStage: WorkflowStage | undefined;

    if (normalized.triggerEvent === "delegateChanged") {
      desiredStage = delegatedToPatchRelay ? resolveWorkflowStage(project, normalizedIssue.stateName) : undefined;
      if (!desiredStage) {
        return undefined;
      }
      if (!stageAllowed && !project.triggerEvents.includes("statusChanged")) {
        return undefined;
      }
    } else if (normalized.triggerEvent === "agentSessionCreated" || normalized.triggerEvent === "agentPrompted") {
      if (!delegatedToPatchRelay || !stageAllowed) {
        return undefined;
      }
      desiredStage = resolveWorkflowStage(project, normalizedIssue.stateName);
    } else if (stageAllowed) {
      desiredStage = resolveWorkflowStage(project, normalizedIssue.stateName);
    } else {
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
