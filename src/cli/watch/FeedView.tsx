import { Box, Text } from "ink";
import type { OperatorFeedEvent } from "../../operator-feed.ts";
import { HelpBar } from "./HelpBar.tsx";

interface FeedViewProps {
  events: OperatorFeedEvent[];
  connected: boolean;
}

const TAIL_SIZE = 30;

const KIND_COLORS: Record<string, string> = {
  stage: "cyan",
  turn: "yellow",
  github: "green",
  webhook: "blue",
  agent: "magenta",
  service: "white",
  workflow: "cyan",
  linear: "blue",
  comment: "cyan",
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour12: false });
}

function FeedEventRow({ event }: { event: OperatorFeedEvent }): React.JSX.Element {
  const kindColor = KIND_COLORS[event.kind] ?? "white";
  return (
    <Box>
      <Text dimColor>{formatTime(event.at)} </Text>
      <Text color={kindColor}>{(event.status ?? event.kind).padEnd(14)}</Text>
      {event.issueKey && <Text bold>{` ${event.issueKey.padEnd(9)}`}</Text>}
      <Text> {event.summary}</Text>
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
      <Box marginTop={1} flexDirection="column">
        {events.length === 0 ? (
          <Text dimColor>No feed events yet.</Text>
        ) : (
          <>
            {skipped > 0 && <Text dimColor>  ... {skipped} earlier</Text>}
            {visible.map((event) => (
              <FeedEventRow key={event.id} event={event} />
            ))}
          </>
        )}
      </Box>
      <Box marginTop={1}>
        <HelpBar view="feed" />
      </Box>
    </Box>
  );
}
