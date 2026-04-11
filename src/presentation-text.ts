function unwrapShellWrappedCommand(text: string): string {
  return text
    .replace(/`(?:\/bin\/bash|bash|\/bin\/sh|sh)\s+-lc\s+'([^`\n]+)'`/g, "`$1`")
    .replace(/`(?:\/bin\/bash|bash|\/bin\/sh|sh)\s+-lc\s+"([^`\n]+)"`/g, "`$1`")
    .replace(/^(?:\/bin\/bash|bash|\/bin\/sh|sh)\s+-lc\s+'([^`\n]+)'$/g, "$1")
    .replace(/^(?:\/bin\/bash|bash|\/bin\/sh|sh)\s+-lc\s+"([^`\n]+)"$/g, "$1");
}

function stripLocalMarkdownLinks(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\(<\/[^)>]+>\)/g, "`$1`")
    .replace(/\[([^\]]+)\]\((\/[^)\s]+)\)/g, "`$1`");
}

function stripLocalAbsolutePaths(text: string): string {
  return text
    .replace(/`\/(?:home|Users|private|tmp|var\/folders)\/[^`\n]+`/g, "`local path omitted`")
    .replace(/(^|[\s(])\/(?:home|Users|private|tmp|var\/folders)\/[^\s)]+/g, "$1`local path omitted`");
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
  return stripLocalAbsolutePaths(stripLocalMarkdownLinks(unwrapShellWrappedCommand(trimmed)));
}
