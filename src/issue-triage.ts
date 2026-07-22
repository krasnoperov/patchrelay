import { createHash } from "node:crypto";
import type { Logger } from "pino";
import { getThreadTurns } from "./codex-thread-utils.ts";
import { isThreadMaterializingError } from "./codex-thread-errors.ts";
import type { IssueClass } from "./issue-class.ts";
import type { IssueRecord } from "./db-types.ts";
import type { CodexThreadSummary } from "./types.ts";
import { extractFirstJsonObject, safeJsonParse } from "./utils.ts";
import { deriveIssuePhase } from "./issue-phase.ts";

const TRIAGE_TIMEOUT_MS = 45_000;
const TRIAGE_POLL_MS = 1_000;
const MIN_CONFIDENCE = 0.55;

export type IssueTriageIntent =
  | "code_change"
  | "split_into_children"
  | "investigate"
  | "review"
  | "coordination"
  | "needs_input";

export interface IssueTriageResult {
  issueClass: IssueClass;
  intent: IssueTriageIntent;
  confidence: number;
  reason: string;
}

type TriageChildIssue = Pick<IssueRecord,
  | "linearIssueId" | "issueKey" | "title" | "currentLinearState"
  | "delegatedToPatchRelay" | "workflowOutcome" | "inputRequestKind"
  | "prNumber" | "prState" | "prIsDraft" | "prReviewState" | "prCheckStatus"
  | "lastGitHubFailureSource" | "deployStartedAt"
>;

interface CodexLike {
  startThreadForIssueTriage(): Promise<CodexThreadSummary>;
  startTurn(options: { threadId: string; cwd?: string; input: string }): Promise<{ threadId: string; turnId: string; status: string }>;
  readThread(threadId: string, includeTurns?: boolean): Promise<CodexThreadSummary>;
}

