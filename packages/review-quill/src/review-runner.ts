import type { Logger } from "pino";
import {
  CodexAppServerClient,
  CodexJsonRpcError,
  type CodexAppServerNotification,
} from "./codex-app-server.ts";
import { classifyCodexFailure, CodexCapacityError } from "./codex-capacity.ts";
import { buildAgentChildEnv } from "./github-cli-auth.ts";
import { renderCorrectivePrompt, renderReviewNormalizationPrompt } from "./prompt-builder/index.ts";
import { extractFirstJsonObject, forgivingJsonParse } from "./utils.ts";
import { REVIEW_VERDICT_JSON_SCHEMA, reviewVerdictSchema } from "./review-verdict-schema.ts";
import type {
  CodexThreadSummary,
  ReviewContext,
  ReviewQuillConfig,
  ReviewVerdict,
} from "./types.ts";
import type { PriorReviewThreadCandidate } from "./prior-review-thread-selector.ts";

export interface ReviewRunOptions {
  signal?: AbortSignal;
  onThreadProgress?: (progress: { threadId: string; turnId: string }) => void;
}

type ReviewThreadStartMode = "fresh" | "forked" | "fresh_fallback";

interface ReviewThreadStart {
  thread: CodexThreadSummary;
  mode: ReviewThreadStartMode;
}

// A parse attempt either yields a valid verdict or a reason string that
// the corrective retry will feed back to the model so it knows what
// went wrong on its previous attempt.
type ParseResult =
  | { ok: true; verdict: ReviewVerdict }
  | { ok: false; reason: string };

// Maximum log preview length for the raw model output when a parse
// fails. Avoids spamming the journal with a huge diff dump.
const PARSE_FAILURE_PREVIEW_CHARS = 200;
const CODEX_START_MAX_ATTEMPTS = 4;
const CODEX_START_BACKOFF_MS = 750;
const TURN_NOTIFICATION_WATCHDOG_MS = 10_000;

export class ReviewRunInterruptedError extends Error {
  constructor(
    message: string,
    readonly threadId?: string,
    readonly turnId?: string,
  ) {
    super(message);
    this.name = "ReviewRunInterruptedError";
  }
}

function isThreadMaterializationRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("not materialized yet")
    || message.includes("includeTurns is unavailable before first user message")
    || (message.includes("rollout-") && message.includes(".jsonl") && message.includes("is empty"));
}

function isCodexAppServerRequestTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^Codex app-server request timed out after \d+ms$/.test(message);
}

function isNativeReviewStillClosing(error: unknown): boolean {
  return error instanceof CodexJsonRpcError
    && error.code === -32603
    && /ActiveTurnNotSteerable.*turn_kind:\s*Review/i.test(error.message);
}

function isForkSourceUnavailable(error: unknown): boolean {
  return error instanceof CodexJsonRpcError
    && error.code === -32600
    && /\bno rollout found for thread id\b/i.test(error.message);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function abortedReviewMessage(signal: AbortSignal | undefined): string {
  if (typeof signal?.reason === "string" && signal.reason.trim()) {
    return signal.reason.trim();
  }
  return "Review run was interrupted before completion.";
}

function collectAssistantMessages(thread: { turns: Array<{ items: Array<{ type: string; text?: string }> }> }): string[] {
  const messages: string[] = [];
  for (const turn of thread.turns) {
    for (const item of turn.items) {
      if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
        messages.push(item.text.trim());
      }
    }
  }
  return messages;
}

function collectNativeReview(thread: CodexThreadSummary, turnId: string): string | undefined {
  const turn = thread.turns.find((entry) => entry.id === turnId);
  if (!turn) return undefined;
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index];
    if (item?.type === "exitedReviewMode" && typeof item.review === "string" && item.review.trim()) {
      return item.review.trim();
    }
  }
  return undefined;
}

