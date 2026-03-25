import { Box, Text } from "ink";

interface HelpBarProps {
  view: "list" | "detail";
}

export function HelpBar({ view }: HelpBarProps): React.JSX.Element {
  return (
    <Box>
      <Text dimColor>
        {view === "list"
          ? "j/k: navigate  Enter: detail  Tab: filter  q: quit"
          : "Esc: back  q: quit"}
      </Text>
    </Box>
  );
}
