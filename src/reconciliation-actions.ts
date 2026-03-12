import type { IssueLifecycleStatus, WorkflowStage } from "./workflow-types.ts";

export type ReconciliationEntityId = string | number;

export type ReconciliationAction =
  | {
      type: "read_linear_issue";
      projectId: string;
      linearIssueId: string;
      reason: string;
    }
  | {
      type: "read_codex_thread";
      projectId: string;
      linearIssueId: string;
      runId: ReconciliationEntityId;
      threadId: string;
      reason: string;
    }
  | {
      type: "launch_desired_stage";
      projectId: string;
      linearIssueId: string;
      stage: WorkflowStage;
      runId?: ReconciliationEntityId;
      reason: string;
    }
  | {
      type: "keep_run_active";
      projectId: string;
      linearIssueId: string;
      runId: ReconciliationEntityId;
      reason: string;
    }
  | {
      type: "mark_run_completed";
      projectId: string;
      linearIssueId: string;
      runId: ReconciliationEntityId;
      threadId: string;
      turnId?: string;
      reason: string;
    }
  | {
      type: "mark_run_failed";
      projectId: string;
      linearIssueId: string;
      runId: ReconciliationEntityId;
      threadId?: string;
      turnId?: string;
      reason: string;
    }
  | {
      type: "clear_active_run";
      projectId: string;
      linearIssueId: string;
      runId: ReconciliationEntityId;
      nextLifecycleStatus: IssueLifecycleStatus;
      reason: string;
    }
  | {
      type: "release_issue_ownership";
      projectId: string;
      linearIssueId: string;
      runId?: ReconciliationEntityId;
      nextLifecycleStatus: IssueLifecycleStatus;
      reason: string;
    }
  | {
      type: "sync_linear_failure";
      projectId: string;
      linearIssueId: string;
      runId: ReconciliationEntityId;
      expectedStateName?: string;
      fallbackStateName?: string;
      message: string;
    }
  | {
      type: "refresh_status_comment";
      projectId: string;
      linearIssueId: string;
      runId?: ReconciliationEntityId;
      commentId?: string;
      mode: "running" | "failed" | "awaiting_handoff" | "completed";
      reason: string;
    }
  | {
      type: "route_obligation";
      projectId: string;
      linearIssueId: string;
      obligationId: ReconciliationEntityId;
      runId: ReconciliationEntityId;
      threadId: string;
      turnId: string;
      reason: string;
    }
  | {
      type: "deliver_obligation";
      projectId: string;
      linearIssueId: string;
      obligationId: ReconciliationEntityId;
      runId: ReconciliationEntityId;
      threadId: string;
      turnId: string;
      reason: string;
    }
  | {
      type: "await_codex_retry";
      projectId: string;
      linearIssueId: string;
      runId: ReconciliationEntityId;
      reason: string;
    };
