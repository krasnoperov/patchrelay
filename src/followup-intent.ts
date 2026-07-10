import type { Logger } from "pino";
import { getThreadTurns } from "./codex-thread-utils.ts";
import { isThreadMaterializingError } from "./codex-thread-errors.ts";
import type { FactoryState, RunType } from "./factory-state.ts";
import type { CodexThreadSummary } from "./types.ts";
import { extractFirstJsonObject, safeJsonParse } from "./utils.ts";

const FOLLOWUP_INTENT_TIMEOUT_MS = 45_000;
const FOLLOWUP_INTENT_POLL_MS = 1_000;
export const FOLLOWUP_INTENT_MIN_CONFIDENCE = 0.55;

export type FollowupIntent =
  | "stop"
  | "status"
  | "resume_or_retry"
  | "implementation_instruction"
  | "answer_to_question"
  | "context_only"
  | "unknown_needs_ack";

export interface FollowupIntentContext {
  source: "agentPrompted" | "comment";
  activeRunType?: RunType | undefined;
  factoryState?: FactoryState | undefined;
  directReply?: boolean | undefined;
  delegatedToPatchRelay?: boolean | undefined;
  prReviewState?: string | undefined;
  explicitWorkflowIntent?: boolean | undefined;
}

export interface FollowupIntentClassification {
  intent: FollowupIntent;
  confidence: number;
  reason: string;
}

export interface FollowupIntentClassifier {
  classify(input: string, context: FollowupIntentContext): Promise<FollowupIntentClassification>;
}

interface CodexLike {
  startThreadForFollowupIntent(): Promise<CodexThreadSummary>;
  startTurn(options: { threadId: string; cwd?: string; input: string }): Promise<{ threadId: string; turnId: string; status: string }>;
  readThread(threadId: string, includeTurns?: boolean): Promise<CodexThreadSummary>;
}

export class CodexFollowupIntentClassifier implements FollowupIntentClassifier {
  constructor(
    private readonly codex: CodexLike,
    private readonly logger: Logger,
  ) {}

  async classify(input: string, context: FollowupIntentContext): Promise<FollowupIntentClassification> {
    if (!input.trim()) {
      return lowConfidenceFollowupIntent("Empty follow-up text.");
    }

    try {
      const thread = await this.codex.startThreadForFollowupIntent();
      const turn = await this.codex.startTurn({
        threadId: thread.id,
        ...(thread.cwd ? { cwd: thread.cwd } : {}),
        input: buildFollowupIntentPrompt(input, context),
      });

      const completedThread = await this.waitForTurn(thread.id, turn.turnId);
      const completedTurn = getThreadTurns(completedThread).find((entry) => entry.id === turn.turnId);
      const latestMessage = completedTurn?.items
        .filter((item): item is Extract<typeof completedTurn.items[number], { type: "agentMessage" }> => item.type === "agentMessage")
        .at(-1)?.text;

      const parsed = parseFollowupIntentClassification(latestMessage);
      if (!parsed) {
        this.logger.warn({ threadId: thread.id, turnId: turn.turnId }, "Follow-up intent classifier returned invalid JSON");
        return lowConfidenceFollowupIntent("Classifier returned invalid JSON.");
      }
      if (parsed.confidence < FOLLOWUP_INTENT_MIN_CONFIDENCE) {
        return {
          intent: "unknown_needs_ack",
          confidence: parsed.confidence,
          reason: `Low confidence (${parsed.confidence}): ${parsed.reason}`,
        };
      }
      return parsed;
    } catch (error) {
      this.logger.warn({ error: error instanceof Error ? error.message : String(error) }, "Follow-up intent classification failed");
      return lowConfidenceFollowupIntent("Classifier unavailable.");
    }
  }

