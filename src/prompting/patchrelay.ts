import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { IssueRecord } from "../db-types.ts";
import type { RunType } from "../factory-state.ts";
import type { PatchRelayPromptingConfig, PromptCustomizationLayer } from "../types.ts";

const WORKFLOW_FILES: Record<RunType, string> = {
  implementation: "IMPLEMENTATION_WORKFLOW.md",
  review_fix: "REVIEW_WORKFLOW.md",
  branch_upkeep: "REVIEW_WORKFLOW.md",
  ci_repair: "IMPLEMENTATION_WORKFLOW.md",
  queue_repair: "IMPLEMENTATION_WORKFLOW.md",
};

export const PATCHRELAY_PROMPT_SECTION_IDS = [
  "header",
  "follow-up-turn",
  "task-objective",
  "scope-discipline",
  "human-context",
  "reactive-context",
  "workflow-guidance",
  "publication-contract",
] as const;

export type PatchRelayPromptSectionId = typeof PATCHRELAY_PROMPT_SECTION_IDS[number];
export const PATCHRELAY_REPLACEABLE_SECTION_IDS = [
  "scope-discipline",
  "workflow-guidance",
  "publication-contract",
] as const;
type PatchRelayReplaceableSectionId = typeof PATCHRELAY_REPLACEABLE_SECTION_IDS[number];

interface PatchRelayPromptSection {
  id: PatchRelayPromptSectionId | "extra-instructions";
  content: string;
}

export interface PatchRelayPromptBuildParams {
  issue: IssueRecord;
  runType: RunType;
  repoPath: string;
  context?: Record<string, unknown>;
  promptLayer?: PromptCustomizationLayer;
}

function readWorkflowFile(repoPath: string, runType: RunType): string | undefined {
  const filename = WORKFLOW_FILES[runType];
  const filePath = path.join(repoPath, filename);
  if (!existsSync(filePath)) return undefined;
  return readFileSync(filePath, "utf8").trim();
}

function buildPromptHeader(issue: IssueRecord): string {
  return [
    `Issue: ${issue.issueKey ?? issue.linearIssueId}`,
    issue.title ? `Title: ${issue.title}` : undefined,
    issue.branchName ? `Branch: ${issue.branchName}` : undefined,
    issue.prNumber ? `PR: #${issue.prNumber}` : undefined,
  ].filter(Boolean).join("\n");
}

function extractIssueSection(description: string | undefined, heading: string): string | undefined {
  if (!description) return undefined;
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^## ${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|$)`, "im");
  const match = description.match(pattern);
  const body = match?.[1]?.trim();
  return body && body.length > 0 ? body : undefined;
}

