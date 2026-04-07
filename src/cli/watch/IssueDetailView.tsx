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

const SESSION_DISPLAY: Record<string, { label: string; color: string }> = {
  idle: { label: "idle", color: "blueBright" },
  running: { label: "running", color: "cyan" },
  waiting_input: { label: "needs input", color: "yellow" },
  done: { label: "done", color: "green" },
  failed: { label: "failed", color: "red" },
};

const STAGE_DISPLAY: Record<string, string> = {
  blocked: "blocked",
  ready: "ready",
  delegated: "delegated",
  implementing: "implementing",
  pr_open: "PR open",
  changes_requested: "review changes",
  repairing_ci: "repairing CI",
  awaiting_queue: "waiting downstream",
  repairing_queue: "repairing queue",
  done: "merged",
  failed: "failed",
  escalated: "escalated",
  awaiting_input: "needs input",
};

function effectiveState(issue: WatchIssue): string {
  if (issue.sessionState === "done") return "done";
  if (issue.sessionState === "failed") return "failed";
  if (issue.blockedByCount > 0 && !issue.activeRunType) return "blocked";
  if (issue.readyForExecution && !issue.activeRunType) return "ready";
  if (issue.sessionState === "waiting_input") return "awaiting_input";
  return issue.factoryState;
}

function sessionDisplay(issue: WatchIssue): { label: string; color: string } {
  const state = issue.sessionState ?? "unknown";
  return SESSION_DISPLAY[state] ?? { label: state, color: "white" };
}

function stageDisplay(issue: WatchIssue): string {
  const state = effectiveState(issue);
  return STAGE_DISPLAY[state] ?? issue.factoryState;
}

function blockerText(issue: WatchIssue, issueContext: WatchIssueContext | null): string | null {
  const rereviewNeeded = issue.prReviewState === "changes_requested"
    && (issue.prCheckStatus === "passed" || issue.prCheckStatus === "success")
    && !issue.activeRunType;
  if (issue.sessionState === "waiting_input") return issue.waitingReason ?? "Waiting for input";
  if (issue.waitingReason && !issue.activeRunType) return issue.waitingReason;
  if (issue.blockedByCount > 0) return `Waiting on ${issue.blockedByKeys.join(", ")}`;
  if (effectiveState(issue) === "repairing_queue") return "Merge queue conflict, repairing branch";
  if (effectiveState(issue) === "repairing_ci") {
    const check = issueContext?.latestFailureCheckName ?? issue.latestFailureCheckName ?? "CI";
    return `Repairing ${check}`;
  }
  if (issue.prCheckStatus === "failed" || issue.prCheckStatus === "failure") {
    const check = issueContext?.latestFailureCheckName ?? issue.latestFailureCheckName ?? "checks";
    return `${check} failed`;
  }
  if (rereviewNeeded) return "Awaiting re-review after requested changes";
  if (issue.prReviewState === "changes_requested") return "Review changes requested";
  if (issue.prNumber !== undefined && !issue.prReviewState && effectiveState(issue) !== "done") return "Awaiting review";
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

  const session = sessionDisplay(issue);
  const stage = stageDisplay(issue);
  const blocker = blockerText(issue, issueContext);

  const history = useMemo(
    () => buildStateHistory(rawRuns, rawFeedEvents, issue.factoryState, activeRunId),
    [rawRuns, rawFeedEvents, issue.factoryState, activeRunId],
  );

  // Build compact facts for the header
  const facts: string[] = [];
  const rereviewNeeded = issue.prReviewState === "changes_requested"
    && (issue.prCheckStatus === "passed" || issue.prCheckStatus === "success")
    && !issue.activeRunType;
  if (issue.prNumber !== undefined) facts.push(`PR #${issue.prNumber}`);
  if (issue.prReviewState === "approved") facts.push("approved");
  else if (rereviewNeeded) facts.push("re-review needed");
  else if (issue.prReviewState === "changes_requested") facts.push("changes requested");
  if (issue.waitingReason && issue.sessionState === "waiting_input") facts.push(issue.waitingReason);
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
        <Text color={session.color}>{session.label}</Text>
        <Text dimColor>{`  debug stage ${stage}`}</Text>
        {facts.length > 0 && <Text dimColor>{facts.join(" \u00b7 ")}</Text>}
        {activeRunStartedAt && <ElapsedTime startedAt={activeRunStartedAt} />}
        {meta.length > 0 && <Text dimColor>{meta.join("  ")}</Text>}
        {follow && <Text color="yellow">follow</Text>}
        <FreshnessBadge connected={connected} lastServerMessageAt={lastServerMessageAt} />
      </Box>
      {issue.title && <Text>{issue.title}</Text>}
      {blocker && <Text color="yellow">{blocker}</Text>}
      {issue.statusNote && issue.statusNote !== blocker && (
        <Text dimColor wrap="wrap">{issue.statusNote}</Text>
      )}
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
            <Text dimColor>PatchRelay activity history.</Text>
            <Text dimColor>Runs, waits, and wake-ups are shown here in PatchRelay order.</Text>
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
