import type { GitHubTriggerEvent } from "./github-types.ts";

/**
 * Factory state machine — the single source of truth for issue lifecycle.
 */
export type FactoryState =
  | "delegated"
  | "implementing"
  | "pr_open"
  | "changes_requested"
  | "repairing_ci"
  | "awaiting_queue"
  | "repairing_queue"
  | "awaiting_input"
  | "escalated"
  | "done"
  | "failed";

/** What kind of Codex run to start. */
export type RunType = "implementation" | "ci_repair" | "review_fix" | "branch_upkeep" | "queue_repair";

/** Which factory states involve an active Codex run. */
export const ACTIVE_RUN_STATES: ReadonlySet<FactoryState> = new Set([
  "implementing",
  "repairing_ci",
  "changes_requested",
  "repairing_queue",
]);

/** Which factory states are terminal (no further transitions possible except pr_merged → done). */
export const TERMINAL_STATES: ReadonlySet<FactoryState> = new Set([
  "done",
  "escalated",
  "failed",
  "awaiting_input",
]);

// ─── Semantic guards ─────────────────────────────────────────────
//
// Guards express INTENT rather than enumerating states. Adding a new
// state automatically participates in transitions whose guard it
// satisfies — no per-event maintenance required.

const isOpen = (s: FactoryState): boolean => !TERMINAL_STATES.has(s);

// ─── Rule-based transition table ─────────────────────────────────
//
// Each rule: { event, guard?, to }. First matching rule wins.
// The table IS the documentation. Scan it to audit any transition.

/** Context passed to guards and dynamic targets for condition-based resolution. */
export interface TransitionContext {
  /** Current PR review state from GitHub metadata. */
  prReviewState?: string | undefined;
  /** Active Codex run ID — set when a run is in progress. */
  activeRunId?: number | undefined;
}

interface TransitionRule {
  event: GitHubTriggerEvent;
  guard?: (current: FactoryState, ctx: TransitionContext) => boolean;
  to: FactoryState | ((current: FactoryState, ctx: TransitionContext) => FactoryState);
}

const TRANSITION_RULES: readonly TransitionRule[] = [
  // ── Terminal events ────────────────────────────────────────────
  // pr_merged transitions to done only when no agent run is active.
  // If an active run exists, suppress the transition — the run's
  // completion handler will detect the merged PR and advance to done.
  // This prevents orphaning agent work (e.g. pending follow-up fixes).
  { event: "pr_merged",
    guard: (_, ctx) => ctx.activeRunId === undefined,
    to: "done" },

  // pr_closed during an active run is suppressed — Codex may reopen.
  // Without a guard match, the event produces no transition (undefined).
  { event: "pr_closed",
    guard: (s, ctx) => ctx.activeRunId === undefined && !TERMINAL_STATES.has(s),
    to: "failed" },

  // ── PR lifecycle ───────────────────────────────────────────────
  { event: "pr_opened",
    guard: (s) => s === "implementing",
    to: "pr_open" },

  // ── Review events — apply when no Codex run is actively executing ──
  // Uses activeRunId (runtime state) rather than the state name, because
  // states like changes_requested are "run states" only while the run is
  // active — once the run completes, reviews should be accepted.
  { event: "review_approved",
    guard: (s, ctx) => isOpen(s) && ctx.activeRunId === undefined,
    to: "awaiting_queue" },

  { event: "review_changes_requested",
    guard: (s, ctx) => isOpen(s) && ctx.activeRunId === undefined,
    to: "changes_requested" },

  // review_commented: no rule → no transition (informational only)

  // ── CI check events ────────────────────────────────────────────
  // After queue repair, return to the merge queue.
  { event: "check_passed",
    guard: (s) => s === "repairing_queue",
    to: "awaiting_queue" },

  // After CI repair, return to merge queue if already approved,
  // otherwise to pr_open for review.
  { event: "check_passed",
    guard: (s) => s === "repairing_ci",
    to: (_, ctx) => ctx.prReviewState === "approved" ? "awaiting_queue" : "pr_open" },

  // CI failure when no run is active triggers repair.
  { event: "check_failed",
    guard: (s, ctx) => isOpen(s) && ctx.activeRunId === undefined,
    to: "repairing_ci" },

  // pr_synchronize: no rule → no transition (resets counters only)
  // merge_group events: not used — merge queue is handled by external steward
];

/**
 * Resolve the next factory state from a GitHub webhook event.
 *
 * Returns `undefined` when no rule matches — the event is a no-op
 * for the current state (e.g. check_passed while implementing).
 */
export function resolveFactoryStateFromGitHub(
  triggerEvent: GitHubTriggerEvent,
  current: FactoryState,
  ctx: TransitionContext = {},
): FactoryState | undefined {
  for (const rule of TRANSITION_RULES) {
    if (rule.event !== triggerEvent) continue;
    if (rule.guard && !rule.guard(current, ctx)) continue;
    return typeof rule.to === "function" ? rule.to(current, ctx) : rule.to;
  }
  return undefined;
}

/**
 * Derive the allowed transitions table from the rules for documentation
 * and test validation. Not used at runtime.
 */
export function deriveAllowedTransitions(
  states: readonly FactoryState[],
  events: readonly GitHubTriggerEvent[],
): Record<FactoryState, Set<FactoryState>> {
  const result: Record<string, Set<FactoryState>> = {};
  for (const state of states) {
    result[state] = new Set<FactoryState>();
  }
  // Sample with common review states to catch dynamic targets
  const contexts: TransitionContext[] = [
    {},
    { prReviewState: "approved" },
    { prReviewState: "changes_requested" },
  ];
  for (const state of states) {
    for (const event of events) {
      for (const ctx of contexts) {
        const target = resolveFactoryStateFromGitHub(event, state, ctx);
        if (target !== undefined && target !== state) {
          result[state]!.add(target);
        }
      }
    }
  }
  return result as Record<FactoryState, Set<FactoryState>>;
}
