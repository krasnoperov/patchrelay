import { Box, Text, useStdout } from "ink";
import type { QueueWatchSnapshot } from "../types.ts";
import { formatDuration, relativeTime, runtimeLabel, summarizeQueueBlock, truncate } from "./format.ts";
import { FreshnessBadge } from "./FreshnessBadge.tsx";

interface StatusBarProps {
  snapshot: QueueWatchSnapshot | null;
  connected: boolean;
  filter: "active" | "all";
  lastSnapshotReceivedAt: number | null;
  expectedFreshMs: number;
}

const TERMINAL = new Set(["merged", "evicted", "dequeued"]);

export function StatusBar({
  snapshot,
  connected,
  filter,
  lastSnapshotReceivedAt,
  expectedFreshMs,
}: StatusBarProps): React.JSX.Element {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;

  if (!snapshot) {
    const left = "merge-steward";
    const availableLeft = Math.max(1, width - 28);
    return (
      <Box justifyContent="space-between">
        <Text bold>{truncate(left, availableLeft)}</Text>
        <FreshnessBadge
          connected={connected}
          lastSnapshotReceivedAt={lastSnapshotReceivedAt}
          expectedFreshMs={expectedFreshMs}
        />
      </Box>
    );
  }

  const { summary, runtime } = snapshot;
  const queueBlockLabel = summarizeQueueBlock(snapshot.queueBlock);
  const activeEntries = snapshot.entries.filter((e) => !TERMINAL.has(e.status));
  const avgWaitMs = activeEntries.length > 0
    ? activeEntries.reduce((sum, e) => sum + (Date.now() - new Date(e.enqueuedAt).getTime()), 0) / activeEntries.length
    : 0;
  const queueHealth = queueBlockLabel
    ? `paused on broken main`
    : summary.headPrNumber !== null
      ? `head #${summary.headPrNumber} active`
      : "queue idle";
  const leftParts = [
    snapshot.repoFullName,
    `base:${snapshot.baseBranch}`,
    `${summary.total} entries ${summary.active} active`,
    queueHealth,
    queueBlockLabel ?? null,
    avgWaitMs > 0 ? `wait ~${formatDuration(avgWaitMs)}` : null,
    `last tick ${runtimeLabel(runtime)} ${relativeTime(runtime.lastTickCompletedAt ?? runtime.lastTickStartedAt)}`,
    filter,
  ].filter(Boolean).join(" | ");
  const availableLeft = Math.max(1, width - 28);

  return (
    <Box justifyContent="space-between">
      <Text bold>{truncate(leftParts, availableLeft)}</Text>
      <FreshnessBadge
        connected={connected}
        lastSnapshotReceivedAt={lastSnapshotReceivedAt}
        expectedFreshMs={expectedFreshMs}
      />
    </Box>
  );
}
