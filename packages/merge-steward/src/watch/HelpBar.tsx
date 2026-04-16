import { Box, Text, useStdout } from "ink";

interface HelpBarProps {
  view: "overview" | "project";
}

export function HelpBar({ view }: HelpBarProps): React.JSX.Element {
  const { stdout } = useStdout();
  const compact = (stdout?.columns ?? 80) < 80;
  const text = compact
    ? (
      view === "overview"
        ? "j/k select  Enter open  r refresh  q quit"
        : "j/k select  Esc overview  a filter  r refresh  d dequeue  q quit"
    )
    : view === "overview"
      ? "j/k: select project  Enter: open project  r: reconcile selected project  q: quit"
      : "j/k: select PR  Esc: overview  a: filter  r: reconcile project  d: dequeue PR  q: quit";

  return (
    <Box marginTop={1}>
      <Text dimColor>{text}</Text>
    </Box>
  );
}
