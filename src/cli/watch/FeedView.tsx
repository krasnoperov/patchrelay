import { Box, Text } from "ink";
import type { OperatorFeedEvent } from "../../operator-feed.ts";
import { HelpBar } from "./HelpBar.tsx";

interface FeedViewProps {
  events: OperatorFeedEvent[];
  connected: boolean;
}

const TAIL_SIZE = 30;

const LEVEL_COLORS: Record<string, string> = {
  info: "white",
  warn: "yellow",
  error: "red",
};

const KIND_COLORS: Record<string, string> = {
  stage: "cyan",
  turn: "yellow",
  github: "green",
  webhook: "blue",
  agent: "magenta",
  service: "white",
  workflow: "cyan",
  linear: "blue",
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour12: false });
}

function FeedEventRow({ event }: { event: OperatorFeedEvent }): React.JSX.Element {
  const kindColor = KIND_COLORS[event.kind] ?? "white";
  const levelColor = LEVEL_COLORS[event.level] ?? "white";
  return (
    <Box gap={1}>
      <Text dimColor>{formatTime(event.at)}</Text>
      <Text color={kindColor}>{event.kind.padEnd(10)}</Text>
      {event.issueKey && <Text bold>{event.issueKey.padEnd(10)}</Text>}
      {event.stage && <Text color="cyan">{event.stage.padEnd(16)}</Text>}
      <Text color={levelColor}>{event.summary}</Text>
    </Box>
  );
}

export function FeedView({ events, connected }: FeedViewProps): React.JSX.Element {
  const visible = events.length > TAIL_SIZE ? events.slice(-TAIL_SIZE) : events;
  const skipped = events.length - visible.length;

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold>Operator Feed</Text>
        <Text color={connected ? "green" : "red"}>
          {connected ? "\u25cf connected" : "\u25cb disconnected"}
        </Text>
      </Box>
      <Text dimColor>{"\u2500".repeat(72)}</Text>
      {events.length === 0 ? (
        <Text dimColor>No feed events yet.</Text>
      ) : (
        <Box flexDirection="column">
          {skipped > 0 && <Text dimColor>  ... {skipped} earlier events</Text>}
          {visible.map((event) => (
            <FeedEventRow key={event.id} event={event} />
          ))}
        </Box>
      )}
      <Text dimColor>{"\u2500".repeat(72)}</Text>
      <HelpBar view="feed" />
    </Box>
  );
}
