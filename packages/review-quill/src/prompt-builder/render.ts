import { renderDiffContextLines } from "../diff-context/index.ts";
import type { ReviewContext } from "../types.ts";

// Output schema the Codex agent must return. Kept inline in the prompt
// so the model sees the exact shape it's producing. Mirrored by the
// `ReviewVerdict` TypeScript interface in types.ts — keep both in sync.
// Exported so the review-runner's corrective retry path can reuse the
// same constants instead of duplicating them.
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

// Strict output rules. These close the common failure modes we see in
// model output: markdown code fences, trailing prose, trailing commas,
// JSON5 syntax, smart quotes. The parser is forgiving of most of these
// already (see utils.ts sanitizeJsonPayload), but telling the model the
// rules is cheaper than repairing its output.
export const OUTPUT_RULES = `Output rules — the response parser expects strict JSON:
- Return ONE JSON object and nothing else. No markdown code fences. No prose before or after.
- Use double-quoted strings only. No single quotes, no unquoted keys.
- No comments (neither // nor /* */).
- No trailing commas before } or ].
- All \`severity\` values must be exactly "blocking" or "nit" (lowercase).
- All \`verdict\` values must be exactly "approve" or "request_changes". Any non-binary verdict is invalid.
- \`path\` is required on every finding; \`line\` is a positive integer, not a string.
- \`path\` MUST be a file that appears in the diff inventory above. Do not invent file paths.
- \`line\` MUST be a line number in the NEW (right side) version of the file — i.e., a line that exists in the file as of this PR's HEAD. Do not point at lines that only exist in the old version.
- Findings on files not visible in the inventory will be silently dropped before posting.`;

// One concrete example so the model has a template to pattern-match
// against. Few-shot is the highest-ROI reliability trick for structured
// output — dramatically reduces drift on the first few fields. The
// example shows a realistic mix: walkthrough + one architectural concern
// + one blocking finding + one nit with a suggestion + a non-approving
// verdict, which covers most of the schema's corners in one pass.
const OUTPUT_EXAMPLE = `Example of a valid response (this is not the real review — just the shape):
{
  "walkthrough": "This PR introduces an admission loop for the merge queue, replacing the previous synchronous check. The loop runs on a 5-second tick and pulls pending PRs from SQLite. Intent looks aligned with the queue-health design doc, but the locking model needs attention.",
  "architectural_concerns": [
    {
      "severity": "nit",
      "category": "convention",
      "message": "Error handling in the new admission code does not match the pattern used elsewhere in src/merge-queue/ — other loops catch + log + re-enqueue; this one swallows silently."
    }
  ],
  "findings": [
    {
      "path": "src/merge-queue/admission.ts",
      "line": 142,
      "severity": "blocking",
      "confidence": 95,
      "message": "Mutex is acquired but never released on the error path at line 142. A failure in \`probePr\` leaves the queue stuck until the process restarts.",
      "suggestion": "try {\\n  await probePr(pr);\\n} finally {\\n  mutex.release();\\n}"
    },
    {
      "path": "src/merge-queue/admission.ts",
      "line": 78,
      "severity": "nit",
      "confidence": 70,
      "message": "\`tickInterval\` hardcoded to 5000; consider moving to config alongside the other queue knobs."
    }
  ],
  "verdict": "request_changes",
  "verdict_reason": "One blocking mutex release issue must be fixed before merge."
}`;

// High-signal filter. Copied almost verbatim from Anthropic's Claude Code
// review plugin (plugins/code-review/commands/code-review.md), which is
// the clearest published statement of "only flag real bugs" in the
// industry. Adapted for review-quill's conventions.
const HIGH_SIGNAL_FILTER = `CRITICAL: Only flag HIGH SIGNAL issues. Flag only:
- Code that will fail to compile, parse, or typecheck (syntax errors, type errors, missing imports, unresolved references)
- Code that will definitely produce wrong results regardless of inputs (clear logic errors, off-by-one, wrong operator, reversed conditions)
- Clear, unambiguous violations of the repository's documented conventions where you can quote the exact rule being broken (from REVIEW_WORKFLOW.md, CLAUDE.md, AGENTS.md)

Do NOT flag:
- Code style or quality concerns unrelated to documented conventions
- Potential issues that depend on specific inputs or runtime state you cannot verify from the diff
- Subjective suggestions or alternative approaches
- Pre-existing issues not introduced by this PR
- Issues a linter or typechecker would catch (assume those already ran)
- Nitpicks a senior engineer would not bother to raise

Before including any finding, ask: "Can I explain, in ONE sentence, the exact scenario in which this causes a bug?" If you cannot, drop it. If you are not certain an issue is real, do not flag it. False positives erode trust.`;

