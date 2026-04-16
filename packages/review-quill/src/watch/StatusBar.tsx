import { Box, Text, useStdout } from "ink";
import type { ReviewQuillWatchSnapshot } from "../types.ts";
import { relativeTime, runtimeLabel, truncate } from "./format.ts";

interface StatusBarProps {
  snapshot: ReviewQuillWatchSnapshot | null;
  connected: boolean;
  filter: "active" | "all";
  lastSnapshotReceivedAt: number | null;
  compact?: boolean;
}

function freshnessLabel(connected: boolean, lastSnapshotReceivedAt: number | null): string {
  if (!connected) return "offline";
  if (!lastSnapshotReceivedAt) return "connecting";
  return `fresh ${relativeTime(new Date(lastSnapshotReceivedAt).toISOString())}`;
}

export function StatusBar({
  snapshot,
  connected,
  filter,
  lastSnapshotReceivedAt,
  compact = false,
}: StatusBarProps): React.JSX.Element {
  const { stdout } = useStdout();
  const width = stdout?.columns ?? 80;

  if (!snapshot) {
    const left = compact
      ? `review-quill · ${filter === "active" ? "active" : "all"}`
      : "review-quill";
    return (
      <Box justifyContent="space-between">
        <Text bold>{truncate(left, Math.max(1, width - 16))}</Text>
        <Text>{freshnessLabel(connected, lastSnapshotReceivedAt)}</Text>
      </Box>
    );
  }

  const left = [
    "review-quill",
    `${snapshot.summary.runningAttempts} active`,
    `${snapshot.summary.queuedAttempts} queued`,
    `${snapshot.summary.failedAttempts} failed`,
    "runner serial",
    `reconcile ${runtimeLabel(snapshot.runtime)}`,
    `last ${relativeTime(snapshot.runtime.lastReconcileCompletedAt ?? snapshot.runtime.lastReconcileStartedAt)}`,
    filter,
  ];
  const compactLeft = [
    "review-quill",
    `${snapshot.summary.runningAttempts}a`,
    `${snapshot.summary.queuedAttempts}q`,
    snapshot.summary.failedAttempts ? `${snapshot.summary.failedAttempts}f` : null,
    runtimeLabel(snapshot.runtime) === "running"
      ? "reconcile running"
      : `runner ${runtimeLabel(snapshot.runtime)}`,
    filter === "active" ? "active" : "all",
  ];

  return (
    <Box justifyContent="space-between">
      <Text bold>{truncate((compact ? compactLeft : left).join(" | "), Math.max(1, width - 16))}</Text>
      <Text>{freshnessLabel(connected, lastSnapshotReceivedAt)}</Text>
    </Box>
  );
}
