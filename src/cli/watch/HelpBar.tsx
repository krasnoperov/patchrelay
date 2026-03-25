import { Box, Text } from "ink";

interface HelpBarProps {
  view: "list" | "detail";
  follow?: boolean | undefined;
}

export function HelpBar({ view, follow }: HelpBarProps): React.JSX.Element {
  return (
    <Box>
      <Text dimColor>
        {view === "list"
          ? "j/k: navigate  Enter: detail  Tab: filter  q: quit"
          : `Esc: back  f: follow ${follow ? "on" : "off"}  r: retry  q: quit`}
      </Text>
    </Box>
  );
}
