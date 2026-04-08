import type { WatchIssue } from "./watch-state.ts";

function isPassingCheckStatus(status: string | undefined): boolean {
  return status === "passed" || status === "success";
}

function isFailingCheckStatus(status: string | undefined): boolean {
  return status === "failed" || status === "failure";
}

function isPendingCheckStatus(status: string | undefined): boolean {
  return status === "pending" || status === "in_progress";
}

export function hasPendingPrChecks(issue: WatchIssue): boolean {
  const summary = issue.prChecksSummary;
  if (summary?.total) {
    return summary.pending > 0 || summary.completed < summary.total;
  }
  return isPendingCheckStatus(issue.prCheckStatus);
}

export function hasFailedPrChecks(issue: WatchIssue): boolean {
  const summary = issue.prChecksSummary;
  if (summary?.total) {
    return summary.failed > 0 || summary.overall === "failure";
  }
  return isFailingCheckStatus(issue.prCheckStatus);
}

export function arePrChecksCompleteAndGreen(issue: WatchIssue): boolean {
  const summary = issue.prChecksSummary;
  if (summary?.total) {
    return summary.pending === 0 && summary.failed === 0;
  }
  return isPassingCheckStatus(issue.prCheckStatus);
}

export function isRereviewNeeded(issue: WatchIssue): boolean {
  return issue.prReviewState === "changes_requested"
    && arePrChecksCompleteAndGreen(issue)
    && !issue.activeRunType;
}

export function prChecksFact(issue: WatchIssue): { text: string; color: "green" | "red" | "yellow" } | undefined {
  const summary = issue.prChecksSummary;
  if (hasFailedPrChecks(issue)) {
    const failedNames = summary?.failedNames ?? [];
    const checkInfo = issue.latestFailureCheckName
      ?? (failedNames.length > 0 ? failedNames.slice(0, 2).join(", ") : "checks");
    return { text: `${checkInfo} failed`, color: "red" };
  }
  if (summary?.total) {
    if (summary.pending > 0 || summary.completed < summary.total) {
      return { text: `checks ${summary.completed}/${summary.total}`, color: "yellow" };
    }
    if (summary.failed === 0) {
      return { text: "checks passed", color: "green" };
    }
  }
  if (isPassingCheckStatus(issue.prCheckStatus)) {
    return { text: "checks passed", color: "green" };
  }
  if (isPendingCheckStatus(issue.prCheckStatus)) {
    return { text: "checks running", color: "yellow" };
  }
  return undefined;
}

export function hasDisplayPrBlocker(issue: WatchIssue): boolean {
  if (issue.prNumber === undefined || issue.activeRunType) {
    return false;
  }
  if (hasPendingPrChecks(issue) || hasFailedPrChecks(issue)) {
    return true;
  }
  if (issue.prReviewState === "changes_requested" && !isRereviewNeeded(issue)) {
    return true;
  }
  if (!issue.prReviewState && issue.factoryState === "pr_open") {
    return true;
  }
  return false;
}
