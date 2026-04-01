import { useEffect, useMemo, useReducer } from "react";
import { Box, Text } from "ink";
import type { TimelineEntry, TimelineRunInput } from "./timeline-builder.ts";
import type { DetailTab, TimelineMode, WatchDiffSummary, WatchIssue, WatchIssueContext, WatchTokenUsage, OperatorFeedEvent } from "./watch-state.ts";
import { Timeline } from "./Timeline.tsx";
import { StateHistoryView } from "./StateHistoryView.tsx";
import { buildStateHistory } from "./history-builder.ts";
import { HelpBar } from "./HelpBar.tsx";
import { planStepSymbol, planStepColor } from "./plan-helpers.ts";
import { progressBar } from "./format-utils.ts";
import { FactoryStateGraph } from "./FactoryStateGraph.tsx";
import { QueueObservationView } from "./QueueObservationView.tsx";
import { buildPatchRelayQueueObservations, buildPatchRelayStateGraph } from "./state-visualization.ts";
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
  timelineMode: TimelineMode;
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

function buildPrStatusSummary(issue: WatchIssue, issueContext: WatchIssueContext | null): string[] {
  if (issue.prNumber === undefined) return [];

  const summary: string[] = [`PR #${issue.prNumber}`];
  const checkState = formatCheckState(issue.prCheckStatus);
  const reviewState = formatReviewState(issue.prReviewState);
  const failedCheck = issueContext?.latestFailureCheckName ?? issue.latestFailureCheckName;

  if (checkState === "checks failed" && failedCheck) {
    summary.push(`${failedCheck} failed`);
  } else if (checkState) {
    summary.push(checkState);
  }

  if (issue.prChecksSummary?.total) {
    if (issue.prChecksSummary.failed > 0) {
      summary.push(`${issue.prChecksSummary.failed}/${issue.prChecksSummary.total} checks failing`);
    } else if (issue.prChecksSummary.pending > 0) {
      summary.push(`${issue.prChecksSummary.completed}/${issue.prChecksSummary.total} checks settled`);
    } else {
      summary.push(`${issue.prChecksSummary.passed}/${issue.prChecksSummary.total} checks passed`);
    }
  }

  if (reviewState) {
    summary.push(`review ${reviewState}`);
  } else if (issue.factoryState === "pr_open" || issue.factoryState === "repairing_ci" || issue.factoryState === "awaiting_queue") {
    summary.push("review pending");
  }

  if (issue.factoryState === "awaiting_queue") {
    summary.push("queued for merge");
  } else if (issue.factoryState === "repairing_queue") {
    summary.push("merge queue repair needed");
  } else if (issue.factoryState === "done") {
    summary.push("merged");
  } else if (issue.prCheckStatus === "failed" || issue.prReviewState === undefined || issue.prReviewState === "changes_requested") {
    summary.push("not mergeable");
  }

  return summary;
}

