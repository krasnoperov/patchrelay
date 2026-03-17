import type { Logger } from "pino";
import { buildAgentSessionExternalUrls } from "./agent-session-presentation.ts";
import type {
  AppConfig,
  LinearAgentSessionPlanItem,
  LinearClientProvider,
  TrackedIssueRecord,
} from "./types.ts";

type AgentActivityContent =
  | { type: "thought" | "elicitation" | "response" | "error"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string };

export class StageAgentActivityPublisher {
  constructor(
    private readonly config: AppConfig,
    private readonly linearProvider: LinearClientProvider,
    private readonly logger: Logger,
  ) {}

  async publishForSession(
    projectId: string,
    agentSessionId: string,
    content: AgentActivityContent,
    options?: { ephemeral?: boolean },
  ): Promise<void> {
    const linear = await this.linearProvider.forProject(projectId);
    if (!linear) {
      return;
    }

    try {
      await linear.createAgentActivity({
        agentSessionId,
        content,
        ephemeral: options?.ephemeral ?? (content.type === "thought" || content.type === "action"),
      });
    } catch (error) {
      this.logger.warn(
        {
          agentSessionId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to publish Linear agent activity",
      );
    }
  }

  async publishForIssue(issue: TrackedIssueRecord, content: AgentActivityContent, options?: { ephemeral?: boolean }): Promise<void> {
    if (!issue.activeAgentSessionId) {
      return;
    }

    await this.publishForSession(issue.projectId, issue.activeAgentSessionId, content, options);
  }

  async updateSession(params: {
    projectId: string;
    agentSessionId: string;
    issueKey?: string;
    plan?: LinearAgentSessionPlanItem[];
  }): Promise<void> {
    const linear = await this.linearProvider.forProject(params.projectId);
    if (!linear?.updateAgentSession) {
      return;
    }

    const externalUrls = buildAgentSessionExternalUrls(this.config, params.issueKey);
    if (!externalUrls && !params.plan) {
      return;
    }

    try {
      await linear.updateAgentSession({
        agentSessionId: params.agentSessionId,
        ...(externalUrls ? { externalUrls } : {}),
        ...(params.plan ? { plan: params.plan } : {}),
      });
    } catch (error) {
      this.logger.warn(
        {
          agentSessionId: params.agentSessionId,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to update Linear agent session",
      );
    }
  }
}
