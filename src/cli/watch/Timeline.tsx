import { useMemo } from "react";
import { Box, Static, Text, useStdout } from "ink";
import type { TimelineEntry } from "./timeline-builder.ts";
import { TimelineRow } from "./TimelineRow.tsx";

interface TimelineProps {
  entries: TimelineEntry[];
  follow: boolean;
}

const ACTIVE_TAIL = 8;

function isFinalized(entry: TimelineEntry): boolean {
  if (entry.kind === "item" && entry.item?.status === "inProgress") return false;
  if (entry.kind === "run-start") return false; // keep run-start in active area until run ends
  return true;
}

export function Timeline({ entries, follow }: TimelineProps): React.JSX.Element {
  const { stdout } = useStdout();
  const rows = stdout?.rows ?? 24;
  const maxActive = Math.max(ACTIVE_TAIL, rows - 12);

  // Split: finalized entries go to Static (terminal scrollback), active entries re-render
  const splitIndex = useMemo(() => {
    if (!follow) return 0; // follow OFF: everything in active area (re-renders)
    // Find the boundary: keep the last maxActive entries in the active area
    return Math.max(0, entries.length - maxActive);
  }, [entries.length, follow, maxActive]);

  const finalized = entries.slice(0, splitIndex);
  const active = entries.slice(splitIndex);

  if (entries.length === 0) {
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
