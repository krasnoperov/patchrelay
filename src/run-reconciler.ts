import type { Logger } from "pino";
import type { IssueRecord, RunRecord } from "./db-types.ts";
import type { PatchRelayDatabase } from "./db.ts";
import { appendDelegationObservedEvent, appendRunReleasedAuthorityEvent } from "./delegation-audit.ts";
import { TERMINAL_STATES } from "./factory-state.ts";
import { resolveAuthoritativeLinearStopState } from "./linear-workflow.ts";
import { buildRunFailureActivity } from "./linear-session-reporting.ts";
import type { LinearSessionSync } from "./linear-session-sync.ts";
import type { OperatorEventFeed } from "./operator-feed.ts";
import type { LinearClientProvider, CodexThreadSummary } from "./types.ts";
import { getThreadTurns } from "./codex-thread-utils.ts";
import type { InterruptedRunRecovery } from "./interrupted-run-recovery.ts";
import { resolveRecoverablePostRunState } from "./interrupted-run-recovery.ts";
import type { RunFinalizer } from "./run-finalizer.ts";
import type { ReleaseIssueSessionLease, WithHeldIssueSessionLease } from "./issue-session-lease-service.ts";
import { resolveEffectiveActiveRun } from "./effective-active-run.ts";

export class RunReconciler {
  constructor(
    private readonly db: PatchRelayDatabase,
    private readonly logger: Logger,
    private readonly linearProvider: LinearClientProvider,
    private readonly linearSync: LinearSessionSync,
    private readonly interruptedRunRecovery: InterruptedRunRecovery,
    private readonly runFinalizer: RunFinalizer,
    private readonly withHeldLease: WithHeldIssueSessionLease,
    private readonly releaseLease: ReleaseIssueSessionLease,
    private readonly readThreadWithRetry: (threadId: string, maxRetries?: number) => Promise<CodexThreadSummary>,
    private readonly recoverOrEscalate: (issue: IssueRecord, runType: RunRecord["runType"], reason: string) => void,
    private readonly feed?: OperatorEventFeed,
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
      effectiveIssue = this.withHeldLease(run.projectId, run.linearIssueId, () => this.db.issues.upsertIssue({
        projectId: run.projectId,
        linearIssueId: run.linearIssueId,
        activeRunId: run.id,
        ...(run.threadId ? { threadId: run.threadId } : {}),
      })) ?? effectiveIssue;
      this.logger.info(
        { issueKey: effectiveIssue.issueKey, runId: run.id, runType: run.runType },
        "Reattached detached active run during reconciliation",
      );
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

    if (TERMINAL_STATES.has(effectiveIssue.factoryState)) {
      this.withHeldLease(run.projectId, run.linearIssueId, () => {
        this.db.runs.finishRun(run.id, { status: "released", failureReason: "Issue reached terminal state during active run" });
        this.db.issues.upsertIssue({ projectId: run.projectId, linearIssueId: run.linearIssueId, activeRunId: null });
      });
      this.logger.info({ issueKey: effectiveIssue.issueKey, runId: run.id, factoryState: effectiveIssue.factoryState }, "Reconciliation: released run on terminal issue");
      const releasedIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? effectiveIssue;
      void this.linearSync.syncSession(releasedIssue, { activeRunType: run.runType });
      this.releaseLease(run.projectId, run.linearIssueId);
      return;
    }

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
      this.withHeldLease(run.projectId, run.linearIssueId, () => {
        this.db.runs.finishRun(run.id, { status: "failed", failureReason: "Zombie: never started (no thread after restart)" });
        this.db.issues.upsertIssue({ projectId: run.projectId, linearIssueId: run.linearIssueId, activeRunId: null });
      });
      this.recoverOrEscalate(effectiveIssue, run.runType, "zombie");
      const recoveredIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? effectiveIssue;
      void this.linearSync.emitActivity(recoveredIssue, buildRunFailureActivity(run.runType, "The Codex turn never started before PatchRelay restarted."));
      void this.linearSync.syncSession(recoveredIssue, { activeRunType: run.runType });
      this.releaseLease(run.projectId, run.linearIssueId);
      return;
    }

    let thread: CodexThreadSummary | undefined;
    try {
      thread = await this.readThreadWithRetry(run.threadId);
    } catch {
      this.logger.warn(
        { issueKey: effectiveIssue.issueKey, runId: run.id, runType: run.runType, threadId: run.threadId },
        "Stale thread during reconciliation",
      );
      this.withHeldLease(run.projectId, run.linearIssueId, () => {
        this.db.runs.finishRun(run.id, { status: "failed", failureReason: "Stale thread after restart" });
        this.db.issues.upsertIssue({ projectId: run.projectId, linearIssueId: run.linearIssueId, activeRunId: null });
      });
      this.recoverOrEscalate(effectiveIssue, run.runType, "stale_thread");
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
          this.withHeldLease(run.projectId, run.linearIssueId, () => {
            this.db.runs.finishRun(run.id, { status: "released" });
            this.db.issues.upsertIssue({
              projectId: run.projectId,
              linearIssueId: run.linearIssueId,
              activeRunId: null,
              currentLinearState: stopState.stateName,
              factoryState: "done",
            });
          });
          this.feed?.publish({
            level: "info",
            kind: "stage",
            issueKey: issue.issueKey,
            projectId: run.projectId,
            stage: "done",
            status: "reconciled",
            summary: `Linear state ${stopState.stateName} -> done`,
          });
          const doneIssue = this.db.issues.getIssue(run.projectId, run.linearIssueId) ?? effectiveIssue;
          void this.linearSync.syncSession(doneIssue, { activeRunType: run.runType });
          this.releaseLease(run.projectId, run.linearIssueId);
          return;
        }
      }
    }

    const latestTurn = getThreadTurns(thread).at(-1);
    if (latestTurn?.status === "interrupted") {
      await this.interruptedRunRecovery.handle(run, effectiveIssue);
      return;
    }

    if (latestTurn?.status === "completed") {
      await this.runFinalizer.finalizeCompletedRun({
        source: "reconciliation",
        run,
        issue: effectiveIssue,
        thread,
        threadId: run.threadId,
        ...(latestTurn.id ? { completedTurnId: latestTurn.id } : {}),
        resolveRecoverableRunState: resolveRecoverablePostRunState,
      });
      return;
    }

    if (acquiredRecoveryLease) {
      this.releaseLease(run.projectId, run.linearIssueId);
    }
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
      const repairedIssue = this.withHeldLease(run.projectId, run.linearIssueId, () => this.db.issues.upsertIssue({
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
      })) ?? issue;
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
      this.db.runs.finishRun(run.id, { status: "released", failureReason: "Issue was un-delegated during active run" });
      this.db.issues.upsertIssue({
        projectId: run.projectId,
        linearIssueId: run.linearIssueId,
        activeRunId: null,
        factoryState: issue.factoryState,
        delegatedToPatchRelay: false,
        ...(linearIssue.identifier ? { issueKey: linearIssue.identifier } : {}),
        ...(linearIssue.title ? { title: linearIssue.title } : {}),
        ...(linearIssue.description ? { description: linearIssue.description } : {}),
        ...(linearIssue.url ? { url: linearIssue.url } : {}),
        ...(linearIssue.priority != null ? { priority: linearIssue.priority } : {}),
        ...(linearIssue.estimate != null ? { estimate: linearIssue.estimate } : {}),
        ...(linearIssue.stateName ? { currentLinearState: linearIssue.stateName } : {}),
        ...(linearIssue.stateType ? { currentLinearStateType: linearIssue.stateType } : {}),
      });
    });
    return { issue, released: true };
  }
}