function extractIssueIntroText(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const trimmed = description.trim();
  if (!trimmed) return undefined;
  const firstSectionIndex = trimmed.search(/^##\s+/m);
  const intro = firstSectionIndex === -1 ? trimmed : trimmed.slice(0, firstSectionIndex).trim();
  return intro.length > 0 ? intro : undefined;
}

function buildTaskObjective(issue: IssueRecord): string {
  const intro = extractIssueIntroText(issue.description);
  return [
    "## Task Objective",
    "",
    issue.title || `Complete ${issue.issueKey ?? issue.linearIssueId}.`,
    ...(intro ? ["", intro] : []),
  ].join("\n");
}

function buildScopeDiscipline(issue: IssueRecord): string {
  const description = issue.description?.trim();
  const scope = extractIssueSection(description, "Scope");
  const acceptance = extractIssueSection(description, "Acceptance criteria")
    ?? extractIssueSection(description, "Success criteria");
  const relevantCode = extractIssueSection(description, "Relevant code");

  return [
    "## Scope Discipline",
    "",
    "Stay inside the delegated task.",
    "Finish the issue completely enough to satisfy its stated scope and acceptance criteria, but do not widen it into unrelated product polish or follow-up cleanup.",
    "Only broaden to adjacent routes, copy, or supporting surfaces when the issue text or repository guidance explicitly says they are the same user flow.",
    "If you notice a worthwhile broader inconsistency that is not required to make this task correct, mention it in your summary as follow-up context instead of expanding the implementation.",
    "",
    ...(scope ? ["### In Scope", "", scope, ""] : []),
    ...(acceptance ? ["### Acceptance / Done", "", acceptance, ""] : []),
    ...(relevantCode ? ["### Relevant Code", "", relevantCode, ""] : []),
    "### Likely Review Invariants",
    "",
    "- Check the surfaces explicitly named in the task before stopping.",
    "- If repository guidance says certain changed surfaces are one flow, verify that shared flow, but do not treat unrelated surrounding cleanup as part of this task.",
    "- A review repair should fix the concrete concern on the current head, not silently expand the Linear issue into a broader rewrite.",
  ].join("\n");
}

function buildHumanContext(context?: Record<string, unknown>): string | undefined {
  const promptContext = typeof context?.promptContext === "string" ? context.promptContext.trim() : "";
  const latestPrompt = typeof context?.promptBody === "string" ? context.promptBody.trim() : "";
  const operatorPrompt = typeof context?.operatorPrompt === "string" ? context.operatorPrompt.trim() : "";
  const userComment = typeof context?.userComment === "string" ? context.userComment.trim() : "";

  const lines: string[] = [];
  if (promptContext) {
    lines.push("## Linear Session Context", "", promptContext, "");
  }
  if (latestPrompt) {
    lines.push("## Latest Human Instruction", "", latestPrompt, "");
  }
  if (operatorPrompt) {
    lines.push("## Operator Prompt", "", operatorPrompt, "");
  }
  if (userComment) {
    lines.push("## Human Follow-up Comment", "", userComment, "");
  }
  return lines.length > 0 ? lines.join("\n").trim() : undefined;
}

interface ReviewFixCommentContext {
  body: string;
  path?: string | undefined;
  line?: number | undefined;
  side?: string | undefined;
  startLine?: number | undefined;
  startSide?: string | undefined;
  url?: string | undefined;
  authorLogin?: string | undefined;
}

type RequestedChangesMode = "address_review_feedback" | "branch_upkeep";

function resolveRequestedChangesMode(runType: RunType, context?: Record<string, unknown>): RequestedChangesMode {
  if (runType === "branch_upkeep") {
    return "branch_upkeep";
  }
  return context?.reviewFixMode === "branch_upkeep" || context?.branchUpkeepRequired === true
    ? "branch_upkeep"
    : "address_review_feedback";
}

function readReviewFixComments(context?: Record<string, unknown>): ReviewFixCommentContext[] {
  const raw = context?.reviewComments;
  if (!Array.isArray(raw)) {
    return [];
  }

  const comments: ReviewFixCommentContext[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const body = typeof record.body === "string" ? record.body.trim() : "";
    if (!body) continue;
    comments.push({
      body,
      ...(typeof record.path === "string" ? { path: record.path } : {}),
      ...(typeof record.line === "number" ? { line: record.line } : {}),
      ...(typeof record.side === "string" ? { side: record.side } : {}),
      ...(typeof record.startLine === "number" ? { startLine: record.startLine } : {}),
      ...(typeof record.startSide === "string" ? { startSide: record.startSide } : {}),
      ...(typeof record.url === "string" ? { url: record.url } : {}),
      ...(typeof record.authorLogin === "string" ? { authorLogin: record.authorLogin } : {}),
    });
  }
  return comments;
}

function buildStructuredReviewContext(context?: Record<string, unknown>): string | undefined {
  const reviewId = typeof context?.reviewId === "number" ? context.reviewId : undefined;
  const reviewCommitId = typeof context?.reviewCommitId === "string" ? context.reviewCommitId : undefined;
  const reviewUrl = typeof context?.reviewUrl === "string" ? context.reviewUrl : undefined;
  const reviewComments = readReviewFixComments(context);
  if (!reviewId && !reviewCommitId && !reviewUrl && reviewComments.length === 0) {
    return undefined;
  }

  const lines = ["## Structured Review Context", ""];
  if (reviewId !== undefined) lines.push(`Review ID: ${reviewId}`);
  if (reviewCommitId) lines.push(`Reviewed commit: ${reviewCommitId}`);
  if (reviewUrl) lines.push(`Review URL: ${reviewUrl}`);
  if (reviewComments.length === 0) {
    lines.push("No inline review comments were captured for this review.");
    return lines.join("\n");
  }

  lines.push(
    `Inline review comments captured: ${reviewComments.length}`,
    "Resolve each comment below or verify it is already fixed on the current head before you stop.",
    "A requested-changes turn is only complete if you push a newer PR head or deliberately escalate because you are blocked.",
    "",
  );
  for (const comment of reviewComments) {
    const location = comment.path
      ? `${comment.path}${comment.line !== undefined ? `:${comment.line}` : ""}${comment.side ? ` (${comment.side})` : ""}`
      : "general";
    lines.push(`- ${location}`);
    lines.push(comment.body);
    if (comment.url) lines.push(`  URL: ${comment.url}`);
  }
  return lines.join("\n");
}

function appendStructuredReviewContext(lines: string[], context?: Record<string, unknown>): void {
  const structured = buildStructuredReviewContext(context);
  if (structured) {
    lines.push(structured, "");
  }
}

function buildRequestedChangesContext(runType: RunType, context?: Record<string, unknown>): string {
  const mode = resolveRequestedChangesMode(runType, context);
  const lines: string[] = [];

  if (mode === "branch_upkeep") {
    lines.push(
      "## Branch Upkeep After Requested Changes",
      "",
      "The requested review changes may already be addressed, but GitHub still shows the PR branch as behind or dirty against the base branch.",
      "Update the existing PR branch onto the latest base branch, resolve conflicts carefully, rerun the narrowest relevant verification, and push a newer head.",
      "Do not open a new PR.",
      "",
    );
  } else {
    const reviewer = typeof context?.reviewerName === "string" ? context.reviewerName : undefined;
    const reviewBody = typeof context?.reviewBody === "string" ? context.reviewBody.trim() : "";
    lines.push(
      "## Review Changes Requested",
      "",
      reviewer ? `Reviewer: ${reviewer}` : "",
      reviewBody ? `Review summary:\n${reviewBody}` : "",
      "",
      "1. Start with the structured review context below. Treat the inline review comments as the primary repair checklist for this turn.",
      "2. Check the current diff (`git diff origin/main`) — a prior rebase may have already resolved some concerns.",
      "3. For each review point: if already resolved on the current head, note why. If not, fix it.",
      "4. If the structured review context looks incomplete, inspect the latest GitHub review threads directly before deciding you are done.",
      "5. Run verification, commit, and push a newer head on the existing PR branch.",
      "6. Do not try to hand the same head back to review. If you cannot produce a new pushed head, stop and surface the blocker clearly.",
      "7. GitHub review happens after the new head is pushed and CI is green. Do not use `gh pr edit --add-reviewer` as part of this workflow.",
      "",
    );
    appendStructuredReviewContext(lines, context);
  }

  return lines.join("\n").trim();
}

function buildCiRepairContext(context?: Record<string, unknown>): string {
  const snapshot = context?.ciSnapshot && typeof context.ciSnapshot === "object"
    ? context.ciSnapshot as {
        gateCheckName?: string;
        gateCheckStatus?: string;
        settledAt?: string;
        failedChecks?: Array<{ name?: string; summary?: string }>;
      }
    : undefined;

  return [
    "## CI Repair",
    "",
    "A full CI iteration has settled failed on your PR. Start from the specific failing check/job/step below on the latest remote PR branch tip, fix that concrete failure first, then push to the same PR branch.",
    snapshot?.gateCheckName ? `Gate check: ${String(snapshot.gateCheckName)}` : "",
    snapshot?.gateCheckStatus ? `Gate status: ${String(snapshot.gateCheckStatus)}` : "",
    snapshot?.settledAt ? `Settled at: ${String(snapshot.settledAt)}` : "",
    context?.failureHeadSha ? `Failing head SHA: ${String(context.failureHeadSha)}` : "",
    context?.checkName ? `Failed check: ${String(context.checkName)}` : "",
    context?.jobName && context?.jobName !== context?.checkName ? `Failed job: ${String(context.jobName)}` : "",
    context?.stepName ? `Failed step: ${String(context.stepName)}` : "",
    context?.summary ? `Failure summary: ${String(context.summary)}` : "",
    Array.isArray(snapshot?.failedChecks) && snapshot.failedChecks.length > 0
      ? `Other failed checks in the settled snapshot (context only; ignore unless the logs show the same root cause):\n${snapshot.failedChecks.map((entry) => `- ${String(entry.name ?? "unknown")}${entry.summary ? `: ${String(entry.summary)}` : ""}`).join("\n")}`
      : "",
    context?.checkUrl ? `Check URL: ${String(context.checkUrl)}` : "",
    Array.isArray(context?.annotations) && context.annotations.length > 0
      ? `Annotations:\n${context.annotations.map((entry) => `- ${String(entry)}`).join("\n")}`
      : "",
    "",
    "Fetch the latest remote branch state first. If the branch moved since this failure, restart from the new tip instead of pushing older work.",
    "Read the latest logs for the named failing check, fix that root cause, and only broaden scope when the logs show direct fallout from the same issue.",
    "Do not change workflows, dependency installation, or unrelated tests unless the failing logs clearly point there.",
    "Run focused verification for the named failure, then commit and push.",
    "Do not open a new PR. Keep working on the existing branch until CI goes green or the situation is clearly stuck.",
    "Do not change test expectations unless the test is genuinely wrong.",
  ].filter(Boolean).join("\n");
}

function appendQueueRepairContext(lines: string[], context?: Record<string, unknown>): void {
  const queueContext = context?.mergeQueueContext;
  if (!queueContext || typeof queueContext !== "object") {
    return;
  }

  const record = queueContext as Record<string, unknown>;
  const conflictingFiles = Array.isArray(record.conflictingFiles)
    ? record.conflictingFiles.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
  const operatorHints = Array.isArray(record.operatorHints)
    ? record.operatorHints.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];

  lines.push("## Merge Queue Context", "");
  if (typeof record.baseBranch === "string") {
    lines.push(`Base branch: ${record.baseBranch}`);
  }
  if (typeof record.baseSha === "string") {
    lines.push(`Base SHA at eviction: ${record.baseSha}`);
  }
  if (typeof record.mergeCommitSha === "string") {
    lines.push(`Synthetic merge commit SHA: ${record.mergeCommitSha}`);
  }
  if (typeof record.checkRunUrl === "string") {
    lines.push(`Steward check run: ${record.checkRunUrl}`);
  }
  if (typeof record.incidentSummary === "string") {
    lines.push(`Steward summary: ${record.incidentSummary}`);
  }
  if (conflictingFiles.length > 0) {
    lines.push("Conflicting files:");
    conflictingFiles.forEach((file) => lines.push(`- ${file}`));
  }
  if (operatorHints.length > 0) {
    lines.push("", "Operator hints:");
    operatorHints.forEach((hint) => lines.push(`- ${hint}`));
  }
  lines.push("");
}

