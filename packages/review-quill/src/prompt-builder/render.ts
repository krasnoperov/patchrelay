import { renderDiffContextLines } from "../diff-context/index.ts";
import type { ReviewContext } from "../types.ts";

export const REVIEW_QUILL_PROMPT_SECTION_IDS = [
  "preamble",
  "output-contract",
  "review-rubric",
  "grounding",
  "pull-request",
  "diff-context",
  "repo-guidance",
  "prior-review-claims",
] as const;

type ReviewPromptSectionId = typeof REVIEW_QUILL_PROMPT_SECTION_IDS[number];

interface ReviewPromptSection {
  id: ReviewPromptSectionId | `custom:${string}`;
  content: string;
}

export function findUnknownReviewPromptSectionIds(replaceSections: Record<string, unknown>): string[] {
  const known = new Set<string>(REVIEW_QUILL_PROMPT_SECTION_IDS);
  return Object.keys(replaceSections).filter((sectionId) => !known.has(sectionId));
}

export const OUTPUT_SCHEMA = `{
  "walkthrough": "2-4 paragraph narrative: what this PR changes, the author's apparent intent, how it fits into the wider codebase, notable risks.",
  "architectural_concerns": [
    {
      "severity": "blocking" | "nit",
      "category": "intent" | "regression" | "convention" | "product",
      "message": "Prose description of a cross-file or product-level concern that cannot be pinned to a single line."
    }
  ],
  "findings": [
    {
      "path": "relative/path/to/file.ts",
      "line": 123,
      "severity": "blocking" | "nit",
      "confidence": 85,
      "message": "Concrete, actionable description of the line-level issue.",
      "suggestion": "Optional committable fix. Include ONLY if the fix is <=6 lines AND fully resolves the issue."
    }
  ],
  "verdict": "approve" | "request_changes",
  "verdict_reason": "One sentence explaining the verdict."
}`;

export const OUTPUT_RULES = `Output rules — the response parser expects strict JSON:
- Return ONE JSON object and nothing else. No markdown code fences. No prose before or after.
- Use double-quoted strings only. No single quotes, no unquoted keys.
- No comments (neither // nor /* */).
- No trailing commas before } or ].
- All \`severity\` values must be exactly "blocking" or "nit" (lowercase).
- All \`verdict\` values must be exactly "approve" or "request_changes". Any non-binary verdict is invalid.
- \`path\` is required on every finding; \`line\` is a positive integer, not a string.
- \`path\` MUST be a file that appears in the diff inventory above. Do not invent file paths.
- \`line\` MUST be a line number in the new version of the file at the current PR head.
- Findings on files not visible in the inventory will be silently dropped before posting.`;

const REVIEW_RUBRIC = `## Review rubric
Review the current PR head only.

- Start by understanding the actual code and diff before deciding on a verdict.
- Flag only high-signal issues: real correctness bugs, definite regressions, or clear documented rule violations you can quote from repository guidance.
- Do not raise speculative issues, style debates, pre-existing problems, or linter/typechecker noise.
- Keep architectural concerns for cross-file or product-level issues that cannot be pinned to one line.
- Keep findings for one concrete issue at one concrete file/line on the current head.
- If any finding or architectural concern is blocking, verdict must be \`request_changes\`. Otherwise verdict must be \`approve\`.
- This is a decisive reviewer in the merge pipeline. Do not emit a neutral/comment-only outcome.
- Do not post the review yourself with \`gh\` or other tools. Return JSON only; review-quill will publish it.`;

const GROUNDING_RULES = `## Grounding
- The changed-files inventory and patch set below define this PR's scope on the current head.
- Use the checked-out repository for surrounding context, but do not expand the claimed PR scope beyond the diff inventory.
- Do not silently widen the delegated task. A broader inconsistency is blocking only when the current diff introduces it, the repository guidance explicitly treats the changed surfaces as one flow, or the PR title/body makes that broader behavior part of the task.
- Previous reviews are historical claims to verify, not facts to repeat. Re-check them against the current head, current diff, and current behavior before reusing them.`;

