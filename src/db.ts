import Database from "better-sqlite3";
import { IssueWorkflowStore } from "./db/issue-workflow-store.ts";
import { LinearInstallationStore } from "./db/linear-installation-store.ts";
import { runPatchRelayMigrations } from "./db/migrations.ts";
import { StageEventStore } from "./db/stage-event-store.ts";
import { WebhookEventStore } from "./db/webhook-event-store.ts";

export class PatchRelayDatabase {
  readonly connection: Database.Database;
  readonly webhookEvents: WebhookEventStore;
  readonly webhooks: WebhookEventStore;
  readonly issueWorkflows: IssueWorkflowStore;
  readonly workflow: IssueWorkflowStore;
  readonly stageEvents: StageEventStore;
  readonly events: StageEventStore;
  readonly linearInstallations: LinearInstallationStore;
  readonly installations: LinearInstallationStore;

  constructor(databasePath: string, wal: boolean) {
    this.connection = new Database(databasePath);
    this.connection.pragma("foreign_keys = ON");
    if (wal) {
      this.connection.pragma("journal_mode = WAL");
    }

    this.webhookEvents = new WebhookEventStore(this.connection);
    this.webhooks = this.webhookEvents;
    this.issueWorkflows = new IssueWorkflowStore(this.connection);
    this.workflow = this.issueWorkflows;
    this.stageEvents = new StageEventStore(this.connection);
    this.events = this.stageEvents;
    this.linearInstallations = new LinearInstallationStore(this.connection);
    this.installations = this.linearInstallations;
  }

  runMigrations(): void {
    runPatchRelayMigrations(this.connection);
  }

  insertWebhookEvent(...args: Parameters<WebhookEventStore["insertWebhookEvent"]>) {
    return this.webhookEvents.insertWebhookEvent(...args);
  }

  markWebhookProcessed(...args: Parameters<WebhookEventStore["markWebhookProcessed"]>) {
    return this.webhookEvents.markWebhookProcessed(...args);
  }

  assignWebhookProject(...args: Parameters<WebhookEventStore["assignWebhookProject"]>) {
    return this.webhookEvents.assignWebhookProject(...args);
  }

  getWebhookEvent(...args: Parameters<WebhookEventStore["getWebhookEvent"]>) {
    return this.webhookEvents.getWebhookEvent(...args);
  }

  upsertTrackedIssue(...args: Parameters<IssueWorkflowStore["upsertTrackedIssue"]>) {
    return this.issueWorkflows.upsertTrackedIssue(...args);
  }

  getTrackedIssue(...args: Parameters<IssueWorkflowStore["getTrackedIssue"]>) {
    return this.issueWorkflows.getTrackedIssue(...args);
  }

  getTrackedIssueByKey(...args: Parameters<IssueWorkflowStore["getTrackedIssueByKey"]>) {
    return this.issueWorkflows.getTrackedIssueByKey(...args);
  }

  getTrackedIssueByLinearIssueId(...args: Parameters<IssueWorkflowStore["getTrackedIssueByLinearIssueId"]>) {
    return this.issueWorkflows.getTrackedIssueByLinearIssueId(...args);
  }

  recordDesiredStage(...args: Parameters<IssueWorkflowStore["recordDesiredStage"]>) {
    return this.issueWorkflows.recordDesiredStage(...args);
  }

  listIssuesReadyForExecution(...args: Parameters<IssueWorkflowStore["listIssuesReadyForExecution"]>) {
    return this.issueWorkflows.listIssuesReadyForExecution(...args);
  }

  listActiveStageRuns(...args: Parameters<IssueWorkflowStore["listActiveStageRuns"]>) {
    return this.issueWorkflows.listActiveStageRuns(...args);
  }

  claimStageRun(...args: Parameters<IssueWorkflowStore["claimStageRun"]>) {
    return this.issueWorkflows.claimStageRun(...args);
  }

  getWorkspace(...args: Parameters<IssueWorkflowStore["getWorkspace"]>) {
    return this.issueWorkflows.getWorkspace(...args);
  }

  getActiveWorkspaceForIssue(...args: Parameters<IssueWorkflowStore["getActiveWorkspaceForIssue"]>) {
    return this.issueWorkflows.getActiveWorkspaceForIssue(...args);
  }

  getPipelineRun(...args: Parameters<IssueWorkflowStore["getPipelineRun"]>) {
    return this.issueWorkflows.getPipelineRun(...args);
  }

  getActivePipelineForIssue(...args: Parameters<IssueWorkflowStore["getActivePipelineForIssue"]>) {
    return this.issueWorkflows.getActivePipelineForIssue(...args);
  }

  getStageRun(...args: Parameters<IssueWorkflowStore["getStageRun"]>) {
    return this.issueWorkflows.getStageRun(...args);
  }

  getStageRunByThreadId(...args: Parameters<IssueWorkflowStore["getStageRunByThreadId"]>) {
    return this.issueWorkflows.getStageRunByThreadId(...args);
  }

  listStageRunsForIssue(...args: Parameters<IssueWorkflowStore["listStageRunsForIssue"]>) {
    return this.issueWorkflows.listStageRunsForIssue(...args);
  }

  updateStageRunThread(...args: Parameters<IssueWorkflowStore["updateStageRunThread"]>) {
    return this.issueWorkflows.updateStageRunThread(...args);
  }

  finishStageRun(...args: Parameters<IssueWorkflowStore["finishStageRun"]>) {
    return this.issueWorkflows.finishStageRun(...args);
  }

