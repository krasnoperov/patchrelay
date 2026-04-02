import { useMemo } from "react";
import { Box, Static, Text, useStdout } from "ink";
import type { TimelineEntry } from "./timeline-builder.ts";
import { buildTimelineRows } from "./timeline-presentation.ts";
import { TimelineRow } from "./TimelineRow.tsx";

interface TimelineProps {
  entries: TimelineEntry[];
  follow: boolean;
}

const ACTIVE_TAIL = 8;

export function Timeline({ entries, follow }: TimelineProps): React.JSX.Element {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const maxActive = Math.max(ACTIVE_TAIL, rows - 12);
  const displayRows = useMemo(() => buildTimelineRows(entries), [entries]);

  const splitIndex = useMemo(() => {
    if (!follow) return 0;
    return Math.max(0, displayRows.length - maxActive);
  }, [displayRows.length, follow, maxActive]);

  const finalized = displayRows.slice(0, splitIndex);
  const active = displayRows.slice(splitIndex);

  if (displayRows.length === 0) {
    return <Text dimColor>No timeline events yet.</Text>;
  }

  return (
    <Box flexDirection="column">
      {finalized.length > 0 && (
        <Static items={finalized}>
          {(entry) => <TimelineRow key={entry.id} entry={entry} />}
        </Static>
      )}
      {active.map((entry) => (
        <TimelineRow key={entry.id} entry={entry} />
      ))}
    </Box>
  );
}
