import { useEffect, useReducer } from "react";
import { Text } from "ink";
import { describePatchRelayFreshness } from "./freshness.ts";

interface FreshnessBadgeProps {
  connected: boolean;
  lastServerMessageAt: number | null;
}

export function FreshnessBadge({ connected, lastServerMessageAt }: FreshnessBadgeProps): React.JSX.Element {
  const [, tick] = useReducer((value: number) => value + 1, 0);

  useEffect(() => {
    const id = setInterval(tick, 5_000);
    return () => clearInterval(id);
  }, []);

  const freshness = describePatchRelayFreshness(connected, lastServerMessageAt);
  return <Text color={freshness.color}>{freshness.label}</Text>;
}
