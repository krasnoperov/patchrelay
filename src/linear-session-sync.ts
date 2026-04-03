import type { Logger } from "pino";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { RunType } from "./factory-state.ts";
import type { AppConfig, LinearClientProvider, LinearAgentActivityContent } from "./types.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import { buildAgentSessionPlanForIssue } from "./agent-session-plan.ts";
import { buildAgentSessionExternalUrls } from "./agent-session-presentation.ts";

const PROGRESS_THROTTLE_MS = 5_000;

export class LinearSessionSync {
  private readonly progressThrottle = new Map<number, number>();

  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly linearProvider: LinearClientProvider,
    private readonly logger: Logger,
    private readonly feed?: OperatorEventFeed,
  ) {}

  async emitActivity(
    issue: IssueRecord,
    content: LinearAgentActivityContent,
    options?: { ephemeral?: boolean },
  ): Promise<void> {
    if (!issue.agentSessionId) return;
    try {
      const linear = await this.linearProvider.forProject(issue.projectId);
      if (!linear) return;
      const allowEphemeral = content.type === "thought" || content.type === "action";
      await linear.createAgentActivity({
        agentSessionId: issue.agentSessionId,
        content,
        ...(options?.ephemeral && allowEphemeral ? { ephemeral: true } : {}),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn({ issueKey: issue.issueKey, type: content.type, error: msg }, "Failed to emit Linear activity");
      this.feed?.publish({
        level: "warn",
        kind: "linear",
        issueKey: issue.issueKey,
        projectId: issue.projectId,
        status: "linear_error",
        summary: `Linear activity failed: ${msg}`,
      });
    }
  }

  async syncSession(issue: IssueRecord, options?: { activeRunType?: RunType }): Promise<void> {
    if (!issue.agentSessionId) return;
    try {
      const linear = await this.linearProvider.forProject(issue.projectId);
      if (!linear?.updateAgentSession) return;
      const externalUrls = buildAgentSessionExternalUrls(this.config, {
        ...(issue.issueKey ? { issueKey: issue.issueKey } : {}),
        ...(issue.prUrl ? { prUrl: issue.prUrl } : {}),
      });
      await linear.updateAgentSession({
        agentSessionId: issue.agentSessionId,
        plan: buildAgentSessionPlanForIssue(issue, options),
        ...(externalUrls ? { externalUrls } : {}),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn({ issueKey: issue.issueKey, error: msg }, "Failed to update Linear plan");
    }
  }

  async syncCodexPlan(issue: IssueRecord, params: Record<string, unknown>): Promise<void> {
    if (!issue.agentSessionId) return;
    const plan = params.plan;
    if (!Array.isArray(plan)) return;

    const STATUS_MAP: Record<string, "pending" | "inProgress" | "completed"> = {
      pending: "pending",
      inProgress: "inProgress",
      completed: "completed",
    };

    const steps = plan.map((entry) => {
      const e = entry as Record<string, unknown>;
      const step = typeof e.step === "string" ? e.step : String(e.step ?? "");
      const status = typeof e.status === "string" ? (STATUS_MAP[e.status] ?? "pending") : "pending";
      return { content: step, status };
    });

    const fullPlan = [
      { content: "Prepare workspace", status: "completed" as const },
      ...steps,
      { content: "Merge", status: "pending" as const },
    ];

    try {
      const linear = await this.linearProvider.forProject(issue.projectId);
      if (!linear?.updateAgentSession) return;
      await linear.updateAgentSession({
        agentSessionId: issue.agentSessionId,
        plan: fullPlan,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn({ issueKey: issue.issueKey, error: msg }, "Failed to sync codex plan to Linear");
    }
  }

  maybeEmitProgress(notification: { method: string; params: Record<string, unknown> }, run: RunRecord): void {
    const activity = resolveProgressActivity(notification);
    if (!activity) return;

    const now = Date.now();
    const lastEmit = this.progressThrottle.get(run.id) ?? 0;
    if (now - lastEmit < PROGRESS_THROTTLE_MS) return;
    this.progressThrottle.set(run.id, now);

    const issue = this.db.getIssue(run.projectId, run.linearIssueId);
    if (issue) {
      void this.emitActivity(issue, activity, { ephemeral: true });
    }
  }

  clearProgress(runId: number): void {
    this.progressThrottle.delete(runId);
  }
}

function resolveProgressActivity(notification: { method: string; params: Record<string, unknown> }): LinearAgentActivityContent | undefined {
  if (notification.method === "item/started") {
    const item = notification.params.item as Record<string, unknown> | undefined;
    if (!item) return undefined;
    const type = typeof item.type === "string" ? item.type : undefined;

    if (type === "commandExecution") {
      const cmd = item.command;
      const cmdStr = Array.isArray(cmd) ? cmd.join(" ") : typeof cmd === "string" ? cmd : undefined;
      return { type: "action", action: "Running", parameter: cmdStr?.slice(0, 120) ?? "command" };
    }
    if (type === "mcpToolCall") {
      const server = typeof item.server === "string" ? item.server : "";
      const tool = typeof item.tool === "string" ? item.tool : "";
      return { type: "action", action: "Using", parameter: `${server}/${tool}` };
    }
    if (type === "dynamicToolCall") {
      const tool = typeof item.tool === "string" ? item.tool : "tool";
      return { type: "action", action: "Using", parameter: tool };
    }
  }
  return undefined;
}
