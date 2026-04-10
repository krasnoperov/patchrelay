function unwrapShellWrappedCommand(text: string): string {
  return text
    .replace(/`(?:\/bin\/bash|bash|\/bin\/sh|sh)\s+-lc\s+'([^`\n]+)'`/g, "`$1`")
    .replace(/`(?:\/bin\/bash|bash|\/bin\/sh|sh)\s+-lc\s+"([^`\n]+)"`/g, "`$1`")
    .replace(/^(?:\/bin\/bash|bash|\/bin\/sh|sh)\s+-lc\s+'([^`\n]+)'$/g, "$1")
    .replace(/^(?:\/bin\/bash|bash|\/bin\/sh|sh)\s+-lc\s+"([^`\n]+)"$/g, "$1");
}

export function sanitizeOperatorFacingCommand(command: string | undefined): string | undefined {
  const trimmed = command?.trim();
  if (!trimmed) {
    return undefined;
  }
  return unwrapShellWrappedCommand(trimmed);
}

export function sanitizeOperatorFacingText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  return unwrapShellWrappedCommand(trimmed);
}
