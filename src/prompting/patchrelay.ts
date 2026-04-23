import { existsSync } from "node:fs";
import path from "node:path";
import type { IssueRecord } from "../db-types.ts";
import type { RunType } from "../factory-state.ts";
import type { IssueClass } from "../issue-class.ts";
import { derivePrDisplayContext } from "../pr-display-context.ts";
import type { PatchRelayPromptingConfig, PromptCustomizationLayer } from "../types.ts";

const WORKFLOW_FILES: Record<RunType, string> = {
  implementation: "IMPLEMENTATION_WORKFLOW.md",
  main_repair: "IMPLEMENTATION_WORKFLOW.md",
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

function hasWorkflowFile(repoPath: string, runType: RunType): boolean {
  const filename = WORKFLOW_FILES[runType];
  const filePath = path.join(repoPath, filename);
  return existsSync(filePath);
}

function buildPromptHeader(issue: IssueRecord): string {
  const prContext = derivePrDisplayContext(issue);
  const prLine = prContext.kind === "active_pr"
    ? `PR: #${prContext.prNumber}`
    : prContext.kind === "merged_pr"
      ? `Merged PR: #${prContext.prNumber}`
      : prContext.kind === "closed_historical_pr"
        ? `Previous PR: #${prContext.prNumber} (closed)`
        : prContext.kind === "closed_replacement_pending"
          ? `Previous PR: #${prContext.prNumber} (closed; replacement PR needed)`
          : prContext.kind === "closed_pr_paused"
            ? `Previous PR: #${prContext.prNumber} (closed; redelegate to replace it)`
            : undefined;
  return [
    `Issue: ${issue.issueKey ?? issue.linearIssueId}`,
    issue.title ? `Title: ${issue.title}` : undefined,
    issue.branchName ? `Branch: ${issue.branchName}` : undefined,
    prLine,
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

function summarizeRelationEntries(
  entries: Array<Record<string, unknown>>,
  options?: { emptyText?: string; maxItems?: number },
): string[] {
  if (entries.length === 0) {
    return options?.emptyText ? [options.emptyText] : [];
  }

  const maxItems = options?.maxItems ?? 5;
  const lines = entries.slice(0, maxItems).map((entry) => {
    const issueRef = typeof entry.issueKey === "string" && entry.issueKey.trim()
      ? entry.issueKey.trim()
      : typeof entry.linearIssueId === "string" && entry.linearIssueId.trim()
        ? entry.linearIssueId.trim()
        : "unknown issue";
    const title = typeof entry.title === "string" && entry.title.trim() ? entry.title.trim() : undefined;
    const stateName = typeof entry.stateName === "string" && entry.stateName.trim()
      ? entry.stateName.trim()
      : typeof entry.currentLinearState === "string" && entry.currentLinearState.trim()
        ? entry.currentLinearState.trim()
        : undefined;
    const factoryState = typeof entry.factoryState === "string" && entry.factoryState.trim() ? entry.factoryState.trim() : undefined;
    const delegated = typeof entry.delegatedToPatchRelay === "boolean"
      ? (entry.delegatedToPatchRelay ? "delegated" : "not delegated")
      : undefined;
    const openPr = typeof entry.hasOpenPr === "boolean"
      ? (entry.hasOpenPr ? "open PR" : "no open PR")
      : undefined;

    return [
      `- ${issueRef}`,
      title ? `: ${title}` : "",
      [stateName, factoryState, delegated, openPr].filter(Boolean).length > 0
        ? ` (${[stateName, factoryState, delegated, openPr].filter(Boolean).join("; ")})`
        : "",
    ].join("");
  });

  if (entries.length > maxItems) {
    lines.push(`- ...and ${entries.length - maxItems} more`);
  }
  return lines;
}

function buildIssueTopology(context?: Record<string, unknown>): string[] {
  const unresolvedBlockers = Array.isArray(context?.unresolvedBlockers)
    ? context.unresolvedBlockers.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : [];
  const childIssues = Array.isArray(context?.childIssues)
    ? context.childIssues.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : Array.isArray(context?.trackedDependents)
      ? context.trackedDependents.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : [];

  if (unresolvedBlockers.length === 0 && childIssues.length === 0) {
    return [];
  }

  const lines = ["### Issue Topology", ""];
  if (unresolvedBlockers.length > 0) {
    lines.push("Unresolved blockers:");
    lines.push(...summarizeRelationEntries(unresolvedBlockers));
  }
  if (childIssues.length > 0) {
    if (unresolvedBlockers.length > 0) {
      lines.push("");
    }
    lines.push("Canonical child issues:");
    lines.push(...summarizeRelationEntries(childIssues));
  }
  return lines;
}

function buildConstraints(issue: IssueRecord, context?: Record<string, unknown>): string {
  const description = issue.description?.trim();
  const scope = extractIssueSection(description, "Scope");
  const acceptance = extractIssueSection(description, "Acceptance criteria")
    ?? extractIssueSection(description, "Success criteria");
  const relevantCode = extractIssueSection(description, "Relevant code");
  const topology = buildIssueTopology(context);

  return [
    "## Constraints",
    "",
    "Stay inside the delegated task. Do not widen scope into unrelated cleanup or optional polish.",
    "",
    ...(scope ? ["### In Scope", "", scope, ""] : []),
    ...(acceptance ? ["### Acceptance / Done", "", acceptance, ""] : []),
    ...(relevantCode ? ["### Relevant Code", "", relevantCode, ""] : []),
    ...topology,
  ].join("\n");
}

function buildOrchestrationConstraints(context?: Record<string, unknown>): string {
  const unresolvedBlockers = Array.isArray(context?.unresolvedBlockers)
    ? context.unresolvedBlockers.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : [];
  const childIssues = Array.isArray(context?.childIssues)
    ? context.childIssues.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : Array.isArray(context?.trackedDependents)
      ? context.trackedDependents.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : [];

  return [
    "## Constraints",
    "",
    "This issue is orchestration work. Coordinate convergence instead of duplicating child implementation.",
    "Inspect the current child set before acting. Reuse existing child issues when they already cover the needed slices instead of creating duplicates.",
    "Babysit child progress and solve parent-owned integration or convergence issues when the delivered pieces do not yet fit together cleanly.",
    "Do not open an overlapping umbrella PR unless this parent owns unique direct work.",
    "Create new child issues only for genuinely missing required work needed to satisfy the parent goal.",
    "Leave later-wave child issues queued unless they are immediately actionable.",
    "",
    "### Child Issue Summaries",
    "",
    ...(childIssues.length > 0
      ? summarizeRelationEntries(childIssues, { emptyText: "No child issues are currently tracked." })
      : ["No child issues are currently tracked."]),
    "",
    ...(unresolvedBlockers.length > 0
      ? ["### Unresolved Blockers", "", ...summarizeRelationEntries(unresolvedBlockers), ""]
      : []),
    "### Convergence Rule",
    "",
    "- Close the umbrella when the original parent goal is satisfied.",
    "- Create blocking follow-up work only when it is required to satisfy that goal.",
  ].join("\n");
}

function buildHumanContextLines(context?: Record<string, unknown>): string[] {
  const promptContext = typeof context?.promptContext === "string" ? context.promptContext.trim() : "";
  const latestPrompt = typeof context?.promptBody === "string" ? context.promptBody.trim() : "";
  const operatorPrompt = typeof context?.operatorPrompt === "string" ? context.operatorPrompt.trim() : "";
  const userComment = typeof context?.userComment === "string" ? context.userComment.trim() : "";

  const lines: string[] = [];
  if (promptContext) {
    lines.push("Linear session context:", promptContext, "");
  }
  if (latestPrompt) {
    lines.push("Latest human instruction:", latestPrompt, "");
  }
  if (operatorPrompt) {
    lines.push("Operator prompt:", operatorPrompt, "");
  }
  if (userComment) {
    lines.push("Human follow-up comment:", userComment, "");
  }
  return lines;
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
      "Branch upkeep is required on the existing PR branch.",
      "Goal: restore merge readiness on the current branch and push a newer head without regressing review or CI readiness.",
    );
  } else {
    const reviewer = typeof context?.reviewerName === "string" ? context.reviewerName : undefined;
    const reviewBody = typeof context?.reviewBody === "string" ? context.reviewBody.trim() : "";
    lines.push(
      "Requested changes on the existing PR branch.",
      "Goal: restore review readiness and push a newer head on the current PR branch.",
      "Address the real concern behind the feedback and verify nearby invariants in the touched flow before you publish.",
      reviewer ? `Reviewer: ${reviewer}` : "",
      reviewBody ? `Review summary:\n${reviewBody}` : "",
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
    "Settled CI failure on the existing PR branch.",
    "Goal: restore CI readiness and push a branch that is likely to pass the next full CI run.",
    "Before changing code or config, reproduce the failure on the exact failing head or identify the concrete log signature that justifies the fix.",
    "If the exact failing head does not reproduce locally and the logs do not support a scoped fix, prefer a rerun-only repair over speculative branch changes.",
    "Do not use broad revert stacks or repo-wide package-manager/workflow/docs cleanups as a repair tactic; stay on the failing incident only.",
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
  ].filter(Boolean).join("\n");
}

function buildMainRepairContext(context?: Record<string, unknown>): string {
  const failingCheckNames = Array.isArray(context?.failingChecks)
    ? context.failingChecks
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .map((entry) => String(entry.name ?? "").trim())
      .filter((name) => name.length > 0)
    : [];

  return [
    "Base-branch repair on the red mainline.",
    "Goal: restore main by fixing the real persistent failure, not by papering over a transient runner incident.",
    "Before changing code or workflow config, verify that the original incident still persists on the exact failing main SHA or identify a concrete log signature that justifies the fix.",
    "For transient infrastructure symptoms such as disk pressure, runner exhaustion, or network flakiness, prefer a rerun-only repair if the rerun clears the branch.",
    "Do not propose or implement moving CI, deploy, or tests onto different nodes or runner pools unless a human explicitly asked for that infrastructure migration.",
    context?.baseSha ? `Failing main SHA: ${String(context.baseSha)}` : "",
    failingCheckNames.length > 0 ? `Failing checks: ${failingCheckNames.join(", ")}` : "",
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
    "Merge queue rejection on the existing PR branch.",
    "Goal: restore a mergeable branch, verify the queue-blocking fix, and push the existing PR branch.",
    context?.failureReason ? `Failure reason: ${String(context.failureReason)}` : "",
  );
  return lines.filter(Boolean).join("\n");
}

function buildFollowUpContextLines(issue: IssueRecord, runType: RunType, context?: Record<string, unknown>): string[] {
  const prContext = derivePrDisplayContext(issue);
  const wakeReason = typeof context?.wakeReason === "string" ? context.wakeReason : undefined;
  const followUps = Array.isArray(context?.followUps) ? context.followUps : [];
  const followUpLines = followUps
    .filter((entry): entry is { type?: unknown; text?: unknown; author?: unknown } => Boolean(entry) && typeof entry === "object")
    .map((entry) => `${String(entry.type ?? "follow_up")} from ${String(entry.author ?? "unknown")}: ${String(entry.text ?? "").trim()}`.trim())
    .filter((line) => !line.endsWith(":"));

  const lines: string[] = [];
  const turnReason = wakeReason === "direct_reply"
    ? "Human reply to the previous question."
    : wakeReason === "initial_delegate"
      ? "Initial orchestration turn after delegation."
      : wakeReason === "child_delivered"
        ? "A child issue was delivered."
        : wakeReason === "child_changed"
          ? "A child issue changed state."
          : wakeReason === "child_regressed"
            ? "A child issue regressed."
            : wakeReason === "human_instruction"
              ? "A human added new orchestration guidance."
              : wakeReason === "completion_check_continue"
                ? "The previous turn ended without a PR and PatchRelay chose to continue automatically."
                : wakeReason === "branch_upkeep"
                  ? "GitHub still shows the PR branch as needing upkeep."
                  : wakeReason === "followup_comment"
                    ? "A human follow-up comment arrived after the previous turn."
                    : `Continue the existing ${runType} run from the latest issue state.`;

  lines.push(`Turn reason: ${turnReason}`);

  if (wakeReason === "completion_check_continue" && typeof context?.completionCheckSummary === "string" && context.completionCheckSummary.trim()) {
    lines.push(`Completion check summary: ${context.completionCheckSummary.trim()}`);
  }

  if (followUpLines.length > 0) {
    lines.push("", "Recent updates:");
    followUpLines.forEach((line) => lines.push(`- ${line}`));
  }

  if (issue.prNumber || issue.prHeadSha || issue.prReviewState || context?.mergeStateStatus) {
    const prHeading = prContext.kind === "closed_historical_pr"
      || prContext.kind === "closed_replacement_pending"
      || prContext.kind === "closed_pr_paused"
      ? "Previous PR facts:"
      : "Current PR facts:";
    const prLine = prContext.kind === "active_pr"
      ? `Current PR: #${prContext.prNumber}`
      : prContext.kind === "merged_pr"
        ? `Merged PR: #${prContext.prNumber}`
        : prContext.kind === "closed_historical_pr"
          ? `Previous PR: #${prContext.prNumber} (closed)`
          : prContext.kind === "closed_replacement_pending"
            ? `Previous PR: #${prContext.prNumber} (closed; replacement PR needed)`
            : prContext.kind === "closed_pr_paused"
              ? `Previous PR: #${prContext.prNumber} (closed; redelegate to replace it)`
              : "";
    lines.push(
      "",
      prHeading,
      `Fact freshness: ${
        context?.githubFactsFresh === true
          ? "refreshed immediately before this turn was created."
          : "may now be stale; refresh before making irreversible decisions."
      }`,
      prLine,
      issue.prHeadSha ? `Current relevant head SHA: ${issue.prHeadSha}` : "",
      issue.prReviewState ? `Current review state: ${issue.prReviewState}` : "",
      typeof context?.mergeStateStatus === "string" ? `Merge state against ${String(context?.baseBranch ?? "main")}: ${String(context.mergeStateStatus)}` : "",
    );
  }

  return lines.filter(Boolean);
}

function buildCurrentContext(runType: RunType, issue: IssueRecord, context?: Record<string, unknown>, followUp = false): string | undefined {
  const lines: string[] = [];

  if (followUp) {
    lines.push(...buildFollowUpContextLines(issue, runType, context), "");
  }

  lines.push(...buildHumanContextLines(context));

  switch (runType) {
    case "main_repair":
      lines.push(buildMainRepairContext(context));
      break;
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
  if (!content.length) return undefined;
  return ["## Current Context", "", content].join("\n");
}

function buildWorkflowGuidance(repoPath: string, runType: RunType): string {
  const filename = WORKFLOW_FILES[runType];
  if (hasWorkflowFile(repoPath, runType)) {
    return [
      "## Workflow",
      "",
      `Read and follow \`${filename}\` in the repository for task-specific behavior before making irreversible changes.`,
    ].join("\n");
  }
  return [
    "## Workflow",
    "",
    "Use repository docs and local guidance as the source of truth for task-specific behavior.",
  ].join("\n");
}

function buildOrchestrationWorkflowGuidance(): string {
  return [
    "## Workflow",
    "",
    "Use the wake reason and child issue summaries to decide the next orchestration step.",
    "Prefer supervising, auditing, and unblocking existing child work over creating more issues.",
    "If the parent goal now depends on an integration fix between delivered child slices, own that convergence work here without restating already-owned child implementation.",
    "Keep outputs concise and observable in Linear.",
  ].join("\n");
}

function buildPrePushSelfReviewSection(target: "new_pr" | "existing_pr", runType: RunType): string[] {
  const publishTarget = target === "new_pr"
    ? "open or update the PR"
    : "push the existing PR branch";

  const lines = [
    "## Final Self-Review Before Push",
    "",
    `Before you ${publishTarget}, do one brief reviewer-minded pass on the current head.`,
    "Fix any likely in-scope blocker you can see now: missing edge-case handling, broken adjacent invariant in the touched flow, mismatch between the PR explanation and the code, or an obviously unreviewable half-finished branch.",
  ];

  if (runType === "implementation") {
    lines.push(
      "Name 2-4 concrete invariants most likely to regress in the touched flow, confirm which file or path enforces each one, and verify at least one adjacent path you did not edit directly.",
      "If you changed schema, enums, shared vocabulary, normalization helpers, or compatibility mappings, inspect the main read/write paths that can bypass the new abstraction and verify one legacy-flow and one new-flow case before publishing.",
    );
  }

  lines.push(
    "Do not widen scope for optional cleanup. If the issue explicitly allows a non-PR outcome, complete that outcome clearly; otherwise publish before stopping.",
  );

  if (runType === "review_fix" || runType === "branch_upkeep" || runType === "ci_repair" || runType === "queue_repair") {
    lines.push(
      "On reactive repair runs, do not publish broad revert stacks or unrelated workflow/package-manager/docs churn. If that seems necessary, stop and surface the blocker instead.",
    );
  }

  return lines;
}

function buildPublicationContract(
  runType: RunType,
  issueClass?: IssueClass,
): string {
  if (issueClass === "orchestration") {
    return [
      "## Publish",
      "",
      "Publish the orchestration outcome clearly: observation, follow-up issues, rollout update, closeout, or a small parent-owned cleanup PR.",
      "Do not open an overlapping umbrella PR unless this parent owns unique direct work.",
    ].join("\n");
  }
  if (runType === "implementation") {
    return [
      "## Publish",
      "",
      "If this is code-delivery work, publish before stopping: commit, push the issue branch, and open or update the PR.",
      "If the issue explicitly allows a non-PR outcome, complete that outcome clearly instead of inventing a PR.",
      "",
      ...buildPrePushSelfReviewSection("new_pr", runType),
    ].join("\n");
  }

  return [
    "## Publish",
    "",
    "Restore and publish on the existing PR branch: commit and push the same branch.",
    "Do not open a new PR.",
    "A PR-less stop is not a successful outcome for a repair run unless a genuine external blocker prevents any correct push.",
    "",
    ...buildPrePushSelfReviewSection("existing_pr", runType),
  ].join("\n");
}

function buildSections(
  issue: IssueRecord,
  runType: RunType,
  repoPath: string,
  context?: Record<string, unknown>,
  followUp = false,
): PatchRelayPromptSection[] {
  const issueClass = issue.issueClass;
  const sections: PatchRelayPromptSection[] = [
    { id: "header", content: buildPromptHeader(issue) },
  ];

  const currentContext = buildCurrentContext(runType, issue, context, followUp);

  sections.push(
    { id: "task-objective", content: buildTaskObjective(issue) },
    {
      id: "scope-discipline",
      content: issueClass === "orchestration" ? buildOrchestrationConstraints(context) : buildConstraints(issue, context),
    },
  );

  if (currentContext) {
    sections.push({ id: "reactive-context", content: currentContext });
  }

  const workflow = issueClass === "orchestration"
    ? buildOrchestrationWorkflowGuidance()
    : buildWorkflowGuidance(repoPath, runType);
  if (workflow) {
    sections.push({ id: "workflow-guidance", content: workflow });
  }

  sections.push({ id: "publication-contract", content: buildPublicationContract(runType, issueClass) });
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
