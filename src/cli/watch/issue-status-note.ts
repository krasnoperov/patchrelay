function stripMarkdownLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

export function summarizeIssueStatusNote(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const firstParagraph = raw.split(/\n\s*\n/).find((part) => part.trim().length > 0)?.trim();
  if (!firstParagraph) return undefined;
  const normalized = stripMarkdownLinks(firstParagraph)
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length > 0 ? normalized : undefined;
}
