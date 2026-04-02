import { Box, Text } from "ink";
import type { WatchView, DetailTab } from "./watch-state.ts";

interface HelpBarProps {
  view: WatchView;
  follow?: boolean | undefined;
  detailTab?: DetailTab | undefined;
}

export function HelpBar({ view, follow, detailTab }: HelpBarProps): React.JSX.Element {
  let text: string;
  if (view === "detail") {
    const tabHint = detailTab === "history" ? "t: timeline" : "h: history";
    text = [tabHint, "Esc: list", `f: follow ${follow ? "on" : "off"}`, "p: prompt", "s: stop", "r: retry", "q: quit"]
      .filter(Boolean)
      .join("  ");
  } else if (view === "feed") {
    text = "Esc: list  q: quit";
  } else {
    text = "Enter: detail  F: feed  Tab: filter  q: quit";
  }
  return (
    <Box>
      <Text dimColor>{text}</Text>
    </Box>
  );
}
