import { Box, Text } from "ink";

interface HelpBarProps {
  view: "list" | "detail";
  compact?: boolean;
}

export function HelpBar({ view, compact = false }: HelpBarProps): React.JSX.Element {
  const text = compact
    ? view === "list"
      ? "j/k enter detail a toggle active/all r reconcile q quit"
      : "esc/backspace list j/k r reconcile q quit"
    : view === "list"
      ? "j/k or arrows move  enter detail  a toggle active/all  r reconcile  q quit"
      : "esc/backspace list  j/k or arrows move  r reconcile  q quit";
  return (
    <Box marginTop={1}>
      <Text dimColor>{text}</Text>
    </Box>
  );
}
