import type { Logger } from "pino";
import { CodexAppServerClient } from "./codex-app-server.ts";
import { renderCorrectivePrompt } from "./prompt-builder/index.ts";
import { extractFirstJsonObject, forgivingJsonParse } from "./utils.ts";
import type {
  ReviewArchitecturalConcern,
  ReviewContext,
  ReviewFinding,
  ReviewFindingSeverity,
  ReviewQuillConfig,
  ReviewVerdict,
} from "./types.ts";

// A parse attempt either yields a valid verdict or a reason string that
// the corrective retry will feed back to the model so it knows what
// went wrong on its previous attempt.
type ParseResult =
  | { ok: true; verdict: ReviewVerdict }
  | { ok: false; reason: string };

// Maximum log preview length for the raw model output when a parse
// fails. Avoids spamming the journal with a huge diff dump.
const PARSE_FAILURE_PREVIEW_CHARS = 200;

function isThreadMaterializationRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("not materialized yet") || message.includes("includeTurns is unavailable before first user message");
}

function isCodexAppServerRequestTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^Codex app-server request timed out after \d+ms$/.test(message);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

export class ReviewRunner {
  private readonly codex: CodexRunnerClient;

  constructor(
    private readonly config: ReviewQuillConfig,
    private readonly logger: Logger,
    codex?: CodexRunnerClient,
    private readonly sleep: (ms: number) => Promise<void> = delay,
  ) {
    this.codex = codex ?? new CodexAppServerClient(config.codex, logger.child({ component: "codex" }));
  }

  async start(): Promise<void> {
    await this.codex.start();
  }

  async stop(): Promise<void> {
    await this.codex.stop();
  }

  async review(context: ReviewContext): Promise<{ verdict: ReviewVerdict; threadId: string; turnId: string }> {
    const cwd = context.workspace.worktreePath;
    const thread = await this.codex.startThread({ cwd });

    // First attempt: full prompt, fresh turn.
    const firstTurn = await this.runTurn(thread.id, cwd, context.prompt);
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
    const secondTurn = await this.runTurn(thread.id, cwd, correctivePrompt);
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

  // Start a turn, wait for completion, and extract the latest assistant
  // message. Separate from parseModelResponse so the same pair can be
  // called twice in review() for the corrective retry.
  private async runTurn(threadId: string, cwd: string, input: string): Promise<{ latestMessage: string; turnId: string }> {
    const started = await this.codex.startTurn({ threadId, cwd, input });
    const completedThread = await this.waitForTurnCompletion(threadId, started.turnId);
    const latestMessage = collectAssistantMessages(completedThread).at(-1);
    if (!latestMessage) {
      throw new Error("Review run completed without an assistant message");
    }
    return { latestMessage, turnId: started.turnId };
  }

  private async waitForTurnCompletion(threadId: string, turnId: string): Promise<Awaited<ReturnType<CodexAppServerClient["readThread"]>>> {
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      let thread: Awaited<ReturnType<CodexAppServerClient["readThread"]>>;
      try {
        thread = await this.codex.readThread(threadId);
      } catch (error) {
        if (isThreadMaterializationRace(error)) {
          await this.sleep(750);
          continue;
        }
        if (isCodexAppServerRequestTimeout(error)) {
          this.logger.warn({ threadId, turnId }, "Codex thread read timed out while waiting for review turn; continuing wait");
          await this.sleep(1_500);
          continue;
        }
        throw error;
      }
      const turn = thread.turns.find((entry) => entry.id === turnId);
      if (!turn) {
        await this.sleep(1_000);
        continue;
      }
      if (turn.status === "completed") return thread;
      if (turn.status === "failed" || turn.status === "interrupted" || turn.status === "cancelled") {
        throw new Error(`Review turn ended with status ${turn.status}`);
      }
      await this.sleep(1_500);
    }
    throw new Error("Timed out waiting for review turn completion");
  }
}
