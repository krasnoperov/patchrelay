import type { IssueWorkflowWebhookStoreProvider, LinearInstallationStoreProvider } from "./db-ports.ts";
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
  constructor(private readonly stores: IssueWorkflowWebhookStoreProvider & LinearInstallationStoreProvider) {}

  record(project: ProjectConfig, normalized: NormalizedEvent): RecordedWebhookIssueState {
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
    const activeStageRun = issue?.activeStageRunId ? this.stores.issueWorkflows.getStageRun(issue.activeStageRunId) : undefined;
    const delegatedToPatchRelay = this.isDelegatedToPatchRelay(project, normalized);
    const desiredStage = this.resolveDesiredStage(project, normalized, issue, activeStageRun, delegatedToPatchRelay);
    const launchInput = this.resolveLaunchInput(normalized.agentSession);

    this.stores.issueWorkflows.recordDesiredStage({
      projectId: project.id,
      linearIssueId: normalizedIssue.id,
      ...(normalizedIssue.identifier ? { issueKey: normalizedIssue.identifier } : {}),
      ...(normalizedIssue.title ? { title: normalizedIssue.title } : {}),
      ...(normalizedIssue.url ? { issueUrl: normalizedIssue.url } : {}),
      ...(normalizedIssue.stateName ? { currentLinearState: normalizedIssue.stateName } : {}),
      ...(desiredStage ? { desiredStage } : {}),
      ...(desiredStage ? { desiredWebhookId: normalized.webhookId } : {}),
      lastWebhookAt: new Date().toISOString(),
    });

    if (normalized.agentSession?.id) {
      this.stores.issueWorkflows.setIssueActiveAgentSession(project.id, normalizedIssue.id, normalized.agentSession.id);
    }
    if (launchInput && !activeStageRun && delegatedToPatchRelay) {
      this.stores.issueWorkflows.setIssuePendingLaunchInput(project.id, normalizedIssue.id, launchInput);
    }

    return {
      issue: issue ?? this.stores.issueWorkflows.getTrackedIssue(project.id, normalizedIssue.id),
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
