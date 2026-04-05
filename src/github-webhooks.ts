import { createHmac, timingSafeEqual } from "node:crypto";
import type { GitHubTriggerEvent, GitHubWebhookPayload, NormalizedGitHubEvent } from "./github-types.ts";

export function verifyGitHubWebhookSignature(rawBody: Buffer, secret: string, signature: string): boolean {
  if (!signature.startsWith("sha256=")) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = signature.slice("sha256=".length);

  if (expected.length !== provided.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
}

export function normalizeGitHubWebhook(params: {
  eventType: string;
  payload: GitHubWebhookPayload;
}): NormalizedGitHubEvent | undefined {
  const { eventType, payload } = params;
  const repoFullName = payload.repository?.full_name ?? "";

  if (eventType === "pull_request" && payload.pull_request) {
    return normalizePullRequestEvent(payload, repoFullName);
  }

  if (eventType === "pull_request_review" && payload.pull_request && payload.review) {
    return normalizePullRequestReviewEvent(payload, repoFullName);
  }

  if (eventType === "check_suite" && payload.check_suite) {
    return normalizeCheckSuiteEvent(payload, repoFullName);
  }

  if (eventType === "check_run" && payload.check_run) {
    return normalizeCheckRunEvent(payload, repoFullName);
  }

  if (eventType === "merge_group" && payload.merge_group) {
    return normalizeMergeGroupEvent(payload, repoFullName);
  }

  return undefined;
}

function normalizePullRequestEvent(payload: GitHubWebhookPayload, repoFullName: string): NormalizedGitHubEvent | undefined {
  const pr = payload.pull_request!;
  const action = payload.action;

  let triggerEvent: GitHubTriggerEvent;
  let prState: NormalizedGitHubEvent["prState"];

  if (action === "opened" || action === "reopened") {
    triggerEvent = "pr_opened";
    prState = "open";
  } else if (action === "synchronize") {
    triggerEvent = "pr_synchronize";
    prState = "open";
  } else if (action === "closed") {
    if (pr.merged) {
      triggerEvent = "pr_merged";
      prState = "merged";
    } else {
      triggerEvent = "pr_closed";
      prState = "closed";
    }
  } else {
    return undefined;
  }

  return {
    triggerEvent,
    repoFullName,
    branchName: pr.head.ref,
    headSha: pr.head.sha,
    prNumber: pr.number,
    prUrl: pr.html_url,
    prState,
    prAuthorLogin: pr.user?.login ?? undefined,
  };
}

function normalizePullRequestReviewEvent(payload: GitHubWebhookPayload, repoFullName: string): NormalizedGitHubEvent | undefined {
  if (payload.action !== "submitted") return undefined;

  const pr = payload.pull_request!;
  const review = payload.review!;
  const state = review.state?.toLowerCase();

  let triggerEvent: GitHubTriggerEvent;
  let reviewState: NormalizedGitHubEvent["reviewState"];

  if (state === "approved") {
    triggerEvent = "review_approved";
    reviewState = "approved";
  } else if (state === "changes_requested") {
    triggerEvent = "review_changes_requested";
    reviewState = "changes_requested";
  } else if (state === "commented") {
    triggerEvent = "review_commented";
    reviewState = "commented";
  } else {
    return undefined;
  }

  return {
    triggerEvent,
    repoFullName,
    branchName: pr.head.ref,
    headSha: pr.head.sha,
    prNumber: pr.number,
    prUrl: pr.html_url,
    prState: "open",
    prAuthorLogin: pr.user?.login ?? undefined,
    reviewState,
    reviewBody: review.body ?? undefined,
    reviewerName: review.user?.login ?? undefined,
  };
}

function normalizeCheckSuiteEvent(payload: GitHubWebhookPayload, repoFullName: string): NormalizedGitHubEvent | undefined {
  if (payload.action !== "completed") return undefined;

  const suite = payload.check_suite!;
  const conclusion = suite.conclusion?.toLowerCase();
  const pr = suite.pull_requests?.[0];
  const branchName = pr?.head.ref ?? suite.head_branch ?? "";

  if (!branchName) return undefined;

  const passed = conclusion === "success" || conclusion === "neutral" || conclusion === "skipped";

  return {
    triggerEvent: passed ? "check_passed" : "check_failed",
    repoFullName,
    branchName,
    headSha: suite.head_sha,
    prNumber: pr?.number,
    checkStatus: passed ? "success" : "failure",
    eventSource: "check_suite",
  };
}

function normalizeCheckRunEvent(payload: GitHubWebhookPayload, repoFullName: string): NormalizedGitHubEvent | undefined {
  if (payload.action !== "completed") return undefined;

  const run = payload.check_run!;
  const conclusion = run.conclusion?.toLowerCase();
  const pr = run.check_suite?.pull_requests?.[0];
  const branchName = pr?.head.ref ?? run.check_suite?.head_branch ?? "";

  if (!branchName) return undefined;

  const passed = conclusion === "success" || conclusion === "neutral" || conclusion === "skipped";

  return {
    triggerEvent: passed ? "check_passed" : "check_failed",
    repoFullName,
    branchName,
    headSha: run.head_sha,
    prNumber: pr?.number,
    checkStatus: passed ? "success" : "failure",
    checkName: run.name,
    checkUrl: run.html_url,
    checkDetailsUrl: run.details_url,
    checkOutputTitle: run.output?.title,
    checkOutputSummary: run.output?.summary,
    checkOutputText: run.output?.text,
    eventSource: "check_run",
  };
}

function normalizeMergeGroupEvent(payload: GitHubWebhookPayload, repoFullName: string): NormalizedGitHubEvent | undefined {
  const group = payload.merge_group!;
  const action = payload.action;

  if (action === "checks_passed") {
    return {
      triggerEvent: "merge_group_passed",
      repoFullName,
      branchName: group.head_ref,
      headSha: group.head_sha,
    };
  }

  if (action === "checks_failed" || action === "destroyed") {
    return {
      triggerEvent: "merge_group_failed",
      repoFullName,
      branchName: group.head_ref,
      headSha: group.head_sha,
      mergeGroupFailureReason: action,
    };
  }

  return undefined;
}
