import type { Logger } from "pino";
import { setTimeout as delay } from "node:timers/promises";
import type { GitHubAppBotIdentity } from "./github-app-token.ts";
import type { CodexAppServerClient } from "./codex-app-server.ts";
import type { PatchRelayDatabase } from "./db.ts";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { FactoryState, RunType } from "./factory-state.ts";
import { resolveFailureFactoryState } from "./reactive-pr-state.ts";
import { buildHookEnv, type HookEnv, type HookResult, runProjectHook } from "./hook-runner.ts";
import { buildRunFailureActivity } from "./linear-session-reporting.ts";
import { loadPatchRelayRepoPrompting } from "./patchrelay-customization.ts";
import {
  buildRunPrompt as buildPatchRelayRunPrompt,
  findDisallowedPatchRelayPromptSectionIds,
  findUnknownPatchRelayPromptSectionIds,
  mergePromptCustomizationLayers,
  resolvePromptLayers,
} from "./prompting/patchrelay.ts";
import type { RunnableWorkflowIntent } from "./run-task-planner.ts";
import type { RunContext } from "./run-context.ts";
import { SIGNAL_CONSUMED_OBSERVATION } from "./workflow-model.ts";
import type { AppConfig, LinearAgentActivityContent } from "./types.ts";
import type { WorktreeManager } from "./worktree-manager.ts";
import { sanitizeDiagnosticText } from "./utils.ts";

const WRITER = "run-launcher";
const DEFAULT_PREPARE_WORKTREE_MAX_ATTEMPTS = 3;
const DEFAULT_PREPARE_WORKTREE_RETRY_DELAY_MS = 2_000;

