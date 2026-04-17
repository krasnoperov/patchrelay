import { Box, Text } from "ink";
import { FreshnessBadge } from "./FreshnessBadge.tsx";

interface StatusBarProps {
  connected: boolean;
  lastSnapshotReceivedAt: number | null;
  gatewayError: string | null;
}

const EXPECTED_FRESH_MS = 3_000;

export function StatusBar({ connected, lastSnapshotReceivedAt, gatewayError }: StatusBarProps): React.JSX.Element {
  return (
    <Box justifyContent="space-between">
      <Text bold>merge-steward</Text>
      <FreshnessBadge
        connected={connected}
        lastSnapshotReceivedAt={lastSnapshotReceivedAt}
        expectedFreshMs={EXPECTED_FRESH_MS}
        gatewayError={gatewayError}
      />
    </Box>
  );
}
