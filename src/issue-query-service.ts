import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import {
  IssueOverviewQuery,
  type RunStatusProvider,
} from "./issue-overview-query.ts";
import { PublicAgentSessionStatusQuery } from "./public-agent-session-status-query.ts";

export class IssueQueryService {
  private readonly overviewQuery: IssueOverviewQuery;
  private readonly publicStatusQuery: PublicAgentSessionStatusQuery;

  constructor(
    db: PatchRelayDatabase,
    codex: CodexAppServerClient,
    private readonly runStatusProvider: RunStatusProvider,
  ) {
    this.overviewQuery = new IssueOverviewQuery(db, codex, runStatusProvider);
    this.publicStatusQuery = new PublicAgentSessionStatusQuery(db, this.overviewQuery);
  }

  async getIssueOverview(issueKey: string) {
    return await this.overviewQuery.getIssueOverview(issueKey);
  }

  async getActiveRunStatus(issueKey: string) {
    return await this.runStatusProvider.getActiveRunStatus(issueKey);
  }

  async getPublicAgentSessionStatus(issueKey: string) {
    return await this.publicStatusQuery.getStatus(issueKey);
  }
}
