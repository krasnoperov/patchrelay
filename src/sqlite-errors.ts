export function isSqliteSchemaReadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("no such table:")
    || message.includes("no such column:");
}

