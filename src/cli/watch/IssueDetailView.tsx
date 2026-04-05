import { useEffect, useMemo, useReducer } from "react";
import { Box, Text } from "ink";
import type { TimelineEntry, TimelineRunInput } from "./timeline-builder.ts";
import type { DetailTab, WatchDiffSummary, WatchIssue, WatchIssueContext, WatchTokenUsage, OperatorFeedEvent } from "./watch-state.ts";
import { Timeline } from "./Timeline.tsx";
import { StateHistoryView } from "./StateHistoryView.tsx";
import { buildStateHistory } from "./history-builder.ts";
import { HelpBar } from "./HelpBar.tsx";
import { planStepSymbol, planStepColor } from "./plan-helpers.ts";
import { progressBar } from "./format-utils.ts";
import { FreshnessBadge } from "./FreshnessBadge.tsx";

interface IssueDetailViewProps {
  issue: WatchIssue | undefined;
  timeline: TimelineEntry[];
  follow: boolean;
  activeRunStartedAt: string | null;
  activeRunId: number | null;
  tokenUsage: WatchTokenUsage | null;
  diffSummary: WatchDiffSummary | null;
  plan: Array<{ step: string; status: string }> | null;
  issueContext: WatchIssueContext | null;
  detailTab: DetailTab;
  rawRuns: TimelineRunInput[];
  rawFeedEvents: OperatorFeedEvent[];
  connected: boolean;
  lastServerMessageAt: number | null;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatReviewState(reviewState?: string): string | null {
  switch (reviewState) {
    case "approved":
      return "approved";
    case "changes_requested":
      return "changes requested";
    case "commented":
      return "commented";
    default:
      return reviewState ? reviewState.replaceAll("_", " ") : null;
  }
}

function formatCheckState(checkState?: string): string | null {
  switch (checkState) {
    case "passed":
    case "success":
      return "checks passed";
    case "failed":
    case "failure":
      return "checks failed";
    case "pending":
    case "in_progress":
    case "queued":
      return "checks pending";
    default:
      return null;
  }
}

const STATE_DISPLAY: Record<string, { label: string; color: string }> = {
  blocked: { label: "blocked", color: "yellow" },
  ready: { label: "ready", color: "blueBright" },
  delegated: { label: "delegated", color: "cyan" },
  implementing: { label: "implementing", color: "cyan" },
  pr_open: { label: "PR open", color: "cyan" },
  changes_requested: { label: "review changes", color: "yellow" },
  repairing_ci: { label: "repairing CI", color: "yellow" },
  awaiting_queue: { label: "queued for merge", color: "cyan" },
  repairing_queue: { label: "repairing queue", color: "yellow" },
  done: { label: "merged", color: "green" },
  failed: { label: "failed", color: "red" },
  escalated: { label: "escalated", color: "red" },
  awaiting_input: { label: "awaiting input", color: "yellow" },
};

function effectiveState(issue: WatchIssue): string {
  if (issue.blockedByCount > 0 && !issue.activeRunType) return "blocked";
  if (issue.readyForExecution && !issue.activeRunType) return "ready";
  return issue.factoryState;
}

function blockerText(issue: WatchIssue, issueContext: WatchIssueContext | null): string | null {
  if (issue.waitingReason && !issue.activeRunType) return issue.waitingReason;
  if (issue.blockedByCount > 0) return `Waiting on ${issue.blockedByKeys.join(", ")}`;
  if (issue.factoryState === "repairing_queue") return "Merge queue conflict, repairing branch";
  if (issue.factoryState === "repairing_ci") {
    const check = issueContext?.latestFailureCheckName ?? issue.latestFailureCheckName ?? "CI";
    return `Repairing ${check}`;
  }
  if (issue.factoryState === "awaiting_queue") return "Waiting for merge queue";
  if (issue.prCheckStatus === "failed" || issue.prCheckStatus === "failure") {
    const check = issueContext?.latestFailureCheckName ?? issue.latestFailureCheckName ?? "checks";
    return `${check} failed`;
  }
  if (issue.prReviewState === "changes_requested") return "Review changes requested";
  if (issue.prNumber !== undefined && !issue.prReviewState && issue.factoryState !== "done") return "Awaiting review";
  return null;
}

function ElapsedTime({ startedAt }: { startedAt: string }): React.JSX.Element {
  const [, tick] = useReducer((c: number) => c + 1, 0);
  useEffect(() => {
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  const elapsed = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return <Text dimColor>{minutes}m {String(seconds).padStart(2, "0")}s</Text>;
}

export function IssueDetailView({
  issue, timeline, follow, activeRunStartedAt, activeRunId, tokenUsage, diffSummary, plan, issueContext,
  detailTab, rawRuns, rawFeedEvents, connected, lastServerMessageAt,
}: IssueDetailViewProps): React.JSX.Element {
  if (!issue) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Loading issue…</Text>
        <HelpBar view="detail" follow={follow} detailTab={detailTab} />
      </Box>
    );
  }

  const key = issue.issueKey ?? issue.projectId;
  const meta: string[] = [];
  if (tokenUsage) meta.push(`${formatTokens(tokenUsage.inputTokens)} in / ${formatTokens(tokenUsage.outputTokens)} out`);
  if (diffSummary && diffSummary.filesChanged > 0) meta.push(`${diffSummary.filesChanged}f +${diffSummary.linesAdded} -${diffSummary.linesRemoved}`);
  if (issueContext?.runCount) meta.push(`${issueContext.runCount} runs`);

  const state = STATE_DISPLAY[effectiveState(issue)] ?? { label: issue.factoryState, color: "white" };
  const blocker = blockerText(issue, issueContext);

  const history = useMemo(
    () => buildStateHistory(rawRuns, rawFeedEvents, issue.factoryState, activeRunId),
    [rawRuns, rawFeedEvents, issue.factoryState, activeRunId],
  );

  // Build compact facts for the header
  const facts: string[] = [];
  if (issue.prNumber !== undefined) facts.push(`PR #${issue.prNumber}`);
  if (issue.prReviewState === "approved") facts.push("approved");
  else if (issue.prReviewState === "changes_requested") facts.push("changes requested");
  if (issue.prCheckStatus === "passed" || issue.prCheckStatus === "success") facts.push("checks passed");
  else if (issue.prCheckStatus === "failed" || issue.prCheckStatus === "failure") {
    const check = issueContext?.latestFailureCheckName ?? issue.latestFailureCheckName ?? "checks";
    facts.push(`${check} failed`);
  } else if (issue.prChecksSummary?.total) {
    facts.push(`checks ${issue.prChecksSummary.completed}/${issue.prChecksSummary.total}`);
  }

  return (
    <Box flexDirection="column">
      {/* Header: issue key · status · facts · elapsed · freshness */}
      <Box gap={2}>
        <Text bold>{key}</Text>
        <Text color={state.color}>{state.label}</Text>
        {facts.length > 0 && <Text dimColor>{facts.join(" \u00b7 ")}</Text>}
        {activeRunStartedAt && <ElapsedTime startedAt={activeRunStartedAt} />}
        {meta.length > 0 && <Text dimColor>{meta.join("  ")}</Text>}
        {follow && <Text color="yellow">follow</Text>}
        <FreshnessBadge connected={connected} lastServerMessageAt={lastServerMessageAt} />
      </Box>
      {issue.title && <Text>{issue.title}</Text>}
      {blocker && <Text color="yellow">{blocker}</Text>}
      {issueContext?.latestFailureSummary && (
        <Text color={issueContext.latestFailureSource === "queue_eviction" ? "yellow" : "red"}>
          Latest failure: {issueContext.latestFailureSummary}
          {issueContext.latestFailureHeadSha ? ` @ ${issueContext.latestFailureHeadSha.slice(0, 8)}` : ""}
        </Text>
      )}

      {detailTab === "timeline" ? (
        <>
          {plan && plan.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Box gap={1}>
                <Text dimColor>Plan</Text>
                <Text>{progressBar(plan.filter((s) => s.status === "completed").length, plan.length, 16)}</Text>
                <Text dimColor>{plan.filter((s) => s.status === "completed").length}/{plan.length}</Text>
              </Box>
              {plan.map((entry, i) => (
                <Box key={`plan-${i}`} gap={1}>
                  <Text color={planStepColor(entry.status)}>[{planStepSymbol(entry.status)}]</Text>
                  <Text>{entry.step}</Text>
                </Box>
              ))}
            </Box>
          )}

          <Box marginTop={1} flexDirection="column">
            <Timeline entries={timeline} follow={follow} />
          </Box>
        </>
      ) : (
        <>
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>PatchRelay activity history only.</Text>
            <Text dimColor>Review and merge automation remain downstream and are intentionally de-emphasized here.</Text>
          </Box>
          <Box marginTop={1}>
            <StateHistoryView history={history} plan={plan} activeRunId={activeRunId} />
          </Box>
        </>
      )}

      <Box marginTop={1}>
        <HelpBar view="detail" follow={follow} detailTab={detailTab} />
      </Box>
    </Box>
  );
}
