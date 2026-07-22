import type { Logger } from "pino";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { PatchRelayDatabase } from "./db.ts";
import { appendDelegationObservedEvent, appendRunReleasedAuthorityEvent } from "./delegation-audit.ts";
import { isIssueTerminalProjection } from "./issue-execution-state.ts";
import { resolveAuthoritativeLinearStopState } from "./linear-workflow.ts";
import { buildRunFailureActivity } from "./linear-session-reporting.ts";
import type { LinearSessionSync } from "./linear-session-sync.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import type { LinearClientProvider, CodexThreadSummary } from "./types.ts";
import { getThreadTurns } from "./codex-thread-utils.ts";
import { classifyCodexFailure } from "./codex-capacity.ts";
import { buildFailedTurnFailureReason } from "./run-reporting.ts";
import type { RunFailurePolicy } from "./run-failure-policy.ts";
import type { RunFinalizer } from "./run-finalizer.ts";
import type { ReleaseIssueSessionLease, WithHeldIssueSessionLease } from "./issue-session-lease-service.ts";
import { resolveEffectiveActiveRun } from "./effective-active-run.ts";
import { isThreadMaterializingError } from "./codex-thread-errors.ts";
import { fetchPullRequestSnapshot } from "./reconcile-pr-fetch.ts";
import { emitTelemetry, noopTelemetry, type PatchRelayTelemetry } from "./telemetry.ts";

const THREAD_MATERIALIZATION_GRACE_MS = 10 * 60_000;

const WRITER = "run-reconciler";

function isWithinThreadMaterializationGrace(run: Pick<RunRecord, "startedAt">, nowMs = Date.now()): boolean {
  const startedAtMs = Date.parse(run.startedAt);
  if (!Number.isFinite(startedAtMs)) return true;
  return nowMs - startedAtMs < THREAD_MATERIALIZATION_GRACE_MS;
}

