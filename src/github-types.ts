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
  prTitle?: string | undefined;
  prBody?: string | undefined;
  prNumber?: number | undefined;
  prUrl?: string | undefined;
  prState?: "open" | "closed" | "merged" | undefined;
  prAuthorLogin?: string | undefined;
  prLabels?: string[] | undefined;
  reviewState?: "approved" | "changes_requested" | "commented" | undefined;
  checkStatus?: "pending" | "success" | "failure" | undefined;
  checkName?: string | undefined;
  checkUrl?: string | undefined;
  checkDetailsUrl?: string | undefined;
  checkOutputTitle?: string | undefined;
  checkOutputSummary?: string | undefined;
  checkOutputText?: string | undefined;
  reviewBody?: string | undefined;
  reviewId?: number | undefined;
  reviewCommitId?: string | undefined;
  reviewerName?: string | undefined;
  mergeGroupFailureReason?: string | undefined;
  eventSource?: "check_run" | "check_suite" | undefined;
}

export interface GitHubWebhookPayload {
  action?: string;
  // pull_request event
  pull_request?: {
    number: number;
    html_url: string;
    title?: string;
    body?: string;
    state: string;
    merged: boolean;
    user?: { login: string };
    labels?: Array<{ name?: string }>;
    head: { ref: string; sha: string };
    base: { ref: string };
  };
  // pull_request_review event
  review?: {
    id?: number;
    state: string;
    body?: string;
    commit_id?: string;
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
    details_url?: string;
    head_sha: string;
    output?: {
      title?: string;
      summary?: string;
      text?: string;
    };
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
