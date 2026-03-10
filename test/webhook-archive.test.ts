import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { archiveWebhook } from "../src/webhook-archive.ts";

test("archiveWebhook writes a dated json file with sanitized webhook id", async () => {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-archive-"));

  try {
    const filePath = await archiveWebhook({
      archiveDir: baseDir,
      webhookId: "delivery/with spaces",
      receivedAt: "2026-03-09T10:11:12.345Z",
      headers: {
        "linear-delivery": "delivery/with spaces",
      },
      rawBody: Buffer.from("{\"ok\":true}", "utf8"),
      payload: { ok: true },
    });

    assert.equal(
      filePath,
      path.join(baseDir, "2026-03-09", "2026-03-09T10-11-12-345Z-delivery-with-spaces.json"),
    );

    const archived = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
    assert.equal(archived.webhookId, "delivery/with spaces");
    assert.equal(archived.receivedAt, "2026-03-09T10:11:12.345Z");
    assert.equal(archived.rawBodyUtf8, "{\"ok\":true}");
    assert.deepEqual(archived.payload, { ok: true });
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