export class RunReconciler {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly logger: Logger,
    private readonly linearProvider: LinearClientProvider,
    private readonly linearSync: LinearSessionSync,
    private readonly failurePolicy: Pick<RunFailurePolicy, "settleStrandedRunAndRecover" | "handleInterruptedRun" | "deferCapacityLimitedRun">,
    private readonly runFinalizer: RunFinalizer,
    private readonly withHeldLease: WithHeldIssueSessionLease,
    private readonly releaseLease: ReleaseIssueSessionLease,
    private readonly readThreadWithRetry: (threadId: string, maxRetries?: number) => Promise<CodexThreadSummary>,
    private readonly resolveRepoFullName: (projectId: string) => string | undefined = () => undefined,
    private readonly feed?: OperatorEventFeed,
    private readonly telemetry: PatchRelayTelemetry = noopTelemetry,
  ) {}

  async reconcile(params: {
    run: RunRecord;
    issue: IssueRecord;
    recoveryLease: boolean | "owned";
  }): Promise<void> {
    const { run, issue, recoveryLease } = params;
    const acquiredRecoveryLease = recoveryLease === true;
    let effectiveIssue = issue;

    const effectiveActiveRun = resolveEffectiveActiveRun({
      activeRun: issue.activeRunId === run.id ? run : undefined,
      latestRun: run,
    });
    if (effectiveActiveRun?.id === run.id && issue.activeRunId !== run.id) {
      const reattachUpdate = {
        projectId: run.projectId,
        linearIssueId: run.linearIssueId,
        activeRunId: run.id,
        ...(run.threadId ? { threadId: run.threadId } : {}),
      };
      const commit = this.withHeldLease(run.projectId, run.linearIssueId, () => this.db.issueSessions.commitIssueState({
        writer: WRITER,
        expectedVersion: issue.version,
        update: reattachUpdate,
        // Never steal the slot from a run that was attached concurrently.
        onConflict: (current) => (current.activeRunId == null ? reattachUpdate : undefined),
      }));
      if (commit?.outcome === "applied") {
        effectiveIssue = commit.issue;
        this.logger.info(
          { issueKey: effectiveIssue.issueKey, runId: run.id, runType: run.runType },
          "Reattached detached active run during reconciliation",
        );
        // Plan §B5: with settleRun idempotent and the launcher persisting the
        // thread id before startTurn, this reattachment should never fire.
        // Telemetry observes it for one release before the block is deleted.
        emitTelemetry(this.telemetry, {
          type: "health.invariant",
          invariant: "detached_active_run",
          status: "repaired",
          projectId: run.projectId,
          linearIssueId: run.linearIssueId,
          ...(effectiveIssue.issueKey ? { issueKey: effectiveIssue.issueKey } : {}),
          runId: run.id,
          detail: `Reattached detached active ${run.runType} run during reconciliation`,
        });
      } else if (commit?.outcome === "conflict_skipped" && commit.issue) {
        effectiveIssue = commit.issue;
      }
    }

    if (!effectiveIssue.delegatedToPatchRelay) {
      const authority = await this.confirmDelegationAuthorityBeforeRelease(run, effectiveIssue);
      effectiveIssue = authority.issue;
      if (authority.released) {
        const pausedIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? effectiveIssue;
        void this.linearSync.syncSession(pausedIssue, { activeRunType: run.runType });
        this.releaseLease(run.projectId, run.linearIssueId);
        return;
      }
    }

    if (isIssueTerminalProjection(effectiveIssue)) {
      this.logger.info(
        { issueKey: effectiveIssue.issueKey, runId: run.id, workflowOutcome: effectiveIssue.workflowOutcome },
        "Reconciliation: terminal issue state observed while run is active; keeping run until Codex turn completes",
      );
    }

    await this.recordMergedPullRequestWhileRunActive(run, effectiveIssue);

    if (!run.threadId) {
      if (recoveryLease === "owned") {
        this.logger.debug(
        { issueKey: effectiveIssue.issueKey, runId: run.id, runType: run.runType },
        "Skipping zombie reconciliation for locally-owned launch that has not created a thread yet",
      );
      return;
      }
      this.logger.warn(
      { issueKey: effectiveIssue.issueKey, runId: run.id, runType: run.runType },
      "Zombie run detected (no thread)",
    );
      // Detection only — the failure policy settles the run and decides
      // retry vs escalate (plan §B4).
      this.failurePolicy.settleStrandedRunAndRecover({
        run,
        issue: effectiveIssue,
        reason: "zombie",
        failureReason: "Zombie: never started (no thread after restart)",
      });
      const recoveredIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? effectiveIssue;
      void this.linearSync.emitActivity(recoveredIssue, buildRunFailureActivity(run.runType, "The Codex turn never started before PatchRelay restarted."));
      void this.linearSync.syncSession(recoveredIssue, { activeRunType: run.runType });
      this.releaseLease(run.projectId, run.linearIssueId);
      return;
    }

    let thread: CodexThreadSummary | undefined;
    try {
      thread = await this.readThreadWithRetry(run.threadId);
    } catch (error) {
      if (isThreadMaterializingError(error) && isWithinThreadMaterializationGrace(run)) {
        this.logger.info(
          { issueKey: effectiveIssue.issueKey, runId: run.id, runType: run.runType, threadId: run.threadId },
          "Codex thread still materializing during reconciliation; keeping run active",
        );
        void this.linearSync.syncSession(effectiveIssue, { activeRunType: run.runType });
        if (acquiredRecoveryLease) {
          this.releaseLease(run.projectId, run.linearIssueId);
        }
        return;
      }
      this.logger.warn(
        { issueKey: effectiveIssue.issueKey, runId: run.id, runType: run.runType, threadId: run.threadId },
        "Stale thread during reconciliation",
      );
      // Detection only — the failure policy settles the run and decides
      // retry vs escalate (plan §B4).
      this.failurePolicy.settleStrandedRunAndRecover({
        run,
        issue: effectiveIssue,
        reason: "stale_thread",
        failureReason: "Stale thread after restart",
      });
      const recoveredIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? effectiveIssue;
      void this.linearSync.emitActivity(recoveredIssue, buildRunFailureActivity(run.runType, "PatchRelay lost the active Codex thread after restart and needs to recover."));
      void this.linearSync.syncSession(recoveredIssue, { activeRunType: run.runType });
      this.releaseLease(run.projectId, run.linearIssueId);
      return;
    }

    const linear = await this.linearProvider.forProject(run.projectId).catch(() => undefined);
    if (linear) {
      const linearIssue = await linear.getIssue(run.linearIssueId).catch(() => undefined);
      if (linearIssue) {
        const stopState = resolveAuthoritativeLinearStopState(linearIssue);
        if (stopState?.isFinal) {
          const stopUpdate = {
            projectId: run.projectId,
            linearIssueId: run.linearIssueId,
            currentLinearState: stopState.stateName,
            currentLinearStateType: "completed" as const,
          };
          this.withHeldLease(run.projectId, run.linearIssueId, () => {
            this.db.issueSessions.commitIssueState({
              writer: WRITER,
              expectedVersion: effectiveIssue.version,
              // Record the external Linear fact, but keep the active run
              // sealed until the Codex turn itself completes.
              update: stopUpdate,
              onConflict: (current) => (current.activeRunId === run.id ? stopUpdate : undefined),
            });
          });
          this.feed?.publish({
            level: "info",
            kind: "stage",
            issueKey: issue.issueKey,
            projectId: run.projectId,
            stage: run.runType,
            status: "reconciled",
            summary: `Linear state ${stopState.stateName} observed while active run continues`,
          });
          effectiveIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? effectiveIssue;
        }
      }
    }

    const latestTurn = getThreadTurns(thread).at(-1);
    if (latestTurn?.status === "interrupted") {
      await this.failurePolicy.handleInterruptedRun(run, effectiveIssue);
      return;
    }

    // A failed turn found during reconciliation (the live notification was
    // lost, e.g. across a restart) whose error is a Codex capacity outage:
    // defer the same workflow task instead of leaving the run dangling or burning a
    // budget. Non-capacity failed turns keep the existing behavior — the
    // notification path owns live settlement.
    if (latestTurn?.status === "failed") {
      const capacity = classifyCodexFailure(latestTurn.error?.message ?? undefined);
      if (capacity.kind === "capacity") {
        this.failurePolicy.deferCapacityLimitedRun({
          run,
          issue: effectiveIssue,
          failureReason: buildFailedTurnFailureReason(latestTurn.error?.message ?? undefined),
          capacity,
          threadId: run.threadId,
          ...(latestTurn.id ? { turnId: latestTurn.id } : {}),
        });
        return;
      }
    }

    if (latestTurn?.status === "completed") {
      await this.runFinalizer.finalizeCompletedRun({
        source: "reconciliation",
        run,
        issue: effectiveIssue,
        thread,
        threadId: run.threadId,
        ...(latestTurn.id ? { completedTurnId: latestTurn.id } : {}),
      });
      return;
    }

    if (acquiredRecoveryLease) {
      this.releaseLease(run.projectId, run.linearIssueId);
    }
  }

  private async recordMergedPullRequestWhileRunActive(run: RunRecord, issue: IssueRecord): Promise<void> {
    if (issue.prNumber === undefined) return;
    if (issue.prState === "merged") {
      return;
    }

    const repoFullName = this.resolveRepoFullName(issue.projectId);
    if (!repoFullName) return;
    const snapshot = await fetchPullRequestSnapshot(repoFullName, issue.prNumber);
    if (!snapshot.ok) {
      this.logger.debug(
        { issueKey: issue.issueKey, prNumber: issue.prNumber, error: snapshot.error.message },
        "Could not refresh active-run PR state during reconciliation",
      );
      return;
    }
    if (snapshot.pr.state !== "MERGED") return;

    const mergedUpdate = {
      projectId: run.projectId,
      linearIssueId: run.linearIssueId,
      prState: "merged",
    };
    this.withHeldLease(run.projectId, run.linearIssueId, () => {
      this.db.issueSessions.commitIssueState({
        writer: WRITER,
        expectedVersion: issue.version,
        // The merge itself is external truth, but it must not release the
        // active run. The Codex turn completion is the handoff boundary.
        update: mergedUpdate,
        onConflict: (current) => (current.activeRunId === run.id ? mergedUpdate : undefined),
      });
    });
    this.feed?.publish({
      level: "info",
      kind: "stage",
      issueKey: issue.issueKey,
      projectId: run.projectId,
      stage: run.runType,
      status: "reconciled",
      summary: `Observed merged PR while active ${run.runType} run continues`,
    });
  }

  private async confirmDelegationAuthorityBeforeRelease(
    run: RunRecord,
    issue: IssueRecord,
  ): Promise<{ issue: IssueRecord; released: boolean }> {
    const installation = this.db.linearInstallations.getLinearInstallationForProject(run.projectId);
    const linear = await this.linearProvider.forProject(run.projectId).catch(() => undefined);
    if (!installation?.actorId || !linear) {
      appendDelegationObservedEvent(this.db, {
        projectId: run.projectId,
        linearIssueId: run.linearIssueId,
        payload: {
          source: "run_reconciler",
          ...(installation?.actorId ? { actorId: installation.actorId } : {}),
          previousDelegatedToPatchRelay: issue.delegatedToPatchRelay,
          observedDelegatedToPatchRelay: issue.delegatedToPatchRelay,
          appliedDelegatedToPatchRelay: issue.delegatedToPatchRelay,
          hydration: "live_linear_failed",
          activeRunId: run.id,
          decision: "none",
          reason: "live_linear_unavailable_before_undelegation_release",
        },
      });
      return { issue, released: false };
    }

    const linearIssue = await linear.getIssue(run.linearIssueId).catch(() => undefined);
    if (!linearIssue) {
      appendDelegationObservedEvent(this.db, {
        projectId: run.projectId,
        linearIssueId: run.linearIssueId,
        payload: {
          source: "run_reconciler",
          actorId: installation.actorId,
          previousDelegatedToPatchRelay: issue.delegatedToPatchRelay,
          observedDelegatedToPatchRelay: issue.delegatedToPatchRelay,
          appliedDelegatedToPatchRelay: issue.delegatedToPatchRelay,
          hydration: "live_linear_failed",
          activeRunId: run.id,
          decision: "none",
          reason: "live_linear_refresh_failed_before_undelegation_release",
        },
      });
      return { issue, released: false };
    }

    const delegated = linearIssue.delegateId === installation.actorId;
    appendDelegationObservedEvent(this.db, {
      projectId: run.projectId,
      linearIssueId: run.linearIssueId,
      payload: {
        source: "run_reconciler",
        actorId: installation.actorId,
        ...(linearIssue.delegateId ? { observedDelegateId: linearIssue.delegateId } : {}),
        previousDelegatedToPatchRelay: issue.delegatedToPatchRelay,
        observedDelegatedToPatchRelay: delegated,
        appliedDelegatedToPatchRelay: delegated,
        hydration: "live_linear",
        activeRunId: run.id,
        decision: delegated ? "resume_issue" : "release_run",
        reason: delegated
          ? "live_linear_confirmed_issue_is_still_delegated"
          : "live_linear_confirmed_issue_is_no_longer_delegated",
      },
    });

    if (delegated) {
      // Live Linear is the authority on delegation; commit unconditionally.
      const repairedIssue = this.withHeldLease(run.projectId, run.linearIssueId, () => {
        const commit = this.db.issueSessions.commitIssueState({
          writer: WRITER,
          update: {
            projectId: run.projectId,
            linearIssueId: run.linearIssueId,
            delegatedToPatchRelay: true,
            ...(linearIssue.identifier ? { issueKey: linearIssue.identifier } : {}),
            ...(linearIssue.title ? { title: linearIssue.title } : {}),
            ...(linearIssue.description ? { description: linearIssue.description } : {}),
            ...(linearIssue.url ? { url: linearIssue.url } : {}),
            ...(linearIssue.priority != null ? { priority: linearIssue.priority } : {}),
            ...(linearIssue.estimate != null ? { estimate: linearIssue.estimate } : {}),
            ...(linearIssue.stateName ? { currentLinearState: linearIssue.stateName } : {}),
            ...(linearIssue.stateType ? { currentLinearStateType: linearIssue.stateType } : {}),
          },
        });
        return commit.outcome === "applied" ? commit.issue : undefined;
      }) ?? issue;
      return { issue: repairedIssue, released: false };
    }

    appendRunReleasedAuthorityEvent(this.db, {
      projectId: run.projectId,
      linearIssueId: run.linearIssueId,
      payload: {
        runId: run.id,
        runType: run.runType,
        localDelegatedToPatchRelay: issue.delegatedToPatchRelay,
        liveDelegatedToPatchRelay: delegated,
        source: "run_reconciler",
        reason: "Issue was un-delegated during active run",
      },
    });

    this.withHeldLease(run.projectId, run.linearIssueId, () => {
      // Undelegation confirmed against live Linear — external truth, commit
      // unconditionally; the run release rides in the same transaction.
      this.db.issueSessions.commitIssueState({
        writer: WRITER,
        update: {
          projectId: run.projectId,
          linearIssueId: run.linearIssueId,
          activeRunId: null,
          delegatedToPatchRelay: false,
          ...(linearIssue.identifier ? { issueKey: linearIssue.identifier } : {}),
          ...(linearIssue.title ? { title: linearIssue.title } : {}),
          ...(linearIssue.description ? { description: linearIssue.description } : {}),
          ...(linearIssue.url ? { url: linearIssue.url } : {}),
          ...(linearIssue.priority != null ? { priority: linearIssue.priority } : {}),
          ...(linearIssue.estimate != null ? { estimate: linearIssue.estimate } : {}),
          ...(linearIssue.stateName ? { currentLinearState: linearIssue.stateName } : {}),
          ...(linearIssue.stateType ? { currentLinearStateType: linearIssue.stateType } : {}),
        },
      });
      this.db.runs.finishRun(run.id, { status: "released", failureReason: "Issue was un-delegated during active run" });
    });
    return { issue, released: true };
  }
}
