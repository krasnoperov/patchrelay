import type { IssueRecord } from "../db-types.ts";
import type { RunContext } from "../run-context.ts";

function humanContext(context: RunContext | undefined): string[] {
  const lines: string[] = [];
  if (context?.promptContext?.trim()) {
    lines.push(context.promptContext.trim());
  }
  if (context?.promptBody?.trim()) {
    lines.push(context.promptBody.trim());
  }
  for (const followUp of context?.followUps ?? []) {
    if (!followUp.text?.trim()) continue;
    lines.push(followUp.author?.trim()
      ? `${followUp.author.trim()}: ${followUp.text.trim()}`
      : followUp.text.trim());
  }
  return lines;
}

export function buildCollaborationPrompt(params: {
  issue: Pick<IssueRecord, "linearIssueId" | "issueKey" | "title" | "description">;
  context?: RunContext;
}): string {
  const request = humanContext(params.context);
  return [
    `Issue: ${params.issue.issueKey ?? params.issue.linearIssueId}`,
    params.issue.title ? `Title: ${params.issue.title}` : undefined,
    params.issue.description?.trim()
      ? ["", "## Issue context", "", params.issue.description.trim()].join("\n")
      : undefined,
    "",
    "## Conversation",
    "",
    ...(request.length > 0 ? request : ["Explore the issue with the user and help decide the next step."]),
    "",
    "## Collaboration contract",
    "",
    "- Treat this as an open-ended working conversation rather than a preset delivery assignment.",
    "- Share concise progress and a small plan when the investigation has multiple steps.",
    "- Ask focused questions when product intent or tradeoffs materially change the answer.",
    "- Use the repository, shell, connected tools, and MCP integrations normally.",
    "- You may inspect or edit files, run checks, commit, push, or work with pull requests when that is useful in the conversation.",
    "- Do not assume that every turn must produce a commit, push, pull request, merge, deploy, or other delivery artifact.",
    "- Show findings, alternatives, drafts, working changes, or a recommended next step as appropriate.",
    "- End with a useful answer or a focused question that lets the user continue the conversation.",
  ].filter((line): line is string => line !== undefined).join("\n");
}
