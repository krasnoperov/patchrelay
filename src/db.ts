import { AuthoritativeLedgerStore } from "./db/authoritative-ledger-store.ts";
import { IssueProjectionStore } from "./db/issue-projection-store.ts";
import { IssueWorkflowCoordinator } from "./db/issue-workflow-coordinator.ts";
import { IssueWorkflowStore } from "./db/issue-workflow-store.ts";
import { LinearInstallationStore } from "./db/linear-installation-store.ts";
import { runPatchRelayMigrations } from "./db/migrations.ts";
import { RunReportStore } from "./db/run-report-store.ts";
import { StageEventStore } from "./db/stage-event-store.ts";
import { SqliteConnection, type DatabaseConnection } from "./db/shared.ts";
import { WebhookEventStore } from "./db/webhook-event-store.ts";

export class PatchRelayDatabase {
  readonly connection: DatabaseConnection;
  readonly authoritativeLedger: AuthoritativeLedgerStore;
  readonly eventReceipts: AuthoritativeLedgerStore;
  readonly issueControl: AuthoritativeLedgerStore;
  readonly workspaceOwnership: AuthoritativeLedgerStore;
  readonly runLeases: AuthoritativeLedgerStore;
  readonly obligations: AuthoritativeLedgerStore;
  readonly webhookEvents: WebhookEventStore;
  readonly issueProjections: IssueProjectionStore;
  readonly issueWorkflows: IssueWorkflowStore;
  readonly workflowCoordinator: IssueWorkflowCoordinator;
  readonly runReports: RunReportStore;
  readonly stageEvents: StageEventStore;
  readonly linearInstallations: LinearInstallationStore;

  constructor(databasePath: string, wal: boolean) {
    this.connection = new SqliteConnection(databasePath);
    this.connection.pragma("foreign_keys = ON");
    if (wal) {
      this.connection.pragma("journal_mode = WAL");
    }

    this.authoritativeLedger = new AuthoritativeLedgerStore(this.connection);
    this.eventReceipts = this.authoritativeLedger;
    this.issueControl = this.authoritativeLedger;
    this.workspaceOwnership = this.authoritativeLedger;
    this.runLeases = this.authoritativeLedger;
    this.obligations = this.authoritativeLedger;
    this.webhookEvents = new WebhookEventStore(this.connection);
    this.issueProjections = new IssueProjectionStore(this.connection);
    this.runReports = new RunReportStore(this.connection);
    this.issueWorkflows = new IssueWorkflowStore({
      authoritativeLedger: this.authoritativeLedger,
      issueProjections: this.issueProjections,
      runReports: this.runReports,
    });
    this.workflowCoordinator = new IssueWorkflowCoordinator({
      connection: this.connection,
      authoritativeLedger: this.authoritativeLedger,
      issueProjections: this.issueProjections,
      issueWorkflows: this.issueWorkflows,
      runReports: this.runReports,
    });
    this.stageEvents = new StageEventStore(this.connection);
    this.linearInstallations = new LinearInstallationStore(this.connection);
  }

  runMigrations(): void {
    runPatchRelayMigrations(this.connection);
  }
}
