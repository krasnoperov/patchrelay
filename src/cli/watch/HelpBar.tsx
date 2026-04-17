import { Box, Text } from "ink";
import type { WatchView } from "./watch-state.ts";

interface HelpBarProps {
  view: WatchView;
  follow?: boolean | undefined;
}

export function buildHelpBarText(view: WatchView, follow?: boolean): string {
  if (view === "log") {
    return [
      "j/k scroll",
      "[ ] turn",
      `f live ${follow ? "on" : "off"}`,
      "y/c/o copy",
      "e export",
      "v pager",
      "esc back",
      "q quit",
    ].join("  ");
  }
  if (view === "detail") {
    return [
      "j/k scroll",
      "[ ] issue",
      "l log",
      "p prompt",
      "r retry",
      "s stop",
      "esc list",
      "q quit",
    ].join("  ");
  }
  return "↑↓ select  enter detail  a filter  x pause  q quit";
}

export function HelpBar({ view, follow }: HelpBarProps): React.JSX.Element {
  return (
    <Box>
      <Text dimColor>{buildHelpBarText(view, follow)}</Text>
    </Box>
  );
}
