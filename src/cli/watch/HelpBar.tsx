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
    text = [tabHint, "Esc: back", `f: follow ${follow ? "on" : "off"}`, "p: prompt", "s: stop", "r: retry"]
      .filter(Boolean)
      .join("  ");
  } else if (view === "feed") {
    text = "Esc: back";
  } else {
    text = "Enter: detail  F: feed  Tab: filter";
  }
  return (
    <Box>
      <Text dimColor>{text}</Text>
    </Box>
  );
}
