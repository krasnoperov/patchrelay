import { Box, Text, useStdout } from "ink";
import type { TimelineEntry } from "./timeline-builder.ts";
import { TimelineRow } from "./TimelineRow.tsx";

interface TimelineProps {
  entries: TimelineEntry[];
  follow: boolean;
}

const DETAIL_CHROME_ROWS = 10;

export function Timeline({ entries, follow }: TimelineProps): React.JSX.Element {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const maxVisible = Math.max(5, rows - DETAIL_CHROME_ROWS);

  const tailSize = follow ? Math.min(maxVisible, entries.length) : Math.min(maxVisible, entries.length);
  const visible = entries.length > tailSize ? entries.slice(-tailSize) : entries;
  const skipped = entries.length - visible.length;

  if (entries.length === 0) {
    return <Text dimColor>No timeline events yet.</Text>;
  }

  return (
    <Box flexDirection="column">
      {skipped > 0 && <Text dimColor>  ... {skipped} earlier</Text>}
      {visible.map((entry) => (
        <TimelineRow key={entry.id} entry={entry} />
      ))}
    </Box>
  );
}