// The error a Codex turn carried, preferring the turn we actually started
// and falling back to the latest turn with an error. Used to surface the
// REAL failure ("You've hit your usage limit ...") instead of the generic
// "completed without an assistant message".
function latestTurnErrorMessage(
  thread: { turns: Array<{ id: string; error?: { message: string } }> },
  turnId: string,
): string | undefined {
  const startedTurn = thread.turns.find((turn) => turn.id === turnId);
  const startedTurnError = startedTurn?.error?.message.trim();
  if (startedTurnError) return startedTurnError;
  for (let index = thread.turns.length - 1; index >= 0; index -= 1) {
    const message = thread.turns[index]?.error?.message.trim();
    if (message) return message;
  }
  return undefined;
}

// Classify a turn error and throw the matching error type: a typed
// CodexCapacityError for account-level capacity exhaustion (so the service
// can pause ALL reviews instead of retrying per PR), or a generic Error
// that carries the real Codex error text.
function throwTurnError(turnError: string, fallbackContext: string): never {
  const classified = classifyCodexFailure(turnError);
  if (classified.kind === "capacity") {
    throw new CodexCapacityError(classified.detail, classified.retryAtIso);
  }
  throw new Error(`${fallbackContext}: ${turnError}`);
}

// Extract + parse + normalize an assistant message into a verdict, or
// return a reason string explaining exactly what went wrong. The reason
// is fed back to the model via renderCorrectivePrompt on the corrective
// retry so the model knows what to fix.
//
// Exported for unit testing the three failure modes independently:
//   - no JSON object found in the message
//   - JSON parse failed even after sanitization
//   - JSON parsed but normalizeVerdict threw (missing walkthrough, etc.)
export function parseModelResponse(message: string): ParseResult {
  const jsonText = extractFirstJsonObject(message);
  if (!jsonText) {
    return { ok: false, reason: "no JSON object found in the assistant response" };
  }
  const raw = forgivingJsonParse<Record<string, unknown>>(jsonText);
  if (!raw) {
    return { ok: false, reason: "JSON parse failed even after sanitization (check for stray tokens, unquoted keys, or unbalanced braces)" };
  }
  try {
    return { ok: true, verdict: normalizeVerdict(raw) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `JSON parsed but did not match the required schema: ${detail}` };
  }
}

export function normalizeVerdict(raw: Record<string, unknown>): ReviewVerdict {
  const parsed = reviewVerdictSchema.parse(raw);
  const findings = parsed.findings.map((finding) => ({
    path: finding.path,
    line: finding.line,
    severity: finding.severity,
    message: finding.message,
    ...(finding.confidence !== null ? { confidence: finding.confidence } : {}),
    ...(finding.suggestion !== null ? { suggestion: finding.suggestion } : {}),
  }));
  const architecturalConcerns = parsed.architectural_concerns;
  const hasBlocking = findings.some((f) => f.severity === "blocking")
    || architecturalConcerns.some((c) => c.severity === "blocking");
  const verdict: ReviewVerdict["verdict"] = parsed.verdict === "request_changes" && !hasBlocking
    ? "approve"
    : parsed.verdict;

  return {
    walkthrough: parsed.walkthrough,
    architectural_concerns: architecturalConcerns,
    findings,
    verdict,
    verdict_reason: parsed.verdict_reason,
  };
}

type CodexRunnerClient = Pick<CodexAppServerClient, "start" | "stop" | "startThread" | "startTurn" | "readThread">;
type InterruptibleCodexRunnerClient = CodexRunnerClient & Partial<Pick<CodexAppServerClient, "interruptTurn" | "subscribeNotifications">>;
type ForkableCodexRunnerClient = InterruptibleCodexRunnerClient & Partial<Pick<CodexAppServerClient, "forkThread" | "startReview">>;

interface TurnCompletionSubscription {
  completion: Promise<void>;
  expectTurn(turnId: string): void;
  unsubscribe(): void;
}

interface NativeReviewCompletionSubscription {
  completion: Promise<string>;
  expectTurn(turnId: string): void;
  unsubscribe(): void;
}

export class ReviewRunner {
  private readonly codex: ForkableCodexRunnerClient;
  private threadForkAvailable = true;

