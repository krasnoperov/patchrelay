import { Box, Text } from "ink";
import type { WatchFilter } from "./watch-state.ts";
import { FreshnessBadge } from "./FreshnessBadge.tsx";

interface StatusBarProps {
  filter: WatchFilter;
  connected: boolean;
  lastServerMessageAt: number | null;
  frozen: boolean;
}

const FILTER_LABEL: Record<WatchFilter, string> = {
  "all": "all",
  "active": "active",
  "non-done": "in progress",
};

export function StatusBar({ filter, connected, lastServerMessageAt, frozen }: StatusBarProps): React.JSX.Element {
  return (
    <Box justifyContent="space-between">
      <Box gap={1}>
        <Text bold>patchrelay</Text>
        <Text dimColor>[{FILTER_LABEL[filter]}]</Text>
        {frozen ? <Text color="magenta">frozen</Text> : null}
      </Box>
      <FreshnessBadge connected={connected} lastServerMessageAt={lastServerMessageAt} />
    </Box>
  );
}
