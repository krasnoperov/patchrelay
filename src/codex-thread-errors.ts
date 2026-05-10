export class CodexThreadMaterializingError extends Error {
  readonly code = "thread_materializing";

  constructor(threadId: string, attempts: number, cause?: unknown) {
    super(`Codex thread ${threadId} is not materialized yet after ${attempts} read attempt(s)`, { cause });
    this.name = "CodexThreadMaterializingError";
  }
}

export function isThreadMaterializingError(error: unknown): boolean {
  if (error instanceof CodexThreadMaterializingError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /not materialized yet|not materialized/i.test(message);
}
