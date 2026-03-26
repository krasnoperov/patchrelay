import { Box, Text } from "ink";
import type { TimelineItemPayload } from "./watch-state.ts";

interface ItemLineProps {
  item: TimelineItemPayload;
  isLast: boolean;
}

const STATUS_SYMBOL: Record<string, string> = {
  completed: "\u2713",
  failed: "\u2717",
  declined: "\u2717",
  inProgress: "\u25cf",
};

function statusChar(status: string): string {
  return STATUS_SYMBOL[status] ?? " ";
}

function statusColor(status: string): string {
  if (status === "completed") return "green";
  if (status === "failed" || status === "declined") return "red";
  if (status === "inProgress") return "yellow";
  return "white";
}

function truncate(text: string, max: number): string {
  const line = text.replace(/\n/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

function renderAgentMessage(item: TimelineItemPayload): React.JSX.Element {
  return (
    <Text>
      <Text dimColor>message: </Text>
      <Text wrap="wrap">{item.text ?? ""}</Text>
    </Text>
  );
}

function cleanCommand(raw: string): string {
  // Strip /bin/bash -lc '...' wrapper — show the inner command
  const bashMatch = raw.match(/^\/bin\/(?:ba)?sh\s+-\w*c\s+['"](.+?)['"]$/s);
  if (bashMatch?.[1]) return bashMatch[1];
  // Strip /bin/bash -lc "..." (double quotes)
  const bashMatch2 = raw.match(/^\/bin\/(?:ba)?sh\s+-\w*c\s+"(.+?)"$/s);
  if (bashMatch2?.[1]) return bashMatch2[1];
  return raw;
}

function renderCommand(item: TimelineItemPayload): React.JSX.Element {
  const cmd = cleanCommand(item.command ?? "?");
  const exitCode = item.exitCode;
  const exitLabel = exitCode !== undefined ? (exitCode === 0 ? "" : ` exit:${exitCode}`) : "";
  const duration = item.durationMs !== undefined ? ` ${(item.durationMs / 1000).toFixed(1)}s` : "";
  return (
    <Box flexDirection="column">
      <Text>
        <Text dimColor>$ </Text>
        <Text>{truncate(cmd, 80)}</Text>
        {exitLabel && <Text color="red">{exitLabel}</Text>}
        {duration && <Text dimColor>{duration}</Text>}
      </Text>
      {item.output && item.status === "inProgress" && (
        <Text dimColor>  {truncate(item.output.split("\n").filter(Boolean).at(-1) ?? "", 100)}</Text>
      )}
    </Box>
  );
}

function renderFileChange(item: TimelineItemPayload): React.JSX.Element {
  const count = item.changes?.length ?? 0;
  return (
    <Text>
      <Text dimColor>files: </Text>
      <Text>{count} change{count !== 1 ? "s" : ""}</Text>
    </Text>
  );
}

function renderToolCall(item: TimelineItemPayload): React.JSX.Element {
  return (
    <Text>
      <Text dimColor>tool: </Text>
      <Text>{item.toolName ?? item.type}</Text>
    </Text>
  );
}

function renderPlan(item: TimelineItemPayload): React.JSX.Element {
  return (
    <Text>
      <Text dimColor>plan: </Text>
      <Text>{truncate(item.text ?? "", 120)}</Text>
    </Text>
  );
}

function renderDefault(item: TimelineItemPayload): React.JSX.Element {
  return (
    <Text dimColor>{item.type}{item.text ? `: ${truncate(item.text, 80)}` : ""}</Text>
  );
}

export function ItemLine({ item, isLast }: ItemLineProps): React.JSX.Element {
  const prefix = isLast ? "\u2514" : "\u251c";
  let content: React.JSX.Element;

  switch (item.type) {
    case "agentMessage":
      content = renderAgentMessage(item);
      break;
    case "commandExecution":
      content = renderCommand(item);
      break;
    case "fileChange":
      content = renderFileChange(item);
      break;
    case "mcpToolCall":
    case "dynamicToolCall":
      content = renderToolCall(item);
      break;
    case "plan":
      content = renderPlan(item);
      break;
    case "userMessage": {
      const userText = item.text?.trim();
      if (!userText) return <></>;
      content = (
        <Text>
          <Text color="yellow">you: </Text>
          <Text wrap="wrap">{userText}</Text>
        </Text>
      );
      break;
    }
    default:
      content = renderDefault(item);
      break;
  }

  return (
    <Box>
      <Text dimColor>{prefix} </Text>
      <Text color={statusColor(item.status)}>{statusChar(item.status)} </Text>
      {content}
    </Box>
  );
}
