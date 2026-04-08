import { Box, Text } from "ink";

interface HelpBarProps {
  view: "overview" | "project";
}

export function HelpBar({ view }: HelpBarProps): React.JSX.Element {
  const text = view === "overview"
    ? "j/k: select project  Enter: open project  r: reconcile selected project  q: quit"
    : "j/k: select PR  Esc: overview  a: filter  r: reconcile project  d: dequeue PR  q: quit";

  return (
    <Box marginTop={1}>
      <Text dimColor>{text}</Text>
    </Box>
  );
}
