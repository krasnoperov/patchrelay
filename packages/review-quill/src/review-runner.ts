import type { Logger } from "pino";
import {
  CodexAppServerClient,
  CodexJsonRpcError,
  type CodexAppServerNotification,
  type StartTurnOptions,
} from "./codex-app-server.ts";
import { classifyCodexFailure, CodexCapacityError } from "./codex-capacity.ts";
import { buildAgentChildEnv } from "./github-cli-auth.ts";
import { renderCorrectivePrompt } from "./prompt-builder/index.ts";
import { extractFirstJsonObject, forgivingJsonParse } from "./utils.ts";
import { REVIEW_VERDICT_JSON_SCHEMA } from "./review-verdict-schema.ts";
import type {
  ReviewArchitecturalConcern,
  CodexThreadSummary,
  ReviewContext,
  ReviewFinding,
  ReviewFindingSeverity,
  ReviewQuillConfig,
  ReviewVerdict,
} from "./types.ts";
import type { PriorReviewThreadCandidate } from "./prior-review-thread-selector.ts";

export interface ReviewRunOptions {
  signal?: AbortSignal;
  onThreadSnapshot?: (thread: CodexThreadSummary) => void;
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

function isForkSourceUnavailable(error: unknown): boolean {
  return error instanceof CodexJsonRpcError
    && error.code === -32600
    && /\bno rollout found for thread id\b/i.test(error.message);
}

export function isUnsupportedOutputSchemaError(error: unknown): error is CodexJsonRpcError {
  if (!(error instanceof CodexJsonRpcError) || error.code !== -32602) return false;
  const data = error.data && typeof error.data === "object"
    ? error.data as Record<string, unknown>
    : undefined;
  const namedParameter = data?.parameter ?? data?.field;
  const structuredReason = [data?.reason, data?.kind, data?.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  if (namedParameter === "outputSchema" && /\b(unknown|unrecognized|unexpected)\b/i.test(structuredReason)) {
    return true;
  }
  return /\b(unknown|unrecognized|unexpected)\s+(?:parameter|field)\s*[:=]?\s*[`"']?outputSchema\b/i.test(error.message)
    || /\b(?:parameter|field)\s+[`"']?outputSchema[`"']?\s+(?:is\s+)?(?:unknown|unrecognized|unexpected)\b/i.test(error.message)
    || /\boutputSchema\s+(?:is\s+)?(?:an?\s+)?(?:unknown|unrecognized|unexpected)\s+(?:parameter|field)\b/i.test(error.message);
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

// Tolerate case variations ("BLOCKING", "Blocking") and common synonyms
// ("critical", "error" → blocking; "warning", "suggestion", "minor" → nit).
// Anything else → undefined, which causes the caller to drop the finding.
function asSeverity(value: unknown): ReviewFindingSeverity | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (v === "blocking" || v === "critical" || v === "error" || v === "high" || v === "major") return "blocking";
  if (v === "nit" || v === "warning" || v === "suggestion" || v === "minor" || v === "low" || v === "info") return "nit";
  return undefined;
}

// Accept number OR numeric string OR a {line: 42} nested shape. Coerce
// to a positive integer. Models occasionally emit "42" or "L42" or
// objects like `{"line": 42}` instead of a plain integer — be forgiving.
function normalizeRawVerdict(value: unknown): ReviewVerdict["verdict"] | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase().replace(/[\s-]/g, "_");
  if (v === "approve" || v === "approved" || v === "lgtm") return "approve";
  if (v === "request_changes" || v === "changes_requested" || v === "reject" || v === "rejected" || v === "needs_changes" || v === "needs_work") return "request_changes";
  return undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.floor(value));
  }
  if (typeof value === "string") {
    const match = value.match(/\d+/);
    if (match) {
      const n = Number.parseInt(match[0]!, 10);
      if (Number.isFinite(n)) return Math.max(1, n);
    }
  }
  return undefined;
}

function normalizeFindings(value: unknown): ReviewFinding[] {
  if (!Array.isArray(value)) return [];
  const out: ReviewFinding[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const path = asString(record.path) ?? asString(record.file) ?? asString(record.filename);
    const line = asPositiveInt(record.line) ?? asPositiveInt(record.lineNumber) ?? asPositiveInt(record.line_number);
    const severity = asSeverity(record.severity);
    const message = asString(record.message) ?? asString(record.description) ?? asString(record.issue);
    // Line-level findings MUST have path + line + severity + message.
    // Anything missing → skip the finding (silently). The server already
    // filters by confidence threshold, so this is a best-effort parse.
    if (!path || line === undefined || !severity || !message) continue;
    const confidence = asPositiveInt(record.confidence);
    const clampedConfidence = confidence === undefined ? undefined : Math.max(0, Math.min(100, confidence));
    const suggestion = asString(record.suggestion) ?? asString(record.fix);
    out.push({
      path,
      line,
      severity,
      message,
      ...(clampedConfidence !== undefined ? { confidence: clampedConfidence } : {}),
      ...(suggestion ? { suggestion } : {}),
    });
  }
  return out;
}

