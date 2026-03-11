import Database from "better-sqlite3";
import { IssueWorkflowStore } from "./db/issue-workflow-store.ts";
import { LinearInstallationStore } from "./db/linear-installation-store.ts";
import { runPatchRelayMigrations } from "./db/migrations.ts";
import { StageEventStore } from "./db/stage-event-store.ts";
import { WebhookEventStore } from "./db/webhook-event-store.ts";

export class PatchRelayDatabase {
  readonly connection: Database.Database;
  readonly webhookEvents: WebhookEventStore;
  readonly issueWorkflows: IssueWorkflowStore;
  readonly stageEvents: StageEventStore;
  readonly linearInstallations: LinearInstallationStore;

  constructor(databasePath: string, wal: boolean) {
    this.connection = new Database(databasePath);
    this.connection.pragma("foreign_keys = ON");
    if (wal) {
      this.connection.pragma("journal_mode = WAL");
    }

    this.webhookEvents = new WebhookEventStore(this.connection);
    this.issueWorkflows = new IssueWorkflowStore(this.connection);
    this.stageEvents = new StageEventStore(this.connection);
    this.linearInstallations = new LinearInstallationStore(this.connection);
  }

  runMigrations(): void {
    runPatchRelayMigrations(this.connection);
  }
}