  private async waitForTurn(threadId: string, turnId: string): Promise<CodexThreadSummary> {
    const deadline = Date.now() + FOLLOWUP_INTENT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      let thread: CodexThreadSummary;
      try {
        thread = await this.codex.readThread(threadId, true);
      } catch (error) {
        if (isThreadMaterializingError(error)) {
          await new Promise((resolve) => setTimeout(resolve, FOLLOWUP_INTENT_POLL_MS));
          continue;
        }
        throw error;
      }
      const turn = getThreadTurns(thread).find((entry) => entry.id === turnId);
      if (turn?.status === "completed") {
        return thread;
      }
      if (turn?.status === "failed" || turn?.status === "interrupted") {
        throw new Error(`Follow-up intent turn ${turnId} ended with status ${turn.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, FOLLOWUP_INTENT_POLL_MS));
    }
    throw new Error(`Follow-up intent timed out after ${FOLLOWUP_INTENT_TIMEOUT_MS}ms`);
  }
}

export function buildFollowupIntentPrompt(input: string, context: FollowupIntentContext): string {
  return [
    "PatchRelay follow-up intent classification",
    "",
    "Classify one human follow-up so PatchRelay can route it through an explicit workflow state.",
    "Do not solve the task, draft a reply, or start work. Infer ordinary natural-language intent from the text and state facts.",
    "Return exactly one JSON object and no extra prose.",
    "",
    "Schema:",
    "{",
    '  "intent": "stop" | "status" | "resume_or_retry" | "implementation_instruction" | "answer_to_question" | "context_only" | "unknown_needs_ack",',
    '  "confidence": 0.0,',
    '  "reason": "one short sentence"',
    "}",
    "",
    "Intent definitions:",
    '- "stop": the user asks PatchRelay to halt or cancel active work.',
    '- "status": the user asks only for current state, progress, or what happened.',
    '- "resume_or_retry": the user asks PatchRelay to continue, resume, retry, or run again.',
    '- "implementation_instruction": the user gives work instructions, constraints, review feedback, or asks for code-changing work.',
    '- "answer_to_question": the user is answering a PatchRelay question or unblocking awaiting-input work.',
    '- "context_only": the user provides background that should not start idle work by itself.',
    '- "unknown_needs_ack": the text is too ambiguous to route confidently.',
    "",
    "Routing facts:",
    `- Source: ${context.source}`,
    `- Active run type: ${context.activeRunType ?? "none"}`,
    `- Factory state: ${context.factoryState ?? "unknown"}`,
    `- Direct reply to outstanding PatchRelay question: ${context.directReply ? "yes" : "no"}`,
    `- Delegated to PatchRelay: ${context.delegatedToPatchRelay ? "yes" : "no"}`,
    `- PR review state: ${context.prReviewState ?? "none"}`,
    `- Explicit PatchRelay workflow intent: ${context.explicitWorkflowIntent ? "yes" : "no"}`,
    "",
    "Follow-up text:",
    input.trim(),
  ].join("\n");
}

export function parseFollowupIntentClassification(text: string | undefined): FollowupIntentClassification | undefined {
  if (!text) return undefined;
  const json = extractFirstJsonObject(text) ?? text;
  const parsed = safeJsonParse<Record<string, unknown>>(json);
  if (!parsed) return undefined;

  const intent = parsed.intent;
  const confidence = parsed.confidence;
  const reason = parsed.reason;
  if (!isFollowupIntent(intent)) return undefined;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return undefined;
  if (typeof reason !== "string" || !reason.trim()) return undefined;

  return {
    intent,
    confidence: Math.max(0, Math.min(1, confidence)),
    reason: reason.trim().slice(0, 240),
  };
}

export function lowConfidenceFollowupIntent(reason: string): FollowupIntentClassification {
  return {
    intent: "unknown_needs_ack",
    confidence: 0,
    reason,
  };
}

export function followupIntentQueuesWork(classification: FollowupIntentClassification | FollowupIntent): boolean {
  const intent = typeof classification === "string" ? classification : classification.intent;
  return intent === "implementation_instruction"
    || intent === "resume_or_retry"
    || intent === "answer_to_question";
}

export function followupIntentIsNonActionable(classification: FollowupIntentClassification | FollowupIntent): boolean {
  const intent = typeof classification === "string" ? classification : classification.intent;
  return intent === "status"
    || intent === "context_only"
    || intent === "unknown_needs_ack";
}

export function followupIntentShouldSteerActiveRun(classification: FollowupIntentClassification | FollowupIntent): boolean {
  const intent = typeof classification === "string" ? classification : classification.intent;
  return intent === "implementation_instruction"
    || intent === "resume_or_retry"
    || intent === "answer_to_question"
    || intent === "context_only"
    || intent === "unknown_needs_ack";
}

function isFollowupIntent(value: unknown): value is FollowupIntent {
  return value === "stop"
    || value === "status"
    || value === "resume_or_retry"
    || value === "implementation_instruction"
    || value === "answer_to_question"
    || value === "context_only"
    || value === "unknown_needs_ack";
}
