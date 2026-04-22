import type { Logger } from "pino";
import { getThreadTurns } from "./codex-thread-utils.ts";
import { extractLatestAssistantSummary } from "./issue-session-events.ts";
import { sanitizeOperatorFacingText } from "./presentation-text.ts";
import type { CodexThreadSummary, IssueRecord } from "./types.ts";
import type { FactoryState } from "./factory-state.ts";
import type { RunRecord } from "./db-types.ts";
import { extractFirstJsonObject, safeJsonParse } from "./utils.ts";

const PUBLICATION_RECAP_TIMEOUT_MS = 45_000;
const PUBLICATION_RECAP_POLL_MS = 1_000;

interface CodexLike {
  forkThreadForPublicationRecap(threadId: string): Promise<CodexThreadSummary>;
  startTurn(options: { threadId: string; cwd?: string; input: string }): Promise<{ threadId: string; turnId: string; status: string }>;
  readThread(threadId: string, includeTurns?: boolean): Promise<CodexThreadSummary>;
}

export interface PublicationRecapResult {
  summary: string;
  threadId: string;
  turnId: string;
}

export interface PublicationRecapFacts {
  wakeReason?: string | undefined;
  postRunState?: FactoryState | undefined;
  prNumber?: number | undefined;
  reviewerName?: string | undefined;
  reviewSummary?: string | undefined;
  failingCheckName?: string | undefined;
  failureSummary?: string | undefined;
  queueIncidentSummary?: string | undefined;
  latestAssistantSummary?: string | undefined;
}

export class PublicationRecapService {
  constructor(
    private readonly codex: CodexLike,
    private readonly logger: Logger,
  ) {}

  async run(params: {
    issue: Pick<IssueRecord, "issueKey" | "linearIssueId" | "title" | "description">;
    run: Pick<RunRecord, "id" | "threadId" | "runType" | "failureReason" | "summaryJson" | "reportJson">;
    facts?: PublicationRecapFacts;
  }): Promise<PublicationRecapResult> {
    const threadId = params.run.threadId;
    if (!threadId) {
      throw new Error("Publication recap could not run because the main thread is missing.");
    }

    const fork = await this.codex.forkThreadForPublicationRecap(threadId);
    const turn = await this.codex.startTurn({
      threadId: fork.id,
      ...(fork.cwd ? { cwd: fork.cwd } : {}),
      input: buildPublicationRecapPrompt(params),
    });

    const completedThread = await this.waitForTurn(fork.id, turn.turnId);
    const completedTurn = getThreadTurns(completedThread).find((entry) => entry.id === turn.turnId);
    const latestMessage = completedTurn?.items
      .filter((item): item is Extract<typeof completedTurn.items[number], { type: "agentMessage" }> => item.type === "agentMessage")
      .at(-1)?.text;

    const parsed = parsePublicationRecapResult(latestMessage);
    if (!parsed) {
      this.logger.warn({ runId: params.run.id, issueKey: params.issue.issueKey, threadId: fork.id, turnId: turn.turnId }, "Publication recap returned invalid JSON");
      throw new Error("Publication recap returned an invalid result.");
    }

    return {
      ...parsed,
      threadId: fork.id,
      turnId: turn.turnId,
    };
  }

