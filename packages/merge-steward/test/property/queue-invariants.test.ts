import { describe, it } from "node:test";
import fc from "fast-check";
import { Harness, type SimPR } from "../harness.ts";

/** PR with a unique file (no conflicts). */
function arbPR(id: number): SimPR {
  return {
    number: id,
    branch: `feat-${id}`,
    files: [{ path: `file-${id}.ts`, content: `content-${id}` }],
  };
}

/** PR that conflicts with another by sharing a file. */
function conflictingPR(id: number, sharedFile: string): SimPR {
  return {
    number: id,
    branch: `feat-${id}`,
    files: [{ path: sharedFile, content: `content-${id}-${Date.now()}` }],
  };
}

type CIMode = "all_pass" | "all_fail" | "odd_fail" | "first_n_fail";

function ciRuleForMode(mode: CIMode, failCount: number): (files: string[]) => "pass" | "fail" {
  let calls = 0;
  switch (mode) {
    case "all_pass":
      return () => "pass";
    case "all_fail":
      return () => "fail";
    case "odd_fail":
      return (files) => files.some((f) => {
        const m = f.match(/file-(\d+)\.ts/);
        return m && Number(m[1]) % 2 === 1;
      }) ? "fail" : "pass";
    case "first_n_fail":
      return () => ++calls <= failCount ? "fail" : "pass";
  }
}

// --- Command types ---

type Command =
  | { type: "enqueue"; prId: number }
  | { type: "enqueue_conflicting"; prId: number; sharedFile: string }
  | { type: "tick" }
  | { type: "tick_n"; n: number }
  | { type: "advance_main" }
  | { type: "force_push"; prId: number }
  | { type: "dequeue"; prId: number };

function arbBasicCommand(maxPRs: number): fc.Arbitrary<Command> {
  return fc.oneof(
    fc.record({ type: fc.constant("enqueue" as const), prId: fc.integer({ min: 1, max: maxPRs }) }),
    fc.record({ type: fc.constant("tick" as const) }),
    fc.record({ type: fc.constant("tick_n" as const), n: fc.integer({ min: 2, max: 8 }) }),
  );
}

function arbFullCommand(maxPRs: number): fc.Arbitrary<Command> {
  return fc.oneof(
    { weight: 3, arbitrary: fc.record({ type: fc.constant("enqueue" as const), prId: fc.integer({ min: 1, max: maxPRs }) }) },
    { weight: 2, arbitrary: fc.record({
      type: fc.constant("enqueue_conflicting" as const),
      prId: fc.integer({ min: 1, max: maxPRs }),
      sharedFile: fc.constantFrom("shared-a.ts", "shared-b.ts"),
    }) },
    { weight: 5, arbitrary: fc.record({ type: fc.constant("tick" as const) }) },
    { weight: 3, arbitrary: fc.record({ type: fc.constant("tick_n" as const), n: fc.integer({ min: 2, max: 6 }) }) },
    { weight: 1, arbitrary: fc.record({ type: fc.constant("advance_main" as const) }) },
    { weight: 1, arbitrary: fc.record({ type: fc.constant("force_push" as const), prId: fc.integer({ min: 1, max: maxPRs }) }) },
    { weight: 1, arbitrary: fc.record({ type: fc.constant("dequeue" as const), prId: fc.integer({ min: 1, max: maxPRs }) }) },
  );
}

async function applyCommand(h: Harness, cmd: Command, enqueued: Set<number>): Promise<void> {
  switch (cmd.type) {
    case "enqueue":
      if (!enqueued.has(cmd.prId)) {
        enqueued.add(cmd.prId);
        await h.enqueue(arbPR(cmd.prId));
      }
      break;
    case "enqueue_conflicting":
      if (!enqueued.has(cmd.prId)) {
        enqueued.add(cmd.prId);
        await h.enqueue(conflictingPR(cmd.prId, cmd.sharedFile));
      }
      break;
    case "tick":
      await h.tick();
      break;
    case "tick_n":
      for (let i = 0; i < cmd.n; i++) await h.tick();
      break;
    case "advance_main":
      await h.advanceMain();
      break;
    case "force_push":
      if (enqueued.has(cmd.prId)) {
        await h.forcePush(cmd.prId);
      }
      break;
    case "dequeue":
      if (enqueued.has(cmd.prId)) {
        h.dequeueByPR(cmd.prId);
      }
      break;
  }
}

// --- Property tests ---