function normalizeArchitecturalConcerns(value: unknown): ReviewArchitecturalConcern[] {
  if (!Array.isArray(value)) return [];
  const out: ReviewArchitecturalConcern[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const severity = asSeverity(record.severity);
    const message = asString(record.message) ?? asString(record.description) ?? asString(record.issue);
    if (!severity || !message) continue;
    const category = asString(record.category) ?? asString(record.type) ?? "general";
    out.push({ severity, category, message });
  }
  return out;
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
  const findings = normalizeFindings(raw.findings);
  const architecturalConcerns = normalizeArchitecturalConcerns(raw.architectural_concerns);

  // Derive verdict. Prefer the model's self-reported verdict if it's
  // recognizable; otherwise synthesize from severity. Tolerate common
  // model variants: case variations, snake_case vs space, "reject" vs
  // "request_changes", etc.
  const normalizedRawVerdict = normalizeRawVerdict(raw.verdict);
  const hasBlocking = findings.some((f) => f.severity === "blocking")
    || architecturalConcerns.some((c) => c.severity === "blocking");
  if (!normalizedRawVerdict) {
    throw new Error("Review run returned no explicit binary verdict (expected approve or request_changes)");
  }
  const verdict: ReviewVerdict["verdict"] = normalizedRawVerdict === "request_changes" && !hasBlocking
    ? "approve"
    : normalizedRawVerdict;

  // Walkthrough is an optional trailing Context appendix as of the
  // inverted-pyramid body layout. Empty string is legitimate and means
  // "the diff alone explains the change" - `buildReviewBody` omits the
  // Context section entirely in that case. The load-bearing signal is
  // verdict_reason (with a canned fallback below).
  const walkthrough = asString(raw.walkthrough)
    ?? asString(raw.summary)
    ?? asString(raw.overview)
    ?? asString(raw.description)
    ?? "";

  const verdictReason = asString(raw.verdict_reason)
    ?? (hasBlocking
      ? "Blocking issues must be addressed before merge."
      : "No blocking issues found.");

  return {
    walkthrough,
    architectural_concerns: architecturalConcerns,
    findings,
    verdict,
    verdict_reason: verdictReason,
  };
}

type CodexRunnerClient = Pick<CodexAppServerClient, "start" | "stop" | "startThread" | "startTurn" | "readThread">;
type InterruptibleCodexRunnerClient = CodexRunnerClient & Partial<Pick<CodexAppServerClient, "interruptTurn" | "subscribeNotifications">>;
type ForkableCodexRunnerClient = InterruptibleCodexRunnerClient & Partial<Pick<CodexAppServerClient, "forkThread">>;

interface TurnCompletionSubscription {
  completion: Promise<void>;
  expectTurn(turnId: string): void;
  unsubscribe(): void;
}

