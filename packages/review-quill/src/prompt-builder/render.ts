import { summarizeSuppressedFile } from "../diff-context/index.ts";
import type { ReviewContext } from "../types.ts";

export function renderReviewPrompt(context: Omit<ReviewContext, "prompt">): string {
  const issueKeys = context.promptContext.issueKeys;
  const lines: string[] = [
    "You are Review Quill, a strict pull request reviewer.",
    "You are running inside a checked-out copy of the current PR head.",
    "Use the repository in the current working directory when you need more context.",
    "Start by understanding the actual code and diff before deciding on a verdict.",
    "Return only one JSON object with this shape:",
    '{"verdict":"approve"|"request_changes","summary":"short summary","findings":[{"path":"optional","line":123,"severity":"blocking"|"nit","message":"text"}]}',
    "",
    "Approve only if the PR is ready to merge as-is.",
    "Nits alone should not block; mark them with severity nit.",
    "",
    `Repository: ${context.repo.repoFullName}`,
    `Base branch: ${context.pr.baseRefName}`,
    `Head branch: ${context.pr.headRefName}`,
    `PR: #${context.pr.number}`,
    `Head SHA: ${context.pr.headSha}`,
    `Title: ${context.pr.title}`,
    context.pr.body ? `Body:\n${context.pr.body}` : "Body: <empty>",
    "",
    "Changed files inventory:",
  ];

  for (const file of context.diff.inventory) {
    const extras = [
      `${file.status}`,
      `+${file.additions}`,
      `-${file.deletions}`,
      file.reason ? `reason=${file.reason}` : undefined,
    ].filter(Boolean).join(" ");
    lines.push(`- ${file.path} (${extras})`);
  }

  if (context.diff.patches.length > 0) {
    lines.push("", "Detailed patches:");
    for (const file of context.diff.patches) {
      lines.push(`## ${file.path}`);
      lines.push("```diff", file.patch, "```");
    }
  }

  if (context.diff.suppressed.length > 0) {
    lines.push("", "Summarized or suppressed files:");
    for (const entry of context.diff.suppressed) {
      lines.push(`- ${summarizeSuppressedFile(entry)}`);
    }
  }

  if (issueKeys.length > 0) {
    lines.push(
      "",
      `Linked issue keys detected: ${issueKeys.join(", ")}`,
      "If the `linear` MCP tool is available, usually read the most relevant issue before finalizing your verdict.",
      "Use the issue to understand intent, acceptance context, and product constraints, then return to the checked-out code and diff.",
    );
  }

  if (context.promptContext.guidanceDocs.length > 0) {
    lines.push("", "Repository guidance:");
    for (const doc of context.promptContext.guidanceDocs) {
      lines.push(`## ${doc.path}`, doc.text.slice(0, 8_000), "");
    }
  }

  if (context.promptContext.priorReviews.length > 0) {
    lines.push("", "Previous formal reviews:");
    for (const review of context.promptContext.priorReviews.slice(-10)) {
      lines.push(`- ${review.authorLogin ?? "unknown"} [${review.state ?? "unknown"}] ${review.commitId ?? ""}`.trim());
      if (review.body) {
        lines.push(review.body.slice(0, 2_000));
      }
    }
  }

  return lines.join("\n");
}
