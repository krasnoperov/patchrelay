import { Box, Text } from "ink";
import type { TimelineItemPayload } from "./watch-state.ts";

interface ItemLineProps {
  item: TimelineItemPayload;
}

function cleanCommand(raw: string): string {
  const bashMatch = raw.match(/^\/bin\/(?:ba)?sh\s+-\w*c\s+['"](.+?)['"]$/s);
  if (bashMatch?.[1]) return bashMatch[1];
  const bashMatch2 = raw.match(/^\/bin\/(?:ba)?sh\s+-\w*c\s+"(.+?)"$/s);
  if (bashMatch2?.[1]) return bashMatch2[1];
  return raw;
}

function summarizeFileChange(item: TimelineItemPayload): string {
  const count = item.changes?.length ?? 0;
  return `updated ${count} file${count === 1 ? "" : "s"}`;
}

function summarizeToolCall(item: TimelineItemPayload): string {
  return `used ${item.toolName ?? item.type}`;
}

function summarizeText(item: TimelineItemPayload): string {
  return (item.text ?? "").replace(/\s+/g, " ").trim();
}

function itemPrefix(item: TimelineItemPayload): string {
  if (item.type === "commandExecution") return "$ ";
  return "";
}

function itemText(item: TimelineItemPayload): string | undefined {
  switch (item.type) {
    case "agentMessage":
    case "plan":
    case "reasoning":
      return summarizeText(item);
    case "commandExecution":
      return cleanCommand(item.command ?? "?");
    case "fileChange":
      return summarizeFileChange(item);
    case "mcpToolCall":
    case "dynamicToolCall":
      return summarizeToolCall(item);
    case "userMessage":
      return `you: ${summarizeText(item)}`;
    default:
      return item.text ? summarizeText(item) : item.type;
  }
}

function itemColor(item: TimelineItemPayload): string | undefined {
  if (item.status === "failed" || item.status === "declined") return "red";
  if (item.status === "inProgress") return "yellow";
  if (item.type === "userMessage") return "yellow";
  return undefined;
}

export function ItemLine({ item }: ItemLineProps): React.JSX.Element {
  const text = itemText(item);
  if (!text) {
    return <></>;
  }
  const color = itemColor(item);

  return (
    <Box flexDirection="column" gap={1}>
      <Text wrap="wrap" bold={item.type === "agentMessage"} {...(color ? { color } : {})}>
        {itemPrefix(item)}{text}
      </Text>
      {item.output && item.status === "inProgress" && (
        <Box paddingLeft={2}>
          <Text dimColor wrap="wrap">{item.output.split("\n").filter(Boolean).at(-1) ?? ""}</Text>
        </Box>
      )}
    </Box>
  );
}
