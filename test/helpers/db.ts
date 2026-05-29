import type { PatchRelayDatabase } from "../../src/db.ts";

/**
 * Age every issue and issue_session row to the given ISO timestamp so idle /
 * cluster-health reconciliation tests can simulate staleness. Uses the
 * test-only raw seam because the stores always stamp `updated_at` to now().
 */
export function backdateAllRows(db: PatchRelayDatabase, updatedAt: string): void {
  const connection = db.unsafeRawConnectionForTests();
  connection.prepare("UPDATE issues SET updated_at = ?").run(updatedAt);
  connection.prepare("UPDATE issue_sessions SET updated_at = ?").run(updatedAt);
}
