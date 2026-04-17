import { Box, Text } from "ink";
import { relativeTime } from "./format.ts";

interface StatusBarProps {
  connected: boolean;
  lastSnapshotReceivedAt: number | null;
}

function freshnessLabel(connected: boolean, lastSnapshotReceivedAt: number | null): string {
  if (!connected) return "offline";
  if (!lastSnapshotReceivedAt) return "connecting";
  return `fresh ${relativeTime(new Date(lastSnapshotReceivedAt).toISOString())}`;
}

export function StatusBar({ connected, lastSnapshotReceivedAt }: StatusBarProps): React.JSX.Element {
  return (
    <Box justifyContent="space-between">
      <Text bold>review-quill</Text>
      <Text dimColor>{freshnessLabel(connected, lastSnapshotReceivedAt)}</Text>
    </Box>
  );
}
