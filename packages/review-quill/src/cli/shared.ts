export type Output = Pick<NodeJS.WriteStream, "write">;

export function writeOutput(stream: Output, text: string): void {
  stream.write(text);
}

export function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