function buildQueueRepairContext(context?: Record<string, unknown>): string {
  const lines: string[] = [];
  appendQueueRepairContext(lines, context);
  lines.push(
    "## Merge Queue Failure",
    "",
    "The merge queue rejected this PR. Rebase onto latest main and fix conflicts.",
    context?.failureReason ? `Failure reason: ${String(context.failureReason)}` : "",
    "",
    "Fetch and rebase onto latest main, resolve conflicts, run verification, push.",
    "If the conflict is a semantic contradiction, explain and stop.",
  );
  return lines.filter(Boolean).join("\n");
}

function buildFollowUpPromptPrelude(issue: IssueRecord, runType: RunType, context?: Record<string, unknown>): string {
  const wakeReason = typeof context?.wakeReason === "string" ? context.wakeReason : undefined;
  const followUps = Array.isArray(context?.followUps) ? context.followUps : [];
  const followUpLines = followUps
    .filter((entry): entry is { type?: unknown; text?: unknown; author?: unknown } => Boolean(entry) && typeof entry === "object")
    .map((entry) => `${String(entry.type ?? "follow_up")} from ${String(entry.author ?? "unknown")}: ${String(entry.text ?? "").trim()}`.trim())
    .filter((line) => !line.endsWith(":"));

  const lines = [
    "## Follow-up Turn",
    "",
    wakeReason === "direct_reply"
      ? "Why this turn exists: A human reply arrived for the outstanding question from the previous turn."
      : wakeReason === "completion_check_continue"
        ? "Why this turn exists: The previous turn ended without a PR, and PatchRelay's completion check decided the work should continue automatically."
      : wakeReason === "branch_upkeep"
        ? "Why this turn exists: GitHub still shows the PR branch as needing upkeep after the requested code change was addressed."
        : wakeReason === "followup_comment"
          ? "Why this turn exists: A human follow-up comment arrived after the previous turn."
          : `Why this turn exists: Continue the existing ${runType} run from the latest issue state.`,
    wakeReason === "direct_reply"
      ? "Required action now: Apply the latest human answer, continue from the current branch/session context, and publish the next concrete result."
      : wakeReason === "completion_check_continue"
        ? "Required action now: Continue from the current branch and thread context, finish the task, and publish the next concrete result."
      : "Required action now: Continue from the latest branch state, refresh any stale assumptions, and publish the next concrete result.",
    "",
  ];

  if (wakeReason === "completion_check_continue" && typeof context?.completionCheckSummary === "string" && context.completionCheckSummary.trim()) {
    lines.push(`Completion check summary: ${context.completionCheckSummary.trim()}`, "");
  }

  if (followUpLines.length > 0) {
    lines.push("Recent updates:");
    followUpLines.forEach((line) => lines.push(`- ${line}`));
    lines.push("");
  }

  if (issue.prNumber || issue.prHeadSha || issue.prReviewState || context?.mergeStateStatus) {
    lines.push(
      "## Current PR Facts",
      "",
      `Fact freshness: ${
        context?.githubFactsFresh === true
          ? "refreshed immediately before this turn was created."
          : "may now be stale; refresh before making irreversible decisions."
      }`,
      issue.prNumber ? `Current PR: #${issue.prNumber}` : "",
      issue.prHeadSha ? `Current relevant head SHA: ${issue.prHeadSha}` : "",
      issue.prReviewState ? `Current review state: ${issue.prReviewState}` : "",
      typeof context?.mergeStateStatus === "string" ? `Merge state against ${String(context?.baseBranch ?? "main")}: ${String(context.mergeStateStatus)}` : "",
    );
  }

  return lines.filter(Boolean).join("\n");
}