describe("property: queue invariants under random commands", () => {
  it("invariants hold for random enqueue + tick sequences (all pass)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbBasicCommand(6), { minLength: 3, maxLength: 30 }),
        async (commands) => {
          const h = new Harness({ ciRule: () => "pass", maxRetries: 2 });
          await h.init();
          const enqueued = new Set<number>();
          for (const cmd of commands) {
            await applyCommand(h, cmd, enqueued);
            h.assertInvariants();
          }
        },
      ),
      { numRuns: 100, endOnFailure: true },
    );
  });

  it("invariants hold for random commands with mixed CI outcomes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<CIMode>("all_pass", "all_fail", "odd_fail", "first_n_fail"),
        fc.integer({ min: 1, max: 5 }),
        fc.array(arbBasicCommand(5), { minLength: 5, maxLength: 40 }),
        async (ciMode, failCount, commands) => {
          const h = new Harness({ ciRule: ciRuleForMode(ciMode, failCount), maxRetries: 2, flakyRetries: 1 });
          await h.init();
          const enqueued = new Set<number>();
          for (const cmd of commands) {
            await applyCommand(h, cmd, enqueued);
            h.assertInvariants();
          }
        },
      ),
      { numRuns: 100, endOnFailure: true },
    );
  });

  it("invariants hold with conflicts, force-pushes, and base advances", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbFullCommand(5), { minLength: 5, maxLength: 30 }),
        async (commands) => {
          const h = new Harness({ ciRule: () => "pass", maxRetries: 2 });
          await h.init();
          const enqueued = new Set<number>();
          for (const cmd of commands) {
            await applyCommand(h, cmd, enqueued);
            h.assertInvariants();
          }
        },
      ),
      { numRuns: 100, endOnFailure: true },
    );
  });

  it("invariants hold with conflicts + CI failures + disruptions", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<CIMode>("all_pass", "all_fail", "odd_fail"),
        fc.array(arbFullCommand(4), { minLength: 8, maxLength: 35 }),
        async (ciMode, commands) => {
          const h = new Harness({ ciRule: ciRuleForMode(ciMode, 0), maxRetries: 1, flakyRetries: 0 });
          await h.init();
          const enqueued = new Set<number>();
          for (const cmd of commands) {
            await applyCommand(h, cmd, enqueued);
            h.assertInvariants();
          }
        },
      ),
      { numRuns: 100, endOnFailure: true },
    );
  });

  it("queue always drains when given enough ticks", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<CIMode>("all_pass", "all_fail", "odd_fail"),
        fc.integer({ min: 1, max: 6 }),
        async (ciMode, prCount) => {
          const h = new Harness({ ciRule: ciRuleForMode(ciMode, 0), maxRetries: 1, flakyRetries: 0 });
          await h.init();
          for (let i = 1; i <= prCount; i++) await h.enqueue(arbPR(i));
          await h.runUntilStable({ maxTicks: prCount * 10 });
          for (const entry of h.entries) {
            if (entry.status !== "merged" && entry.status !== "evicted") {
              throw new Error(`PR #${entry.prNumber} stuck in ${entry.status}`);
            }
          }
          h.assertInvariants();
        },
      ),
      { numRuns: 100, endOnFailure: true },
    );
  });

  it("conservation: merged + evicted + dequeued = enqueued after drain", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<CIMode>("all_pass", "all_fail", "odd_fail", "first_n_fail"),
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 1, max: 6 }),
        async (ciMode, failCount, prCount) => {
          const h = new Harness({ ciRule: ciRuleForMode(ciMode, failCount), maxRetries: 1, flakyRetries: 1 });
          await h.init();
          for (let i = 1; i <= prCount; i++) await h.enqueue(arbPR(i));
          await h.runUntilStable({ maxTicks: prCount * 15 });

          const merged = h.entries.filter((e) => e.status === "merged").length;
          const evicted = h.entries.filter((e) => e.status === "evicted").length;
          if (merged + evicted !== prCount) {
            throw new Error(`Conservation: ${merged} merged + ${evicted} evicted != ${prCount} enqueued`);
          }
          h.assertInvariants();
        },
      ),
      { numRuns: 100, endOnFailure: true },
    );
  });

  it("serialization order preserved across random enqueue ordering", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray([1, 2, 3, 4, 5, 6], { minLength: 2, maxLength: 6 }),
        async (prOrder) => {
          const h = new Harness({ ciRule: () => "pass", maxRetries: 1 });
          await h.init();
          for (const id of prOrder) await h.enqueue(arbPR(id));
          await h.runUntilStable({ maxTicks: prOrder.length * 8 });

          if (h.merged.length !== prOrder.length) {
            throw new Error(`Expected ${prOrder.length} merges, got ${h.merged.length}`);
          }
          for (let i = 0; i < h.merged.length; i++) {
            if (h.merged[i] !== prOrder[i]) {
              throw new Error(`Merge order mismatch at ${i}: expected #${prOrder[i]}, got #${h.merged[i]}`);
            }
          }
          h.assertInvariants();
        },
      ),
      { numRuns: 50, endOnFailure: true },
    );
  });

  it("conflicting PRs: one merges, other evicts or waits (never both merge with conflicts)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 5 }),
        async (prCount) => {
          // All PRs modify the same file — only one can merge cleanly.
          const h = new Harness({ ciRule: () => "pass", maxRetries: 0 });
          await h.init();
          for (let i = 1; i <= prCount; i++) {
            await h.enqueue(conflictingPR(i, "shared.ts"));
          }
          await h.runUntilStable({ maxTicks: prCount * 10 });

          // Exactly one should merge (the first). Rest evicted.
          if (h.merged.length !== 1) {
            throw new Error(`Expected 1 merge, got ${h.merged.length} (merged: ${h.merged})`);
          }
          if (h.evicted.length !== prCount - 1) {
            throw new Error(`Expected ${prCount - 1} evictions, got ${h.evicted.length}`);
          }
          h.assertInvariants();
        },
      ),
      { numRuns: 50, endOnFailure: true },
    );
  });
});
