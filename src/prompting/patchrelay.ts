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

interface PatchRelayPromptSection {
  id: PatchRelayPromptSectionId | `custom:${string}`;
  content: string;
}

export interface PatchRelayPromptBuildParams {
  issue: IssueRecord;
  runType: RunType;
  repoPath: string;
  context?: Record<string, unknown>;
  promptLayers?: PromptCustomizationLayer[];
}

function readWorkflowFile(repoPath: string, runType: RunType): string | undefined {
  const filename = WORKFLOW_FILES[runType];
  const filePath = path.join(repoPath, filename);
  if (!existsSync(filePath)) return undefined;
  return readFileSync(filePath, "utf8").trim();
}

export type ImplementationDeliveryMode = "publish_pr" | "linear_only";

function collectImplementationInstructionText(
  issue: Pick<IssueRecord, "title" | "description">,
  context?: Record<string, unknown>,
  promptText?: string,
): string {
  const parts: string[] = [];
  if (issue.title) parts.push(issue.title);
  if (issue.description) parts.push(issue.description);
  if (promptText) parts.push(promptText);

  const stringFields = ["promptContext", "promptBody", "operatorPrompt", "userComment"];
  for (const field of stringFields) {
    const value = context?.[field];
    if (typeof value === "string" && value.trim()) {
      parts.push(value);
    }
  }

  if (Array.isArray(context?.followUps)) {
    for (const entry of context.followUps) {
      if (!entry || typeof entry !== "object") continue;
      const text = (entry as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) {
        parts.push(text);
      }
    }
  }

  return parts.join("\n").toLowerCase();
}