  constructor(
    private readonly config: ReviewQuillConfig,
    private readonly logger: Logger,
    codex?: ForkableCodexRunnerClient,
    private readonly sleep: (ms: number) => Promise<void> = delay,
    private readonly notificationWatchdogMs = TURN_NOTIFICATION_WATCHDOG_MS,
  ) {
    // The Codex review agent is long-lived: give it an env without GH_TOKEN/GITHUB_TOKEN
    // so its git/gh authenticate as the App via the inherited GH_CONFIG_DIR (rotated),
    // never falling back to the operator's personal credentials.
    this.codex = codex ?? new CodexAppServerClient(config.codex, logger.child({ component: "codex" }), undefined, () => buildAgentChildEnv());
  }

  async start(): Promise<void> {
    await this.codex.start();
  }

  async stop(): Promise<void> {
    await this.codex.stop();
  }

  async readThread(threadId: string): Promise<CodexThreadSummary> {
    return await this.codex.readThread(threadId);
  }

  async review(
    context: ReviewContext,
    options: ReviewRunOptions = {},
    priorThread?: PriorReviewThreadCandidate,
  ): Promise<{ verdict: ReviewVerdict; threadId: string; turnId: string; reviewTurnId?: string; rawReview?: string }> {
    const cwd = context.workspace.worktreePath;
    this.throwIfReviewRunInterrupted(options.signal);
    const reviewMode = this.config.codex.reviewMode ?? "structured-turn";
    const threadStart = await this.startReviewThread(
      cwd,
      priorThread,
      options.signal,
      reviewMode === "native-two-pass" ? context.developerInstructions : undefined,
    );
    const thread = threadStart.thread;
    this.throwIfReviewRunInterrupted(options.signal, thread.id);
    const promptMode = threadStart.mode === "forked" ? "follow_up" : "full";
    if (promptMode === "follow_up" && !context.followUpPrompt) {
      throw new Error("Forked review thread is missing its bounded follow-up prompt");
    }
    const reviewPrompt = promptMode === "follow_up" ? context.followUpPrompt! : context.prompt;
    const nativePrompt = reviewMode === "native-two-pass"
      ? (promptMode === "follow_up" ? context.nativeFollowUpReviewPrompt : context.nativeReviewPrompt)
      : undefined;
    if (reviewMode === "native-two-pass" && !nativePrompt) {
      throw new Error(`Native ${promptMode} review prompt is missing`);
    }
    const selectedPrompt = nativePrompt ?? reviewPrompt;
    const inventoryCount = context.diff?.inventory.length ?? 0;
    const patches = context.diff?.patches ?? [];
    const omittedPatchChars = patches.reduce((sum, patch) => sum + patch.patch.length, 0);
    this.logger.info?.({
      reviewMode,
      threadStartMode: threadStart.mode,
      promptMode,
      threadId: thread.id,
      ...(priorThread
        ? {
          sourceAttemptId: priorThread.sourceAttemptId,
          sourceThreadId: priorThread.threadId,
          sourceTurnId: priorThread.lastTurnId,
          priorHeadSha: priorThread.priorHeadSha,
        }
        : {}),
      currentHeadSha: context.pr?.headSha,
      inventoryCount,
      guidancePathCount: context.promptContext?.guidanceDocs.length ?? 0,
      omittedPatchCount: patches.length,
      omittedPatchChars,
      promptChars: selectedPrompt.length,
    }, "Selected Review Quill prompt mode");

    if (reviewMode === "native-two-pass") {
      if (!this.codex.startReview) {
        throw new Error("Codex app-server client does not support review/start");
      }
      const nativeTurn = await this.runNativeReview(thread, cwd, selectedPrompt, options);
      const normalizationPrompt = renderReviewNormalizationPrompt();
      const firstNormalization = await this.runTurn(nativeTurn.thread, cwd, normalizationPrompt, options);
      const firstParse = parseModelResponse(firstNormalization.latestMessage);
      if (firstParse.ok) {
        return {
          verdict: firstParse.verdict,
          threadId: thread.id,
          turnId: firstNormalization.turnId,
          reviewTurnId: nativeTurn.turnId,
          rawReview: nativeTurn.rawReview,
        };
      }
      this.logger.warn({
        reason: firstParse.reason,
        preview: firstNormalization.latestMessage.slice(0, PARSE_FAILURE_PREVIEW_CHARS),
        threadId: thread.id,
        reviewTurnId: nativeTurn.turnId,
        normalizationTurnId: firstNormalization.turnId,
      }, "Native review normalization failed, retrying with corrective prompt");
      const correctiveTurn = await this.runTurn(
        firstNormalization.thread,
        cwd,
        renderCorrectivePrompt(firstParse.reason),
        options,
      );
      const correctiveParse = parseModelResponse(correctiveTurn.latestMessage);
      if (!correctiveParse.ok) {
        throw new Error(
          `Native review normalization produced unparseable output after one corrective retry. `
          + `First failure: ${firstParse.reason}. Second failure: ${correctiveParse.reason}.`,
        );
      }
      return {
        verdict: correctiveParse.verdict,
        threadId: thread.id,
        turnId: correctiveTurn.turnId,
        reviewTurnId: nativeTurn.turnId,
        rawReview: nativeTurn.rawReview,
      };
    }

    // First attempt: selected review prompt, fresh turn on the chosen thread.
    const firstTurn = await this.runTurn(thread, cwd, reviewPrompt, options);
    const firstParse = parseModelResponse(firstTurn.latestMessage);
    if (firstParse.ok) {
      return { verdict: firstParse.verdict, threadId: thread.id, turnId: firstTurn.turnId };
    }

    // First attempt failed parse/normalize. Log with a truncated preview
    // so we can tell what the model actually produced, then send a
    // corrective turn on the SAME thread. Same-thread is important:
    // the Codex thread retains the PR and review context, so we do not
    // pay the initial prompt cost a second time.
    this.logger.warn({
      reason: firstParse.reason,
      preview: firstTurn.latestMessage.slice(0, PARSE_FAILURE_PREVIEW_CHARS),
      threadId: thread.id,
      firstTurnId: firstTurn.turnId,
    }, "Review parse failed, retrying with corrective prompt");

    const correctivePrompt = renderCorrectivePrompt(firstParse.reason);
    const secondTurn = await this.runTurn(firstTurn.thread, cwd, correctivePrompt, options);
    const secondParse = parseModelResponse(secondTurn.latestMessage);
    if (secondParse.ok) {
      this.logger.info({
        threadId: thread.id,
        correctiveTurnId: secondTurn.turnId,
      }, "Review parse recovered on corrective retry");
      return { verdict: secondParse.verdict, threadId: thread.id, turnId: secondTurn.turnId };
    }

    // Two consecutive parse failures. Bubble up a combined error —
    // reconciliation loop will re-enter on the next cycle with a fresh
    // workspace and a fresh Codex thread.
    throw new Error(
      `Review run produced unparseable output after one corrective retry. `
      + `First failure: ${firstParse.reason}. Second failure: ${secondParse.reason}.`,
    );
  }

