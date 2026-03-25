import { Box, Text } from "ink";
import type { WatchView } from "./watch-state.ts";

interface HelpBarProps {
  view: WatchView;
  follow?: boolean | undefined;
}

const HELP_TEXT: Record<WatchView, string> = {
  list: "j/k: navigate  Enter: detail  F: feed  Tab: filter  q: quit",
  detail: "",
  feed: "Esc: list  q: quit",
};

export function HelpBar({ view, follow }: HelpBarProps): React.JSX.Element {
  const text = view === "detail"
    ? `j/k: prev/next  Esc: list  f: follow ${follow ? "on" : "off"}  r: retry  q: quit`
    : HELP_TEXT[view];
  return (
    <Box>
      <Text dimColor>{text}</Text>
    </Box>
  );
}