  private async waitForTurn(threadId: string, turnId: string): Promise<CodexThreadSummary> {
    const deadline = Date.now() + PUBLICATION_RECAP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const thread = await this.codex.readThread(threadId, true);
      const turn = getThreadTurns(thread).find((entry) => entry.id === turnId);
      if (turn?.status === "completed") {
        return thread;
      }
      if (turn?.status === "failed" || turn?.status === "interrupted") {
        throw new Error(`Publication recap turn ${turnId} ended with status ${turn.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, PUBLICATION_RECAP_POLL_MS));
    }
    throw new Error(`Publication recap timed out after ${PUBLICATION_RECAP_TIMEOUT_MS}ms`);
  }
}

function buildPublicationRecapPrompt(params: {
  issue: Pick<IssueRecord, "issueKey" | "linearIssueId" | "title" | "description">;
  run: Pick<RunRecord, "runType" | "failureReason" | "summaryJson" | "reportJson">;
  facts?: PublicationRecapFacts;
}): string {
  const latestSummary = params.facts?.latestAssistantSummary
    ? sanitizeOperatorFacingText(params.facts.latestAssistantSummary)
    : extractLatestAssistantSummary(params.run);
  return [
    "PatchRelay publication recap",
    "",
    "The main task run succeeded.",
    "This is a read-only follow-up used only to produce one concise Linear-visible recap for that successful run.",
    "Do not run commands, call tools, edit files, or inspect the repository.",
    "Use only the prior thread context and the facts in this prompt.",
    "Return exactly one JSON object and no extra prose.",
    "",
    "Schema:",
    '{',
    '  "summary": "one short sentence, max 30 words"',
    '}',
    "",
    "Writing rules:",
    "- Focus on what this session chunk achieved.",
    "- Mention the wake reason only when it makes the change clearer, for example requested changes, a failing CI check, or a merge queue incident.",
    "- Do not list touched files, test commands, branch names, commit SHAs, or internal process details.",
    "- Do not say that you reviewed files or ran checks unless that is the only meaningful achievement.",
    "- For implementation runs, summarize the delivered user-facing or system-facing change.",
    "- For review-fix runs, summarize the concern that was addressed and imply that a newer head was published.",
    "- For CI repair runs, summarize the failure that was fixed if known.",
    "- For queue repair runs, summarize the queue or merge issue that was resolved if known.",
    "",
    "Facts:",
    `- Issue: ${params.issue.issueKey ?? params.issue.linearIssueId}`,
    ...(params.issue.title ? [`- Title: ${params.issue.title}`] : []),
    `- Run type: ${params.run.runType}`,
    ...(params.facts?.postRunState ? [`- Post-run state: ${params.facts.postRunState}`] : []),
    ...(params.facts?.wakeReason ? [`- Wake reason: ${params.facts.wakeReason}`] : []),
    ...(params.facts?.prNumber !== undefined ? [`- PR number: ${params.facts.prNumber}`] : []),
    ...(params.facts?.reviewerName ? [`- Reviewer: ${params.facts.reviewerName}`] : []),
    ...(params.facts?.reviewSummary ? [`- Review summary: ${sanitizeOperatorFacingText(params.facts.reviewSummary)}`] : []),
    ...(params.facts?.failingCheckName ? [`- Failing check: ${params.facts.failingCheckName}`] : []),
    ...(params.facts?.failureSummary ? [`- Failure summary: ${sanitizeOperatorFacingText(params.facts.failureSummary)}`] : []),
    ...(params.facts?.queueIncidentSummary ? [`- Queue incident: ${sanitizeOperatorFacingText(params.facts.queueIncidentSummary)}`] : []),
    ...(latestSummary ? [`- Latest assistant summary: ${latestSummary}`] : []),
    ...(params.run.failureReason ? [`- Failure reason: ${sanitizeOperatorFacingText(params.run.failureReason)}`] : []),
    ...(params.issue.description ? ["", "Issue description:", params.issue.description] : []),
  ].join("\n");
}

function parsePublicationRecapResult(text: string | undefined): { summary: string } | undefined {
  const raw = sanitizeOperatorFacingText(text);
  if (!raw) return undefined;
  const candidate = safeJsonParse<Record<string, unknown>>(raw) ?? safeJsonParse<Record<string, unknown>>(extractFirstJsonObject(raw) ?? "");
  if (!candidate) return undefined;
  const summary = typeof candidate.summary === "string" ? sanitizeOperatorFacingText(candidate.summary) : undefined;
  if (!summary) return undefined;
  return { summary };
}