  private async startReviewThread(
    cwd: string,
    priorThread: PriorReviewThreadCandidate | undefined,
    signal: AbortSignal | undefined,
    developerInstructions: string | undefined,
  ): Promise<ReviewThreadStart> {
    if (!this.config.codex.forkPriorReviewThread || !priorThread || !this.threadForkAvailable) {
      const thread = await this.startThreadWithMaterializationRetry(cwd, developerInstructions);
      return { thread, mode: priorThread && this.config.codex.forkPriorReviewThread ? "fresh_fallback" : "fresh" };
    }
    if (!this.codex.forkThread) {
      this.disableThreadForkCapability();
      return { thread: await this.startThreadWithMaterializationRetry(cwd, developerInstructions), mode: "fresh_fallback" };
    }
    try {
      const thread = await this.codex.forkThread({
        threadId: priorThread.threadId,
        lastTurnId: priorThread.lastTurnId,
        cwd,
        ...(developerInstructions ? { developerInstructions } : {}),
      });
      return { thread, mode: "forked" };
    } catch (error) {
      this.throwIfReviewRunInterrupted(signal);
      if (error instanceof CodexJsonRpcError && error.code === -32601) {
        this.disableThreadForkCapability();
        return { thread: await this.startThreadWithMaterializationRetry(cwd, developerInstructions), mode: "fresh_fallback" };
      }
      if (isForkSourceUnavailable(error)) {
        this.logger.debug({ sourceAttemptId: priorThread.sourceAttemptId }, "Prior review thread unavailable; starting a fresh thread");
        return { thread: await this.startThreadWithMaterializationRetry(cwd, developerInstructions), mode: "fresh_fallback" };
      }
      throw error;
    }
  }

