import { Box, Text } from "ink";

interface HelpBarProps {
  view: "list" | "detail";
}

export function HelpBar({ view }: HelpBarProps): React.JSX.Element {
  const text = view === "list"
    ? "j/k: navigate  Enter: detail  a: filter  r: reconcile  d: dequeue  q: quit"
    : "j/k: prev/next  Esc: list  r: reconcile  d: dequeue  q: quit";

  return (
    <Box marginTop={1}>
      <Text dimColor>{text}</Text>
    </Box>
  );
}