export class ReviewRunner {
  private readonly codex: ForkableCodexRunnerClient;
  private outputSchemaAvailable = true;
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
  ): Promise<{ verdict: ReviewVerdict; threadId: string; turnId: string }> {
    const cwd = context.workspace.worktreePath;
    this.throwIfReviewRunInterrupted(options.signal);
    const threadStart = await this.startReviewThread(cwd, priorThread, options.signal);
    const thread = threadStart.thread;
    this.throwIfReviewRunInterrupted(options.signal, thread.id);
    const promptMode = threadStart.mode === "forked" ? "follow_up" : "full";
    if (promptMode === "follow_up" && !context.followUpPrompt) {
      throw new Error("Forked review thread is missing its bounded follow-up prompt");
    }
    const reviewPrompt = promptMode === "follow_up" ? context.followUpPrompt! : context.prompt;
    const inventoryCount = context.diff?.inventory.length ?? 0;
    const patches = context.diff?.patches ?? [];
    const omittedPatchChars = patches.reduce((sum, patch) => sum + patch.patch.length, 0);
    this.logger.info?.({
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
      omittedPatchCount: promptMode === "follow_up" ? patches.length : 0,
      omittedPatchChars: promptMode === "follow_up" ? omittedPatchChars : 0,
      promptChars: reviewPrompt.length,
    }, "Selected Review Quill prompt mode");

    // First attempt: selected review prompt, fresh turn on the chosen thread.
    const firstTurn = await this.runTurn(thread, cwd, reviewPrompt, options);
    const firstParse = parseModelResponse(firstTurn.latestMessage);
    if (firstParse.ok) {
      return { verdict: firstParse.verdict, threadId: thread.id, turnId: firstTurn.turnId };
    }

    // First attempt failed parse/normalize. Log with a truncated preview
    // so we can tell what the model actually produced, then send a
    // corrective turn on the SAME thread. Same-thread is important:
    // the Codex thread retains the diff + PR + guidance context, so we
    // don't pay the full prompt cost a second time.
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
  ): Promise<ReviewThreadStart> {
    if (!this.config.codex.forkPriorReviewThread || !priorThread || !this.threadForkAvailable) {
      const thread = await this.startThreadWithMaterializationRetry(cwd);
      return { thread, mode: priorThread && this.config.codex.forkPriorReviewThread ? "fresh_fallback" : "fresh" };
    }
    if (!this.codex.forkThread) {
      this.disableThreadForkCapability();
      return { thread: await this.startThreadWithMaterializationRetry(cwd), mode: "fresh_fallback" };
    }
    try {
      const thread = await this.codex.forkThread({
        threadId: priorThread.threadId,
        lastTurnId: priorThread.lastTurnId,
        cwd,
      });
      return { thread, mode: "forked" };
    } catch (error) {
      this.throwIfReviewRunInterrupted(signal);
      if (error instanceof CodexJsonRpcError && error.code === -32601) {
        this.disableThreadForkCapability();
        return { thread: await this.startThreadWithMaterializationRetry(cwd), mode: "fresh_fallback" };
      }
      if (isForkSourceUnavailable(error)) {
        this.logger.debug({ sourceAttemptId: priorThread.sourceAttemptId }, "Prior review thread unavailable; starting a fresh thread");
        return { thread: await this.startThreadWithMaterializationRetry(cwd), mode: "fresh_fallback" };
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
      const startedThread: CodexThreadSummary = {
        id: threadId,
        turns: [
          ...priorThread.turns,
          { id: started.turnId, status: started.status, items: [] },
        ],
      };
      const startedThreadPersisted = this.emitThreadSnapshot(options.onThreadSnapshot, startedThread);
      const completedThread = await this.waitForTurnCompletion(
        threadId,
        started.turnId,
        options,
        startedThreadPersisted ? JSON.stringify(startedThread) : undefined,
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

  private async startThreadWithMaterializationRetry(cwd: string): Promise<Awaited<ReturnType<CodexRunnerClient["startThread"]>>> {
    for (let attempt = 1; attempt <= CODEX_START_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.codex.startThread({ cwd });
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

  private async startTurnWithMaterializationRetry(
    threadId: string,
    cwd: string,
    input: string,
  ): Promise<Awaited<ReturnType<CodexRunnerClient["startTurn"]>>> {
    for (let attempt = 1; attempt <= CODEX_START_MAX_ATTEMPTS; attempt += 1) {
      try {
        return await this.startTurnWithOutputSchemaFallback({ threadId, cwd, input });
      } catch (error) {
        if (!isThreadMaterializationRace(error) || attempt === CODEX_START_MAX_ATTEMPTS) {
          throw error;
        }
        this.logger.warn({
          threadId,
          attempt,
          nextAttemptInMs: CODEX_START_BACKOFF_MS,
        }, "Codex turn start hit materialization race; retrying");
        await this.sleep(CODEX_START_BACKOFF_MS);
      }
    }
    throw new Error("unreachable");
  }

  private async startTurnWithOutputSchemaFallback(
    options: Omit<StartTurnOptions, "outputSchema">,
  ): Promise<Awaited<ReturnType<CodexRunnerClient["startTurn"]>>> {
    const useOutputSchema = this.config.codex.outputSchema && this.outputSchemaAvailable;
    try {
      return await this.codex.startTurn({
        ...options,
        ...(useOutputSchema
          ? { outputSchema: REVIEW_VERDICT_JSON_SCHEMA as unknown as Record<string, unknown> }
          : {}),
      });
    } catch (error) {
      if (!useOutputSchema || !isUnsupportedOutputSchemaError(error)) {
        throw error;
      }
      if (this.outputSchemaAvailable) {
        this.outputSchemaAvailable = false;
        this.logger.warn({
          code: error.code,
          error: error.message,
        }, "Codex app-server does not recognize turn outputSchema; disabling structured output for this process");
      }
      return await this.codex.startTurn(options);
    }
  }

  private async waitForTurnCompletion(
    threadId: string,
    turnId: string,
    options: ReviewRunOptions,
    initialPersistedThreadJson?: string,
    completionNotification?: Promise<void>,
  ): Promise<Awaited<ReturnType<CodexAppServerClient["readThread"]>>> {
    const { signal, onThreadSnapshot } = options;
    const deadline = Date.now() + 15 * 60_000;
    let persistedThreadJson = initialPersistedThreadJson;
    const persistThread = (thread: CodexThreadSummary): void => {
      const threadJson = JSON.stringify(thread);
      if (threadJson === persistedThreadJson) return;
      if (this.emitThreadSnapshot(onThreadSnapshot, thread)) {
        persistedThreadJson = threadJson;
      }
    };
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
          persistThread(thread);
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

  private emitThreadSnapshot(
    onThreadSnapshot: ReviewRunOptions["onThreadSnapshot"],
    thread: CodexThreadSummary,
  ): boolean {
    if (!onThreadSnapshot) return true;
    try {
      onThreadSnapshot(thread);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ threadId: thread.id, error: message }, "Failed to record Codex thread progress; continuing review");
      return false;
    }
  }

  private throwIfReviewRunInterrupted(signal: AbortSignal | undefined, threadId?: string, turnId?: string): void {
    if (!signal?.aborted) return;
    throw new ReviewRunInterruptedError(abortedReviewMessage(signal), threadId, turnId);
  }
}