  private disableThreadForkCapability(): void {
    if (!this.threadForkAvailable) return;
    this.threadForkAvailable = false;
    this.logger.warn("Codex app-server does not support thread/fork; disabling prior review thread forks for this process");
  }

  // Start a turn, wait for completion, and extract the latest assistant
  // message. Separate from parseModelResponse so the same pair can be
  // called twice in review() for the corrective retry.
  private async runTurn(
    priorThread: CodexThreadSummary,
    cwd: string,
    input: string,
    options: ReviewRunOptions,
  ): Promise<{ latestMessage: string; turnId: string; thread: CodexThreadSummary }> {
    const threadId = priorThread.id;
    this.throwIfReviewRunInterrupted(options.signal, threadId);
    const completionSubscription = this.subscribeToTurnCompletion(threadId);
    try {
      const started = await this.startTurnWithMaterializationRetry(threadId, cwd, input);
      completionSubscription?.expectTurn(started.turnId);
      this.emitThreadProgress(options.onThreadProgress, { threadId, turnId: started.turnId });
      const completedThread = await this.waitForTurnCompletion(
        threadId,
        started.turnId,
        options,
        completionSubscription?.completion,
      );
      const latestMessage = collectAssistantMessages(completedThread).at(-1);
      if (!latestMessage) {
        // The turn "completed" but produced no message — the thread summary
        // usually carries the real failure as a turn-level error event
        // (account usage limits surface this way). Surface it, and throw the
        // typed capacity error when it is a usage-limit/quota failure.
        const turnError = latestTurnErrorMessage(completedThread, started.turnId);
        if (turnError) {
          throwTurnError(turnError, "Review run completed without an assistant message");
        }
        throw new Error("Review run completed without an assistant message");
      }
      return { latestMessage, turnId: started.turnId, thread: completedThread };
    } finally {
      completionSubscription?.unsubscribe();
    }
  }

  private async runNativeReview(
    priorThread: CodexThreadSummary,
    cwd: string,
    instructions: string,
    options: ReviewRunOptions,
  ): Promise<{ rawReview: string; turnId: string; thread: CodexThreadSummary }> {
    const threadId = priorThread.id;
    this.throwIfReviewRunInterrupted(options.signal, threadId);
    const reviewCompletion = this.subscribeToNativeReviewCompletion(threadId);
    const turnCompletion = this.subscribeToTurnCompletion(threadId);
    try {
      const started = await this.startNativeReviewWithMaterializationRetry(threadId, instructions);
      if (started.reviewThreadId !== threadId) {
        throw new Error(`Inline review unexpectedly started on detached thread ${started.reviewThreadId}`);
      }
      reviewCompletion?.expectTurn(started.turnId);
      turnCompletion?.expectTurn(started.turnId);
      this.emitThreadProgress(options.onThreadProgress, { threadId, turnId: started.turnId });
      let rawReview: string | undefined;
      let completedThread = priorThread;
      if (reviewCompletion) {
        const completion = await this.waitForNativeReviewNotification(
          reviewCompletion.completion,
          turnCompletion?.completion,
          threadId,
          started.turnId,
          options.signal,
        );
        if (completion.kind === "review") {
          rawReview = completion.review;
        } else {
          completedThread = await this.codex.readThread(threadId);
          rawReview = collectNativeReview(completedThread, started.turnId);
        }
      } else {
        completedThread = await this.waitForTurnCompletion(threadId, started.turnId, options);
        rawReview = collectNativeReview(completedThread, started.turnId);
      }
      if (!rawReview) {
        const turnError = latestTurnErrorMessage(completedThread, started.turnId);
        if (turnError) throwTurnError(turnError, "Native review completed without exitedReviewMode output");
        throw new Error("Native review completed without exitedReviewMode output");
      }
      this.logger.info({
        threadId,
        reviewTurnId: started.turnId,
        reviewChars: rawReview.length,
      }, "Native Codex review completed; starting structured normalization");
      return { rawReview, turnId: started.turnId, thread: completedThread };
    } finally {
      reviewCompletion?.unsubscribe();
      turnCompletion?.unsubscribe();
    }
  }