// S5: read the `consumesObservationIds` an inbox workflow task carries in its
// requirements_json. Boundary over stringly-stored JSON: a malformed payload
// degrades to "no ids to consume" rather than wedging the claim.
function parseConsumesObservationIds(requirementsJson: string | undefined): number[] {
  if (!requirementsJson) return [];
  try {
    const parsed = JSON.parse(requirementsJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const ids = (parsed as Record<string, unknown>).consumesObservationIds;
    return Array.isArray(ids) ? ids.filter((id): id is number => typeof id === "number") : [];
  } catch {
    return [];
  }
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function shouldCompactThread(issue: IssueRecord, threadGeneration: number | undefined, context?: RunContext): boolean {
  const followUpCount = context?.followUpCount ?? 0;
  return issue.threadId !== undefined
    && (threadGeneration ?? 0) >= 4
    && followUpCount >= 4;
}

function compactGoalText(value: string, maxLength = 600): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function extractIssueSection(description: string | undefined, heading: string): string | undefined {
  if (!description) return undefined;
  const headingLine = `## ${heading}`.toLowerCase();
  const lines = description.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === headingLine);
  if (start === -1) return undefined;
  const end = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
  const body = lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim();
  return body && body.length > 0 ? body : undefined;
}

export function buildInitialImplementationGoal(issue: IssueRecord): string {
  const title = issue.title?.trim() || `Complete ${issue.issueKey ?? issue.linearIssueId}`;
  const description = issue.description?.trim();
  const goal = extractIssueSection(description, "Goal");

  return compactGoalText(goal ? `${title}. ${goal}` : title);
}

export function shouldReuseIssueThread(params: {
  existingThreadId?: string | undefined;
  compactThread: boolean;
  resumeThread: boolean;
}): boolean {
  return Boolean(params.existingThreadId) && !params.compactThread && params.resumeThread;
}

export function shouldFreshenWorktreeBeforeLaunch(params: {
  runType: RunType;
  effectiveContext?: RunContext;
}): boolean {
  if (shouldPreserveDirtyWorktreeBeforeLaunch(params)) {
    return false;
  }
  if (params.runType === "queue_repair") {
    return false;
  }
  if (params.runType === "review_fix") {
    return params.effectiveContext?.branchUpkeepRequired === true
      || params.effectiveContext?.reviewFixMode === "branch_upkeep";
  }
  return true;
}

export function shouldPreserveDirtyWorktreeBeforeLaunch(params: {
  runType: RunType;
  effectiveContext?: RunContext;
}): boolean {
  return params.effectiveContext?.preserveDirtyWorktree === true
    && (
      params.runType === "review_fix"
      || params.runType === "branch_upkeep"
      || params.runType === "ci_repair"
      || params.runType === "queue_repair"
  );
}

function prepareWorktreeHookFailureMessage(result: HookResult): string {
  const exitCode = result.exitCode ?? 1;
  const stderr = result.stderr?.trim();
  const stdout = result.stdout?.trim();
  const detail = sanitizeDiagnosticText(stderr || stdout || "[no output]");
  return `prepare-worktree hook failed (exit ${exitCode}): ${detail}`;
}

function prepareWorktreeHookErrorMessage(error: unknown): string {
  const detail = sanitizeDiagnosticText(error instanceof Error ? error.message : String(error));
  return `prepare-worktree hook errored: ${detail}`;
}

export async function runPrepareWorktreeHookWithRetries(params: {
  repoPath: string;
  worktreePath: string;
  hookEnv: HookEnv;
  logger: Logger;
  issueKey?: string | undefined;
  runType: RunType;
  maxAttempts?: number | undefined;
  retryDelayMs?: number | undefined;
  runHook?: typeof runProjectHook | undefined;
}): Promise<void> {
  const runHook = params.runHook ?? runProjectHook;
  const maxAttempts = Math.max(1, Math.floor(params.maxAttempts ?? DEFAULT_PREPARE_WORKTREE_MAX_ATTEMPTS));
  const retryDelayMs = Math.max(0, Math.floor(params.retryDelayMs ?? DEFAULT_PREPARE_WORKTREE_RETRY_DELAY_MS));
  let lastMessage: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let result: HookResult;
    try {
      result = await runHook(params.repoPath, "prepare-worktree", { cwd: params.worktreePath, env: params.hookEnv });
    } catch (error) {
      lastMessage = prepareWorktreeHookErrorMessage(error);
      if (attempt >= maxAttempts) {
        throw new Error(`${lastMessage} after ${attempt} attempt${attempt === 1 ? "" : "s"}`);
      }
      params.logger.warn(
        {
          issueKey: params.issueKey,
          runType: params.runType,
          attempt,
          maxAttempts,
          error: lastMessage,
        },
        "prepare-worktree hook errored; retrying",
      );
      if (retryDelayMs > 0) {
        await delay(retryDelayMs);
      }
      continue;
    }

    if (!result.ran || result.exitCode === 0) {
      return;
    }

    lastMessage = prepareWorktreeHookFailureMessage(result);
    if (attempt >= maxAttempts) {
      throw new Error(`${lastMessage} after ${attempt} attempt${attempt === 1 ? "" : "s"}`);
    }
    params.logger.warn(
      {
        issueKey: params.issueKey,
        runType: params.runType,
        attempt,
        maxAttempts,
        exitCode: result.exitCode,
        detail: lastMessage,
      },
      "prepare-worktree hook failed; retrying",
    );
    if (retryDelayMs > 0) {
      await delay(retryDelayMs);
    }
  }

  throw new Error(lastMessage ?? "prepare-worktree hook failed");
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
    effectiveContext?: RunContext;
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
    authorityEpoch?: number;
    effectiveContext?: RunContext;
    resolveRunTask: (issue: IssueRecord) => RunnableWorkflowIntent | undefined;
    branchName: string;
    worktreePath: string;
  }): RunRecord | undefined {
    return this.db.issueSessions.withIssueSessionLease(params.item.projectId, params.item.issueId, params.leaseId, () => {
      return this.db.batchIssueSessionProjections(() => {
        const fresh = this.db.issues.getIssue(params.item.projectId, params.item.issueId);
        if (!fresh || fresh.activeRunId !== undefined) return undefined;
        const freshRunTask = params.resolveRunTask(fresh);
        if (!freshRunTask || freshRunTask.runType !== params.runType) return undefined;

        const created = this.db.runs.createRun({
          issueId: fresh.id,
          projectId: params.item.projectId,
          linearIssueId: params.item.issueId,
          runType: params.runType,
          ...(params.sourceHeadSha ? { sourceHeadSha: params.sourceHeadSha } : {}),
          ...(params.authorityEpoch !== undefined ? { authorityEpoch: params.authorityEpoch } : {}),
          promptText: params.prompt,
        });
        const failureHeadSha = params.effectiveContext?.failureHeadSha ?? params.effectiveContext?.headSha;
        const failureSignature = params.effectiveContext?.failureSignature;
        const claimUpdate = {
          projectId: params.item.projectId,
          linearIssueId: params.item.issueId,
          activeRunId: created.id,
          branchName: params.branchName,
          worktreePath: params.worktreePath,
          factoryState: params.runType === "implementation" ? "implementing" as const
            : params.runType === "ci_repair" ? "repairing_ci" as const
            : params.runType === "review_fix" || params.runType === "branch_upkeep" ? "changes_requested" as const
            : params.runType === "queue_repair" ? "repairing_queue" as const
            : "implementing" as const,
          ...((params.runType === "ci_repair" || params.runType === "queue_repair") && failureSignature
            ? {
                lastAttemptedFailureSignature: failureSignature,
                lastAttemptedFailureHeadSha: failureHeadSha ?? null,
                lastAttemptedFailureAt: new Date().toISOString(),
              }
            : {}),
        };
        const claimCommit = this.db.issueSessions.commitIssueState({
          writer: WRITER,
          expectedVersion: fresh.version,
          update: claimUpdate,
          // Never steal a slot another writer claimed concurrently.
          onConflict: (current) => (current.activeRunId == null ? claimUpdate : undefined),
        });
        if (claimCommit.outcome !== "applied") return undefined;
        // Session events are consumed for session-history coherence; the
        // claimed workflow task is the runnable-work authority.
        this.db.issueSessions.consumeIssueSessionEvents(params.item.projectId, params.item.issueId, freshRunTask.eventIds, created.id);
        this.db.issueSessions.setIssueSessionLastWorkflowReason(params.item.projectId, params.item.issueId, freshRunTask.workflowReason ?? null);
        // S5 CLAIM consumption: stamp the workflow task id on the run and, when
        // the claimed task carries inbox observations, record their exactly-once
        // consumption as a `workflow.signal_consumed` observation (never a
        // column) so re-derivation stays monotonic. The dedupe key keys off the
        // run id, so a retried claim of the same run is idempotent, and once the
        // input observations are consumed the task self-closes on the next
        // reconcile — a re-claim cannot spawn a second run against the same input.
        const claimedTaskId = freshRunTask.workflowReason;
        if (claimedTaskId) {
          const claimedTask = this.db.workflowTasks.getTask(params.item.projectId, params.item.issueId, claimedTaskId);
          if (claimedTask?.status === "open") {
            this.db.runs.setRunTaskId(created.id, claimedTaskId);
            const consumedObservationIds = parseConsumesObservationIds(claimedTask.requirementsJson);
            if (consumedObservationIds.length > 0) {
              this.db.workflowObservations.appendObservation({
                projectId: params.item.projectId,
                subjectId: params.item.issueId,
                source: "executor",
                type: SIGNAL_CONSUMED_OBSERVATION,
                payloadJson: JSON.stringify({
                  runId: created.id,
                  taskId: claimedTaskId,
                  consumedObservationIds,
                  method: "claim",
                }),
                dedupeKey: `signal_consumed:run:${created.id}`,
              });
            }
          }
        }
        return created;
      });
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
    effectiveContext?: RunContext;
    leaseId: string;
    botIdentity?: GitHubAppBotIdentity;
    assertLaunchLease: (run: Pick<RunRecord, "id" | "projectId" | "linearIssueId">, phase: string) => void;
    linearSync: {
      emitActivity: (issue: IssueRecord, activity: LinearAgentActivityContent) => Promise<void> | void;
      syncSession: (issue: IssueRecord, options?: { activeRunType?: RunType }) => Promise<void> | void;
    };
    releaseLease: (projectId: string, issueId: string) => void;
    lowerCaseFirst: (value: string) => string;
  }): Promise<{ threadId: string; turnId: string; parentThreadId?: string }> {
    let threadId: string;
    let turnId: string;
    let parentThreadId: string | undefined;
    let createdThreadForRun = false;
    const firstThreadForIssue = !params.issue.threadId;
    try {
      await this.worktreeManager.ensureIssueWorktree(
        params.project.repoPath,
        params.project.worktreeRoot,
        params.worktreePath,
        params.branchName,
        { allowExistingOutsideRoot: params.issue.branchName !== undefined },
      );

      // GitHub auth (gh + git) and bot commit identity reach the agent via the inherited
      // process env (GH_CONFIG_DIR + gh credential helper + GIT_AUTHOR/COMMITTER). Nothing
      // is written into the worktree git config, so credentials never leak into interactive
      // shell sessions on the shared clone.
      const preserveDirtyWorktree = shouldPreserveDirtyWorktreeBeforeLaunch({
        runType: params.runType,
        ...(params.effectiveContext ? { effectiveContext: params.effectiveContext } : {}),
      });
      if (preserveDirtyWorktree) {
        this.logger.warn(
          { issueKey: params.issue.issueKey, runType: params.runType, worktreePath: params.worktreePath },
          "Preserving dirty repair worktree for automatic publication continuation",
        );
      } else {
        await this.worktreeManager.resetWorktreeToTrackedBranch(params.worktreePath, params.branchName, params.issue, this.logger);
      }
      if (shouldFreshenWorktreeBeforeLaunch({
        runType: params.runType,
        ...(params.effectiveContext ? { effectiveContext: params.effectiveContext } : {}),
      })) {
        await this.worktreeManager.freshenWorktree(params.worktreePath, params.project, params.issue, this.logger);
      }

      const hookEnv = buildHookEnv(params.issue.issueKey ?? params.issue.linearIssueId, params.branchName, params.runType, params.worktreePath);
      await runPrepareWorktreeHookWithRetries({
        repoPath: params.project.repoPath,
        worktreePath: params.worktreePath,
        hookEnv,
        logger: this.logger,
        issueKey: params.issue.issueKey,
        runType: params.runType,
      });
      this.db.runs.updateLaunchPhase(params.run.id, "worktree_prepared");
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
        createdThreadForRun = true;
        this.db.issueSessions.commitIssueState({
          writer: WRITER,
          lease: { projectId: params.project.id, linearIssueId: params.issue.linearIssueId, leaseId: params.leaseId },
          update: { projectId: params.project.id, linearIssueId: params.issue.linearIssueId, threadId },
        });
      }
      // Plan §B5: persist the thread id on the run row BEFORE startTurn is
      // awaited, so a turn/completed notification arriving while the turn is
      // starting can already resolve the run by thread id. The orchestrator
      // re-records it (with the turn id) after the launch returns.
      this.recordRunThread(params, threadId, parentThreadId);
      this.db.runs.updateLaunchPhase(params.run.id, "thread_started");

      try {
        const turn = await this.codex.startTurn({ threadId, cwd: params.worktreePath, input: params.prompt });
        turnId = turn.turnId;
        this.db.runs.updateLaunchPhase(params.run.id, "turn_started");
      } catch (turnError) {
        const msg = turnError instanceof Error ? turnError.message : String(turnError);
        if (msg.includes("thread not found") || msg.includes("not materialized")) {
          this.logger.info({ issueKey: params.issue.issueKey, staleThreadId: threadId }, "Thread is stale, retrying with fresh thread");
          const thread = await this.codex.startThread({ cwd: params.worktreePath });
          threadId = thread.id;
          createdThreadForRun = true;
          this.db.issueSessions.commitIssueState({
            writer: WRITER,
            lease: { projectId: params.project.id, linearIssueId: params.issue.linearIssueId, leaseId: params.leaseId },
            update: { projectId: params.project.id, linearIssueId: params.issue.linearIssueId, threadId },
          });
          // Plan §B5: re-point the run row at the fresh thread before the
          // retried startTurn, for the same notification race.
          this.recordRunThread(params, threadId, parentThreadId);
          const turn = await this.codex.startTurn({ threadId, cwd: params.worktreePath, input: params.prompt });
          turnId = turn.turnId;
          this.db.runs.updateLaunchPhase(params.run.id, "turn_started");
        } else {
          throw turnError;
        }
      }
      if (createdThreadForRun && firstThreadForIssue && params.runType === "implementation") {
        await this.setInitialImplementationGoal(threadId, params.issue);
      }
      params.assertLaunchLease(params.run, "after starting the Codex turn");
      return { threadId, turnId, ...(parentThreadId ? { parentThreadId } : {}) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const lostLease = error instanceof Error && error.name === "IssueSessionLeaseLostError";
      if (!lostLease) {
        const nextState: FactoryState = resolveFailureFactoryState(params.runType);
        // Issue clear + run-terminal write ride in one transaction; the run
        // finish is gated on the issue commit so a lost lease skips both.
        this.db.transaction(() => {
          const commit = this.db.issueSessions.commitIssueState({
            writer: WRITER,
            lease: { projectId: params.project.id, linearIssueId: params.issue.linearIssueId, leaseId: params.leaseId },
            update: {
              projectId: params.project.id,
              linearIssueId: params.issue.linearIssueId,
              activeRunId: null,
              factoryState: nextState,
            },
          });
          if (commit.outcome !== "applied") return;
          this.db.runs.finishRun(params.run.id, {
            status: "failed",
            failureReason: message,
          });
        });
      }
      this.logger.error({ issueKey: params.issue.issueKey, runType: params.runType, error: message }, `Failed to launch ${params.runType} run`);
      const failedIssue = this.db.issues.getIssue(params.project.id, params.issue.linearIssueId) ?? params.issue;
      void params.linearSync.emitActivity(failedIssue, buildRunFailureActivity(params.runType, `Failed to start ${params.lowerCaseFirst(message)}`));
      void params.linearSync.syncSession(failedIssue, { activeRunType: params.runType });
      params.releaseLease(params.project.id, params.issue.linearIssueId);
      throw error;
    }
  }

  // Persist the Codex thread id on the run row under the launch lease.
  // Losing the lease here aborts the launch the same way assertLaunchLease
  // does — the run row must not be touched by a worker that no longer owns
  // the session.
  private recordRunThread(
    params: {
      project: AppConfig["projects"][number];
      issue: IssueRecord;
      run: RunRecord;
      leaseId: string;
    },
    threadId: string,
    parentThreadId: string | undefined,
  ): void {
    const recorded = this.db.issueSessions.updateRunThreadWithLease(
      { projectId: params.project.id, linearIssueId: params.issue.linearIssueId, leaseId: params.leaseId },
      params.run.id,
      { threadId, ...(parentThreadId ? { parentThreadId } : {}) },
    );
    if (recorded) return;
    const error = new Error("Lost issue-session lease while recording the Codex thread id");
    error.name = "IssueSessionLeaseLostError";
    this.logger.warn(
      { runId: params.run.id, issueId: params.issue.linearIssueId },
      "Aborting run launch after losing issue-session lease while recording the Codex thread id",
    );
    throw error;
  }

  private async setInitialImplementationGoal(threadId: string, issue: IssueRecord): Promise<void> {
    const goalSetter = (this.codex as unknown as {
      setThreadGoal?: (options: { threadId: string; objective: string; status: "active" }) => Promise<unknown>;
    }).setThreadGoal;
    if (typeof goalSetter !== "function") {
      return;
    }

    const objective = buildInitialImplementationGoal(issue);
    try {
      await goalSetter.call(this.codex, { threadId, objective, status: "active" });
      this.logger.info({ issueKey: issue.issueKey, threadId }, "Set Codex thread goal for implementation run");
    } catch (error) {
      this.logger.warn(
        {
          issueKey: issue.issueKey,
          threadId,
          error: sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)),
        },
        "Failed to set Codex thread goal for implementation run",
      );
    }
  }
}