export function buildIssueTriageHash(params: {
  issue: Pick<IssueRecord, "linearIssueId" | "issueKey" | "title" | "description" | "parentLinearIssueId">;
  childIssues: TriageChildIssue[];
}): string {
  const payload = {
    linearIssueId: params.issue.linearIssueId,
    issueKey: params.issue.issueKey ?? null,
    title: params.issue.title ?? "",
    description: params.issue.description ?? "",
    parentLinearIssueId: params.issue.parentLinearIssueId ?? null,
    childIssues: params.childIssues.map((child) => ({
      linearIssueId: child.linearIssueId,
      issueKey: child.issueKey ?? null,
      title: child.title ?? "",
      currentLinearState: child.currentLinearState ?? null,
      phase: deriveIssuePhase(child),
    })),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export class IssueTriageService {
  constructor(
    private readonly codex: CodexLike,
    private readonly logger: Logger,
  ) {}

  async classify(params: {
    issue: Pick<IssueRecord, "linearIssueId" | "issueKey" | "title" | "description" | "parentLinearIssueId">;
    childIssues: TriageChildIssue[];
  }): Promise<IssueTriageResult | undefined> {
    const thread = await this.codex.startThreadForIssueTriage();
    const turn = await this.codex.startTurn({
      threadId: thread.id,
      ...(thread.cwd ? { cwd: thread.cwd } : {}),
      input: buildIssueTriagePrompt(params),
    });

    const completedThread = await this.waitForTurn(thread.id, turn.turnId);
    const completedTurn = getThreadTurns(completedThread).find((entry) => entry.id === turn.turnId);
    const latestMessage = completedTurn?.items
      .filter((item): item is Extract<typeof completedTurn.items[number], { type: "agentMessage" }> => item.type === "agentMessage")
      .at(-1)?.text;

    const parsed = parseIssueTriageResult(latestMessage);
    if (!parsed) {
      this.logger.warn(
        { issueKey: params.issue.issueKey, linearIssueId: params.issue.linearIssueId, threadId: thread.id, turnId: turn.turnId },
        "Issue triage returned invalid JSON",
      );
      return undefined;
    }

    if (parsed.confidence < MIN_CONFIDENCE) {
      return {
        ...parsed,
        issueClass: "implementation",
        reason: `Low confidence triage (${parsed.confidence}): ${parsed.reason}`,
      };
    }

    return parsed;
  }

  private async waitForTurn(threadId: string, turnId: string): Promise<CodexThreadSummary> {
    const deadline = Date.now() + TRIAGE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      let thread: CodexThreadSummary;
      try {
        thread = await this.codex.readThread(threadId, true);
      } catch (error) {
        if (isThreadMaterializingError(error)) {
          await new Promise((resolve) => setTimeout(resolve, TRIAGE_POLL_MS));
          continue;
        }
        throw error;
      }
      const turn = getThreadTurns(thread).find((entry) => entry.id === turnId);
      if (turn?.status === "completed") {
        return thread;
      }
      if (turn?.status === "failed" || turn?.status === "interrupted") {
        throw new Error(`Issue triage turn ${turnId} ended with status ${turn.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, TRIAGE_POLL_MS));
    }
    throw new Error(`Issue triage timed out after ${TRIAGE_TIMEOUT_MS}ms`);
  }
}

function buildIssueTriagePrompt(params: {
  issue: Pick<IssueRecord, "linearIssueId" | "issueKey" | "title" | "description" | "parentLinearIssueId">;
  childIssues: TriageChildIssue[];
}): string {
  return [
    "PatchRelay issue triage",
    "",
    "Classify the Linear issue so PatchRelay can choose the right first worker prompt.",
    "Do not solve the task, decompose the work, create a plan, or propose child issue titles.",
    "Return exactly one JSON object and no extra prose.",
    "",
    "Schema:",
    "{",
    '  "issueClass": "implementation" | "orchestration",',
    '  "intent": "code_change" | "split_into_children" | "investigate" | "review" | "coordination" | "needs_input",',
    '  "confidence": 0.0,',
    '  "reason": "one short sentence"',
    "}",
    "",
    "Choose issueClass:",
    '- "implementation" when the worker should directly change code, investigate a concrete bug, repair a PR, answer with repo findings, or do a single bounded task.',
    '- "orchestration" when the worker should coordinate a parent issue, split work into child issues, supervise existing children, or converge already-delegated work instead of directly implementing the full scope.',
    "",
    "Facts:",
    `- Issue: ${params.issue.issueKey ?? params.issue.linearIssueId}`,
    `- Parent issue id: ${params.issue.parentLinearIssueId ?? "none"}`,
    `- Title: ${params.issue.title ?? ""}`,
    "Description:",
    params.issue.description?.trim() ? params.issue.description.trim() : "(empty)",
    "",
    "Existing children:",
    ...(params.childIssues.length > 0
      ? params.childIssues.map((child) => {
        const label = child.issueKey ?? child.linearIssueId;
        const state = child.currentLinearState ? `; state ${child.currentLinearState}` : "";
        return `- ${label}: ${child.title ?? "(untitled)"} (${deriveIssuePhase(child)}${state})`;
      })
      : ["- none"]),
  ].join("\n");
}

function parseIssueTriageResult(text: string | undefined): IssueTriageResult | undefined {
  if (!text) return undefined;
  const json = extractFirstJsonObject(text) ?? text;
  const parsed = safeJsonParse<Record<string, unknown>>(json);
  if (!parsed) return undefined;

  const issueClass = parsed.issueClass;
  const intent = parsed.intent;
  const confidence = parsed.confidence;
  const reason = parsed.reason;
  if (issueClass !== "implementation" && issueClass !== "orchestration") return undefined;
  if (
    intent !== "code_change" &&
    intent !== "split_into_children" &&
    intent !== "investigate" &&
    intent !== "review" &&
    intent !== "coordination" &&
    intent !== "needs_input"
  ) return undefined;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return undefined;
  if (typeof reason !== "string" || !reason.trim()) return undefined;

  return {
    issueClass,
    intent,
    confidence: Math.max(0, Math.min(1, confidence)),
    reason: reason.trim().slice(0, 240),
  };
}
