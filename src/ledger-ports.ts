import type { EventReceiptRecord, IssueControlRecord, ObligationRecord, RunLeaseRecord, WorkspaceOwnershipRecord } from "./types.ts";
import type { IssueLifecycleStatus, WorkflowStage } from "./workflow-types.ts";

export interface EventReceiptStore {
  insertEventReceipt(params: {
    source: string;
    externalId: string;
    eventType: string;
    receivedAt: string;
    acceptanceStatus: EventReceiptRecord["acceptanceStatus"];
    projectId?: string;
    linearIssueId?: string;
    headersJson?: string;
    payloadJson?: string;
  }): { id: number; inserted: boolean };
  markEventReceiptProcessed(id: number, status: EventReceiptRecord["processingStatus"]): void;
  assignEventReceiptContext(id: number, params: { projectId?: string; linearIssueId?: string }): void;
  getEventReceipt(id: number): EventReceiptRecord | undefined;
  getEventReceiptBySourceExternalId(source: string, externalId: string): EventReceiptRecord | undefined;
}

export interface EventReceiptStoreProvider {
  eventReceipts: EventReceiptStore;
}

export interface IssueControlStore {
  upsertIssueControl(params: {
    projectId: string;
    linearIssueId: string;
    desiredStage?: WorkflowStage | null;
    desiredReceiptId?: number | null;
    activeWorkspaceOwnershipId?: number | null;
    activeRunLeaseId?: number | null;
    serviceOwnedCommentId?: string | null;
    activeAgentSessionId?: string | null;
    lifecycleStatus: IssueLifecycleStatus;
  }): IssueControlRecord;
  getIssueControl(projectId: string, linearIssueId: string): IssueControlRecord | undefined;
  listIssueControlsReadyForLaunch(): IssueControlRecord[];
}

export interface IssueControlStoreProvider {
  issueControl: IssueControlStore;
}

export interface WorkspaceOwnershipStore {
  upsertWorkspaceOwnership(params: {
    projectId: string;
    linearIssueId: string;
    branchName: string;
    worktreePath: string;
    status: WorkspaceOwnershipRecord["status"];
    currentRunLeaseId?: number | null;
  }): WorkspaceOwnershipRecord;
  getWorkspaceOwnership(id: number): WorkspaceOwnershipRecord | undefined;
  getWorkspaceOwnershipForIssue(projectId: string, linearIssueId: string): WorkspaceOwnershipRecord | undefined;
}

export interface WorkspaceOwnershipStoreProvider {
  workspaceOwnership: WorkspaceOwnershipStore;
}

export interface RunLeaseStore {
  createRunLease(params: {
    issueControlId: number;
    projectId: string;
    linearIssueId: string;
    workspaceOwnershipId: number;
    stage: WorkflowStage;
    workflowFile?: string;
    promptText?: string;
    triggerReceiptId?: number | null;
    status?: Extract<RunLeaseRecord["status"], "queued" | "running" | "paused">;
  }): RunLeaseRecord;
  getRunLease(id: number): RunLeaseRecord | undefined;
  getRunLeaseByThreadId(threadId: string): RunLeaseRecord | undefined;
  listActiveRunLeases(): RunLeaseRecord[];
  listRunLeasesForIssue(projectId: string, linearIssueId: string): RunLeaseRecord[];
  updateRunLeaseThread(params: {
    runLeaseId: number;
    threadId?: string | null;
    parentThreadId?: string | null;
    turnId?: string | null;
  }): void;
  finishRunLease(params: {
    runLeaseId: number;
    status: Extract<RunLeaseRecord["status"], "paused" | "completed" | "failed" | "released">;
    threadId?: string | null;
    turnId?: string | null;
    failureReason?: string | null;
  }): void;
}

export interface RunLeaseStoreProvider {
  runLeases: RunLeaseStore;
}

export interface ObligationStore {
  enqueueObligation(params: {
    projectId: string;
    linearIssueId: string;
    kind: string;
    source: string;
    payloadJson: string;
    runLeaseId?: number | null;
    threadId?: string | null;
    turnId?: string | null;
    dedupeKey?: string | null;
  }): ObligationRecord;
  getObligationByDedupeKey(params: { runLeaseId: number; kind: string; dedupeKey: string }): ObligationRecord | undefined;
  listPendingObligations(params?: { runLeaseId?: number; kind?: string; includeInProgress?: boolean }): ObligationRecord[];
  claimPendingObligation(id: number, params?: { runLeaseId?: number | null; threadId?: string | null; turnId?: string | null }): boolean;
  updateObligationPayloadJson(id: number, payloadJson: string): void;
  updateObligationRouting(id: number, params: { runLeaseId?: number | null; threadId?: string | null; turnId?: string | null }): void;
  markObligationStatus(id: number, status: ObligationRecord["status"], lastError?: string | null): void;
}

export interface ObligationStoreProvider {
  obligations: ObligationStore;
}

export interface AuthoritativeLedgerStore extends EventReceiptStore, IssueControlStore, WorkspaceOwnershipStore, RunLeaseStore, ObligationStore {}

export interface AuthoritativeLedgerStoreProvider {
  authoritativeLedger: AuthoritativeLedgerStore;
}
