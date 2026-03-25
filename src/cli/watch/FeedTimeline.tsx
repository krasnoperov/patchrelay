import { Box, Text } from "ink";
import type { WatchFeedEntry } from "./watch-state.ts";

interface FeedTimelineProps {
  entries: WatchFeedEntry[];
  maxEntries?: number | undefined;
}

const KIND_COLORS: Record<string, string> = {
  stage: "cyan",
  turn: "yellow",
  github: "green",
  webhook: "blue",
  workflow: "magenta",
  hook: "white",
};

function kindColor(kind: string): string {
  return KIND_COLORS[kind] ?? "white";
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour12: false });
}

export function FeedTimeline({ entries, maxEntries }: FeedTimelineProps): React.JSX.Element {
  const visible = maxEntries ? entries.slice(-maxEntries) : entries;

  if (visible.length === 0) {
    return <Text dimColor>No events yet.</Text>;
  }

  return (
    <Box flexDirection="column">
      {visible.map((entry, i) => (
        <Box key={`feed-${i}`} gap={1}>
          <Text dimColor>{formatTime(entry.at)}</Text>
          <Text color={kindColor(entry.kind)}>{(entry.status ?? entry.kind).padEnd(15)}</Text>
          <Text>{entry.summary}</Text>
        </Box>
      ))}
    </Box>
  );
}
