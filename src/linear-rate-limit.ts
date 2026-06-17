const DEFAULT_LINEAR_RATE_LIMIT_BACKOFF_MS = 10 * 60 * 1000;

export function isLinearRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|too many requests|ratelimit|rate limit/i.test(message);
}

export class LinearWriteBackoff {
  private readonly retryAfterByProject = new Map<string, number>();

  constructor(private readonly defaultBackoffMs = DEFAULT_LINEAR_RATE_LIMIT_BACKOFF_MS) {}

  shouldAttempt(projectId: string, now = Date.now()): boolean {
    const retryAfter = this.retryAfterByProject.get(projectId);
    if (retryAfter === undefined) return true;
    if (retryAfter > now) return false;
    this.retryAfterByProject.delete(projectId);
    return true;
  }

  noteError(projectId: string, error: unknown, now = Date.now()): boolean {
    if (!isLinearRateLimitError(error)) return false;
    this.retryAfterByProject.set(projectId, now + this.defaultBackoffMs);
    return true;
  }

  clear(projectId?: string): void {
    if (projectId === undefined) {
      this.retryAfterByProject.clear();
      return;
    }
    this.retryAfterByProject.delete(projectId);
  }
}

export const sharedLinearWriteBackoff = new LinearWriteBackoff();
