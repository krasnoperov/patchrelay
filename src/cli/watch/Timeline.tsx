import { Box, Text } from "ink";
import type { TimelineEntry } from "./timeline-builder.ts";
import { TimelineRow } from "./TimelineRow.tsx";

interface TimelineProps {
  entries: TimelineEntry[];
  follow: boolean;
}

const FOLLOW_TAIL_SIZE = 20;

export function Timeline({ entries, follow }: TimelineProps): React.JSX.Element {
  const visible = follow && entries.length > FOLLOW_TAIL_SIZE
    ? entries.slice(-FOLLOW_TAIL_SIZE)
    : entries;
  const skipped = entries.length - visible.length;

  if (entries.length === 0) {
    return <Text dimColor>No timeline events yet.</Text>;
  }

  return (
    <Box flexDirection="column">
      {skipped > 0 && <Text dimColor>  ... {skipped} earlier events</Text>}
      {visible.map((entry) => (
        <TimelineRow key={entry.id} entry={entry} />
      ))}
    </Box>
  );
}
