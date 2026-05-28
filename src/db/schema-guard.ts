import type { DatabaseConnection } from "./shared.ts";

const REQUIRED_PATCHRELAY_TABLES = [
  "issues",
  "runs",
  "issue_sessions",
  "issue_session_events",
] as const;

export function assertPatchRelaySchemaReady(connection: DatabaseConnection, databasePath: string): void {
  const rows = connection
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<Record<string, unknown>>;
  const tables = new Set(rows.map((row) => String(row.name)));
  const missing = REQUIRED_PATCHRELAY_TABLES.filter((table) => !tables.has(table));
  if (missing.length === 0) {
    return;
  }

  throw new Error(
    `PatchRelay database is uninitialized or points at the wrong path: ${databasePath}. Missing required table(s): ${missing.join(", ")}`,
  );
}

