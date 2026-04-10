import { Box, Text } from "ink";
import type { WatchView, DetailTab } from "./watch-state.ts";

interface HelpBarProps {
  view: WatchView;
  follow?: boolean | undefined;
  detailTab?: DetailTab | undefined;
}

export function buildHelpBarText(view: WatchView, follow?: boolean, detailTab?: DetailTab): string {
  if (view === "detail") {
    const tabHint = detailTab === "history" ? "t: timeline" : "h: history";
    return [
      tabHint,
      "j/k: scroll",
      "Ctrl-U/Ctrl-D: page",
      "[ ]: issue",
      "Home/End: jump",
      `f: live ${follow ? "on" : "off"}`,
      "p: prompt",
      "y/c/o: copy",
      "v/e: transcript",
      "s: stop",
      "r: retry",
    ]
      .filter(Boolean)
      .join("  ");
  }
  return "Enter: detail  Tab: filter";
}

export function HelpBar({ view, follow, detailTab }: HelpBarProps): React.JSX.Element {
  const text = buildHelpBarText(view, follow, detailTab);
  return (
    <Box>
      <Text dimColor>{text}</Text>
    </Box>
  );
}
