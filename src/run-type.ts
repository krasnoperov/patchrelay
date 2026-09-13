/** What kind of Codex run to start. */
export type RunType =
  | "collaboration"
  | "implementation"
  | "ci_repair"
  | "review_fix"
  | "branch_upkeep"
  | "integration_repair"
  /** Legacy persisted name; new GitHub-derived work uses integration_repair. */
  | "queue_repair";
