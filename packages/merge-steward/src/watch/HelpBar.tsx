import { Box, Text } from "ink";

interface HelpBarProps {
  view: "list" | "detail";
}

export function HelpBar({ view }: HelpBarProps): React.JSX.Element {
  const text = view === "list"
    ? "↑↓ switch repo  enter detail  r reconcile  q quit"
    : "↑↓ switch repo  esc back  r reconcile  q quit";
  return (
    <Box marginTop={1}>
      <Text dimColor>{text}</Text>
    </Box>
  );
}
