import { useEffect, useReducer } from "react";
import { Box, Text } from "ink";
import type { TimelineEntry } from "./timeline-builder.ts";
import type { WatchDiffSummary, WatchIssue, WatchIssueContext, WatchTokenUsage } from "./watch-state.ts";
import { Timeline } from "./Timeline.tsx";
import { HelpBar } from "./HelpBar.tsx";

interface IssueDetailViewProps {
  issue: WatchIssue | undefined;
  timeline: TimelineEntry[];
  follow: boolean;
  activeRunStartedAt: string | null;
  tokenUsage: WatchTokenUsage | null;
  diffSummary: WatchDiffSummary | null;
  plan: Array<{ step: string; status: string }> | null;
  issueContext: WatchIssueContext | null;
  allIssues: WatchIssue[];
  activeDetailKey: string | null;
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

function planStepSymbol(status: string): string {
  if (status === "completed") return "\u2713";
  if (status === "inProgress") return "\u25b8";
  return " ";
}

function planStepColor(status: string): string {
  if (status === "completed") return "green";
  if (status === "inProgress") return "yellow";
  return "white";
}

const SIDEBAR_STATE_COLORS: Record<string, string> = {
  delegated: "blue", preparing: "blue",
  implementing: "yellow", awaiting_input: "yellow",
  pr_open: "cyan",
  changes_requested: "magenta", repairing_ci: "magenta", repairing_queue: "magenta",
  awaiting_queue: "green", done: "green",
  failed: "red", escalated: "red",
};

function CompactSidebar({ issues, activeKey }: { issues: WatchIssue[]; activeKey: string | null }): React.JSX.Element {
  return (
    <Box flexDirection="column" width={24} paddingRight={1}>
      {issues.map((issue) => {
        const key = issue.issueKey ?? issue.projectId;
        const isCurrent = key === activeKey;
        const sc = SIDEBAR_STATE_COLORS[issue.factoryState] ?? "white";
        return (
          <Box key={key} gap={1}>
            <Text color={isCurrent ? "blueBright" : "white"} bold={isCurrent}>{isCurrent ? "\u25b8" : " "}</Text>
            <Text bold={isCurrent}>{key.padEnd(9)}</Text>
            <Text color={sc}>{issue.factoryState.slice(0, 10)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

const PRIORITY_LABELS: Record<number, { label: string; color: string }> = {
  1: { label: "urgent", color: "red" },
  2: { label: "high", color: "yellow" },
  3: { label: "medium", color: "cyan" },
  4: { label: "low", color: "" },
};

function ContextPanel({ issue, ctx }: { issue: WatchIssue; ctx: WatchIssueContext }): React.JSX.Element {
  const parts: string[] = [];
  if (ctx.priority != null && ctx.priority > 0) {
    const p = PRIORITY_LABELS[ctx.priority];
    parts.push(p ? `${p.label}` : `p${ctx.priority}`);
  }
  if (issue.prNumber) {
    let pr = `#${issue.prNumber}`;
    if (issue.prReviewState === "approved") pr += " \u2713";
    else if (issue.prReviewState === "changes_requested") pr += " \u2717";
    parts.push(pr);
  }
  if (ctx.runCount > 0) parts.push(`${ctx.runCount} runs`);
  const retries = [
    ctx.ciRepairAttempts > 0 ? `ci:${ctx.ciRepairAttempts}` : "",
    ctx.queueRepairAttempts > 0 ? `q:${ctx.queueRepairAttempts}` : "",
    ctx.reviewFixAttempts > 0 ? `rev:${ctx.reviewFixAttempts}` : "",
  ].filter(Boolean).join(" ");
  if (retries) parts.push(retries);

  return (
    <Box flexDirection="column">
      {parts.length > 0 && <Text dimColor>{parts.join("  ")}</Text>}
      {ctx.description && (
        <Text dimColor wrap="truncate-end">{ctx.description.slice(0, 160)}{ctx.description.length > 160 ? "\u2026" : ""}</Text>
      )}
    </Box>
  );
}

function DetailPanel({
  issue, timeline, follow, activeRunStartedAt, tokenUsage, diffSummary, plan, issueContext,
}: Omit<IssueDetailViewProps, "allIssues" | "activeDetailKey">): React.JSX.Element {
  if (!issue) {
    return <Text color="red">Issue not found.</Text>;
  }

  const key = issue.issueKey ?? issue.projectId;

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box gap={2}>
        <Text bold>{key}</Text>
        <Text color="cyan">{issue.factoryState}</Text>
        {issue.activeRunType && <Text color="yellow">{issue.activeRunType}</Text>}
        {issue.prNumber !== undefined && <Text dimColor>#{issue.prNumber}</Text>}
        {activeRunStartedAt && <ElapsedTime startedAt={activeRunStartedAt} />}
      </Box>
      {issue.title && <Text>{issue.title}</Text>}

      {(tokenUsage || (diffSummary && diffSummary.filesChanged > 0)) && (
        <Box gap={2}>
          {tokenUsage && <Text dimColor>{formatTokens(tokenUsage.inputTokens)} in / {formatTokens(tokenUsage.outputTokens)} out</Text>}
          {diffSummary && diffSummary.filesChanged > 0 && (
            <Text dimColor>{diffSummary.filesChanged}f +{diffSummary.linesAdded} -{diffSummary.linesRemoved}</Text>
          )}
          {follow && <Text color="yellow">follow</Text>}
        </Box>
      )}

      {issueContext && <ContextPanel issue={issue} ctx={issueContext} />}

      {plan && plan.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
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
    </Box>
  );
}

export function IssueDetailView(props: IssueDetailViewProps): React.JSX.Element {
  const { allIssues, activeDetailKey, follow, ...detailProps } = props;
  const showSidebar = allIssues.length > 1;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexGrow={1}>
        {showSidebar && <CompactSidebar issues={allIssues} activeKey={activeDetailKey} />}
        <DetailPanel {...detailProps} follow={follow} />
      </Box>
      <Box marginTop={1}>
        <HelpBar view="detail" follow={follow} />
      </Box>
    </Box>
  );
}
