import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHarness, type SimPR } from "../harness.ts";

describe("eviction reporting", () => {
  it("conflict eviction produces incident with failureClass and context", async () => {
    const prA: SimPR = {
      number: 1,
      branch: "feat-a",
      files: [{ path: "shared.ts", content: "version A" }],
    };
    const prB: SimPR = {
      number: 2,
      branch: "feat-b",
      files: [{ path: "shared.ts", content: "version B" }],
    };

    const h = await createHarness({ ciRule: () => "pass", maxRetries: 0 });
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.runUntilStable({ maxTicks: 30 });

    assert.ok(h.merged.includes(1));
    assert.strictEqual(h.entryStatus(prB), "evicted");

    // Check the incident record.
    const entry = h.entries.find((e) => e.prNumber === 2)!;
    const incidents = h.store.listIncidents(entry.id);
    assert.strictEqual(incidents.length, 1);

    const incident = incidents[0]!;
    assert.strictEqual(incident.failureClass, "integration_conflict");
    assert.strictEqual(incident.outcome, "open");
    assert.strictEqual(incident.context.version, 1);
    assert.strictEqual(incident.context.failureClass, "integration_conflict");
    assert.ok(incident.context.baseSha.length > 0);
    assert.ok(incident.context.prHeadSha.length > 0);

    h.assertInvariants();
  });

  it("CI failure eviction produces incident with failedChecks", async () => {
    const prA: SimPR = { number: 1, branch: "feat-a", files: [{ path: "a.ts", content: "a" }] };

    const h = await createHarness({
      ciRule: () => "fail",
      maxRetries: 0,
      flakyRetries: 0,
    });
    await h.enqueue(prA);
    await h.runUntilStable({ maxTicks: 20 });

    assert.strictEqual(h.entryStatus(prA), "evicted");

    const entry = h.entries.find((e) => e.prNumber === 1)!;
    const incidents = h.store.listIncidents(entry.id);
    assert.strictEqual(incidents.length, 1);
    assert.strictEqual(incidents[0]!.outcome, "open");

    // Eviction was reported.
    assert.strictEqual(h.evictions.length, 1);

    h.assertInvariants();
  });

  it("incident is queryable by ID", async () => {
    const prA: SimPR = {
      number: 1,
      branch: "feat-a",
      files: [{ path: "shared.ts", content: "version A" }],
    };
    const prB: SimPR = {
      number: 2,
      branch: "feat-b",
      files: [{ path: "shared.ts", content: "version B" }],
    };

    const h = await createHarness({ ciRule: () => "pass", maxRetries: 0 });
    await h.enqueue(prA);
    await h.enqueue(prB);
    await h.runUntilStable({ maxTicks: 30 });

    const entry = h.entries.find((e) => e.prNumber === 2)!;
    const incidents = h.store.listIncidents(entry.id);
    const byId = h.store.getIncident(incidents[0]!.id);
    assert.ok(byId);
    assert.strictEqual(byId.id, incidents[0]!.id);
    assert.strictEqual(byId.entryId, entry.id);
  });
});