function buildReactiveContext(runType: RunType, issue: IssueRecord, context?: Record<string, unknown>, followUp = false): string | undefined {
  const lines: string[] = [];

  if (followUp) {
    lines.push(buildFollowUpPromptPrelude(issue, runType, context), "");
  }

  switch (runType) {
    case "ci_repair":
      lines.push(buildCiRepairContext(context));
      break;
    case "review_fix":
    case "branch_upkeep":
      lines.push(buildRequestedChangesContext(runType, context));
      break;
    case "queue_repair":
      lines.push(buildQueueRepairContext(context));
      break;
    default:
      break;
  }

  const content = lines.map((line) => line.trimEnd()).join("\n").trim();
  return content.length > 0 ? content : undefined;
}

function buildWorkflowGuidance(repoPath: string, runType: RunType): string {
  const workflowBody = readWorkflowFile(repoPath, runType);
  if (workflowBody) return workflowBody;
  if (runType === "implementation") {
    return "Implement the Linear issue. Read the issue via MCP for details.";
  }
  return "";
}

function buildPublicationContract(
  runType: RunType,
): string {
  if (runType === "implementation") {
    return [
      "## Publication Requirements",
      "",
      "Before finishing, publish the result instead of leaving it only in the worktree.",
      "If the task is genuinely complete without a PR, say so clearly in your normal summary instead of inventing one.",
      "If the worktree already contains relevant changes for this issue, verify them and publish them.",
      "If you changed files for this issue, commit them, push the issue branch, and open or update the PR before stopping.",
      "Do not stop with only local commits or uncommitted changes.",
    ].join("\n");
  }

  return [
    "## Publication Requirements",
    "",
    "Before finishing, publish the result to the existing PR branch.",
    "If you changed files for this repair, commit them and push the same branch before stopping.",
    "Do not open a new PR.",
    "Do not stop with only local commits or uncommitted changes.",
  ].join("\n");
}

