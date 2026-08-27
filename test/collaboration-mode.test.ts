import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import pino from "pino";
import { PatchRelayDatabase } from "../src/db.ts";
import { projectWorkflowSnapshot } from "../src/workflow-runtime.ts";
import { reconcileWorkflowTasksForIssue } from "../src/workflow-task-reconciler.ts";
import { RunTaskPlanner } from "../src/run-task-planner.ts";
import { RunLauncher } from "../src/run-launcher.ts";
import { buildCollaborationPrompt } from "../src/prompting/collaboration.ts";
import { HUMAN_INPUT_OBSERVATION } from "../src/workflow-model.ts";
import type { AppConfig, ProjectConfig } from "../src/types.ts";
import { AgentSessionHandler } from "../src/webhooks/agent-session-handler.ts";
import { AgentInputService } from "../src/agent-input-service.ts";
import { LinearSessionSync } from "../src/linear-session-sync.ts";
import type { LinearClient } from "../src/types.ts";

function createDb(): { db: PatchRelayDatabase; cleanup: () => void; baseDir: string } {
  const baseDir = mkdtempSync(path.join(tmpdir(), "patchrelay-collaboration-"));
  const db = new PatchRelayDatabase(path.join(baseDir, "patchrelay.sqlite"), true);
  db.initializeSchema();
  return {
    db,
    baseDir,
    cleanup: () => {
      db.close();
      rmSync(baseDir, { recursive: true, force: true });
    },
  };
}

function appendCollaborationInput(db: PatchRelayDatabase, projectId: string, issueId: string): void {
  db.workflowObservations.appendObservation({
    projectId,
    subjectId: issueId,
    source: "linear",
    type: HUMAN_INPUT_OBSERVATION,
    payloadJson: JSON.stringify({
      text: "Help me compare two approaches before we implement anything.",
      inputKind: "followup_prompt",
      collaborationMode: true,
    }),
    dedupeKey: `collaboration:${issueId}`,
  });
}

test("an undelegated mention derives a runnable collaboration task even when delivery is blocked", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "inventory",
      linearIssueId: "issue-1",
      issueKey: "INV-1",
      title: "Explore the interaction",
      delegatedToPatchRelay: false,
    });
    appendCollaborationInput(db, issue.projectId, issue.linearIssueId);

    const snapshot = projectWorkflowSnapshot({
      issue,
      observations: db.workflowObservations.listObservations(issue.projectId, issue.linearIssueId),
      blockerCount: 1,
    });

    assert.equal(snapshot.authority.delegated, false);
    assert.equal(snapshot.openTasks[0]?.id, "run:collaboration");
    assert.equal(snapshot.openTasks[0]?.runType, "collaboration");
  } finally {
    cleanup();
  }
});

test("delegation upgrades queued collaboration input to a fresh implementation thread", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "inventory",
      linearIssueId: "issue-2",
      issueKey: "INV-2",
      title: "Explore then implement",
      delegatedToPatchRelay: true,
    });
    appendCollaborationInput(db, issue.projectId, issue.linearIssueId);

    const snapshot = projectWorkflowSnapshot({
      issue,
      observations: db.workflowObservations.listObservations(issue.projectId, issue.linearIssueId),
    });
    const task = snapshot.openTasks[0];

    assert.equal(task?.runType, "implementation");
    assert.equal(task?.requirements?.collaborationMode, false);
    assert.equal(task?.requirements?.resumeThread, false);
  } finally {
    cleanup();
  }
});

test("collaboration prompt permits normal tools and delivery without making delivery mandatory", () => {
  const prompt = buildCollaborationPrompt({
    issue: {
      linearIssueId: "issue-3",
      issueKey: "INV-3",
      title: "Choose an editing model",
      description: "We need to compare a one-shot agent with an interactive agent.",
    },
    context: {
      collaborationMode: true,
      followUps: [{ text: "Show the tradeoffs and ask me about uncertain product choices." }],
    },
  });

  assert.match(prompt, /open-ended working conversation rather than a preset delivery assignment/i);
  assert.match(prompt, /Show the tradeoffs/);
  assert.match(prompt, /Use the repository, shell, connected tools, and MCP integrations normally/i);
  assert.match(prompt, /You may inspect or edit files, run checks, commit, push/i);
  assert.match(prompt, /Do not assume that every turn must produce a commit, push, pull request/i);
});

