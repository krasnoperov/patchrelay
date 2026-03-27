import { describe, it } from "node:test";
import fc from "fast-check";
import { Harness, type SimPR } from "../harness.ts";

/**
 * Property-based tests using fast-check.
 *
 * Generates random sequences of queue commands and verifies that all 6
 * invariants hold after every step, regardless of the command order.
 */

/** Generate a PR with a unique number and distinct file. */
function arbPR(id: number): SimPR {
  return {
    number: id,
    branch: `feat-${id}`,
    files: [{ path: `file-${id}.ts`, content: `content-${id}` }],
  };
}

/** CI rule types we can randomly select. */
type CIMode = "all_pass" | "all_fail" | "odd_fail" | "first_n_fail";

function ciRuleForMode(mode: CIMode, failCount: number): (files: string[]) => "pass" | "fail" {
  let calls = 0;
  switch (mode) {
    case "all_pass":
      return () => "pass";
    case "all_fail":
      return () => "fail";
    case "odd_fail":
      // Files with odd PR number fail.
      return (files) => files.some((f) => {
        const m = f.match(/file-(\d+)\.ts/);
        return m && Number(m[1]) % 2 === 1;
      }) ? "fail" : "pass";
    case "first_n_fail":
      return () => ++calls <= failCount ? "fail" : "pass";
  }
}

type Command =
  | { type: "enqueue"; prId: number }
  | { type: "tick" }
  | { type: "tick_n"; n: number };

function arbCommand(maxPRs: number): fc.Arbitrary<Command> {
  return fc.oneof(
    fc.record({
      type: fc.constant("enqueue" as const),
      prId: fc.integer({ min: 1, max: maxPRs }),
    }),
    fc.record({ type: fc.constant("tick" as const) }),
    fc.record({
      type: fc.constant("tick_n" as const),
      n: fc.integer({ min: 2, max: 8 }),
    }),
  );
}

describe("property: queue invariants under random commands", () => {
  it("invariants hold for random enqueue + tick sequences (all pass)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbCommand(6), { minLength: 3, maxLength: 30 }),
        async (commands) => {
          const h = new Harness({ ciRule: () => "pass", repairBudget: 2 });
          await h.init();

          const enqueued = new Set<number>();

          for (const cmd of commands) {
            switch (cmd.type) {
              case "enqueue":
                if (!enqueued.has(cmd.prId)) {
                  enqueued.add(cmd.prId);
                  await h.enqueue(arbPR(cmd.prId));
                }
                break;
              case "tick":
                await h.tick();
                break;
              case "tick_n":
                for (let i = 0; i < cmd.n; i++) await h.tick();
                break;
            }
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
        fc.array(arbCommand(5), { minLength: 5, maxLength: 40 }),
        async (ciMode, failCount, commands) => {
          const h = new Harness({
            ciRule: ciRuleForMode(ciMode, failCount),
            repairBudget: 2,
            flakyRetries: 1,
          });
          await h.init();

          const enqueued = new Set<number>();

          for (const cmd of commands) {
            switch (cmd.type) {
              case "enqueue":
                if (!enqueued.has(cmd.prId)) {
                  enqueued.add(cmd.prId);
                  await h.enqueue(arbPR(cmd.prId));
                }
                break;
              case "tick":
                await h.tick();
                break;
              case "tick_n":
                for (let i = 0; i < cmd.n; i++) await h.tick();
                break;
            }
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
          const h = new Harness({
            ciRule: ciRuleForMode(ciMode, 0),
            repairBudget: 1,
            flakyRetries: 0,
          });
          await h.init();

          for (let i = 1; i <= prCount; i++) {
            await h.enqueue(arbPR(i));
          }

          // Give enough ticks to fully drain.
          // Each PR needs at most ~6 ticks (queued → prep → validate → merge + repair cycles).
          await h.runUntilStable({ maxTicks: prCount * 10 });

          // Every entry must be terminal.
          for (const entry of h.entries) {
            const isTerminal = entry.status === "merged" || entry.status === "evicted";
            if (!isTerminal) {
              throw new Error(
                `PR #${entry.prNumber} stuck in ${entry.status} after ${prCount * 10} ticks (ciMode=${ciMode}, prCount=${prCount})`,
              );
            }
          }

          h.assertInvariants();
        },
      ),
      { numRuns: 100, endOnFailure: true },
    );
  });

  it("merged count + evicted count = enqueued count after drain", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<CIMode>("all_pass", "all_fail", "odd_fail", "first_n_fail"),
        fc.integer({ min: 1, max: 3 }),
        fc.integer({ min: 1, max: 6 }),
        async (ciMode, failCount, prCount) => {
          const h = new Harness({
            ciRule: ciRuleForMode(ciMode, failCount),
            repairBudget: 1,
            flakyRetries: 1,
          });
          await h.init();

          for (let i = 1; i <= prCount; i++) {
            await h.enqueue(arbPR(i));
          }

          await h.runUntilStable({ maxTicks: prCount * 15 });

          const mergedCount = h.entries.filter((e) => e.status === "merged").length;
          const evictedCount = h.entries.filter((e) => e.status === "evicted").length;

          if (mergedCount + evictedCount !== prCount) {
            throw new Error(
              `Conservation violated: ${mergedCount} merged + ${evictedCount} evicted != ${prCount} enqueued ` +
              `(ciMode=${ciMode}, failCount=${failCount})`,
            );
          }

          h.assertInvariants();
        },
      ),
      { numRuns: 100, endOnFailure: true },
    );
  });

  it("serialization order is preserved across random enqueue ordering", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.shuffledSubarray([1, 2, 3, 4, 5, 6], { minLength: 2, maxLength: 6 }),
        async (prOrder) => {
          const h = new Harness({ ciRule: () => "pass", repairBudget: 1 });
          await h.init();

          // Enqueue in the given (shuffled) order.
          for (const id of prOrder) {
            await h.enqueue(arbPR(id));
          }

          await h.runUntilStable({ maxTicks: prOrder.length * 8 });

          // All should merge — no conflicts, all pass.
          if (h.merged.length !== prOrder.length) {
            throw new Error(
              `Expected ${prOrder.length} merges, got ${h.merged.length} (order: ${prOrder})`,
            );
          }

          // Merged order should match enqueue order (position order),
          // which is the order they were enqueued, not the PR number order.
          for (let i = 0; i < h.merged.length; i++) {
            if (h.merged[i] !== prOrder[i]) {
              throw new Error(
                `Merge order mismatch at index ${i}: expected PR #${prOrder[i]}, got #${h.merged[i]} ` +
                `(enqueue order: ${prOrder}, merge order: ${h.merged})`,
              );
            }
          }

          h.assertInvariants();
        },
      ),
      { numRuns: 50, endOnFailure: true },
    );
  });
});
