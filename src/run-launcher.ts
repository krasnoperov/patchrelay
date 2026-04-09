import type { Logger } from "pino";
import type { GitHubAppBotIdentity } from "./github-app-token.ts";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { FactoryState, RunType } from "./factory-state.ts";
import { buildHookEnv, runProjectHook } from "./hook-runner.ts";
import { buildRunFailureActivity } from "./linear-session-reporting.ts";
import { loadPatchRelayRepoPrompting } from "./patchrelay-customization.ts";
import {
  buildRunPrompt as buildPatchRelayRunPrompt,
  findDisallowedPatchRelayPromptSectionIds,
  findUnknownPatchRelayPromptSectionIds,
  mergePromptCustomizationLayers,
  resolvePromptLayers,
} from "./prompting/patchrelay.ts";
import type { PendingRunWake } from "./run-wake-planner.ts";
import type { AppConfig, LinearAgentActivityContent } from "./types.ts";
import { execCommand } from "./utils.ts";
import { WorktreeManager } from "./worktree-manager.ts";

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function shouldCompactThread(issue: IssueRecord, threadGeneration: number | undefined, context?: Record<string, unknown>): boolean {
  const followUpCount = typeof context?.followUpCount === "number" ? context.followUpCount : 0;
  return issue.threadId !== undefined
    && (threadGeneration ?? 0) >= 4
    && followUpCount >= 4;
}

function shouldReuseIssueThread(params: {
  existingThreadId?: string | undefined;
  compactThread: boolean;
  resumeThread: boolean;
}): boolean {
  return Boolean(params.existingThreadId) && !params.compactThread && params.resumeThread;
}

