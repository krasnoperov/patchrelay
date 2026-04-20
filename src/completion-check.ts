import type { Logger } from "pino";
import { getThreadTurns } from "./codex-thread-utils.ts";
import type { CompletionCheckResult } from "./completion-check-types.ts";
import type { RunRecord } from "./db-types.ts";
import { extractLatestAssistantSummary } from "./issue-session-events.ts";
import { sanitizeOperatorFacingText } from "./presentation-text.ts";
import type { CodexThreadSummary, IssueRecord } from "./types.ts";
import { extractFirstJsonObject, safeJsonParse } from "./utils.ts";

const COMPLETION_CHECK_TIMEOUT_MS = 90_000;
const COMPLETION_CHECK_POLL_MS = 1_000;

interface CodexLike {
  forkThreadForCompletionCheck(threadId: string): Promise<CodexThreadSummary>;
  startTurn(options: { threadId: string; cwd?: string; input: string }): Promise<{ threadId: string; turnId: string; status: string }>;
  readThread(threadId: string, includeTurns?: boolean): Promise<CodexThreadSummary>;
}

export interface CompletionCheckExecution extends CompletionCheckResult {
  threadId: string;
  turnId: string;
}

export function extractCompletionCheck(run: Pick<
  RunRecord,
  | "completionCheckOutcome"
  | "completionCheckSummary"
  | "completionCheckQuestion"
  | "completionCheckWhy"
  | "completionCheckRecommendedReply"
> | undefined): CompletionCheckResult | undefined {
  if (!run?.completionCheckOutcome || !run.completionCheckSummary) {
    return undefined;
  }
  return {
    outcome: run.completionCheckOutcome,
    summary: run.completionCheckSummary,
    ...(run.completionCheckQuestion ? { question: run.completionCheckQuestion } : {}),
    ...(run.completionCheckWhy ? { why: run.completionCheckWhy } : {}),
    ...(run.completionCheckRecommendedReply ? { recommendedReply: run.completionCheckRecommendedReply } : {}),
  };
}

export class CompletionCheckService {
  constructor(
    private readonly codex: CodexLike,
    private readonly logger: Logger,
  ) {}

  async run(params: {
    issue: Pick<IssueRecord, "issueKey" | "linearIssueId" | "title" | "description" | "worktreePath">;
    run: Pick<RunRecord, "id" | "threadId" | "runType" | "failureReason" | "summaryJson" | "reportJson">;
    noPrSummary: string;
    onStarted?: ((start: { threadId: string; turnId: string }) => void | Promise<void>) | undefined;
  }): Promise<CompletionCheckExecution> {
    const threadId = params.run.threadId;
    if (!threadId) {
      return {
        outcome: "failed",
        summary: "No PR was found, and PatchRelay could not run the completion check because the main thread is missing.",
        threadId: "missing-thread",
        turnId: "missing-turn",
      };
    }

    const fork = await this.codex.forkThreadForCompletionCheck(threadId);
    const turn = await this.codex.startTurn({
      threadId: fork.id,
      ...(fork.cwd ? { cwd: fork.cwd } : {}),
      input: buildCompletionCheckPrompt(params),
    });
    await params.onStarted?.({ threadId: fork.id, turnId: turn.turnId });

    const completedThread = await this.waitForTurn(fork.id, turn.turnId);
    const completedTurn = getThreadTurns(completedThread).find((entry) => entry.id === turn.turnId);
    const latestMessage = completedTurn?.items
      .filter((item): item is Extract<typeof completedTurn.items[number], { type: "agentMessage" }> => item.type === "agentMessage")
      .at(-1)?.text;

    const parsed = parseCompletionCheckResult(latestMessage);
    if (!parsed) {
      this.logger.warn({ runId: params.run.id, issueKey: params.issue.issueKey, threadId: fork.id, turnId: turn.turnId }, "Completion check returned invalid JSON");
      return {
        outcome: "failed",
        summary: "No PR was found, and the completion check returned an invalid result.",
        threadId: fork.id,
        turnId: turn.turnId,
      };
    }

    return {
      ...parsed,
      threadId: fork.id,
      turnId: turn.turnId,
    };
  }

