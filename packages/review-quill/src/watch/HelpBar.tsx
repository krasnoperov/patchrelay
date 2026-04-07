import { Box, Text } from "ink";

interface HelpBarProps {
  view: "list" | "detail";
}

export function HelpBar({ view }: HelpBarProps): React.JSX.Element {
  return (
    <Box marginTop={1}>
      <Text dimColor>
        {view === "list"
          ? "j/k or arrows move  enter detail  a toggle active/all  r reconcile  q quit"
          : "esc/backspace list  j/k or arrows move  r reconcile  q quit"}
      </Text>
    </Box>
  );
}
