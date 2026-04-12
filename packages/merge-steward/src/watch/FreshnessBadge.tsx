import { useEffect, useReducer } from "react";
import { Text } from "ink";
import { describeSnapshotFreshness } from "./freshness.ts";

interface FreshnessBadgeProps {
  connected: boolean;
  lastSnapshotReceivedAt: number | null;
  expectedFreshMs: number;
  gatewayError?: string | null;
}

export function FreshnessBadge({
  connected,
  lastSnapshotReceivedAt,
  expectedFreshMs,
  gatewayError,
}: FreshnessBadgeProps): React.JSX.Element {
  const [, tick] = useReducer((value: number) => value + 1, 0);

  useEffect(() => {
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, []);

  const freshness = describeSnapshotFreshness(connected, lastSnapshotReceivedAt, expectedFreshMs, gatewayError);
  return <Text color={freshness.color}>{freshness.label}</Text>;
}