function resolvePrimaryBlocker(issue: WatchIssue, issueContext: WatchIssueContext | null): { text: string; color: "red" | "yellow" } | null {
  if (issue.blockedByCount > 0) {
    return {
      text: `Waiting on blockers: ${issue.blockedByKeys.join(", ")}`,
      color: "yellow",
    };
  }

  if (issue.prCheckStatus === "failed" || issue.prCheckStatus === "failure") {
    const failedChecks = issue.prChecksSummary?.failedNames ?? [];
    const failedCheck = issueContext?.latestFailureCheckName
      ?? issue.latestFailureCheckName
      ?? (failedChecks.length > 0 ? failedChecks.slice(0, 2).join(", ") : undefined);
    return {
      text: failedCheck ? `Blocked by failed check: ${failedCheck}` : "Blocked by failed PR checks",
      color: "red",
    };
  }

  if (issue.prCheckStatus === "pending" || issue.prCheckStatus === "in_progress" || issue.prCheckStatus === "queued") {
    return { text: "Waiting for PR checks to finish", color: "yellow" };
  }

  if (issue.prReviewState === "changes_requested") {
    return { text: "Blocked by requested review changes", color: "yellow" };
  }

  if (issue.factoryState === "repairing_queue") {
    return { text: "Blocked by merge queue refresh failure", color: "yellow" };
  }

  if (issue.factoryState === "awaiting_queue") {
    return { text: "Waiting in merge queue", color: "yellow" };
  }

  if (issue.prNumber !== undefined && !issue.prReviewState && issue.factoryState !== "done") {
    return { text: "Blocked pending review approval", color: "yellow" };
  }

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
  detailTab, timelineMode, rawRuns, rawFeedEvents, connected, lastServerMessageAt,
}: IssueDetailViewProps): React.JSX.Element {
  if (!issue) {
    return (
      <Box flexDirection="column">
        <Text color="red">Issue not found.</Text>
        <HelpBar view="detail" follow={follow} detailTab={detailTab} timelineMode={timelineMode} />
      </Box>
    );
  }

  const key = issue.issueKey ?? issue.projectId;
  const meta: string[] = [];
  if (tokenUsage) meta.push(`${formatTokens(tokenUsage.inputTokens)} in / ${formatTokens(tokenUsage.outputTokens)} out`);
  if (diffSummary && diffSummary.filesChanged > 0) meta.push(`${diffSummary.filesChanged}f +${diffSummary.linesAdded} -${diffSummary.linesRemoved}`);
  if (issueContext?.runCount) meta.push(`${issueContext.runCount} runs`);

  const history = useMemo(
    () => buildStateHistory(rawRuns, rawFeedEvents, issue.factoryState, activeRunId),
    [rawRuns, rawFeedEvents, issue.factoryState, activeRunId],
  );
  const graph = useMemo(
    () => buildPatchRelayStateGraph(history, issue.factoryState),
    [history, issue.factoryState],
  );
  const queueObservations = useMemo(
    () => buildPatchRelayQueueObservations(issue, rawFeedEvents),
    [issue, rawFeedEvents],
  );
  const prStatusSummary = useMemo(
    () => buildPrStatusSummary(issue, issueContext),
    [issue, issueContext],
  );
  const primaryBlocker = useMemo(
    () => resolvePrimaryBlocker(issue, issueContext),
    [issue, issueContext],
  );

  return (
    <Box flexDirection="column">
      <Box gap={2}>
        <Text bold>{key}</Text>
        <Text color="cyan">{issue.factoryState}</Text>
        {issue.blockedByCount > 0 && <Text color="yellow">blocked by {issue.blockedByKeys.join(", ")}</Text>}
        {issue.readyForExecution && !issue.activeRunType && issue.blockedByCount === 0 && <Text color="blueBright">ready</Text>}
        {issue.activeRunType && <Text color="yellow">{issue.activeRunType}</Text>}
        {issue.prNumber !== undefined && <Text dimColor>#{issue.prNumber}</Text>}
        {activeRunStartedAt && <ElapsedTime startedAt={activeRunStartedAt} />}
        {meta.length > 0 && <Text dimColor>{meta.join("  ")}</Text>}
        {detailTab === "timeline" && <Text dimColor>{timelineMode}</Text>}
        {follow && <Text color="yellow">follow</Text>}
        <FreshnessBadge connected={connected} lastServerMessageAt={lastServerMessageAt} />
      </Box>
      {issue.title && <Text>{issue.title}</Text>}
      {prStatusSummary.length > 0 && (
        <Box marginTop={1}>
          <Text dimColor>{prStatusSummary.join("  |  ")}</Text>
        </Box>
      )}
      {primaryBlocker && (
        <Box marginTop={1}>
          <Text color={primaryBlocker.color}>Blocked by: {primaryBlocker.text}</Text>
        </Box>
      )}
      {issueContext?.latestFailureSummary && (
        <Box marginTop={1}>
          <Text color={issueContext.latestFailureSource === "queue_eviction" ? "yellow" : "red"}>
            Latest failure: {issueContext.latestFailureSummary}
            {issueContext.latestFailureHeadSha ? ` @ ${issueContext.latestFailureHeadSha.slice(0, 8)}` : ""}
          </Text>
        </Box>
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
            <Timeline entries={timeline} follow={follow} mode={timelineMode} />
          </Box>
        </>
      ) : (
        <>
          <FactoryStateGraph
            main={graph.main}
            prLoops={graph.prLoops}
            queueLoop={graph.queueLoop}
            exits={graph.exits}
          />
          <QueueObservationView observations={queueObservations} />
          <Box marginTop={1}>
            <StateHistoryView history={history} plan={plan} activeRunId={activeRunId} />
          </Box>
        </>
      )}

      <Box marginTop={1}>
        <HelpBar view="detail" follow={follow} detailTab={detailTab} timelineMode={timelineMode} />
      </Box>
    </Box>
  );
}
