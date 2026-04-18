import { Box, Text } from "ink";

interface HelpBarProps {
  view: "list" | "detail";
}

export function HelpBar({ view }: HelpBarProps): React.JSX.Element {
  const text = view === "list"
    ? "↑↓ repo  enter detail  r reconcile  q quit"
    : "[ ] repo  ↑↓ scroll  g/G top/end  esc back  r reconcile  q quit";
  return (
    <Box marginTop={1}>
      <Text dimColor>{text}</Text>
    </Box>
  );
}