export function renderCorrectivePrompt(reason: string): string {
  return [
    "Your previous response could not be parsed. The response parser reported:",
    "",
    `  ${reason}`,
    "",
    "Return ONLY a JSON object matching the schema below. No markdown code fences, no prose before or after, no comments, no trailing commas. Use double-quoted strings only.",
    "",
    OUTPUT_SCHEMA,
    "",
    OUTPUT_RULES,
  ].join("\n");
}

export function renderReviewPrompt(context: Omit<ReviewContext, "prompt">): string {
  const sections: ReviewPromptSection[] = [
    {
      id: "preamble",
      content: [
        "You are Review Quill, a strict pull request reviewer.",
        "You are running inside a checked-out copy of the current PR head.",
        "Use the repository in the current working directory when you need more context.",
      ].join("\n"),
    },
    {
      id: "output-contract",
      content: [
        "## Output contract",
        "Return exactly ONE JSON object matching this schema:",
        "",
        OUTPUT_SCHEMA,
        "",
        OUTPUT_RULES,
      ].join("\n"),
    },
    { id: "review-rubric", content: REVIEW_RUBRIC },
    { id: "grounding", content: GROUNDING_RULES },
    {
      id: "pull-request",
      content: [
        "## Pull request",
        `Repository: ${context.repo.repoFullName}`,
        `Base branch: ${context.pr.baseRefName}`,
        `Head branch: ${context.pr.headRefName}`,
        `PR: #${context.pr.number}`,
        `Head SHA: ${context.pr.headSha}`,
        `Title: ${context.pr.title}`,
        context.pr.body ? `Body:\n${context.pr.body}` : "Body: <empty>",
        context.promptContext.issueKeys.length > 0
          ? `Linked issue keys: ${context.promptContext.issueKeys.join(", ")}`
          : "",
      ].filter(Boolean).join("\n"),
    },
    { id: "diff-context", content: renderDiffContextLines(context.diff).join("\n") },
  ];

  if (context.promptContext.guidanceDocs.length > 0) {
    sections.push({
      id: "repo-guidance",
      content: [
        "## Repository guidance",
        ...context.promptContext.guidanceDocs.flatMap((doc) => [`### ${doc.path}`, doc.text.slice(0, 8_000), ""]),
      ].join("\n"),
    });
  }

  if (context.promptContext.priorReviewClaims.length > 0) {
    sections.push({
      id: "prior-review-claims",
      content: [
        "## Prior review claims to verify",
        "Verify these historical claims against the current head before reusing them.",
        ...context.promptContext.priorReviewClaims.map((claim) => {
          const label = [
            claim.authorLogin ?? "unknown",
            claim.state ? `[${claim.state}]` : undefined,
            claim.commitId ? `commit ${claim.commitId}` : undefined,
          ].filter(Boolean).join(" ");
          return `- ${label}: ${claim.excerpt}`;
        }),
      ].join("\n"),
    });
  }

  const replacements = new Map<string, string>();
  const prepend: ReviewPromptSection[] = [];
  const append: ReviewPromptSection[] = [];

  context.promptCustomization.prepend.forEach((fragment, index) => {
    prepend.push({ id: `custom:prepend:${index}`, content: fragment.content });
  });
  Object.entries(context.promptCustomization.replaceSections).forEach(([sectionId, fragment]) => {
    replacements.set(sectionId, fragment.content);
  });
  context.promptCustomization.append.forEach((fragment, index) => {
    append.push({ id: `custom:append:${index}`, content: fragment.content });
  });

  return [...prepend, ...sections.map((section) => ({
    ...section,
    content: replacements.get(section.id) ?? section.content,
  })), ...append]
    .map((section) => section.content.trim())
    .filter(Boolean)
    .join("\n\n");
}
