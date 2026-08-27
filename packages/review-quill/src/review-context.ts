import type { Logger } from "pino";
import type { GitHubClient } from "./github-client.ts";
import type { PullRequestSummary, ReviewContext, ReviewQuillRepositoryConfig } from "./types.ts";
import { loadReviewQuillRepoPrompting } from "./customization.ts";
import { buildDiffContext } from "./diff-context/index.ts";
import { buildPromptContext } from "./prompt-context/index.ts";
import {
  renderFollowUpReviewPrompt,
  renderNativeFollowUpReviewPrompt,
  renderNativeReviewPrompt,
  renderReviewDeveloperInstructions,
  renderReviewPrompt,
} from "./prompt-builder/index.ts";
import { findDisallowedReviewPromptSectionIds, findUnknownReviewPromptSectionIds } from "./prompt-builder/render.ts";
import { materializeReviewWorkspace } from "./review-workspace/index.ts";
import type { PriorReviewThreadCandidate } from "./prior-review-thread-selector.ts";
import { buildPromptFingerprint } from "./prompt-fingerprint.ts";

export async function resolvePromptPullRequest(params: {
  github: GitHubClient;
  repoFullName: string;
  pr: PullRequestSummary;
}): Promise<PullRequestSummary> {
  const latestPr = await params.github.getPullRequest(params.repoFullName, params.pr.number);
  // Keep the reconcile-selected head stable. We only refresh the mutable PR
  // description/title when GitHub still points at the same commit.
  if (latestPr.headSha !== params.pr.headSha || latestPr.baseSha !== params.pr.baseSha) {
    return params.pr;
  }
  return {
    ...params.pr,
    ...latestPr,
  };
}

export function revalidatePriorThreadForPrompt(
  candidate: PriorReviewThreadCandidate | undefined,
  promptPr: PullRequestSummary,
): PriorReviewThreadCandidate | undefined {
  return candidate?.promptFingerprint === buildPromptFingerprint(promptPr) ? candidate : undefined;
}

function mergePromptCustomization(
  base: ReviewContext["promptCustomization"],
  override: ReviewContext["promptCustomization"] | undefined,
): ReviewContext["promptCustomization"] {
  return {
    ...(override?.extraInstructions
      ? { extraInstructions: override.extraInstructions }
      : base.extraInstructions
      ? { extraInstructions: base.extraInstructions }
      : {}),
    replaceSections: {
      ...base.replaceSections,
      ...override?.replaceSections,
    },
  };
}

export async function buildReviewContext(params: {
  github: GitHubClient;
  repo: ReviewQuillRepositoryConfig;
  pr: PullRequestSummary;
  prompting: ReviewContext["promptCustomization"];
  logger: Logger;
  selfLogin: string | undefined;
  priorThread?: PriorReviewThreadCandidate;
  materialized?: Awaited<ReturnType<typeof materializeReviewWorkspace>>;
}): Promise<{ context: ReviewContext; dispose: () => Promise<void>; priorThread?: PriorReviewThreadCandidate }> {
  const materialized = params.materialized ?? await (async () => {
    const token = params.github.currentTokenForRepo(params.repo.repoFullName);
    if (!token) {
      throw new Error(`No GitHub installation token available for ${params.repo.repoFullName}`);
    }
    return await materializeReviewWorkspace({
      repoFullName: params.repo.repoFullName,
      pr: params.pr,
      token,
    });
  })();

  try {
    const promptPr = await resolvePromptPullRequest({
      github: params.github,
      repoFullName: params.repo.repoFullName,
      pr: params.pr,
    });
    // The candidate was selected from an earlier PR metadata snapshot. Only
    // reuse it when the exact snapshot rendered below has the same prompt
    // fingerprint; title/body edits during workspace preparation must start a
    // full fresh review instead of anchoring a bounded follow-up to stale
    // context.
    const priorThread = revalidatePriorThreadForPrompt(params.priorThread, promptPr);
    const diff = await buildDiffContext(params.repo, materialized.workspace);
    const promptContext = await buildPromptContext(
      params.github,
      params.repo.repoFullName,
      promptPr,
      materialized.workspace,
      params.repo.reviewDocs,
      params.selfLogin,
      priorThread?.completedAt,
    );
    const repoPromptCustomization = loadReviewQuillRepoPrompting({
      repoRoot: materialized.workspace.worktreePath,
      logger: params.logger,
    });
    const baseContext = {
      workspaceMode: "checkout" as const,
      workspace: materialized.workspace,
      repo: params.repo,
      pr: promptPr,
      diff,
      promptCustomization: mergePromptCustomization(params.prompting, repoPromptCustomization),
      promptContext,
    };
    const unknownPromptSections = findUnknownReviewPromptSectionIds(baseContext.promptCustomization.replaceSections);
    if (unknownPromptSections.length > 0) {
      params.logger.warn(
        { repo: params.repo.repoFullName, prNumber: params.pr.number, unknownPromptSections },
        "Review Quill prompt customization references unknown section ids",
      );
    }
    const disallowedPromptSections = findDisallowedReviewPromptSectionIds(baseContext.promptCustomization.replaceSections);
    if (disallowedPromptSections.length > 0) {
      params.logger.warn(
        { repo: params.repo.repoFullName, prNumber: params.pr.number, disallowedPromptSections },
        "Review Quill prompt customization attempted to replace non-overridable sections",
      );
    }
    const prompt = renderReviewPrompt(baseContext);
    const followUpPrompt = priorThread
      ? renderFollowUpReviewPrompt(baseContext, priorThread.priorHeadSha)
      : undefined;
    const developerInstructions = renderReviewDeveloperInstructions(baseContext);
    const nativeReviewPrompt = renderNativeReviewPrompt(baseContext);
    const nativeFollowUpReviewPrompt = priorThread
      ? renderNativeFollowUpReviewPrompt(baseContext, priorThread.priorHeadSha)
      : undefined;
    return {
      context: {
        ...baseContext,
        prompt,
        developerInstructions,
        nativeReviewPrompt,
        ...(followUpPrompt ? { followUpPrompt } : {}),
        ...(nativeFollowUpReviewPrompt ? { nativeFollowUpReviewPrompt } : {}),
      },
      dispose: materialized.dispose,
      ...(priorThread ? { priorThread } : {}),
    };
  } catch (error) {
    await materialized.dispose();
    throw error;
  }
}
