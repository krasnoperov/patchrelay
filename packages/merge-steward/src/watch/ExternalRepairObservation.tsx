import { Box, Text } from "ink";
import type { ObservationLine } from "./state-visualization.ts";

interface ExternalRepairObservationProps {
  observations: ObservationLine[];
}

function toneColor(tone: ObservationLine["tone"]): string {
  switch (tone) {
    case "success":
      return "green";
    case "warn":
      return "yellow";
    case "info":
      return "cyan";
  }
}

export function ExternalRepairObservation({ observations }: ExternalRepairObservationProps): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>External Repair</Text>
      {observations.map((observation, index) => (
        <Box key={`external-repair-${index}`} gap={1}>
          <Text color={toneColor(observation.tone)}>-</Text>
          <Text>{observation.text}</Text>
        </Box>
      ))}
    </Box>
  );
}
