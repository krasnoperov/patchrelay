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
    text = [
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
  } else if (view === "feed") {
    text = "Legacy feed view  Esc: back";
  } else {
    text = "Enter: detail  Tab: filter";
  }
  return (
    <Box>
      <Text dimColor>{text}</Text>
    </Box>
  );
}
