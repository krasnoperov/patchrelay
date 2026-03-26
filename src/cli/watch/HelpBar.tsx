import { Box, Text } from "ink";
import type { WatchView, DetailTab } from "./watch-state.ts";

interface HelpBarProps {
  view: WatchView;
  follow?: boolean | undefined;
  detailTab?: DetailTab | undefined;
}

const HELP_TEXT: Record<WatchView, string> = {
  list: "j/k: navigate  Enter: detail  F: feed  Tab: filter  q: quit",
  detail: "",
  feed: "Esc: list  q: quit",
};

export function HelpBar({ view, follow, detailTab }: HelpBarProps): React.JSX.Element {
  let text: string;
  if (view === "detail") {
    const tabHint = detailTab === "history" ? "t: timeline" : "h: history";
    text = `${tabHint}  j/k: prev/next  Esc: list  f: follow ${follow ? "on" : "off"}  p: prompt  s: stop  r: retry  q: quit`;
  } else {
    text = HELP_TEXT[view];
  }
  return (
    <Box>
      <Text dimColor>{text}</Text>
    </Box>
  );
}