  private async waitForTurn(threadId: string, turnId: string): Promise<CodexThreadSummary> {
    const deadline = Date.now() + COMPLETION_CHECK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const thread = await this.codex.readThread(threadId, true);
      const turn = getThreadTurns(thread).find((entry) => entry.id === turnId);
      if (turn?.status === "completed") {
        return thread;
      }
      if (turn?.status === "failed" || turn?.status === "interrupted") {
        throw new Error(`Completion check turn ${turnId} ended with status ${turn.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, COMPLETION_CHECK_POLL_MS));
    }
    throw new Error(`Completion check timed out after ${COMPLETION_CHECK_TIMEOUT_MS}ms`);
  }
}

function buildCompletionCheckPrompt(params: {
  issue: Pick<IssueRecord, "issueKey" | "linearIssueId" | "title" | "description">;
  run: Pick<RunRecord, "runType" | "failureReason" | "summaryJson" | "reportJson">;
  noPrSummary: string;
}): string {
  const latestSummary = extractLatestAssistantSummary(params.run);
  return [
    "PatchRelay completion check",
    "",
    "The main task run finished without a linked PR.",
    "This is a read-only check. Do not run commands, call tools, edit files, or inspect the repository.",
    "Return exactly one JSON object and no extra prose.",
    "",
    "Schema:",
    '{',
    '  "outcome": "continue" | "needs_input" | "done" | "failed",',
    '  "summary": "short operator-facing summary",',
    '  "question": "required only for needs_input",',
    '  "why": "optional explanation",',
    '  "recommendedReply": "optional suggested reply for needs_input"',
    '}',
    "",
    "Choose:",
    '- "continue" if PatchRelay should keep working automatically on the same thread.',
    '- "needs_input" if a human must answer a concrete question before work can continue.',
    '- "done" if the task was successfully completed without a PR.',
    '- "failed" if the run stopped incorrectly and PatchRelay should not auto-continue.',
    "",
    "Bias rules:",
    '- Prefer "continue" when the task looks like normal code-delivery work and the run simply ended before publishing a branch or PR.',
    '- Use "done" only when the issue explicitly permits a no-PR outcome or the deliverable is clearly non-repo work such as planning, orchestration, or follow-up issue creation.',
    '- Use "needs_input" only when one specific missing human decision blocks the very next concrete action. Do not use it just because the branch might need more work.',
    '- If the run appears unfinished but still actionable by PatchRelay, return "continue", not "done".',
    "",
    "Facts:",
    `- Issue: ${params.issue.issueKey ?? params.issue.linearIssueId}`,
    ...(params.issue.title ? [`- Title: ${params.issue.title}`] : []),
    `- Run type: ${params.run.runType}`,
    `- No-PR summary: ${sanitizeOperatorFacingText(params.noPrSummary)}`,
    ...(latestSummary ? [`- Latest assistant summary: ${sanitizeOperatorFacingText(latestSummary)}`] : []),
    ...(params.run.failureReason ? [`- Failure reason: ${sanitizeOperatorFacingText(params.run.failureReason)}`] : []),
    ...(params.issue.description ? ["", "Issue description:", params.issue.description] : []),
  ].join("\n");
}

function parseCompletionCheckResult(text: string | undefined): CompletionCheckResult | undefined {
  const raw = sanitizeOperatorFacingText(text);
  if (!raw) return undefined;
  const candidate = safeJsonParse<Record<string, unknown>>(raw) ?? safeJsonParse<Record<string, unknown>>(extractFirstJsonObject(raw) ?? "");
  if (!candidate) return undefined;

  const outcome = typeof candidate.outcome === "string" ? candidate.outcome : undefined;
  const summary = typeof candidate.summary === "string" ? sanitizeOperatorFacingText(candidate.summary) : undefined;
  const question = typeof candidate.question === "string" ? sanitizeOperatorFacingText(candidate.question) : undefined;
  const why = typeof candidate.why === "string" ? sanitizeOperatorFacingText(candidate.why) : undefined;
  const recommendedReply = typeof candidate.recommendedReply === "string"
    ? sanitizeOperatorFacingText(candidate.recommendedReply)
    : undefined;

  if (!summary) return undefined;
  if (outcome !== "continue" && outcome !== "needs_input" && outcome !== "done" && outcome !== "failed") {
    return undefined;
  }
  if (outcome === "needs_input" && !question) {
    return undefined;
  }

  return {
    outcome,
    summary,
    ...(question ? { question } : {}),
    ...(why ? { why } : {}),
    ...(recommendedReply ? { recommendedReply } : {}),
  };
}