  private subscribeToNativeReviewCompletion(threadId: string): NativeReviewCompletionSubscription | undefined {
    if (!this.codex.subscribeNotifications) return undefined;
    let expectedTurnId: string | undefined;
    let completed = false;
    const buffered: Array<{ itemId: string; notifiedThreadId?: string; review: string }> = [];
    let resolveCompletion!: (review: string) => void;
    const completion = new Promise<string>((resolve) => {
      resolveCompletion = resolve;
    });
    const listener = (notification: CodexAppServerNotification): void => {
      if (completed || notification.method !== "item/completed") return;
      const params = notification.params && typeof notification.params === "object"
        ? notification.params as Record<string, unknown>
        : undefined;
      const item = params?.item && typeof params.item === "object"
        ? params.item as Record<string, unknown>
        : undefined;
      const notifiedThreadId = typeof params?.threadId === "string" ? params.threadId : undefined;
      const itemId = typeof item?.id === "string" ? item.id : undefined;
      const review = item?.type === "exitedReviewMode" && typeof item.review === "string"
        ? item.review.trim()
        : undefined;
      if (!itemId || !review) return;
      if (!expectedTurnId) {
        buffered.push({ itemId, ...(notifiedThreadId ? { notifiedThreadId } : {}), review });
        return;
      }
      // Depending on the installed app-server version, the completed review
      // may retain either the parent review thread id or the synthetic review
      // turn id while the actual reviewer runs on a managed child thread.
      // Accept either correlation key, but never an unrelated review.
      if (itemId !== expectedTurnId && notifiedThreadId !== threadId) return;
      completed = true;
      resolveCompletion(review);
    };
    const unsubscribe = this.codex.subscribeNotifications(listener);
    return {
      completion,
      expectTurn: (turnId) => {
        expectedTurnId = turnId;
        const match = buffered.find((entry) => entry.itemId === turnId || entry.notifiedThreadId === threadId);
        buffered.length = 0;
        if (!completed && match) {
          completed = true;
          resolveCompletion(match.review);
        }
      },
      unsubscribe,
    };
  }

