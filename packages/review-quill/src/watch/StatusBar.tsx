import { Box, Text, useStdout } from "ink";
import type { ReviewQuillWatchSnapshot } from "../types.ts";
import { relativeTime, runtimeLabel, truncate } from "./format.ts";

interface StatusBarProps {
  snapshot: ReviewQuillWatchSnapshot | null;
  connected: boolean;
  filter: "active" | "all";
  lastSnapshotReceivedAt: number | null;
}

function freshnessLabel(connected: boolean, lastSnapshotReceivedAt: number | null): string {
  if (!connected) return "offline";
  if (!lastSnapshotReceivedAt) return "connecting";
  return `fresh ${relativeTime(new Date(lastSnapshotReceivedAt).toISOString())}`;
}

export function StatusBar({ snapshot, connected, filter, lastSnapshotReceivedAt }: StatusBarProps): React.JSX.Element {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;

  if (!snapshot) {
    const left = "review-quill";
    return (
      <Box justifyContent="space-between">
        <Text bold>{truncate(left, Math.max(1, width - 16))}</Text>
        <Text>{freshnessLabel(connected, lastSnapshotReceivedAt)}</Text>
      </Box>
    );
  }

  const left = [
    "review-quill",
    `${snapshot.summary.runningAttempts} running`,
    `${snapshot.summary.queuedAttempts} queued`,
    `${snapshot.summary.failedAttempts} failed`,
    `reconcile ${runtimeLabel(snapshot.runtime)}`,
    `last ${relativeTime(snapshot.runtime.lastReconcileCompletedAt ?? snapshot.runtime.lastReconcileStartedAt)}`,
    filter,
  ].join(" | ");

  return (
    <Box justifyContent="space-between">
      <Text bold>{truncate(left, Math.max(1, width - 16))}</Text>
      <Text>{freshnessLabel(connected, lastSnapshotReceivedAt)}</Text>
    </Box>
  );
}