test("collaboration launch uses a normal writable issue worktree without a publish requirement", async () => {
  const { db, cleanup, baseDir } = createDb();
  try {
    const project = {
      id: "inventory",
      repoPath: path.join(baseDir, "repo"),
      worktreeRoot: path.join(baseDir, "worktrees"),
      branchPrefix: "inv",
    } as ProjectConfig;
    const issue = db.upsertIssue({
      projectId: project.id,
      linearIssueId: "issue-4",
      issueKey: "INV-4",
      title: "Collaborate safely",
      delegatedToPatchRelay: false,
    });
    appendCollaborationInput(db, issue.projectId, issue.linearIssueId);
    reconcileWorkflowTasksForIssue(db, issue);

    const calls: string[] = [];
    const codex = {
      startThreadForCollaboration: async (cwd: string) => {
        calls.push(`thread:${cwd}`);
        return { id: "thread-collaboration" };
      },
      startTurn: async ({ threadId, cwd }: { threadId: string; cwd?: string }) => {
        calls.push(`turn:${threadId}:${cwd}`);
        return { threadId, turnId: "turn-collaboration", status: "inProgress" };
      },
    };
    const worktrees = {
      ensureIssueWorktree: async () => {
        calls.push("worktree:ensure");
      },
      resetWorktreeToTrackedBranch: async () => assert.fail("collaboration must not reset a worktree"),
      freshenWorktree: async () => assert.fail("collaboration must not freshen a worktree"),
    };
    const launcher = new RunLauncher(
      {} as AppConfig,
      db,
      codex as never,
      pino({ enabled: false }),
      worktrees as never,
    );
    const planner = new RunTaskPlanner(db);
    const plan = launcher.prepareLaunchPlan({
      project,
      issue,
      runType: "collaboration",
      effectiveContext: {
        collaborationMode: true,
        followUps: [{ text: "Inspect and discuss this with me." }],
      },
    });
    const leaseId = "collaboration-lease";
    assert.equal(db.issueSessions.acquireIssueSessionLease({
      projectId: project.id,
      linearIssueId: issue.linearIssueId,
      leaseId,
      workerId: "test-worker",
      leasedUntil: new Date(Date.now() + 60_000).toISOString(),
    }), true);
    const run = launcher.claimRun({
      item: { projectId: project.id, issueId: issue.linearIssueId },
      issue,
      leaseId,
      runType: "collaboration",
      prompt: plan.prompt,
      effectiveContext: { collaborationMode: true },
      resolveRunTask: (targetIssue) => planner.resolveRunTask(targetIssue),
      branchName: plan.branchName,
      worktreePath: plan.worktreePath,
    });
    assert.ok(run);
    assert.equal(db.runs.getRunById(run.id)?.shouldNotPublish, undefined);
    const claimedIssue = db.getIssue(project.id, issue.linearIssueId);
    assert.equal(claimedIssue?.branchName, plan.branchName);
    assert.equal(claimedIssue?.worktreePath, plan.worktreePath);

    const launched = await launcher.launchTurn({
      project,
      issue: claimedIssue!,
      run,
      runType: "collaboration",
      prompt: plan.prompt,
      branchName: plan.branchName,
      worktreePath: plan.worktreePath,
      resumeThread: true,
      effectiveContext: { collaborationMode: true },
      leaseId,
      assertLaunchLease: () => undefined,
      linearSync: {
        emitActivity: async () => undefined,
        syncSession: async () => undefined,
      },
      releaseLease: () => undefined,
      lowerCaseFirst: (value) => value,
    });

    assert.deepEqual(launched, {
      threadId: "thread-collaboration",
      turnId: "turn-collaboration",
    });
    assert.deepEqual(calls, [
      "worktree:ensure",
      `thread:${plan.worktreePath}`,
      `turn:thread-collaboration:${plan.worktreePath}`,
    ]);
  } finally {
    cleanup();
  }
});

