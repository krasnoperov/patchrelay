export type ReviewExecutionPhase =
  | "dispatched"
  | "stabilizing"
  | "waiting_for_semaphore"
  | "preparing"
  | "codex_review"
  | "post_codex"
  | "publication"
  | "completed";

export interface ReviewExecutionTimingSnapshot {
  phase: ReviewExecutionPhase;
  attemptCreated: boolean;
  codexStarted: boolean;
  stabilizationWaitMs: number;
  semaphoreWaitMs: number;
  dispatchToCodexStartMs?: number;
  codexReviewMs?: number;
  publicationMs?: number;
  totalExecutionMs: number;
}

/** In-memory phase timer for one dispatched PR head. It shapes structured
 * telemetry only; it does not participate in scheduling or persistence. */
export class ReviewExecutionTiming {
  private readonly dispatchedAtMs: number;
  private phaseStartedAtMs: number;
  private currentPhase: ReviewExecutionPhase = "dispatched";
  private createdAttempt = false;
  private startedCodex = false;
  private stabilizationMs = 0;
  private semaphoreMs = 0;
  private dispatchToCodexMs: number | undefined;
  private codexMs: number | undefined;
  private publicationDurationMs: number | undefined;

  constructor(private readonly nowMs: () => number = () => performance.now()) {
    this.dispatchedAtMs = nowMs();
    this.phaseStartedAtMs = this.dispatchedAtMs;
  }

  get phase(): ReviewExecutionPhase {
    return this.currentPhase;
  }

  get attemptCreated(): boolean {
    return this.createdAttempt;
  }

  get codexStarted(): boolean {
    return this.startedCodex;
  }

  beginStabilization(): void {
    this.beginPhase("stabilizing");
  }

  endStabilization(): void {
    this.stabilizationMs += this.elapsedPhaseMs();
  }

  beginSemaphoreWait(): void {
    this.beginPhase("waiting_for_semaphore");
  }

  endSemaphoreWait(): void {
    this.semaphoreMs += this.elapsedPhaseMs();
  }

  markAttemptCreated(): void {
    this.createdAttempt = true;
    this.beginPhase("preparing");
  }

  beginCodexReview(): void {
    const now = this.nowMs();
    this.startedCodex = true;
    this.currentPhase = "codex_review";
    this.phaseStartedAtMs = now;
    this.dispatchToCodexMs = this.elapsedMs(this.dispatchedAtMs, now);
  }

  endCodexReview(completed = true): void {
    this.codexMs = this.elapsedPhaseMs();
    if (completed) {
      this.beginPhase("post_codex");
    }
  }

  beginPublication(): void {
    this.beginPhase("publication");
  }

  endPublication(completed = true): void {
    this.publicationDurationMs = this.elapsedPhaseMs();
    if (completed) {
      this.beginPhase("completed");
    }
  }

  snapshot(): ReviewExecutionTimingSnapshot {
    const now = this.nowMs();
    return {
      phase: this.currentPhase,
      attemptCreated: this.createdAttempt,
      codexStarted: this.startedCodex,
      stabilizationWaitMs: this.stabilizationMs,
      semaphoreWaitMs: this.semaphoreMs,
      ...(this.dispatchToCodexMs !== undefined ? { dispatchToCodexStartMs: this.dispatchToCodexMs } : {}),
      ...(this.codexMs !== undefined ? { codexReviewMs: this.codexMs } : {}),
      ...(this.publicationDurationMs !== undefined ? { publicationMs: this.publicationDurationMs } : {}),
      totalExecutionMs: this.elapsedMs(this.dispatchedAtMs, now),
    };
  }

  private beginPhase(phase: ReviewExecutionPhase): void {
    this.currentPhase = phase;
    this.phaseStartedAtMs = this.nowMs();
  }

  private elapsedPhaseMs(): number {
    return this.elapsedMs(this.phaseStartedAtMs, this.nowMs());
  }

  private elapsedMs(startedAtMs: number, endedAtMs: number): number {
    return Math.max(0, Math.round(endedAtMs - startedAtMs));
  }
}
import { performance } from "node:perf_hooks";
