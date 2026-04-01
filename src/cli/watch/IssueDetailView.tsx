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