test("stopping collaboration releases a queued run and records paused local work", async () => {
  const { db, cleanup, baseDir } = createDb();
  try {
    const project = {
      id: "inventory",
      repoPath: path.join(baseDir, "repo"),
      worktreeRoot: path.join(baseDir, "worktrees"),
      branchPrefix: "inv",
    } as ProjectConfig;
    const issue = db.upsertIssue({
      projectId: project.id,
      linearIssueId: "issue-5",
      issueKey: "INV-5",
      title: "Stop the conversation",
      delegatedToPatchRelay: false,
      agentSessionId: "session-5",
      inputRequestKind: "completion_check_question",
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "collaboration",
    });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
    });

    const handler = new AgentSessionHandler(
      {} as AppConfig,
      db,
      {
        forProject: async () => ({
          createAgentActivity: async () => undefined,
          updateAgentSession: async () => undefined,
        }),
      } as never,
      {} as never,
      {} as never,
      pino({ enabled: false }),
    );
    await handler.handle({
      normalized: {
        triggerEvent: "agentSignal",
        issue: { id: issue.linearIssueId, identifier: issue.issueKey },
        agentSession: { id: "session-5", signal: "stop" },
      } as never,
      project,
      trackedIssue: db.getIssue(project.id, issue.linearIssueId),
      runnableTaskRunType: undefined,
      delegated: false,
      peekRunnableWorkflowTaskRunType: () => undefined,
      isDirectReplyToOutstandingQuestion: () => false,
    });

    assert.equal(db.runs.getRunById(run.id)?.status, "released");
    const stoppedIssue = db.getIssue(project.id, issue.linearIssueId);
    assert.equal(stoppedIssue?.activeRunId, undefined);
    assert.equal(stoppedIssue?.inputRequestKind, "paused_local_work");
  } finally {
    cleanup();
  }
});

test("a failed Codex interrupt leaves the run active and does not record a successful stop", async () => {
  const { db, cleanup } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "inventory",
      linearIssueId: "issue-stop-failure",
      issueKey: "INV-5F",
      title: "Do not falsely confirm stop",
      delegatedToPatchRelay: false,
    });
    const run = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "collaboration",
    });
    db.runs.updateRunThread(run.id, {
      threadId: "thread-stop-failure",
      turnId: "turn-stop-failure",
    });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: run.id,
    });

    const service = new AgentInputService(
      db,
      {
        interruptTurn: async () => {
          throw new Error("Codex app-server connection closed");
        },
      } as never,
      {} as never,
      pino({ enabled: false }),
    );
    const result = await service.stopIssue({
      issue,
      body: "Stop",
      source: "linear_stop_signal",
    });

    assert.deepEqual(result, {
      status: "failed",
      activeRunType: "collaboration",
      reason: "Codex app-server connection closed",
    });
    assert.equal(db.getIssue(issue.projectId, issue.linearIssueId)?.activeRunId, run.id);
    assert.equal(db.runs.getRunById(run.id)?.status, "running");
    assert.equal(
      db.issueSessions
        .listIssueSessionEvents(issue.projectId, issue.linearIssueId)
        .some((event) => event.eventType === "stop_requested"),
      false,
    );
  } finally {
    cleanup();
  }
});

