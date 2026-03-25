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

// ─── Compact Issue Sidebar (#4 split-pane) ───────────────────────

const SIDEBAR_STATE_COLORS: Record<string, string> = {
  delegated: "blue", preparing: "blue",
  implementing: "yellow", awaiting_input: "yellow",
  pr_open: "cyan", awaiting_review: "cyan",
  changes_requested: "magenta", repairing_ci: "magenta", repairing_queue: "magenta",
  awaiting_queue: "green", done: "green",
  failed: "red", escalated: "red",
};

function CompactSidebar({ issues, activeKey }: { issues: WatchIssue[]; activeKey: string | null }): React.JSX.Element {
  return (
    <Box flexDirection="column" width={28} borderStyle="single" borderColor="gray" paddingLeft={1} paddingRight={1}>
      <Text bold dimColor>Issues</Text>
      {issues.map((issue) => {
        const key = issue.issueKey ?? issue.projectId;
        const isCurrent = key === activeKey;
        const stateColor = SIDEBAR_STATE_COLORS[issue.factoryState] ?? "white";
        return (
          <Box key={key} gap={1}>
            <Text color={isCurrent ? "blueBright" : "white"} bold={isCurrent}>{isCurrent ? "\u25b8" : " "}</Text>
            <Text bold={isCurrent}>{key.padEnd(10)}</Text>
            <Text color={stateColor}>{issue.factoryState.slice(0, 12)}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

// ─── Issue Context Panel (#5) ────────────────────────────────────

const PRIORITY_LABELS: Record<number, { label: string; color: string }> = {
  0: { label: "none", color: "" },
  1: { label: "urgent", color: "red" },
  2: { label: "high", color: "yellow" },
  3: { label: "medium", color: "cyan" },
  4: { label: "low", color: "" },
};

function ContextPanel({ issue, ctx }: { issue: WatchIssue; ctx: WatchIssueContext }): React.JSX.Element {
  const parts: Array<{ label: string; value: string; color: string }> = [];

  if (ctx.priority != null && ctx.priority > 0) {
    const p = PRIORITY_LABELS[ctx.priority] ?? { label: String(ctx.priority), color: "" };
    parts.push({ label: "priority", value: p.label, color: p.color });
  }
  if (ctx.estimate != null) {
    parts.push({ label: "estimate", value: String(ctx.estimate), color: "" });
  }
  if (ctx.currentLinearState) {
    parts.push({ label: "linear", value: ctx.currentLinearState, color: "" });
  }
  if (issue.prNumber) {
    const prInfo = `#${issue.prNumber}${issue.prReviewState === "approved" ? " \u2713" : issue.prReviewState === "changes_requested" ? " \u2717" : ""}${issue.prCheckStatus ? ` ci:${issue.prCheckStatus}` : ""}`;
    const prColor = issue.prReviewState === "approved" ? "green" : issue.prReviewState === "changes_requested" ? "red" : "";
    parts.push({ label: "pr", value: prInfo, color: prColor });
  }
  if (ctx.runCount > 0) {
    parts.push({ label: "runs", value: String(ctx.runCount), color: "" });
  }
  const retries = [
    ctx.ciRepairAttempts > 0 ? `ci:${ctx.ciRepairAttempts}` : "",
    ctx.queueRepairAttempts > 0 ? `queue:${ctx.queueRepairAttempts}` : "",
    ctx.reviewFixAttempts > 0 ? `review:${ctx.reviewFixAttempts}` : "",
  ].filter(Boolean).join(" ");
  if (retries) {
    parts.push({ label: "retries", value: retries, color: "yellow" });
  }
  if (ctx.branchName) {
    parts.push({ label: "branch", value: ctx.branchName, color: "" });
  }

  const hasDescription = Boolean(ctx.description);

  return (
    <Box flexDirection="column">
      <Box gap={2} flexWrap="wrap">
        {parts.map((p) => (
          <Text key={p.label} dimColor>
            {p.label}: {p.color ? <Text color={p.color}>{p.value}</Text> : <Text dimColor>{p.value}</Text>}
          </Text>
        ))}
      </Box>
      {hasDescription && (
        <Text dimColor wrap="truncate-end">{ctx.description!.slice(0, 200)}{ctx.description!.length > 200 ? "\u2026" : ""}</Text>
      )}
    </Box>
  );
}

// ─── Detail Panel (right side of split) ──────────────────────────

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
        {issue.prNumber !== undefined && <Text dimColor>PR #{issue.prNumber}</Text>}
        {activeRunStartedAt && <ElapsedTime startedAt={activeRunStartedAt} />}
      </Box>
      {issue.title && <Text dimColor>{issue.title}</Text>}

      <Box gap={2}>
        {tokenUsage && (
          <Text dimColor>
            tokens: {formatTokens(tokenUsage.inputTokens)} in / {formatTokens(tokenUsage.outputTokens)} out
          </Text>
        )}
        {diffSummary && diffSummary.filesChanged > 0 && (
          <Text dimColor>
            diff: {diffSummary.filesChanged} file{diffSummary.filesChanged !== 1 ? "s" : ""}
            {" "}+{diffSummary.linesAdded} -{diffSummary.linesRemoved}
          </Text>
        )}
        {follow && <Text color="yellow">follow</Text>}
      </Box>

      {issueContext && <ContextPanel issue={issue} ctx={issueContext} />}

      {plan && plan.length > 0 && (
        <Box flexDirection="column">
          {plan.map((entry, i) => (
            <Box key={`plan-${i}`} gap={1}>
              <Text color={planStepColor(entry.status)}>[{planStepSymbol(entry.status)}]</Text>
              <Text>{entry.step}</Text>
            </Box>
          ))}
        </Box>
      )}

      <Text dimColor>{"\u2500".repeat(60)}</Text>
      <Timeline entries={timeline} follow={follow} />
    </Box>
  );
}

// ─── Main Detail View (split layout) ─────────────────────────────

export function IssueDetailView(props: IssueDetailViewProps): React.JSX.Element {
  const { allIssues, activeDetailKey, follow, ...detailProps } = props;
  const showSidebar = allIssues.length > 1;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" flexGrow={1}>
        {showSidebar && <CompactSidebar issues={allIssues} activeKey={activeDetailKey} />}
        <DetailPanel {...detailProps} follow={follow} />
      </Box>
      <Text dimColor>{"\u2500".repeat(72)}</Text>
      <HelpBar view="detail" follow={follow} />
    </Box>
  );
}