export function resolveImplementationDeliveryMode(
  issue: Pick<IssueRecord, "title" | "description">,
  context?: Record<string, unknown>,
  promptText?: string,
): ImplementationDeliveryMode {
  const instructionText = collectImplementationInstructionText(issue, context, promptText);
  if (!instructionText) return "publish_pr";

  const hasExplicitNoPr = [
    /\bdo not open (?:a |any )?pr\b/,
    /\bdo not open (?:a |any )?pull request\b/,
    /\bno pr is opened\b/,
    /\bpatchrelay should not open a pr\b/,
    /\bwithout opening a pr\b/,
  ].some((pattern) => pattern.test(instructionText));
  const forbidsRepoChanges = [
    /\bdo not make repository changes\b/,
    /\bdo not make repo changes\b/,
    /\bno repository changes\b/,
    /\bno repo changes\b/,
    /\bdo not modify repo files\b/,
  ].some((pattern) => pattern.test(instructionText));
  const planningOnly = [
    /\bplanning\/specification issue only\b/,
    /\bplanning[- ]only\b/,
    /\bspecification[- ]only\b/,
    /\bplanning issue only\b/,
  ].some((pattern) => pattern.test(instructionText));

  if (hasExplicitNoPr || (planningOnly && forbidsRepoChanges)) {
    return "linear_only";
  }
  return "publish_pr";
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

function buildTaskObjective(issue: IssueRecord): string {
  const description = issue.description?.trim();
  return [
    "## Task Objective",
    "",
    issue.title || `Complete ${issue.issueKey ?? issue.linearIssueId}.`,
    ...(description ? ["", description] : []),
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

function isRequestedChangesRunType(runType: RunType): boolean {
  return runType === "review_fix" || runType === "branch_upkeep";
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
      : wakeReason === "branch_upkeep"
        ? "Why this turn exists: GitHub still shows the PR branch as needing upkeep after the requested code change was addressed."
        : wakeReason === "followup_comment"
          ? "Why this turn exists: A human follow-up comment arrived after the previous turn."
          : `Why this turn exists: Continue the existing ${runType} run from the latest issue state.`,
    wakeReason === "direct_reply"
      ? "Required action now: Apply the latest human answer, continue from the current branch/session context, and publish the next concrete result."
      : "Required action now: Continue from the latest branch state, refresh any stale assumptions, and publish the next concrete result.",
    "",
  ];

  if (followUpLines.length > 0) {
    lines.push("## What Changed Since The Last Turn", "", ...followUpLines, "");
  }

  if (issue.prNumber || issue.prHeadSha || issue.prReviewState || context?.mergeStateStatus) {
    lines.push(
      "## Fact Freshness",
      "",
      context?.githubFactsFresh === true
        ? "GitHub facts below were refreshed immediately before this turn was created."
        : "GitHub facts below may now be stale. Refresh them before making any irreversible decision.",
      "",
      "## Authoritative GitHub Facts",
      "",
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
  issue?: Pick<IssueRecord, "title" | "description">,
  context?: Record<string, unknown>,
): string {
  const deliveryMode = runType === "implementation" && issue
    ? resolveImplementationDeliveryMode(issue, context)
    : "publish_pr";
  if (runType === "implementation" && deliveryMode === "linear_only") {
    return [
      "## Delivery Requirements",
      "",
      "This issue is planning/specification only.",
      "Do not modify repo files or open a PR for this issue.",
      "Deliver the result through Linear artifacts such as follow-up issues, documents, and a concise summary.",
      "Leave the worktree clean before stopping.",
    ].join("\n");
  }

  if (runType === "implementation") {
    return [
      "## Publication Requirements",
      "",
      "Before finishing, publish the result instead of leaving it only in the worktree.",
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

  sections.push({ id: "publication-contract", content: buildPublicationContract(runType, issue, context) });
  return sections;
}

function applyPromptLayers(
  sections: PatchRelayPromptSection[],
  promptLayers: PromptCustomizationLayer[] | undefined,
): PatchRelayPromptSection[] {
  if (!promptLayers || promptLayers.length === 0) {
    return sections;
  }

  const replacements = new Map<string, string>();
  const prepend: PatchRelayPromptSection[] = [];
  const append: PatchRelayPromptSection[] = [];

  promptLayers.forEach((layer, layerIndex) => {
    layer.prepend.forEach((fragment, fragmentIndex) => {
      prepend.push({ id: `custom:prepend:${layerIndex}:${fragmentIndex}`, content: fragment.content });
    });
    Object.entries(layer.replaceSections).forEach(([sectionId, fragment]) => {
      replacements.set(sectionId, fragment.content);
    });
    layer.append.forEach((fragment, fragmentIndex) => {
      append.push({ id: `custom:append:${layerIndex}:${fragmentIndex}`, content: fragment.content });
    });
  });

  const replaced = sections.map((section) => ({
    ...section,
    content: replacements.get(section.id) ?? section.content,
  })).filter((section) => section.content.trim().length > 0);

  return [
    ...prepend.filter((section) => section.content.trim().length > 0),
    ...replaced,
    ...append.filter((section) => section.content.trim().length > 0),
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
): PromptCustomizationLayer[] {
  if (!config) {
    return [];
  }
  return [config.default, config.byRunType[runType]].filter((layer): layer is PromptCustomizationLayer => Boolean(layer));
}

export function findUnknownPatchRelayPromptSectionIds(promptLayers: PromptCustomizationLayer[] | undefined): string[] {
  const known = new Set<string>(PATCHRELAY_PROMPT_SECTION_IDS);
  const unknown = new Set<string>();
  for (const layer of promptLayers ?? []) {
    for (const sectionId of Object.keys(layer.replaceSections)) {
      if (!known.has(sectionId)) {
        unknown.add(sectionId);
      }
    }
  }
  return [...unknown];
}

export function buildInitialRunPrompt(params: PatchRelayPromptBuildParams): string {
  return renderPromptSections(applyPromptLayers(
    buildSections(params.issue, params.runType, params.repoPath, params.context, false),
    params.promptLayers,
  ));
}

export function buildFollowUpRunPrompt(params: PatchRelayPromptBuildParams): string {
  return renderPromptSections(applyPromptLayers(
    buildSections(params.issue, params.runType, params.repoPath, params.context, true),
    params.promptLayers,
  ));
}

export function buildRunPrompt(params: PatchRelayPromptBuildParams): string {
  if (shouldBuildFollowUpPrompt(params.runType, params.context)) {
    return buildFollowUpRunPrompt(params);
  }
  return buildInitialRunPrompt(params);
}
