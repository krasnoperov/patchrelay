import type { CodexAppServerClient } from "./codex-app-server.ts";
import type {
  IssueControlStoreProvider,
  ObligationStoreProvider,
  RunLeaseStoreProvider,
  WorkspaceOwnershipStoreProvider,
} from "./ledger-ports.ts";
import type { ReconciliationInput, ReconciliationObligation } from "./reconciliation-types.ts";
import type {
  AppConfig,
  IssueControlRecord,
  LinearClientProvider,
  RunLeaseRecord,
  WorkspaceOwnershipRecord,
} from "./types.ts";
import { safeJsonParse } from "./utils.ts";

export interface ReconciliationSnapshot {
  issueControl: IssueControlRecord;
  runLease: RunLeaseRecord;
  workspaceOwnership?: WorkspaceOwnershipRecord;
  input: ReconciliationInput;
}

type SnapshotStores = IssueControlStoreProvider &
  RunLeaseStoreProvider &
  Partial<WorkspaceOwnershipStoreProvider & ObligationStoreProvider>;

export async function buildReconciliationSnapshot(params: {
  config: Pick<AppConfig, "projects">;
  stores: SnapshotStores;
  linearProvider: LinearClientProvider;
  codex: Pick<CodexAppServerClient, "readThread">;
  runLeaseId: number;
}): Promise<ReconciliationSnapshot | undefined> {
  const runLease = params.stores.runLeases.getRunLease(params.runLeaseId);
  if (!runLease) {
    return undefined;
  }

  const issueControl = params.stores.issueControl.getIssueControl(runLease.projectId, runLease.linearIssueId);
  if (!issueControl) {
    return undefined;
  }

  const workspaceOwnership = params.stores.workspaceOwnership?.getWorkspaceOwnership(runLease.workspaceOwnershipId);
  const project = params.config.projects.find((candidate) => candidate.id === runLease.projectId);
  const workflowConfig = project?.workflows.find((workflow) => workflow.id === runLease.stage);
  const liveLinear =
    project
      ? await params.linearProvider
          .forProject(runLease.projectId)
          .then((linear) =>
            linear
              ? linear.getIssue(runLease.linearIssueId).then((issue) =>
                  issue.stateName
                    ? {
                        status: "known" as const,
                        issue: {
                          id: issue.id,
                          stateName: issue.stateName,
                        },
                      }
                    : ({ status: "unknown" as const }),
                )
              : ({ status: "unknown" as const }),
          )
          .catch(() => ({ status: "unknown" as const }))
      : ({ status: "unknown" as const });

  const liveCodex =
    runLease.threadId
      ? await params.codex
          .readThread(runLease.threadId, true)
          .then((thread) => ({ status: "found" as const, thread }))
          .catch((error) => ({
            status: "error" as const,
            errorMessage: error instanceof Error ? error.message : String(error),
          }))
      : ({ status: "unknown" as const });

  const obligations: ReconciliationObligation[] =
    params.stores.obligations?.listPendingObligations({ runLeaseId: runLease.id }).map((obligation) => {
      const payload = safeJsonParse<unknown>(obligation.payloadJson);
      return {
        id: obligation.id,
        kind: obligation.kind,
        status: obligation.status,
        ...(obligation.runLeaseId !== undefined ? { runId: obligation.runLeaseId } : {}),
        ...(obligation.threadId ? { threadId: obligation.threadId } : {}),
        ...(obligation.turnId ? { turnId: obligation.turnId } : {}),
        ...(payload !== undefined ? { payload } : {}),
      };
    }) ?? [];

  return {
    issueControl,
    runLease,
    ...(workspaceOwnership ? { workspaceOwnership } : {}),
    input: {
      issue: {
        projectId: runLease.projectId,
        linearIssueId: runLease.linearIssueId,
        ...(issueControl.desiredStage ? { desiredStage: issueControl.desiredStage } : {}),
        lifecycleStatus: issueControl.lifecycleStatus,
        ...(issueControl.serviceOwnedCommentId ? { statusCommentId: issueControl.serviceOwnedCommentId } : {}),
        activeRun: {
          id: runLease.id,
          stage: runLease.stage,
          status: runLease.status,
          ...(runLease.threadId ? { threadId: runLease.threadId } : {}),
          ...(runLease.turnId ? { turnId: runLease.turnId } : {}),
          ...(runLease.parentThreadId ? { parentThreadId: runLease.parentThreadId } : {}),
        },
      },
      ...(obligations.length > 0 ? { obligations } : {}),
      ...(workflowConfig
        ? {
            policy: {
              ...(workflowConfig.activeState ? { activeLinearStateName: workflowConfig.activeState } : {}),
              ...(workflowConfig.fallbackState ? { fallbackLinearStateName: workflowConfig.fallbackState } : {}),
            },
          }
        : {}),
      live: {
        linear: liveLinear,
        codex: liveCodex,
      },
    },
  };
}
