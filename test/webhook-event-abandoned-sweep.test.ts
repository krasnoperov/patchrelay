import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PatchRelayDatabase } from "../src/db.ts";

test("abandoned sweep marks only stale pending rows and makes them archiveable", () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-abandoned-sweep-"));
  try {
    const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), false);
    db.runMigrations();

    const staleAt = "2026-01-01T00:00:00.000Z";
    const freshAt = "2026-01-02T11:55:00.000Z";
    const cutoffIso = "2026-01-02T11:45:00.000Z";

    db.webhookEvents.insertFullWebhookEvent({ webhookId: "stale-pending", receivedAt: staleAt, payloadJson: "{}" });
    db.webhookEvents.insertFullWebhookEvent({ webhookId: "fresh-pending", receivedAt: freshAt, payloadJson: "{}" });
    const processed = db.webhookEvents.insertFullWebhookEvent({ webhookId: "stale-processed", receivedAt: staleAt, payloadJson: "{}" });
    db.webhookEvents.markWebhookProcessed(processed.id, "processed");

    // Before the sweep only the processed row is archiveable.
    assert.equal(db.webhookEvents.countArchiveableEventsBefore("2026-01-03T00:00:00.000Z"), 1);

    const abandoned = db.webhookEvents.markAbandonedPendingEventsBefore(cutoffIso);
    assert.equal(abandoned, 1);

    // The stale pending row is now terminal and archiveable; the fresh
    // pending row was left alone (still in-flight, still not archiveable).
    assert.equal(db.webhookEvents.countArchiveableEventsBefore("2026-01-03T00:00:00.000Z"), 2);

    // The sweep is idempotent — a second pass finds nothing left to mark.
    assert.equal(db.webhookEvents.markAbandonedPendingEventsBefore(cutoffIso), 0);

    db.close();
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