  markPipelineCompleted(...args: Parameters<IssueWorkflowStore["markPipelineCompleted"]>) {
    return this.issueWorkflows.markPipelineCompleted(...args);
  }

  setPipelineStatus(...args: Parameters<IssueWorkflowStore["setPipelineStatus"]>) {
    return this.issueWorkflows.setPipelineStatus(...args);
  }

  setIssueDesiredStage(...args: Parameters<IssueWorkflowStore["setIssueDesiredStage"]>) {
    return this.issueWorkflows.setIssueDesiredStage(...args);
  }

  setIssueLifecycleStatus(...args: Parameters<IssueWorkflowStore["setIssueLifecycleStatus"]>) {
    return this.issueWorkflows.setIssueLifecycleStatus(...args);
  }

  setIssueStatusComment(...args: Parameters<IssueWorkflowStore["setIssueStatusComment"]>) {
    return this.issueWorkflows.setIssueStatusComment(...args);
  }

  setIssueActiveAgentSession(...args: Parameters<IssueWorkflowStore["setIssueActiveAgentSession"]>) {
    return this.issueWorkflows.setIssueActiveAgentSession(...args);
  }

  setIssuePendingLaunchInput(...args: Parameters<IssueWorkflowStore["setIssuePendingLaunchInput"]>) {
    return this.issueWorkflows.setIssuePendingLaunchInput(...args);
  }

  consumeIssuePendingLaunchInput(...args: Parameters<IssueWorkflowStore["consumeIssuePendingLaunchInput"]>) {
    return this.issueWorkflows.consumeIssuePendingLaunchInput(...args);
  }

  getLatestStageRunForIssue(...args: Parameters<IssueWorkflowStore["getLatestStageRunForIssue"]>) {
    return this.issueWorkflows.getLatestStageRunForIssue(...args);
  }

  getIssueOverview(...args: Parameters<IssueWorkflowStore["getIssueOverview"]>) {
    return this.issueWorkflows.getIssueOverview(...args);
  }

  saveThreadEvent(...args: Parameters<StageEventStore["saveThreadEvent"]>) {
    return this.stageEvents.saveThreadEvent(...args);
  }

  listThreadEvents(...args: Parameters<StageEventStore["listThreadEvents"]>) {
    return this.stageEvents.listThreadEvents(...args);
  }

  enqueueTurnInput(...args: Parameters<StageEventStore["enqueueTurnInput"]>) {
    return this.stageEvents.enqueueTurnInput(...args);
  }

  listPendingTurnInputs(...args: Parameters<StageEventStore["listPendingTurnInputs"]>) {
    return this.stageEvents.listPendingTurnInputs(...args);
  }

  markTurnInputDelivered(...args: Parameters<StageEventStore["markTurnInputDelivered"]>) {
    return this.stageEvents.markTurnInputDelivered(...args);
  }

  setPendingTurnInputRouting(...args: Parameters<StageEventStore["setPendingTurnInputRouting"]>) {
    return this.stageEvents.setPendingTurnInputRouting(...args);
  }

  upsertLinearInstallation(...args: Parameters<LinearInstallationStore["upsertLinearInstallation"]>) {
    return this.linearInstallations.upsertLinearInstallation(...args);
  }

  saveLinearInstallation(...args: Parameters<LinearInstallationStore["saveLinearInstallation"]>) {
    return this.linearInstallations.saveLinearInstallation(...args);
  }

  updateLinearInstallationTokens(...args: Parameters<LinearInstallationStore["updateLinearInstallationTokens"]>) {
    return this.linearInstallations.updateLinearInstallationTokens(...args);
  }

  getLinearInstallation(...args: Parameters<LinearInstallationStore["getLinearInstallation"]>) {
    return this.linearInstallations.getLinearInstallation(...args);
  }

  listLinearInstallations(...args: Parameters<LinearInstallationStore["listLinearInstallations"]>) {
    return this.linearInstallations.listLinearInstallations(...args);
  }

  linkProjectInstallation(...args: Parameters<LinearInstallationStore["linkProjectInstallation"]>) {
    return this.linearInstallations.linkProjectInstallation(...args);
  }

  setProjectInstallation(...args: Parameters<LinearInstallationStore["setProjectInstallation"]>) {
    return this.linearInstallations.setProjectInstallation(...args);
  }

  getProjectInstallation(...args: Parameters<LinearInstallationStore["getProjectInstallation"]>) {
    return this.linearInstallations.getProjectInstallation(...args);
  }

  listProjectInstallations(...args: Parameters<LinearInstallationStore["listProjectInstallations"]>) {
    return this.linearInstallations.listProjectInstallations(...args);
  }

  unlinkProjectInstallation(...args: Parameters<LinearInstallationStore["unlinkProjectInstallation"]>) {
    return this.linearInstallations.unlinkProjectInstallation(...args);
  }

  getLinearInstallationForProject(...args: Parameters<LinearInstallationStore["getLinearInstallationForProject"]>) {
    return this.linearInstallations.getLinearInstallationForProject(...args);
  }

  createOAuthState(...args: Parameters<LinearInstallationStore["createOAuthState"]>) {
    return this.linearInstallations.createOAuthState(...args);
  }

  getOAuthState(...args: Parameters<LinearInstallationStore["getOAuthState"]>) {
    return this.linearInstallations.getOAuthState(...args);
  }

  finalizeOAuthState(...args: Parameters<LinearInstallationStore["finalizeOAuthState"]>) {
    return this.linearInstallations.finalizeOAuthState(...args);
  }
}
