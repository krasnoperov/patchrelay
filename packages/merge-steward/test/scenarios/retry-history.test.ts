import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "../harness.ts";

describe("retryHistory records per-transition baseSha", () => {
  it("each retry history entry reflects the baseSha at that transition", async () => {
    const h = await createHarness({ maxRetries: 2, flakyRetries: 0, ciRule: () => "fail" });

    await h.enqueue({ number: 1, branch: "feat-retry", files: [{ path: "r.ts", content: "r" }] });

    // Run 1: queued → preparing_head → validating (baseSha = main_sha_1).
    await h.tick(); // queued → preparing_head
    await h.tick(); // rebase + trigger CI (fail) → validating

    const baseSha1 = h.entries[0]!.baseSha;

    // CI fails → back to preparing_head, retry 1.
    await h.tick();

    // Advance main so next rebase gets a different baseSha.
    await h.advanceMain();

    // Run 2: refresh updates the branch head, then the next tick re-promotes,
    // and the following tick validates against the new base.
    await h.tick();
    await h.tick();
    await h.tick();

    const baseSha2 = h.entries[0]!.baseSha;
    assert.notStrictEqual(baseSha1, baseSha2, "baseSha should change between retries");

    // CI fails again → retry 2.
    await h.tick();
    await h.advanceMain();

    // Run until the retry budget is exhausted and the issue is evicted.
    for (let i = 0; i < 20 && h.evictionSim.evictions.length === 0; i++) {
      await h.tick();
    }

    assert.strictEqual(h.evictionSim.evictions.length, 1);

    const history = h.evictionSim.evictions[0]!.incident.context.retryHistory;
    assert.ok(history.length >= 2, `expected at least 2 retry history entries, got ${history.length}`);

    const baseShas = history.map((h: { baseSha: string }) => h.baseSha).filter((s: string) => s !== "unknown");
    const uniqueBaseShas = new Set(baseShas);
    assert.ok(uniqueBaseShas.size > 1, `retryHistory baseShas should differ across retries, got: ${JSON.stringify(baseShas)}`);
  });

  it("event records include baseSha snapshot", async () => {
    const h = await createHarness({ maxRetries: 1 });

    await h.enqueue({ number: 1, branch: "feat-event-base", files: [{ path: "e.ts", content: "e" }] });

    await h.tick(); // queued → preparing_head
    await h.tick(); // preparing_head → validating

    const entry = h.entries[0]!;
    const events = h.store.listEvents(entry.id);

    const validatingEvent = events.find(
      (e) => e.fromStatus === "preparing_head" && e.toStatus === "validating",
    );
    assert.ok(validatingEvent, "should have a preparing_head → validating event");
    assert.ok(validatingEvent.baseSha, "event should have baseSha snapshot");
    assert.strictEqual(validatingEvent.baseSha, entry.baseSha);
  });
});