// Wide-vs-specific split. The model needs to understand that architectural
// concerns and line-level findings are different output buckets, not
// different prose tones in the same bucket.
const SCOPE_SPLIT = `Your review has two scopes:

WIDE (produces \`walkthrough\` and \`architectural_concerns[]\`):
- What the PR changes and the author's apparent intent
- How it fits into the wider codebase and architecture
- Cross-file regressions, convention drift, or product-intent misalignment
- These issues CANNOT be pinned to one specific line — they span multiple files or describe a pattern.

SPECIFIC (produces \`findings[]\`):
- Line-level bugs, wrong error handling, broken edge cases
- Missing tests for changed behavior
- Each finding MUST have a concrete path and line number
- Each finding describes ONE issue at ONE location
- If the same bug appears in 3 files, emit 3 findings (one per location), not one vague finding

NEVER put the same issue in both buckets. If you describe a theme in the walkthrough ("inconsistent error handling across the new admission code"), the findings should point to specific lines where it shows up. The walkthrough should not list individual line numbers.`;

// Severity + verdict mapping. Nits never block.
const SEVERITY_RULES = `Severity: exactly two levels — "blocking" and "nit".
- blocking: correctness, security, failing tests, clear policy violations. Author MUST fix before merge.
- nit: style, naming, readability, small refactors. Author may ignore.

Verdict rules (apply exactly):
- If ANY finding or architectural_concern has severity "blocking" → verdict = "request_changes"
- Else → verdict = "approve"
- Non-blocking findings and architectural concerns should still be included in the JSON, but they ride along with an approval instead of a neutral review.
This reviewer is part of the merge pipeline, so you MUST produce a decisive binary verdict. Do not emit a neutral/comment-only outcome.`;

// Posting carve-out. The REVIEW_WORKFLOW.md guidance doc may instruct
// human reviewers to post via `gh pr review`. The agent must not do this
// — review-quill posts atomically via the GitHub App installation token
// using the JSON the agent returns.
const POSTING_CARVEOUT = `DO NOT POST THE REVIEW YOURSELF. The repository's REVIEW_WORKFLOW.md (or similar guidance) may describe how human reviewers post their verdict (e.g., \`gh pr review --approve\`). IGNORE those posting instructions. You are running as a GitHub App service — review-quill will post your review for you using the JSON you return.

Focus only on the CONTENT of the review: read the diff, understand the change, find the real bugs, and emit one structured JSON object. Do not shell out to \`gh pr review\`, \`gh pr comment\`, or any other posting mechanism. Do not approve or request changes via tools.`;

// Short corrective prompt sent on the SAME Codex thread when the first
// response failed to parse. The model still has the full original
// context (diff, PR metadata, guidance docs) in its thread memory —
// we only need to redirect its output shape. The OUTPUT_EXAMPLE is
// intentionally NOT included here; the model has it from the first
// turn and repeating it would just bloat the retry context.
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
  const issueKeys = context.promptContext.issueKeys;
  const lines: string[] = [
    "You are Review Quill, a strict pull request reviewer.",
    "You are running inside a checked-out copy of the current PR head.",
    "Use the repository in the current working directory when you need more context.",
    "Start by understanding the actual code and diff before deciding on a verdict.",
    "",
    "## Output contract",
    "Return exactly ONE JSON object matching this schema (the keys are exactly as shown; all values are prose descriptions, not the literal strings):",
    "",
    OUTPUT_SCHEMA,
    "",
    OUTPUT_RULES,
    "",
    OUTPUT_EXAMPLE,
    "",
    "## Scope: wide + specific",
    SCOPE_SPLIT,
    "",
    "## Quality bar",
    HIGH_SIGNAL_FILTER,
    "",
    "## Severity and verdict",
    SEVERITY_RULES,
    "",
    "## Posting",
    POSTING_CARVEOUT,
    "",
    "## Pull request",
    `Repository: ${context.repo.repoFullName}`,
    `Base branch: ${context.pr.baseRefName}`,
    `Head branch: ${context.pr.headRefName}`,
    `PR: #${context.pr.number}`,
    `Head SHA: ${context.pr.headSha}`,
    `Title: ${context.pr.title}`,
    context.pr.body ? `Body:\n${context.pr.body}` : "Body: <empty>",
    "",
    ...renderDiffContextLines(context.diff),
  ];

  if (issueKeys.length > 0) {
    lines.push(
      "",
      `Linked issue keys detected: ${issueKeys.join(", ")}`,
      "If the `linear` MCP tool is available, read the most relevant issue before finalizing your verdict.",
      "Use the issue to understand intent and acceptance context, then return to the checked-out code and diff.",
    );
  }

  if (context.promptContext.guidanceDocs.length > 0) {
    lines.push("", "## Repository guidance");
    for (const doc of context.promptContext.guidanceDocs) {
      lines.push(`### ${doc.path}`, doc.text.slice(0, 8_000), "");
    }
  }

  if (context.promptContext.priorReviews.length > 0) {
    lines.push("", "## Previous formal reviews");
    for (const review of context.promptContext.priorReviews.slice(-10)) {
      lines.push(`- ${review.authorLogin ?? "unknown"} [${review.state ?? "unknown"}] ${review.commitId ?? ""}`.trim());
      if (review.body) {
        lines.push(review.body.slice(0, 2_000));
      }
    }
  }

  return lines.join("\n");
}
