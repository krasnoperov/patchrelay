export type GitHubTriggerEvent =
  | "pr_opened"
  | "pr_synchronize"
  | "pr_closed"
  | "pr_merged"
  | "review_approved"
  | "review_changes_requested"
  | "review_commented"
  | "check_passed"
  | "check_failed"
  | "merge_group_passed"
  | "merge_group_failed";

export interface NormalizedGitHubEvent {
  triggerEvent: GitHubTriggerEvent;
  repoFullName: string;
  branchName: string;
  headSha: string;
  prNumber?: number | undefined;
  prUrl?: string | undefined;
  prState?: "open" | "closed" | "merged" | undefined;
  reviewState?: "approved" | "changes_requested" | "commented" | undefined;
  checkStatus?: "pending" | "success" | "failure" | undefined;
  checkName?: string | undefined;
  checkUrl?: string | undefined;
  reviewBody?: string | undefined;
  reviewerName?: string | undefined;
  mergeGroupFailureReason?: string | undefined;
}

export interface GitHubWebhookPayload {
  action?: string;
  // pull_request event
  pull_request?: {
    number: number;
    html_url: string;
    state: string;
    merged: boolean;
    head: { ref: string; sha: string };
    base: { ref: string };
  };
  // pull_request_review event
  review?: {
    state: string;
    body?: string;
    user?: { login: string };
  };
  // check_suite event
  check_suite?: {
    conclusion: string | null;
    head_sha: string;
    head_branch: string | null;
    pull_requests: Array<{ number: number; head: { ref: string } }>;
  };
  // check_run event
  check_run?: {
    conclusion: string | null;
    name: string;
    html_url: string;
    head_sha: string;
    check_suite?: {
      head_branch: string | null;
      pull_requests: Array<{ number: number; head: { ref: string } }>;
    };
  };
  // merge_group event
  merge_group?: {
    head_sha: string;
    head_ref: string;
    base_ref: string;
  };
  // common
  repository?: {
    full_name: string;
  };
}