  private async waitForNativeReviewNotification(
    completion: Promise<string>,
    turnCompletion: Promise<void> | undefined,
    threadId: string,
    turnId: string,
    signal?: AbortSignal,
  ): Promise<{ kind: "review"; review: string } | { kind: "turn_completed" }> {
    let timeout: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    try {
      const result = await Promise.race([
        completion.then((review) => ({ kind: "completed" as const, review })),
        ...(turnCompletion
          ? [turnCompletion.then(() => ({ kind: "turn_completed" as const }))]
          : []),
        new Promise<{ kind: "timeout" }>((resolve) => {
          timeout = setTimeout(() => resolve({ kind: "timeout" }), 15 * 60_000);
          timeout.unref?.();
        }),
        ...(signal
          ? [new Promise<{ kind: "aborted" }>((resolve) => {
              abortListener = () => resolve({ kind: "aborted" });
              signal.addEventListener("abort", abortListener, { once: true });
            })]
          : []),
      ]);
      if (result.kind === "completed") return { kind: "review", review: result.review };
      if (result.kind === "turn_completed") return result;
      if (result.kind === "aborted") {
        if (this.codex.interruptTurn) {
          try {
            await this.codex.interruptTurn({ threadId, turnId });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.warn({ threadId, turnId, error: message }, "Codex native review interrupt failed while cancelling review");
          }
        }
        throw new ReviewRunInterruptedError(abortedReviewMessage(signal), threadId, turnId);
      }
      throw new Error("Timed out waiting for native review completion");
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abortListener) signal?.removeEventListener("abort", abortListener);
    }
  }

  private subscribeToTurnCompletion(threadId: string): TurnCompletionSubscription | undefined {
    if (!this.codex.subscribeNotifications) return undefined;
    let expectedTurnId: string | undefined;
    let completed = false;
    const bufferedTurnIds = new Set<string>();
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const listener = (notification: CodexAppServerNotification): void => {
      if (completed || notification.method !== "turn/completed") return;
      const params = notification.params && typeof notification.params === "object"
        ? notification.params as Record<string, unknown>
        : undefined;
      const turn = params?.turn && typeof params.turn === "object"
        ? params.turn as Record<string, unknown>
        : undefined;
      const notifiedThreadId = typeof params?.threadId === "string" ? params.threadId : undefined;
      const notifiedTurnId = typeof turn?.id === "string" ? turn.id : undefined;
      if (notifiedThreadId !== threadId || !notifiedTurnId) return;
      if (!expectedTurnId) {
        bufferedTurnIds.add(notifiedTurnId);
        return;
      }
      if (notifiedTurnId !== expectedTurnId) return;
      completed = true;
      resolveCompletion();
    };
    const unsubscribe = this.codex.subscribeNotifications(listener);
    return {
      completion,
      expectTurn: (turnId) => {
        expectedTurnId = turnId;
        if (!completed && bufferedTurnIds.has(turnId)) {
          completed = true;
          resolveCompletion();
        }
        bufferedTurnIds.clear();
      },
      unsubscribe,
    };
  }

  private async startThreadWithMaterializationRetry(
    cwd: string,
    developerInstructions?: string,
  ): Promise<Awaited<ReturnType<CodexRunnerClient["startThread"]>>> {
    for (let attempt = 1; attempt <= CODEX_START_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.codex.startThread({
          cwd,
          ...(developerInstructions ? { developerInstructions } : {}),
        });
      } catch (error) {
        if (!isThreadMaterializationRace(error) || attempt === CODEX_START_MAX_ATTEMPTS) {
          throw error;
        }
        this.logger.warn({
          attempt,
          nextAttemptInMs: CODEX_START_BACKOFF_MS,
        }, "Codex thread start hit materialization race; retrying");
        await this.sleep(CODEX_START_BACKOFF_MS);
      }
    }
    throw new Error("unreachable");
  }

  private async startNativeReviewWithMaterializationRetry(
    threadId: string,
    instructions: string,
  ): Promise<Awaited<ReturnType<NonNullable<ForkableCodexRunnerClient["startReview"]>>>> {
    if (!this.codex.startReview) throw new Error("Codex app-server client does not support review/start");
    for (let attempt = 1; attempt <= CODEX_START_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.codex.startReview({ threadId, instructions });
      } catch (error) {
        if (!isThreadMaterializationRace(error) || attempt === CODEX_START_MAX_ATTEMPTS) throw error;
        this.logger.warn({ threadId, attempt, nextAttemptInMs: CODEX_START_BACKOFF_MS }, "Codex review start hit materialization race; retrying");
        await this.sleep(CODEX_START_BACKOFF_MS);
      }
    }
    throw new Error("unreachable");
  }

  private async startTurnWithMaterializationRetry(
    threadId: string,
    cwd: string,
    input: string,
  ): Promise<Awaited<ReturnType<CodexRunnerClient["startTurn"]>>> {
    for (let attempt = 1; attempt <= CODEX_START_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.codex.startTurn({
          threadId,
          cwd,
          input,
          outputSchema: REVIEW_VERDICT_JSON_SCHEMA as unknown as Record<string, unknown>,
        });
      } catch (error) {
        const retryable = isThreadMaterializationRace(error) || isNativeReviewStillClosing(error);
        if (!retryable || attempt === CODEX_START_MAX_ATTEMPTS) {
          throw error;
        }
        this.logger.warn({
          threadId,
          attempt,
          nextAttemptInMs: CODEX_START_BACKOFF_MS,
        }, isNativeReviewStillClosing(error)
          ? "Codex native review is still closing; retrying normalization turn"
          : "Codex turn start hit materialization race; retrying");
        await this.sleep(CODEX_START_BACKOFF_MS);
      }
    }
    throw new Error("unreachable");
  }

  private async waitForTurnCompletion(
    threadId: string,
    turnId: string,
    options: ReviewRunOptions,
    completionNotification?: Promise<void>,
  ): Promise<Awaited<ReturnType<CodexAppServerClient["readThread"]>>> {
    const { signal } = options;
    const deadline = Date.now() + 15 * 60_000;
    let interruptSubmitted = false;
    const submitInterrupt = async (): Promise<void> => {
      if (interruptSubmitted || !signal?.aborted) return;
      interruptSubmitted = true;
      if (!this.codex.interruptTurn) return;
      try {
        await this.codex.interruptTurn({ threadId, turnId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn({ threadId, turnId, error: message }, "Codex turn interrupt failed while cancelling review");
      }
    };
    const abortListener = (): void => {
      void submitInterrupt();
    };
    signal?.addEventListener("abort", abortListener, { once: true });
    try {
      await submitInterrupt();
      if (completionNotification && !signal?.aborted) {
        await this.waitForCompletionNotification(completionNotification, signal);
      }
      while (Date.now() < deadline) {
        await submitInterrupt();
        let thread: Awaited<ReturnType<CodexAppServerClient["readThread"]>>;
        try {
          thread = await this.codex.readThread(threadId);
        } catch (error) {
          if (isThreadMaterializationRace(error)) {
            await this.sleepUntilNextPoll(750, signal);
            continue;
          }
          if (isCodexAppServerRequestTimeout(error)) {
            this.logger.warn({ threadId, turnId }, "Codex thread read timed out while waiting for review turn; continuing wait");
            await this.sleepUntilNextPoll(1_500, signal);
            continue;
          }
          throw error;
        }
        const turn = thread.turns.find((entry) => entry.id === turnId);
        if (!turn) {
          await this.sleepUntilNextPoll(1_000, signal);
          continue;
        }
        if (signal?.aborted && (turn.status === "completed" || turn.status === "interrupted" || turn.status === "cancelled")) {
          throw new ReviewRunInterruptedError(abortedReviewMessage(signal), threadId, turnId);
        }
        if (turn.status === "completed") {
          return thread;
        }
        if (turn.status === "failed" || turn.status === "interrupted" || turn.status === "cancelled") {
          const turnError = turn.error?.message.trim();
          if (turnError) {
            throwTurnError(turnError, `Review turn ended with status ${turn.status}`);
          }
          throw new Error(`Review turn ended with status ${turn.status}`);
        }
        await this.sleepUntilNextPoll(1_500, signal);
      }
    } finally {
      signal?.removeEventListener("abort", abortListener);
    }
    throw new Error("Timed out waiting for review turn completion");
  }

  private async waitForCompletionNotification(completion: Promise<void>, signal?: AbortSignal): Promise<void> {
    let abortListener: (() => void) | undefined;
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        completion,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, this.notificationWatchdogMs);
          timeout.unref?.();
        }),
        ...(signal
          ? [new Promise<void>((resolve) => {
            abortListener = () => resolve();
            signal.addEventListener("abort", abortListener, { once: true });
          })]
          : []),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abortListener) signal?.removeEventListener("abort", abortListener);
    }
  }

  private async sleepUntilNextPoll(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal) {
      await this.sleep(ms);
      return;
    }
    if (signal.aborted) return;
    let abortListener: (() => void) | undefined;
    try {
      await Promise.race([
        this.sleep(ms),
        new Promise<void>((resolve) => {
          abortListener = () => resolve();
          signal.addEventListener("abort", abortListener, { once: true });
        }),
      ]);
    } finally {
      if (abortListener) signal.removeEventListener("abort", abortListener);
    }
  }

  private emitThreadProgress(
    onThreadProgress: ReviewRunOptions["onThreadProgress"],
    progress: { threadId: string; turnId: string },
  ): void {
    if (!onThreadProgress) return;
    try {
      onThreadProgress(progress);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ ...progress, error: message }, "Failed to record Codex thread progress; continuing review");
    }
  }

  private throwIfReviewRunInterrupted(signal: AbortSignal | undefined, threadId?: string, turnId?: string): void {
    if (!signal?.aborted) return;
    throw new ReviewRunInterruptedError(abortedReviewMessage(signal), threadId, turnId);
  }
}