test("stop does not clear a newer run that claims the issue during interrupt confirmation", async () => {
  const { db, cleanup } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "inventory",
      linearIssueId: "issue-stop-race",
      issueKey: "INV-5R",
      title: "Preserve the newer run",
      delegatedToPatchRelay: false,
    });
    const originalRun = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "collaboration",
    });
    db.runs.updateRunThread(originalRun.id, {
      threadId: "thread-stop-race",
      turnId: "turn-stop-race",
    });
    db.upsertIssue({
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      activeRunId: originalRun.id,
    });
    const issueAtStop = db.getIssue(issue.projectId, issue.linearIssueId)!;
    let replacementRunId: number | undefined;
    const service = new AgentInputService(
      db,
      {
        interruptTurn: async () => {
          db.runs.finishRun(originalRun.id, {
            status: "released",
            failureReason: "Original turn settled during interrupt",
          });
          const replacement = db.runs.createRun({
            issueId: issue.id,
            projectId: issue.projectId,
            linearIssueId: issue.linearIssueId,
            runType: "collaboration",
          });
          replacementRunId = replacement.id;
          db.upsertIssue({
            projectId: issue.projectId,
            linearIssueId: issue.linearIssueId,
            activeRunId: replacement.id,
          });
        },
      } as never,
      {} as never,
      pino({ enabled: false }),
    );

    const result = await service.stopIssue({
      issue: issueAtStop,
      body: "Stop",
      source: "linear_stop_signal",
    });

    assert.equal(result.status, "failed");
    assert.match(result.reason ?? "", /active run changed/i);
    assert.equal(db.getIssue(issue.projectId, issue.linearIssueId)?.activeRunId, replacementRunId);
    assert.equal(db.runs.getRunById(replacementRunId!)?.status, "queued");
    assert.equal(
      db.issueSessions
        .listIssueSessionEvents(issue.projectId, issue.linearIssueId)
        .some((event) => event.eventType === "stop_requested"),
      false,
    );
  } finally {
    cleanup();
  }
});

test("collaboration plan sync does not move the Linear issue into delivery states", async () => {
  const { db, cleanup, baseDir } = createDb();
  try {
    const project = {
      id: "inventory",
      repoPath: path.join(baseDir, "repo"),
      worktreeRoot: path.join(baseDir, "worktrees"),
      branchPrefix: "inv",
    } as ProjectConfig;
    const issue = db.upsertIssue({
      projectId: project.id,
      linearIssueId: "issue-6",
      issueKey: "INV-6",
      title: "Keep backlog state while exploring",
      delegatedToPatchRelay: false,
      agentSessionId: "session-6",
      currentLinearState: "Backlog",
      currentLinearStateType: "backlog",
    });
    let stateWrites = 0;
    const plans: Array<Array<{ content: string }>> = [];
    const linear = {
      updateAgentSession: async ({ plan }: { plan?: Array<{ content: string }> }) => {
        plans.push(plan ?? []);
        return { id: "session-6" };
      },
      setIssueState: async () => {
        stateWrites += 1;
      },
    } as unknown as LinearClient;
    const sync = new LinearSessionSync(
      {
        server: { bind: "127.0.0.1", port: 8787 },
        projects: [project],
      } as AppConfig,
      db,
      { forProject: async () => linear },
      pino({ enabled: false }),
    );

    await sync.syncSession(issue, { activeRunType: "collaboration" });

    assert.equal(stateWrites, 0);
    assert.match(plans[0]?.map((step) => step.content).join("\n") ?? "", /Investigate relevant context/);
    assert.doesNotMatch(plans[0]?.map((step) => step.content).join("\n") ?? "", /Merge/);
  } finally {
    cleanup();
  }
});

test("reused collaboration threads resolve notifications to the matching newest run", () => {
  const { db, cleanup } = createDb();
  try {
    const issue = db.upsertIssue({
      projectId: "inventory",
      linearIssueId: "issue-thread-reuse",
      issueKey: "INV-THREAD",
      title: "Continue one conversation",
      delegatedToPatchRelay: false,
    });
    const first = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "collaboration",
    });
    db.runs.updateRunThread(first.id, {
      threadId: "thread-shared",
      turnId: "turn-first",
    });
    db.runs.finishRun(first.id, { status: "completed" });
    const second = db.runs.createRun({
      issueId: issue.id,
      projectId: issue.projectId,
      linearIssueId: issue.linearIssueId,
      runType: "collaboration",
    });
    db.runs.updateRunThread(second.id, {
      threadId: "thread-shared",
      turnId: "turn-second",
    });

    assert.equal(db.runs.getRunByThreadId("thread-shared", "turn-first")?.id, first.id);
    assert.equal(db.runs.getRunByThreadId("thread-shared", "turn-second")?.id, second.id);
    assert.equal(db.runs.getRunByThreadId("thread-shared")?.id, second.id);
  } finally {
    cleanup();
  }
});
