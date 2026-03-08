import { existsSync } from "node:fs";
import path from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { IPty } from "node-pty";
import type { Logger } from "pino";
import { PatchRelayDatabase } from "./db.js";
import type {
  AppConfig,
  IssueMetadata,
  IssueRunRecord,
  LaunchPlan,
  PersistedIssueRecord,
  ProjectConfig,
  SessionRecord,
  WorkflowKind,
} from "./types.js";
import { ensureDir, execCommand, interpolateTemplateArray } from "./utils.js";
import { ZmxSessionManager } from "./zmx.js";

const LEASE_DURATION_MS = 5 * 60 * 1000;
const LEASE_HEARTBEAT_MS = 30 * 1000;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function buildSessionName(config: AppConfig, issue: IssueMetadata, workflowKind: WorkflowKind): string {
  const base = sanitizePathSegment((issue.identifier ?? issue.id).toLowerCase());
  const suffix = workflowKind === "implementation" ? "" : workflowKind === "review" ? "r" : "d";
  const prefixedBase = config.runner.zmxSessionPrefix
    ? `${sanitizePathSegment(config.runner.zmxSessionPrefix)}-${base}`
    : base;

  return `${prefixedBase}${suffix}`;
}

function buildPrompt(issue: IssueMetadata, workflowKind: WorkflowKind, workflowFile: string): string {
  const verb = workflowKind === "implementation" ? "implement" : workflowKind === "review" ? "review" : "deploy";
  return `${issue.identifier ?? issue.id} ${verb} according to ${path.basename(workflowFile)}`;
}

export function buildLaunchPlan(
  config: AppConfig,
  project: ProjectConfig,
  issue: IssueMetadata,
  workflowKind: WorkflowKind,
): LaunchPlan {
  const issueRef = sanitizePathSegment(issue.identifier ?? issue.id);
  const slug = issue.title ? slugify(issue.title) : "";
  const branchSuffix = slug ? `${issueRef}-${slug}` : issueRef;
  const workflowFile = project.workflowFiles[workflowKind];

  return {
    branchName: `${project.branchPrefix}/${branchSuffix}`,
    worktreePath: path.join(project.worktreeRoot, issueRef),
    sessionName: buildSessionName(config, issue, workflowKind),
    prompt: buildPrompt(issue, workflowKind, workflowFile),
    workflowKind,
    workflowFile,
    stage: workflowKind,
  };
}

function toIssueMetadata(issue: PersistedIssueRecord): IssueMetadata {
  return {
    id: issue.linearIssueId,
    ...(issue.linearIssueKey ? { identifier: issue.linearIssueKey } : {}),
    ...(issue.title ? { title: issue.title } : {}),
    ...(issue.issueUrl ? { url: issue.issueUrl } : {}),
    labelNames: [],
  };
}

function parseExitCodeFromHistory(history: string): number | undefined {
  const match = history.match(/ZMX_TASK_COMPLETED:(\d+)/);
  if (!match) {
    return undefined;
  }

  return Number(match[1]);
}

