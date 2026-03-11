import type { Logger } from "pino";
import type { LinearClientProvider, TrackedIssueRecord } from "./types.ts";

type AgentActivityContent =
  | { type: "thought" | "elicitation" | "response" | "error"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string };

export class StageAgentActivityPublisher {
  constructor(
    private readonly linearProvider: LinearClientProvider,
    private readonly logger: Logger,
  ) {}

  async publishForSession(projectId: string, agentSessionId: string, content: AgentActivityContent): Promise<void> {
    const linear = await this.linearProvider.forProject(projectId);
    if (!linear) {
      return;
    }

    try {
      await linear.createAgentActivity({
        agentSessionId,
        content,
        ephemeral: content.type === "thought" || content.type === "action",
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

  async publishForIssue(issue: TrackedIssueRecord, content: AgentActivityContent): Promise<void> {
    if (!issue.activeAgentSessionId) {
      return;
    }

    await this.publishForSession(issue.projectId, issue.activeAgentSessionId, content);
  }
}
