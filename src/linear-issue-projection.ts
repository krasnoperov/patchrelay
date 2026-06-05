import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { LinearClientProvider, LinearIssueRelationSummary, LinearIssueSnapshot } from "./types.ts";

interface LinearIssueDependencySource {
  id: string;
  blockedBy: LinearIssueRelationSummary[];
}

export interface LinearIssueProjectionRefreshResult {
  refreshed: boolean;
  liveIssue?: LinearIssueSnapshot | undefined;
  error?: string | undefined;
}

export class LinearIssueProjectionService {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly linearProvider: LinearClientProvider,
    private readonly logger?: Logger | undefined,
  ) {}

  async refreshIssue(projectId: string, linearIssueId: string): Promise<LinearIssueProjectionRefreshResult> {
    return refreshIssueFromLinear({
      db: this.db,
      linearProvider: this.linearProvider,
      projectId,
      linearIssueId,
      logger: this.logger,
    });
  }
}

export async function refreshIssueFromLinear(params: {
  db: PatchRelayDatabase;
  linearProvider: LinearClientProvider;
  projectId: string;
  linearIssueId: string;
  logger?: Logger | undefined;
}): Promise<LinearIssueProjectionRefreshResult> {
  const linear = await params.linearProvider.forProject(params.projectId).catch((error) => {
    params.logger?.warn(
      {
        projectId: params.projectId,
        linearIssueId: params.linearIssueId,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to resolve Linear client while refreshing issue projection",
    );
    return undefined;
  });
  if (!linear) {
    return { refreshed: false, error: "linear_client_unavailable" };
  }

  try {
    const liveIssue = await linear.getIssue(params.linearIssueId);
    upsertLinearIssueProjection(params.db, params.projectId, liveIssue);
    return { refreshed: true, liveIssue };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    params.logger?.warn(
      {
        projectId: params.projectId,
        linearIssueId: params.linearIssueId,
        error: message,
      },
      "Failed to refresh issue projection from Linear",
    );
    return { refreshed: false, error: message };
  }
}

export function upsertLinearIssueProjection(
  db: PatchRelayDatabase,
  projectId: string,
  liveIssue: LinearIssueSnapshot,
): void {
  replaceIssueDependenciesFromLinearIssue(db, projectId, liveIssue);

  db.issues.replaceIssueParentLink({
    projectId,
    childLinearIssueId: liveIssue.id,
    parentLinearIssueId: liveIssue.parentId ?? null,
  });

  db.issues.upsertIssue({
    projectId,
    linearIssueId: liveIssue.id,
    ...(liveIssue.identifier ? { issueKey: liveIssue.identifier } : {}),
    ...(liveIssue.title ? { title: liveIssue.title } : {}),
    ...(liveIssue.description ? { description: liveIssue.description } : {}),
    ...(liveIssue.url ? { url: liveIssue.url } : {}),
    ...(liveIssue.priority != null ? { priority: liveIssue.priority } : {}),
    ...(liveIssue.estimate != null ? { estimate: liveIssue.estimate } : {}),
    ...(liveIssue.stateName ? { currentLinearState: liveIssue.stateName } : {}),
    ...(liveIssue.stateType ? { currentLinearStateType: liveIssue.stateType } : {}),
  });
}

export function replaceIssueDependenciesFromLinearIssue(
  db: PatchRelayDatabase,
  projectId: string,
  liveIssue: LinearIssueDependencySource,
): void {
  db.issues.replaceIssueDependencies({
    projectId,
    linearIssueId: liveIssue.id,
    blockers: liveIssue.blockedBy.map((blocker) => ({
      blockerLinearIssueId: blocker.id,
      ...(blocker.identifier ? { blockerIssueKey: blocker.identifier } : {}),
      ...(blocker.title ? { blockerTitle: blocker.title } : {}),
      ...(blocker.stateName ? { blockerCurrentLinearState: blocker.stateName } : {}),
      ...(blocker.stateType ? { blockerCurrentLinearStateType: blocker.stateType } : {}),
    })),
  });
}
