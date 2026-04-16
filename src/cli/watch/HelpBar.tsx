import { Box, Text } from "ink";
import type { WatchView, DetailTab } from "./watch-state.ts";

interface HelpBarProps {
  view: WatchView;
  follow?: boolean | undefined;
  detailTab?: DetailTab | undefined;
  compact?: boolean;
}

export function buildHelpBarText(view: WatchView, follow?: boolean, detailTab?: DetailTab, compact = false): string {
  if (view === "detail") {
    const tabHint = detailTab === "history" ? "t: timeline" : "h: history";
    if (compact) {
      return "j/k: scroll  f: live  p: prompt  y/c/o: copy  r: retry  s: stop  esc: list  q: quit";
    }
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
  if (compact) {
    return "Enter: detail  Tab: filter  x: pause  q: quit";
  }
  return "Enter: detail  Tab: filter";
}

export function HelpBar({ view, follow, detailTab, compact = false }: HelpBarProps): React.JSX.Element {
  const text = buildHelpBarText(view, follow, detailTab, compact);
  return (
    <Box>
      <Text dimColor>{text}</Text>
    </Box>
  );
}