function buildSections(
  issue: IssueRecord,
  runType: RunType,
  repoPath: string,
  context?: Record<string, unknown>,
  followUp = false,
): PatchRelayPromptSection[] {
  const sections: PatchRelayPromptSection[] = [
    { id: "header", content: buildPromptHeader(issue) },
  ];

  const reactiveContext = buildReactiveContext(runType, issue, context, followUp);
  if (followUp && reactiveContext) {
    sections.push({ id: "follow-up-turn", content: reactiveContext });
  }

  sections.push(
    { id: "task-objective", content: buildTaskObjective(issue) },
    { id: "scope-discipline", content: buildScopeDiscipline(issue) },
  );

  const humanContext = buildHumanContext(context);
  if (humanContext) {
    sections.push({ id: "human-context", content: humanContext });
  }

  if (!followUp && reactiveContext) {
    sections.push({ id: "reactive-context", content: reactiveContext });
  }

  const workflow = buildWorkflowGuidance(repoPath, runType);
  if (workflow) {
    sections.push({ id: "workflow-guidance", content: workflow });
  }

  sections.push({ id: "publication-contract", content: buildPublicationContract(runType) });
  return sections;
}

function filterAllowedReplacements(promptLayer: PromptCustomizationLayer | undefined): Map<PatchRelayReplaceableSectionId, string> {
  const allowed = new Set<string>(PATCHRELAY_REPLACEABLE_SECTION_IDS);
  const replacements = new Map<PatchRelayReplaceableSectionId, string>();
  for (const [sectionId, fragment] of Object.entries(promptLayer?.replaceSections ?? {})) {
    if (!allowed.has(sectionId)) {
      continue;
    }
    replacements.set(sectionId as PatchRelayReplaceableSectionId, fragment.content);
  }
  return replacements;
}

