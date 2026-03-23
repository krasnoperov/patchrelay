import type { GitHubTriggerEvent } from "./github-types.ts";

/**
 * Factory state machine — the single source of truth for issue lifecycle.
 */
export type FactoryState =
  | "delegated"
  | "preparing"
  | "implementing"
  | "pr_open"
  | "awaiting_review"
  | "changes_requested"
  | "repairing_ci"
  | "awaiting_queue"
  | "repairing_queue"
  | "awaiting_input"
  | "escalated"
  | "done"
  | "failed";

/** What kind of Codex run to start. */
export type RunType = "implementation" | "ci_repair" | "review_fix" | "queue_repair";

/** Which factory states involve an active Codex run. */
export const ACTIVE_RUN_STATES: ReadonlySet<FactoryState> = new Set([
  "implementing",
  "repairing_ci",
  "changes_requested",
  "repairing_queue",
]);

/** Which factory states are terminal (no further transitions possible). */
export const TERMINAL_STATES: ReadonlySet<FactoryState> = new Set([
  "done",
  "escalated",
]);

export const ALLOWED_TRANSITIONS: Readonly<Record<FactoryState, readonly FactoryState[]>> = {
  delegated: ["preparing", "failed"],
  preparing: ["implementing", "failed"],
  implementing: ["pr_open", "awaiting_input", "failed", "escalated"],
  pr_open: ["awaiting_review", "repairing_ci", "failed"],
  awaiting_review: ["changes_requested", "awaiting_queue", "repairing_ci"],
  changes_requested: ["implementing", "awaiting_input", "escalated"],
  repairing_ci: ["pr_open", "awaiting_review", "escalated", "failed"],
  awaiting_queue: ["done", "repairing_queue", "repairing_ci"],
  repairing_queue: ["pr_open", "awaiting_review", "awaiting_queue", "escalated", "failed"],
  awaiting_input: ["implementing", "delegated", "escalated"],
  escalated: [],
  done: [],
  failed: ["delegated"],
};

export function resolveFactoryStateFromGitHub(
  triggerEvent: GitHubTriggerEvent,
  current: FactoryState,
): FactoryState | undefined {
  switch (triggerEvent) {
    case "pr_opened":
      return current === "implementing" ? "pr_open" : undefined;
    case "pr_synchronize":
      return undefined; // just resets repair counters, no state change
    case "review_approved":
      return current === "awaiting_review" || current === "pr_open" ? "awaiting_queue" : undefined;
    case "review_changes_requested":
      return current === "awaiting_review" || current === "pr_open" ? "changes_requested" : undefined;
    case "review_commented":
      return undefined; // informational only
    case "check_passed":
      if (current === "repairing_queue") return "awaiting_queue";
      return current === "repairing_ci" ? "pr_open" : undefined;
    case "check_failed":
      return current === "pr_open" || current === "awaiting_review" || current === "awaiting_queue"
        ? "repairing_ci"
        : undefined;
    case "pr_merged":
      return "done";
    case "pr_closed":
      return "failed";
    case "merge_group_passed":
      return undefined; // merge event will follow
    case "merge_group_failed":
      return current === "awaiting_queue" ? "repairing_queue" : undefined;
    default:
      return undefined;
  }
}