export class RunLauncher {
  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly codex: CodexAppServerClient,
    private readonly logger: Logger,
    private readonly worktreeManager: WorktreeManager,
  ) {}

  prepareLaunchPlan(params: {
    project: AppConfig["projects"][number];
    issue: IssueRecord;
    runType: RunType;
    effectiveContext?: Record<string, unknown>;
  }): { prompt: string; branchName: string; worktreePath: string } {
    const repoPrompting = loadPatchRelayRepoPrompting({
      repoRoot: params.project.repoPath,
      logger: this.logger,
    });
    const promptLayer = mergePromptCustomizationLayers(
      resolvePromptLayers(this.config.prompting, params.runType),
      resolvePromptLayers(repoPrompting, params.runType),
    );
    const unknownPromptSections = findUnknownPatchRelayPromptSectionIds(promptLayer);
    if (unknownPromptSections.length > 0) {
      this.logger.warn(
        { issueKey: params.issue.issueKey, runType: params.runType, unknownPromptSections },
        "PatchRelay prompt customization references unknown section ids",
      );
    }
    const disallowedPromptSections = findDisallowedPatchRelayPromptSectionIds(promptLayer);
    if (disallowedPromptSections.length > 0) {
      this.logger.warn(
        { issueKey: params.issue.issueKey, runType: params.runType, disallowedPromptSections },
        "PatchRelay prompt customization attempted to replace non-overridable sections",
      );
    }

    const prompt = buildPatchRelayRunPrompt({
      issue: params.issue,
      runType: params.runType,
      repoPath: params.project.repoPath,
      ...(params.effectiveContext ? { context: params.effectiveContext } : {}),
      ...(promptLayer ? { promptLayer } : {}),
    });

    const issueRef = sanitizePathSegment(params.issue.issueKey ?? params.issue.linearIssueId);
    const slug = params.issue.title ? slugify(params.issue.title) : "";
    const branchSuffix = slug ? `${issueRef}-${slug}` : issueRef;
    const branchName = params.issue.branchName ?? `${params.project.branchPrefix}/${branchSuffix}`;
    const worktreePath = params.issue.worktreePath ?? `${params.project.worktreeRoot}/${issueRef}`;

    return { prompt, branchName, worktreePath };
  }

  claimRun(params: {
    item: { projectId: string; issueId: string };
    issue: IssueRecord;
    leaseId: string;
    runType: RunType;
    prompt: string;
    sourceHeadSha?: string;
    effectiveContext?: Record<string, unknown>;
    materializeLegacyPendingWake: (
      issue: IssueRecord,
      lease: { projectId: string; linearIssueId: string; leaseId: string },
    ) => IssueRecord;
    resolveRunWake: (issue: IssueRecord) => PendingRunWake | undefined;
    branchName: string;
    worktreePath: string;
  }): RunRecord | undefined {
    return this.db.issueSessions.withIssueSessionLease(params.item.projectId, params.item.issueId, params.leaseId, () => {
      const fresh = this.db.getIssue(params.item.projectId, params.item.issueId);
      if (!fresh || fresh.activeRunId !== undefined) return undefined;
      const wakeIssue = params.materializeLegacyPendingWake(fresh, {
        projectId: params.item.projectId,
        linearIssueId: params.item.issueId,
        leaseId: params.leaseId,
      });
      const freshWake = params.resolveRunWake(wakeIssue);
      if (!freshWake || freshWake.runType !== params.runType) return undefined;

      const created = this.db.runs.createRun({
        issueId: fresh.id,
        projectId: params.item.projectId,
        linearIssueId: params.item.issueId,
        runType: params.runType,
        ...(params.sourceHeadSha ? { sourceHeadSha: params.sourceHeadSha } : {}),
        promptText: params.prompt,
      });
      const failureHeadSha = typeof params.effectiveContext?.failureHeadSha === "string"
        ? params.effectiveContext.failureHeadSha
        : typeof params.effectiveContext?.headSha === "string" ? params.effectiveContext.headSha : undefined;
      const failureSignature = typeof params.effectiveContext?.failureSignature === "string" ? params.effectiveContext.failureSignature : undefined;
      this.db.upsertIssue({
        projectId: params.item.projectId,
        linearIssueId: params.item.issueId,
        pendingRunType: null,
        pendingRunContextJson: null,
        activeRunId: created.id,
        branchName: params.branchName,
        worktreePath: params.worktreePath,
        factoryState: params.runType === "implementation" ? "implementing"
          : params.runType === "ci_repair" ? "repairing_ci"
          : params.runType === "review_fix" || params.runType === "branch_upkeep" ? "changes_requested"
          : params.runType === "queue_repair" ? "repairing_queue"
          : "implementing",
        ...((params.runType === "ci_repair" || params.runType === "queue_repair") && failureSignature
          ? {
              lastAttemptedFailureSignature: failureSignature,
              lastAttemptedFailureHeadSha: failureHeadSha ?? null,
            }
          : {}),
      });
      this.db.issueSessions.consumeIssueSessionEvents(params.item.projectId, params.item.issueId, freshWake.eventIds, created.id);
      this.db.issueSessions.setIssueSessionLastWakeReason(params.item.projectId, params.item.issueId, freshWake.wakeReason ?? null);
      this.db.issueSessions.setBranchOwnerWithLease({ projectId: params.item.projectId, linearIssueId: params.item.issueId, leaseId: params.leaseId }, "patchrelay");
      return created;
    });
  }

  async launchTurn(params: {
    project: AppConfig["projects"][number];
    issue: IssueRecord;
    issueSession?: { threadGeneration?: number };
    run: RunRecord;
    runType: RunType;
    prompt: string;
    branchName: string;
    worktreePath: string;
    resumeThread: boolean;
    effectiveContext?: Record<string, unknown>;
    leaseId: string;
    botIdentity?: GitHubAppBotIdentity;
    assertLaunchLease: (run: Pick<RunRecord, "id" | "projectId" | "linearIssueId">, phase: string) => void;
    resetWorktreeToTrackedBranch: (
      worktreePath: string,
      branchName: string,
      issue: Pick<IssueRecord, "issueKey">,
    ) => Promise<void>;
    freshenWorktree: (
      worktreePath: string,
      project: { github?: { baseBranch?: string }; repoPath: string },
      issue: IssueRecord,
    ) => Promise<void>;
    linearSync: {
      emitActivity: (issue: IssueRecord, activity: LinearAgentActivityContent) => Promise<void> | void;
      syncSession: (issue: IssueRecord, options?: { activeRunType?: RunType }) => Promise<void> | void;
    };
    releaseLease: (projectId: string, issueId: string) => void;
    isRequestedChangesRunType: (runType: RunType) => boolean;
    lowerCaseFirst: (value: string) => string;
  }): Promise<{ threadId: string; turnId: string; parentThreadId?: string }> {
    let threadId: string;
    let turnId: string;
    let parentThreadId: string | undefined;
    try {
      await this.worktreeManager.ensureIssueWorktree(
        params.project.repoPath,
        params.project.worktreeRoot,
        params.worktreePath,
        params.branchName,
        { allowExistingOutsideRoot: params.issue.branchName !== undefined },
      );

      if (params.botIdentity) {
        const gitBin = this.config.runner.gitBin;
        await execCommand(gitBin, ["-C", params.worktreePath, "config", "user.name", params.botIdentity.name], { timeoutMs: 5_000 });
        await execCommand(gitBin, ["-C", params.worktreePath, "config", "user.email", params.botIdentity.email], { timeoutMs: 5_000 });
        const credentialHelper = `!f() { echo "username=x-access-token"; echo "password=$(cat ${params.botIdentity.tokenFile})"; }; f`;
        await execCommand(gitBin, ["-C", params.worktreePath, "config", "credential.helper", credentialHelper], { timeoutMs: 5_000 });
      }

      await params.resetWorktreeToTrackedBranch(params.worktreePath, params.branchName, params.issue);
      if (params.runType !== "queue_repair") {
        await params.freshenWorktree(params.worktreePath, params.project, params.issue);
      }

      const hookEnv = buildHookEnv(params.issue.issueKey ?? params.issue.linearIssueId, params.branchName, params.runType, params.worktreePath);
      const prepareResult = await runProjectHook(params.project.repoPath, "prepare-worktree", { cwd: params.worktreePath, env: hookEnv });
      if (prepareResult.ran && prepareResult.exitCode !== 0) {
        throw new Error(`prepare-worktree hook failed (exit ${prepareResult.exitCode}): ${prepareResult.stderr?.slice(0, 500) ?? ""}`);
      }
      params.assertLaunchLease(params.run, "before starting the Codex turn");

      const compactThread = shouldCompactThread(params.issue, params.issueSession?.threadGeneration, params.effectiveContext);
      if (compactThread && params.issue.threadId) {
        parentThreadId = params.issue.threadId;
      }
      if (shouldReuseIssueThread({ existingThreadId: params.issue.threadId, compactThread, resumeThread: params.resumeThread })) {
        threadId = params.issue.threadId!;
      } else {
        const thread = await this.codex.startThread({ cwd: params.worktreePath });
        threadId = thread.id;
        this.db.issueSessions.upsertIssueWithLease(
          { projectId: params.project.id, linearIssueId: params.issue.linearIssueId, leaseId: params.leaseId },
          { projectId: params.project.id, linearIssueId: params.issue.linearIssueId, threadId },
        );
      }

      try {
        const turn = await this.codex.startTurn({ threadId, cwd: params.worktreePath, input: params.prompt });
        turnId = turn.turnId;
      } catch (turnError) {
        const msg = turnError instanceof Error ? turnError.message : String(turnError);
        if (msg.includes("thread not found") || msg.includes("not materialized")) {
          this.logger.info({ issueKey: params.issue.issueKey, staleThreadId: threadId }, "Thread is stale, retrying with fresh thread");
          const thread = await this.codex.startThread({ cwd: params.worktreePath });
          threadId = thread.id;
          this.db.issueSessions.upsertIssueWithLease(
            { projectId: params.project.id, linearIssueId: params.issue.linearIssueId, leaseId: params.leaseId },
            { projectId: params.project.id, linearIssueId: params.issue.linearIssueId, threadId },
          );
          const turn = await this.codex.startTurn({ threadId, cwd: params.worktreePath, input: params.prompt });
          turnId = turn.turnId;
        } else {
          throw turnError;
        }
      }
      params.assertLaunchLease(params.run, "after starting the Codex turn");
      return { threadId, turnId, ...(parentThreadId ? { parentThreadId } : {}) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lostLease = error instanceof Error && error.name === "IssueSessionLeaseLostError";
      if (!lostLease) {
        const nextState: FactoryState = params.isRequestedChangesRunType(params.runType) ? "escalated" : "failed";
        this.db.issueSessions.finishRunWithLease({ projectId: params.project.id, linearIssueId: params.issue.linearIssueId, leaseId: params.leaseId }, params.run.id, {
          status: "failed",
          failureReason: message,
        });
        this.db.issueSessions.upsertIssueWithLease(
          { projectId: params.project.id, linearIssueId: params.issue.linearIssueId, leaseId: params.leaseId },
          {
            projectId: params.project.id,
            linearIssueId: params.issue.linearIssueId,
            activeRunId: null,
            factoryState: nextState,
          },
        );
      }
      this.logger.error({ issueKey: params.issue.issueKey, runType: params.runType, error: message }, `Failed to launch ${params.runType} run`);
      const failedIssue = this.db.getIssue(params.project.id, params.issue.linearIssueId) ?? params.issue;
      void params.linearSync.emitActivity(failedIssue, buildRunFailureActivity(params.runType, `Failed to start ${params.lowerCaseFirst(message)}`));
      void params.linearSync.syncSession(failedIssue, { activeRunType: params.runType });
      params.releaseLease(params.project.id, params.issue.linearIssueId);
      throw error;
    }
  }
}
