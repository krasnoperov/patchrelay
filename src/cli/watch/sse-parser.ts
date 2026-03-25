/**
 * Shared SSE (Server-Sent Events) stream parser.
 * Extracts event type + data from a ReadableStream, calls onEvent for each complete event.
 */
export async function readSSEStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (eventType: string, data: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventType = "";
  let dataLines: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const rawLine = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;

      if (!line) {
        if (dataLines.length > 0) {
          onEvent(eventType, dataLines.join("\n"));
          dataLines = [];
          eventType = "";
        }
        newlineIndex = buffer.indexOf("\n");
        continue;
      }

      if (line.startsWith(":")) {
        newlineIndex = buffer.indexOf("\n");
        continue;
      }

      if (line.startsWith("event:")) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
      newlineIndex = buffer.indexOf("\n");
    }
  }
}