export class LaunchRunner {
  private readonly zmx: ZmxSessionManager;
  private readonly attachedClients = new Map<number, IPty>();
  private readonly monitoredSessions = new Set<number>();
  private runCompletionHandler?: (params: {
    projectId: string;
    linearIssueId: string;
    runId: number;
    sessionId: number;
    exitCode: number;
  }) => Promise<void> | void;

  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly logger: Logger,
    private readonly leaseOwner: string,
  ) {
    this.zmx = new ZmxSessionManager(config.runner.zmxBin);
  }

  setRunCompletionHandler(
    handler: (params: { projectId: string; linearIssueId: string; runId: number; sessionId: number; exitCode: number }) => Promise<void> | void,
  ): void {
    this.runCompletionHandler = handler;
  }

  async launch(params: {
    project: ProjectConfig;
    issue: PersistedIssueRecord;
    workflowKind: WorkflowKind;
    triggerWebhookId: string;
  }): Promise<LaunchPlan | undefined> {
    const issueMetadata = toIssueMetadata(params.issue);
    const plan = buildLaunchPlan(this.config, params.project, issueMetadata, params.workflowKind);
    const claim = this.db.claimIssueLaunch({
      projectId: params.project.id,
      linearIssueId: params.issue.linearIssueId,
      stage: plan.stage,
      triggerWebhookId: params.triggerWebhookId,
      branchName: plan.branchName,
      worktreePath: plan.worktreePath,
      leaseOwner: this.leaseOwner,
      leaseDurationMs: LEASE_DURATION_MS,
    });

    if (!claim) {
      return undefined;
    }

    const { runId } = claim;
    let attachClient: IPty | undefined;

    this.logger.info(
      {
        projectId: params.project.id,
        issueId: params.issue.linearIssueId,
        issueKey: params.issue.linearIssueKey,
        issueTitle: params.issue.title,
        workflowKind: plan.workflowKind,
        workflowFile: plan.workflowFile,
        branchName: plan.branchName,
        worktreePath: plan.worktreePath,
        sessionName: plan.sessionName,
        runId,
      },
      "Prepared launch plan",
    );

    try {
      if (!existsSync(plan.workflowFile)) {
        throw new Error(`Workflow file not found: ${plan.workflowFile}`);
      }

      await ensureDir(params.project.worktreeRoot);
      await this.ensureWorktree(params.project.repoPath, plan.worktreePath, plan.branchName);

      const command = interpolateTemplateArray(this.config.runner.launch.args, {
        repoPath: params.project.repoPath,
        worktreePath: plan.worktreePath,
        workflowFile: plan.workflowFile,
        projectId: params.project.id,
        issueId: params.issue.linearIssueId,
        issueKey: params.issue.linearIssueKey ?? "",
        issueTitle: params.issue.title ?? "",
        issueUrl: params.issue.issueUrl ?? "",
        branchName: plan.branchName,
        prompt: plan.prompt,
      });

      this.logger.info(
        {
          projectId: params.project.id,
          issueId: params.issue.linearIssueId,
          runId,
          cwd: plan.worktreePath,
          workflowKind: plan.workflowKind,
          command: {
            shell: this.config.runner.launch.shell,
            args: command,
          },
        },
        "Launching zmx session command",
      );

      attachClient = this.zmx.attach(plan.sessionName, this.config.runner.launch.shell, command, {
        cwd: plan.worktreePath,
      });
      await this.waitForAttachSession(plan.sessionName, attachClient, 10_000);

      const sessionId = this.db.createSession({
        projectId: params.project.id,
        linearIssueId: params.issue.linearIssueId,
        runId,
        stage: plan.stage,
        zmxSessionName: plan.sessionName,
        branchName: plan.branchName,
        worktreePath: plan.worktreePath,
      });
      this.attachedClients.set(sessionId, attachClient);
      attachClient = undefined;

      this.db.updateRunSessionId(runId, sessionId);
      this.db.refreshIssueLease({
        projectId: params.project.id,
        linearIssueId: params.issue.linearIssueId,
        runId,
        leaseOwner: this.leaseOwner,
        leaseDurationMs: LEASE_DURATION_MS,
        state: "running",
      });

      this.monitorSession({
        project: params.project,
        issue: issueMetadata,
        run: {
          id: runId,
          projectId: params.project.id,
          linearIssueId: params.issue.linearIssueId,
          stage: plan.stage,
          status: "running",
          startedAt: new Date().toISOString(),
          triggerWebhookId: params.triggerWebhookId,
          sessionId,
        },
        session: {
          id: sessionId,
          projectId: params.project.id,
          linearIssueId: params.issue.linearIssueId,
          runId,
          stage: plan.stage,
          zmxSessionName: plan.sessionName,
          branchName: plan.branchName,
          worktreePath: plan.worktreePath,
          startedAt: new Date().toISOString(),
        },
        plan,
      });

      return plan;
    } catch (error) {
      attachClient?.kill();
      this.db.finishIssueRun({
        runId,
        status: "failed",
        errorJson: JSON.stringify({ message: error instanceof Error ? error.message : String(error) }),
      });
      this.db.clearActiveRun({
        projectId: params.project.id,
        linearIssueId: params.issue.linearIssueId,
        runId,
        nextState: "failed",
      });
      throw error;
    }
  }

  resumeSessionMonitoring(params: {
    project: ProjectConfig;
    issue: PersistedIssueRecord;
    run: IssueRunRecord;
    session: SessionRecord;
  }): void {
    const issueMetadata = toIssueMetadata(params.issue);
    const plan = buildLaunchPlan(this.config, params.project, issueMetadata, params.run.stage);
    this.db.refreshIssueLease({
      projectId: params.project.id,
      linearIssueId: params.issue.linearIssueId,
      runId: params.run.id,
      leaseOwner: this.leaseOwner,
      leaseDurationMs: LEASE_DURATION_MS,
      state: "running",
    });
    this.monitorSession({
      project: params.project,
      issue: issueMetadata,
      run: params.run,
      session: params.session,
      plan: {
        ...plan,
        branchName: params.session.branchName,
        worktreePath: params.session.worktreePath,
        sessionName: params.session.zmxSessionName,
      },
    });
  }

  async listLiveSessions(): Promise<string[]> {
    return this.zmx.listSessions({ timeoutMs: 10_000 });
  }

  async readExitCode(sessionName: string): Promise<number | undefined> {
    try {
      const history = await this.zmx.history(sessionName, { timeoutMs: 10_000 });
      return parseExitCodeFromHistory(history);
    } catch {
      return undefined;
    }
  }

  private monitorSession(params: {
    project: ProjectConfig;
    issue: IssueMetadata;
    run: IssueRunRecord;
    session: SessionRecord;
    plan: LaunchPlan;
  }): void {
    if (this.monitoredSessions.has(params.session.id)) {
      return;
    }

    this.monitoredSessions.add(params.session.id);
    const attachClient = this.attachedClients.get(params.session.id);
    const child = this.zmx.spawnWait(params.plan.sessionName, {
      cwd: params.plan.worktreePath,
    });
    const heartbeat = setInterval(() => {
      this.db.refreshIssueLease({
        projectId: params.project.id,
        linearIssueId: params.issue.id,
        runId: params.run.id,
        leaseOwner: this.leaseOwner,
        leaseDurationMs: LEASE_DURATION_MS,
        state: "running",
      });
    }, LEASE_HEARTBEAT_MS);

    child.stdout.on("data", (chunk) => {
      this.logger.info(
        {
          projectId: params.project.id,
          issueId: params.issue.id,
          sessionName: params.plan.sessionName,
          output: chunk.toString().trim(),
        },
        "Launch session output",
      );
    });

    child.stderr.on("data", (chunk) => {
      this.logger.warn(
        {
          projectId: params.project.id,
          issueId: params.issue.id,
          sessionName: params.plan.sessionName,
          errorOutput: chunk.toString().trim(),
        },
        "Launch session stderr",
      );
    });

    child.on("close", (code) => {
      clearInterval(heartbeat);
      const exitCode = code ?? 1;
      this.monitoredSessions.delete(params.session.id);
      this.attachedClients.delete(params.session.id);
      attachClient?.kill();
      this.logger.info(
        {
          projectId: params.project.id,
          issueId: params.issue.id,
          sessionName: params.plan.sessionName,
          exitCode,
        },
        "Launch session exited",
      );
      this.finishRunLifecycle({
        projectId: params.project.id,
        linearIssueId: params.issue.id,
        runId: params.run.id,
        sessionId: params.session.id,
        exitCode,
      });
    });
  }

  private finishRunLifecycle(params: {
    projectId: string;
    linearIssueId: string;
    runId: number;
    sessionId: number;
    exitCode: number;
  }): void {
    this.db.finishSession(params.sessionId, params.exitCode);
    this.db.finishIssueRun({
      runId: params.runId,
      status: params.exitCode === 0 ? "completed" : "failed",
      ...(params.exitCode === 0
        ? { resultJson: JSON.stringify({ exitCode: params.exitCode }) }
        : { errorJson: JSON.stringify({ exitCode: params.exitCode }) }),
    });
    this.db.clearActiveRun({
      projectId: params.projectId,
      linearIssueId: params.linearIssueId,
      runId: params.runId,
      nextState: params.exitCode === 0 ? "completed" : "failed",
    });
    void Promise.resolve(
      this.runCompletionHandler?.({
        projectId: params.projectId,
        linearIssueId: params.linearIssueId,
        runId: params.runId,
        sessionId: params.sessionId,
        exitCode: params.exitCode,
      }),
    ).catch((error) => {
      this.logger.error({ error, ...params }, "Run completion handler failed");
    });
  }

  private async waitForAttachSession(sessionName: string, attachClient: IPty, timeoutMs: number): Promise<void> {
    let exited = false;
    let exitCode: number | undefined;
    let recentOutput = "";

    attachClient.onExit(({ exitCode: nextExitCode }) => {
      exited = true;
      exitCode = nextExitCode;
    });
    attachClient.onData((chunk) => {
      recentOutput = `${recentOutput}${chunk}`.slice(-4000);
    });

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (exited) {
        throw new Error(
          `zmx attach exited before session was registered for ${sessionName}: exit=${exitCode ?? 1} output=${recentOutput.trim()}`,
        );
      }

      const sessions = await this.zmx.listSessions({ timeoutMs: 5_000 });
      if (sessions.includes(sessionName)) {
        return;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 250);
      });
    }

    attachClient.kill();
    throw new Error(`Timed out waiting for zmx attach session registration: ${sessionName}`);
  }

  private async ensureWorktree(repoPath: string, worktreePath: string, branchName: string): Promise<void> {
    await ensureDir(path.dirname(worktreePath));
    const args = ["-C", repoPath, "worktree", "add", "--force", "-B", branchName, worktreePath, "HEAD"];
    this.logger.info(
      {
        command: {
          shell: this.config.runner.gitBin,
          args,
        },
        cwd: repoPath,
      },
      "Preparing worktree command",
    );
    await execCommand(this.config.runner.gitBin, args, {
      timeoutMs: 120_000,
    });
  }
}