function applyPromptLayer(
  sections: PatchRelayPromptSection[],
  promptLayer: PromptCustomizationLayer | undefined,
): PatchRelayPromptSection[] {
  if (!promptLayer) {
    return sections;
  }

  const replacements = filterAllowedReplacements(promptLayer);
  const replaced = sections.map((section) => ({
    ...section,
    content: replacements.get(section.id as PatchRelayReplaceableSectionId) ?? section.content,
  })).filter((section) => section.content.trim().length > 0);

  if (!promptLayer.extraInstructions || promptLayer.extraInstructions.content.trim().length === 0) {
    return replaced;
  }

  const workflowIndex = replaced.findIndex((section) => section.id === "workflow-guidance");
  const extraSection: PatchRelayPromptSection = {
    id: "extra-instructions",
    content: ["## Extra Instructions", "", promptLayer.extraInstructions.content.trim()].join("\n"),
  };
  if (workflowIndex === -1) {
    return [...replaced, extraSection];
  }

  return [
    ...replaced.slice(0, workflowIndex),
    extraSection,
    ...replaced.slice(workflowIndex),
  ];
}

function renderPromptSections(sections: PatchRelayPromptSection[]): string {
  return sections
    .map((section) => section.content.trim())
    .filter(Boolean)
    .join("\n\n");
}

function shouldBuildFollowUpPrompt(runType: RunType, context?: Record<string, unknown>): boolean {
  if (context?.followUpMode) return true;
  if (runType !== "implementation") return true;
  const wakeReason = typeof context?.wakeReason === "string" ? context.wakeReason : undefined;
  return Boolean(wakeReason && wakeReason !== "delegated");
}

export function resolvePromptLayers(
  config: PatchRelayPromptingConfig | undefined,
  runType: RunType,
): PromptCustomizationLayer | undefined {
  return mergePromptCustomizationLayers(config?.default, config?.byRunType[runType]);
}

export function mergePromptCustomizationLayers(
  base: PromptCustomizationLayer | undefined,
  override: PromptCustomizationLayer | undefined,
): PromptCustomizationLayer | undefined {
  if (!base && !override) {
    return undefined;
  }
  return {
    ...(override?.extraInstructions
      ? { extraInstructions: override.extraInstructions }
      : base?.extraInstructions
      ? { extraInstructions: base.extraInstructions }
      : {}),
    replaceSections: {
      ...(base?.replaceSections ?? {}),
      ...(override?.replaceSections ?? {}),
    },
  };
}

export function findUnknownPatchRelayPromptSectionIds(promptLayer: PromptCustomizationLayer | undefined): string[] {
  const known = new Set<string>(PATCHRELAY_PROMPT_SECTION_IDS);
  const unknown = new Set<string>();
  for (const sectionId of Object.keys(promptLayer?.replaceSections ?? {})) {
    if (!known.has(sectionId)) {
      unknown.add(sectionId);
    }
  }
  return [...unknown];
}

export function findDisallowedPatchRelayPromptSectionIds(promptLayer: PromptCustomizationLayer | undefined): string[] {
  const allowed = new Set<string>(PATCHRELAY_REPLACEABLE_SECTION_IDS);
  const known = new Set<string>(PATCHRELAY_PROMPT_SECTION_IDS);
  const disallowed = new Set<string>();
  for (const sectionId of Object.keys(promptLayer?.replaceSections ?? {})) {
    if (known.has(sectionId) && !allowed.has(sectionId)) {
      disallowed.add(sectionId);
    }
  }
  return [...disallowed];
}

export function buildInitialRunPrompt(params: PatchRelayPromptBuildParams): string {
  return renderPromptSections(applyPromptLayer(
    buildSections(params.issue, params.runType, params.repoPath, params.context, false),
    params.promptLayer,
  ));
}

export function buildFollowUpRunPrompt(params: PatchRelayPromptBuildParams): string {
  return renderPromptSections(applyPromptLayer(
    buildSections(params.issue, params.runType, params.repoPath, params.context, true),
    params.promptLayer,
  ));
}

export function buildRunPrompt(params: PatchRelayPromptBuildParams): string {
  if (shouldBuildFollowUpPrompt(params.runType, params.context)) {
    return buildFollowUpRunPrompt(params);
  }
  return buildInitialRunPrompt(params);
}
