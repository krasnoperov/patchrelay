import { renderDiffContextLines } from "../diff-context/index.ts";
import type { ReviewContext } from "../types.ts";

export const REVIEW_QUILL_PROMPT_SECTION_IDS = [
  "preamble",
  "output-contract",
  "review-rubric",
  "pull-request",
  "diff-context",
  "repo-guidance",
  "prior-review-claims",
] as const;

type ReviewPromptSectionId = typeof REVIEW_QUILL_PROMPT_SECTION_IDS[number];
export const REVIEW_QUILL_REPLACEABLE_SECTION_IDS = [
  "review-rubric",
] as const;
type ReviewQuillReplaceableSectionId = typeof REVIEW_QUILL_REPLACEABLE_SECTION_IDS[number];

interface ReviewPromptSection {
  id: ReviewPromptSectionId | "extra-instructions";
  content: string;
}

export function findUnknownReviewPromptSectionIds(replaceSections: Record<string, unknown>): string[] {
  const known = new Set<string>(REVIEW_QUILL_PROMPT_SECTION_IDS);
  return Object.keys(replaceSections).filter((sectionId) => !known.has(sectionId));
}

export function findDisallowedReviewPromptSectionIds(replaceSections: Record<string, unknown>): string[] {
  const known = new Set<string>(REVIEW_QUILL_PROMPT_SECTION_IDS);
  const allowed = new Set<string>(REVIEW_QUILL_REPLACEABLE_SECTION_IDS);
  return Object.keys(replaceSections).filter((sectionId) => known.has(sectionId) && !allowed.has(sectionId));
}

export const OUTPUT_SCHEMA = `{
  "walkthrough": "Optional 1-2 sentence Context appendix. Include ONLY when the author's intent or a codebase-wide constraint is NOT visible from the diff alone. Default to empty string. Never restate the PR body or describe what the diff already shows.",
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

const REVIEW_RULES = `## Review rules
Review the current PR head only.

- Start by understanding the actual code and diff before deciding on a verdict.
- Every blocking concern must name (a) a concrete input, runtime state, or sequence that triggers it on the current head, and (b) the realistic usage pattern under which that state arises in this repository. Hypothetical failure modes that require unstated preconditions are not blockers — flag them as nits at most, or drop them.
- If the PR body, diff, or repository guidance directly names your concern and argues against it — e.g., a threat-model section, a "why not X" paragraph, or an explicit rationale inside the changed code — engage with that argument. Either identify the specific condition under which the rebuttal fails on this head, or drop the concern. Do not re-raise it without rebutting.
- Start by checking whether the previous blocking review concerns are now resolved, still blocking, or no longer relevant on the current head.
- If a previous blocker still applies AND the author has not visibly engaged with it on the new head, restate it clearly. If the author has pushed heads without accepting it OR has added a rebuttal in the current head's content, engage with that engagement — do not mechanically restate.
- Only raise a new blocker when it is clearly independent from the previous blockers.
- When several symptoms share one root cause, report them as one blocker instead of separate variants.
- Prefer the smallest set of remaining merge-blocking concerns that makes the PR's current risk clear.
- Flag only high-signal issues: real correctness bugs, definite regressions, or clear documented rule violations you can quote from repository guidance.
- Keep each \`finding.message\` under ~200 characters of prose. Put multi-line fix detail in the \`suggestion\` committable block (≤6 lines) instead of the message body.
- Do not raise speculative issues, style debates, pre-existing problems, or linter/typechecker noise.
- Keep architectural concerns for cross-file or product-level issues that cannot be pinned to one line.
- Keep findings for one concrete issue at one concrete file/line on the current head.
- If any finding or architectural concern is blocking, verdict must be \`request_changes\`. Otherwise verdict must be \`approve\`.
- This is a decisive reviewer in the merge pipeline. Do not emit a neutral/comment-only outcome.
- Do not post the review yourself with \`gh\` or other tools. Return JSON only; review-quill will publish it.
- The changed-files inventory and patch set below define this PR's scope on the current head.
- Use the checked-out repository for surrounding context, but do not expand the claimed PR scope beyond the diff inventory.
- Start by identifying the PR's primary task from the title, body, and diff.
- Treat explicit scope notes, out-of-scope notes, supersedes notes, and threat-model notes in the PR body as evidence of author intent, not automatic waivers.
- Do not let the PR description waive direct regressions or correctness issues introduced by the diff.
- Do not silently widen the delegated task. A broader inconsistency is blocking only when the current diff introduces it, materially worsens it, the repository guidance explicitly treats the changed surfaces as one flow, or the stated PR task depends on it being correct.
- If a concern is real but mostly pre-existing or only weakly connected to the stated PR task, prefer a nit or drop it instead of blocking.
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
    { id: "review-rubric", content: REVIEW_RULES },
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
        "In your walkthrough, make the continuity explicit: note what appears resolved since the prior review, what still blocks on this head, and what is genuinely new if anything.",
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

  const allowed = new Set<string>(REVIEW_QUILL_REPLACEABLE_SECTION_IDS);
  const replacements = new Map<string, string>();
  Object.entries(context.promptCustomization.replaceSections).forEach(([sectionId, fragment]) => {
    if (allowed.has(sectionId)) {
      replacements.set(sectionId, fragment.content);
    }
  });

  const renderedSections = sections.map((section) => ({
    ...section,
    content: replacements.get(section.id) ?? section.content,
  }));
  if (context.promptCustomization.extraInstructions?.content.trim()) {
    const extraSection: ReviewPromptSection = {
      id: "extra-instructions",
      content: ["## Extra Instructions", "", context.promptCustomization.extraInstructions.content.trim()].join("\n"),
    };
    const repoGuidanceIndex = renderedSections.findIndex((section) => section.id === "repo-guidance");
    if (repoGuidanceIndex === -1) {
      renderedSections.push(extraSection);
    } else {
      renderedSections.splice(repoGuidanceIndex, 0, extraSection);
    }
  }

  return renderedSections.map((section) => section.content.trim()).filter(Boolean).join("\n\n");
}
