import { Box, Text, useStdout } from "ink";
import type { QueueWatchSnapshot } from "../types.ts";
import { relativeTime, runtimeLabel, truncate } from "./format.ts";
import { FreshnessBadge } from "./FreshnessBadge.tsx";

interface StatusBarProps {
  snapshot: QueueWatchSnapshot | null;
  connected: boolean;
  filter: "active" | "all";
  lastSnapshotReceivedAt: number | null;
  expectedFreshMs: number;
}

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
  const leftParts = [
    snapshot.repoFullName,
    `base:${snapshot.baseBranch}`,
    `${summary.active} active`,
    summary.queued > 0 ? `${summary.queued} queued` : null,
    summary.preparingHead > 0 ? `${summary.preparingHead} prep` : null,
    summary.validating > 0 ? `${summary.validating} validating` : null,
    summary.merging > 0 ? `${summary.merging} merging` : null,
    summary.evicted > 0 ? `${summary.evicted} evicted` : null,
    summary.merged > 0 ? `${summary.merged} merged` : null,
    filter,
    `tick ${runtimeLabel(runtime)}`,
    relativeTime(runtime.lastTickCompletedAt ?? runtime.lastTickStartedAt),
    summary.headPrNumber !== null ? `head #${summary.headPrNumber}` : null,
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
