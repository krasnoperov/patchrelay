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
import { resolveWorkflowStageConfig } from "./workflow-policy.ts";
import { safeJsonParse } from "./utils.ts";

export interface ReconciliationSnapshot {
  issueControl: IssueControlRecord;
  runLease: RunLeaseRecord;
  workspaceOwnership?: WorkspaceOwnershipRecord;
  input: ReconciliationInput;
}

type SnapshotStores = IssueControlStoreProvider & RunLeaseStoreProvider & WorkspaceOwnershipStoreProvider & ObligationStoreProvider;

export async function buildReconciliationSnapshot(params: {
  config: Pick<AppConfig, "projects">;
  stores: SnapshotStores;
  linearProvider: LinearClientProvider;
  codex: Pick<CodexAppServerClient, "readThread" | "resumeThread">;
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

  const workspaceOwnership = params.stores.workspaceOwnership.getWorkspaceOwnership(runLease.workspaceOwnershipId);
  const project = params.config.projects.find((candidate) => candidate.id === runLease.projectId);
  const workflowConfig = project ? resolveWorkflowStageConfig(project, runLease.stage, issueControl.selectedWorkflowId) : undefined;
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

  const liveCodex = runLease.threadId
    ? await hydrateLiveCodexState({
        codex: params.codex,
        threadId: runLease.threadId,
        ...(workspaceOwnership?.worktreePath ? { cwd: workspaceOwnership.worktreePath } : {}),
      })
    : ({ status: "unknown" as const });

  const obligations: ReconciliationObligation[] = params.stores.obligations
    .listPendingObligations({ runLeaseId: runLease.id, includeInProgress: true })
    .map((obligation) => {
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
    });

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

async function hydrateLiveCodexState(params: {
  codex: Pick<CodexAppServerClient, "readThread" | "resumeThread">;
  threadId: string;
  cwd?: string;
}) {
  try {
    const thread = await params.codex.readThread(params.threadId, true);
    if (latestThreadTurn(thread)?.status === "interrupted" && params.cwd) {
      const resumedThread = await tryResumeThread(params.codex, params.threadId, params.cwd);
      if (resumedThread) {
        return { status: "found" as const, thread: resumedThread };
      }
    }
    return { status: "found" as const, thread };
  } catch (error) {
    const mapped = mapCodexReadFailure(error);
    if (mapped.status === "missing" && params.cwd) {
      const resumedThread = await tryResumeThread(params.codex, params.threadId, params.cwd);
      if (resumedThread) {
        return { status: "found" as const, thread: resumedThread };
      }
    }
    return mapped;
  }
}

async function tryResumeThread(
  codex: Pick<CodexAppServerClient, "resumeThread">,
  threadId: string,
  cwd: string,
) {
  try {
    return await codex.resumeThread(threadId, cwd);
  } catch {
    return undefined;
  }
}

function latestThreadTurn(thread: { turns: Array<{ status: string }> }) {
  return thread.turns.at(-1);
}

function mapCodexReadFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.trim().toLowerCase();
  if (normalized.includes("not found") || normalized.includes("missing")) {
    return { status: "missing" as const };
  }
  return {
    status: "error" as const,
    errorMessage: message,
  };
}
