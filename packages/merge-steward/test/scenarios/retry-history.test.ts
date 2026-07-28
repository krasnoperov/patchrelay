import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "../harness.ts";

describe("retryHistory records per-transition baseSha", () => {
  it("records distinct bases when a cached downstream conflict is invalidated and recomputed", async () => {
    const h = await createHarness({ ciRule: () => "pass", speculativeDepth: 2 });
    await h.enqueue({ number: 1, branch: "feat-parent", files: [{ path: "shared.ts", content: "parent" }] });
    await h.enqueue({ number: 2, branch: "feat-child", files: [{ path: "shared.ts", content: "child" }] });

    await h.tick(); // promote
    await h.tick(); // parent candidate + first child conflict
    await h.advanceMain(); // invalidate the parent candidate before landing
    await h.runUntilStable({ maxTicks: 30 });

    const child = h.entries.find((entry) => entry.prNumber === 2)!;
    assert.equal(child.status, "evicted");
    const incident = h.store.listIncidents(child.id)[0]!;
    const conflictBases = incident.context.retryHistory
      .filter((event) => event.outcome === "conflict_retry")
      .map((event) => event.baseSha)
      .filter((sha) => sha !== "unknown");
    assert.ok(conflictBases.length >= 2, `expected two conflict observations, got ${JSON.stringify(conflictBases)}`);
    assert.ok(new Set(conflictBases).size >= 2, `conflict bases should differ, got ${JSON.stringify(conflictBases)}`);
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
