import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";
import type { ReconcileAction } from "../../src/types.ts";

const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };
const prB: SimPR = { number: 2, branch: "feat-b", files: [{ path: "b.ts", content: "b" }] };

function actionsFor(h: ReturnType<Awaited<typeof createHarness>>, prNumber: number): ReconcileAction[] {
  return h.reconcileEvents
    .filter((e) => e.prNumber === prNumber)
    .map((e) => e.action);
}

describe("observability: reconciler event stream", () => {
  it("happy path emits full event sequence for serial merge", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    await h.enqueue(prA);
    await h.runUntilStable();

    const actions = actionsFor(h, 1);
    // Should see the full lifecycle:
    assert.ok(actions.includes("promoted"), "should emit promoted");
    assert.ok(actions.includes("fetch_started"), "should emit fetch_started");
    assert.ok(actions.includes("spec_build_started"), "should emit spec_build_started");
    assert.ok(actions.includes("spec_build_succeeded"), "should emit spec_build_succeeded");
    assert.ok(actions.includes("ci_triggered"), "should emit ci_triggered");
    assert.ok(actions.includes("ci_passed"), "should emit ci_passed");
    assert.ok(actions.includes("merge_revalidating"), "should emit merge_revalidating");
    assert.ok(actions.includes("merge_succeeded"), "should emit merge_succeeded");

    // Order: promoted before spec_build before ci_triggered before merge_succeeded
    const promotedIdx = actions.indexOf("promoted");
    const specIdx = actions.indexOf("spec_build_started");
    const ciIdx = actions.indexOf("ci_triggered");
    const mergeIdx = actions.indexOf("merge_succeeded");
    assert.ok(promotedIdx < specIdx, "promoted before spec_build");
    assert.ok(specIdx < ciIdx, "spec_build before CI");
    assert.ok(ciIdx < mergeIdx, "CI before merge");

    h.assertInvariants();
  });

  it("conflict emits spec_build_conflict with file info", async () => {
    const prConflict: SimPR = { number: 2, branch: "feat-conflict", files: [{ path: "shared.ts", content: "conflict" }] };
    const prOriginal: SimPR = { number: 1, branch: "feat-orig", files: [{ path: "shared.ts", content: "original" }] };

    const h = await createHarness({ ciRule: () => "pass", maxRetries: 0 });
    await h.enqueue(prOriginal);
    await h.enqueue(prConflict);
    await h.runUntilStable({ maxTicks: 30 });

    const conflictEvents = h.reconcileEvents.filter(
      (e) => e.prNumber === 2 && e.action === "spec_build_conflict",
    );
    assert.ok(conflictEvents.length > 0, "should emit spec_build_conflict for PR #2");

    const evictEvents = h.reconcileEvents.filter(
      (e) => e.prNumber === 2 && e.action === "evicted",
    );
    assert.ok(evictEvents.length > 0, "should emit evicted for PR #2");
    assert.strictEqual(evictEvents[0]!.failureClass, "integration_conflict");

    h.assertInvariants();
  });

  it("non-spinning retry emits retry_gated", async () => {
    const prConflict: SimPR = { number: 2, branch: "feat-conflict", files: [{ path: "shared.ts", content: "conflict" }] };
    const prOriginal: SimPR = { number: 1, branch: "feat-orig", files: [{ path: "shared.ts", content: "original" }] };

    const h = await createHarness({ ciRule: () => "pass", maxRetries: 2 });
    await h.enqueue(prOriginal);
    await h.enqueue(prConflict);

    // Run until A merges and B conflicts, then keep ticking.
    for (let i = 0; i < 15; i++) await h.tick();

    const gatedEvents = h.reconcileEvents.filter(
      (e) => e.prNumber === 2 && e.action === "retry_gated",
    );
    assert.ok(gatedEvents.length > 0, "should emit retry_gated when base unchanged");

    h.assertInvariants();
  });

  it("speculative execution emits spec_build events", async () => {
    const h = await createHarness({ ciRule: () => "pass", speculativeDepth: 3 });
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.runUntilStable();

    // A should have spec_build events (head builds spec for downstream).
    const aSpecEvents = h.reconcileEvents.filter(
      (e) => e.prNumber === 1 && e.action === "spec_build_succeeded",
    );
    assert.ok(aSpecEvents.length > 0, "A should emit spec_build_succeeded");

    // B should have spec_build events with dependsOn referencing A.
    const bSpecEvents = h.reconcileEvents.filter(
      (e) => e.prNumber === 2 && e.action === "spec_build_succeeded",
    );
    assert.ok(bSpecEvents.length > 0, "B should emit spec_build_succeeded");
    assert.ok(bSpecEvents[0]!.dependsOn, "B's spec should reference A as dependency");

    h.assertInvariants();
  });

  it("eviction cascade emits invalidated for downstream entries", async () => {
    const h = await createHarness({
      ciRule: (files) => files.includes("b.ts") ? "fail" : "pass",
      speculativeDepth: 3,
      maxRetries: 0,
    });
    const prC: SimPR = { number: 3, branch: "feat-c", files: [{ path: "c.ts", content: "c" }] };
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.enqueue(prC);
    await h.runUntilStable({ maxTicks: 40 });

    // B fails CI → evicted. C should be invalidated.
    const invalidEvents = h.reconcileEvents.filter(
      (e) => e.prNumber === 3 && e.action === "invalidated",
    );
    assert.ok(invalidEvents.length > 0, "C should be invalidated when B is evicted");

    h.assertInvariants();
  });

  it("queue_events detail field contains meaningful descriptions", async () => {
    const h = await createHarness({ ciRule: () => "pass" });
    await h.enqueue(prA);
    await h.runUntilStable();

    const events = h.store.listEvents(h.entries[0]!.id);
    // At least some events should have detail strings.
    const withDetail = events.filter((e) => e.detail && e.detail.length > 0);
    assert.ok(withDetail.length >= 2, `Expected at least 2 events with detail, got ${withDetail.length}`);

    // The validating transition should explain what happened.
    const validatingEvent = events.find((e) => e.toStatus === "validating");
    assert.ok(validatingEvent?.detail?.includes("spec") || validatingEvent?.detail?.includes("CI"), "validating detail should mention spec or CI");

    // The merged transition should explain.
    const mergedEvent = events.find((e) => e.toStatus === "merged");
    assert.ok(mergedEvent?.detail?.includes("main") || mergedEvent?.detail?.includes("merged"),
      "merged detail should mention main or merge");

    h.assertInvariants();
  });
});
