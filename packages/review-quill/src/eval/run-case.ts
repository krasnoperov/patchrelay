import type { Logger } from "pino";
import { loadReviewQuillRepoPrompting } from "../customization.ts";
import { buildDiffContext } from "../diff-context/index.ts";
import { alignFindingAnchors } from "../finding-anchors.ts";
import { loadRepoGuidanceDocs } from "../prompt-context/repo-guidance.ts";
import {
  renderNativeReviewPrompt,
  renderReviewDeveloperInstructions,
  renderReviewPrompt,
} from "../prompt-builder/index.ts";
import { renderReviewArtifacts } from "../review-artifact-renderer.ts";
import type { ReviewRunner } from "../review-runner.ts";
import type {
  PromptCustomizationLayer,
  PullRequestSummary,
  ReviewContext,
  ReviewQuillConfig,
  ReviewQuillRepositoryConfig,
  ReviewVerdict,
  ReviewWorkspace,
} from "../types.ts";
import type { ReviewEvalCase } from "./case-file.ts";
import { gradeEvalCase, type EvalGrade } from "./grade.ts";
import { isChangedNewLine } from "./worktree.ts";

function mergePromptCustomization(
  installation: PromptCustomizationLayer,
  repository: PromptCustomizationLayer | undefined,
): PromptCustomizationLayer {
  return {
    ...(repository?.extraInstructions
      ? { extraInstructions: repository.extraInstructions }
      : installation.extraInstructions
      ? { extraInstructions: installation.extraInstructions }
      : {}),
    replaceSections: {
      ...installation.replaceSections,
      ...repository?.replaceSections,
    },
  };
}

function buildPullRequest(evalCase: ReviewEvalCase): PullRequestSummary {
  return {
    number: evalCase.pullRequest,
    title: evalCase.title,
    body: evalCase.body,
    url: `https://github.com/${evalCase.repository}/pull/${evalCase.pullRequest}`,
    state: "OPEN",
    isDraft: false,
    headSha: evalCase.headSha,
    headRefName: evalCase.headBranch,
    baseRefName: evalCase.baseBranch,
    baseSha: evalCase.baseSha,
    labels: [],
  };
}

export interface EvalCaseSuccess {
  status: "completed";
  evalCase: ReviewEvalCase;
  grade: EvalGrade;
  verdict: ReviewVerdict;
  deliveredVerdict: "approve" | "request_changes";
  droppedFindings: number;
  rawReview: string;
  threadId: string;
  reviewTurnId?: string;
  normalizationTurnId: string;
}

export interface EvalCaseFailure {
  status: "failed";
  evalCase: ReviewEvalCase;
  error: string;
}

export type EvalCaseOutcome = EvalCaseSuccess | EvalCaseFailure;

export async function runEvalCase(params: {
  evalCase: ReviewEvalCase;
  config: ReviewQuillConfig;
  repository: ReviewQuillRepositoryConfig;
  workspace: ReviewWorkspace;
  runner: ReviewRunner;
  logger: Logger;
  onProgress?: (threadId: string, turnId: string) => void;
}): Promise<EvalCaseSuccess> {
  const { evalCase, workspace } = params;
  const diff = await buildDiffContext(params.repository, workspace);
  const pr = buildPullRequest(evalCase);
  const guidanceDocs = await loadRepoGuidanceDocs(workspace.worktreePath, evalCase.reviewDocs, [evalCase.title, evalCase.body]);
  const repoCustomization = loadReviewQuillRepoPrompting({ repoRoot: workspace.worktreePath, logger: params.logger });
  const baseContext = {
    workspaceMode: "checkout" as const,
    workspace,
    repo: params.repository,
    pr,
    diff,
    promptCustomization: mergePromptCustomization(params.config.prompting, repoCustomization),
    promptContext: {
      guidanceDocs,
      priorReviewClaims: evalCase.priorReviewClaims.map((excerpt) => ({ excerpt })),
      issueKeys: [],
    },
  };
  const context: ReviewContext = {
    ...baseContext,
    prompt: renderReviewPrompt(baseContext),
    developerInstructions: renderReviewDeveloperInstructions(baseContext),
    nativeReviewPrompt: renderNativeReviewPrompt(baseContext),
  };
  const rawResult = await params.runner.review(context, {
    onThreadProgress: (progress) => params.onProgress?.(progress.threadId, progress.turnId),
  });
  const result = {
    ...rawResult,
    verdict: await alignFindingAnchors(workspace, rawResult.verdict),
  };
  const artifacts = renderReviewArtifacts({
    verdict: result.verdict,
    inventoryPaths: diff.inventory.map((entry) => entry.path),
  });
  const deliveredVerdict = artifacts.event === "REQUEST_CHANGES" ? "request_changes" : "approve";
  const invalidAnchors = (await Promise.all(result.verdict.findings.map(async (finding) => ({
    finding,
    valid: await isChangedNewLine(workspace.worktreePath, evalCase.baseSha, finding.path, finding.line),
  }))))
    .filter((entry) => !entry.valid)
    .map((entry) => `${entry.finding.path}:${entry.finding.line}`);
  return {
    status: "completed",
    evalCase,
    grade: gradeEvalCase(evalCase, result.verdict, invalidAnchors, deliveredVerdict),
    verdict: result.verdict,
    deliveredVerdict,
    droppedFindings: artifacts.dropStats.droppedTotal,
    rawReview: result.rawReview ?? "",
    threadId: result.threadId,
    ...(result.reviewTurnId ? { reviewTurnId: result.reviewTurnId } : {}),
    normalizationTurnId: result.turnId,
  };
}
