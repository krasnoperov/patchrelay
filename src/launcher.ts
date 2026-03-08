import { existsSync } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { PatchRelayDatabase } from "./db.js";
import type { AppConfig, IssueMetadata, LaunchPlan, ProjectConfig, WorkflowKind } from "./types.js";
import { ensureDir, execCommand, interpolateTemplateArray } from "./utils.js";
import { ZmxSessionManager } from "./zmx.js";

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

function buildPrompt(issue: IssueMetadata, workflowKind: WorkflowKind, workflowFile: string): string {
  const verb = workflowKind === "implementation" ? "implement" : workflowKind === "review" ? "review" : "deploy";
  return `${issue.id} ${verb} according to ${path.basename(workflowFile)}`;
}

function buildLaunchPlan(project: ProjectConfig, issue: IssueMetadata, workflowKind: WorkflowKind): LaunchPlan {
  const slug = issue.title ? slugify(issue.title) : "";
  const branchSuffix = slug ? `${issue.id}-${slug}` : issue.id;
  const workflowFile = project.workflowFiles[workflowKind];

  return {
    branchName: `${project.branchPrefix}/${branchSuffix}`,
    worktreePath: path.join(project.worktreeRoot, sanitizePathSegment(issue.id)),
    sessionName: `${sanitizePathSegment(project.id)}-${sanitizePathSegment(issue.id)}-${workflowKind}`,
    prompt: buildPrompt(issue, workflowKind, workflowFile),
    workflowKind,
    workflowFile,
    stage: workflowKind,
  };
}

export class LaunchRunner {
  private readonly zmx: ZmxSessionManager;

  constructor(
    private readonly config: AppConfig,
    private readonly db: PatchRelayDatabase,
    private readonly logger: Logger,
  ) {
    this.zmx = new ZmxSessionManager(config.runner.zmxBin);
  }

  async launch(params: {
    project: ProjectConfig;
    issue: IssueMetadata;
    webhookId: string;
    workflowKind: WorkflowKind;
  }): Promise<LaunchPlan> {
    const { project, issue, webhookId, workflowKind } = params;
    const plan = buildLaunchPlan(project, issue, workflowKind);
    const runId = this.db.createIssueRun({
      projectId: project.id,
      linearIssueId: issue.id,
      stage: plan.stage,
      triggerWebhookId: webhookId,
    });

    this.db.updateIssueState(project.id, issue.id, "launching", {
      branchName: plan.branchName,
      worktreePath: plan.worktreePath,
      activeRunId: runId,
    });

    this.logger.info(
      {
        projectId: project.id,
        issueId: issue.id,
        issueKey: issue.identifier,
        issueTitle: issue.title,
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

      await ensureDir(project.worktreeRoot);
      await this.ensureWorktree(project.repoPath, plan.worktreePath, plan.branchName);

      const command = interpolateTemplateArray(this.config.runner.launch.args, {
        repoPath: project.repoPath,
        worktreePath: plan.worktreePath,
        workflowFile: plan.workflowFile,
        projectId: project.id,
        issueId: issue.id,
        issueKey: issue.identifier ?? "",
        issueTitle: issue.title ?? "",
        issueUrl: issue.url ?? "",
        branchName: plan.branchName,
        prompt: plan.prompt,
      });

      this.logger.info(
        {
          projectId: project.id,
          issueId: issue.id,
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

      await this.zmx.run(plan.sessionName, this.config.runner.launch.shell, command, {
        cwd: plan.worktreePath,
        timeoutMs: 60_000,
      });

      const sessionId = this.db.createSession({
        projectId: project.id,
        linearIssueId: issue.id,
        runId,
        stage: plan.stage,
        zmxSessionName: plan.sessionName,
        branchName: plan.branchName,
        worktreePath: plan.worktreePath,
      });

      this.db.updateRunSessionId(runId, sessionId);
      this.db.updateIssueState(project.id, issue.id, "running", {
        branchName: plan.branchName,
        worktreePath: plan.worktreePath,
        activeRunId: runId,
      });

      this.monitorSession({
        project,
        issue,
        runId,
        sessionId,
        plan,
      });

      return plan;
    } catch (error) {
      this.db.finishIssueRun({
        runId,
        status: "failed",
        errorJson: JSON.stringify({ message: error instanceof Error ? error.message : String(error) }),
      });
      this.db.updateIssueState(project.id, issue.id, "failed", {
        branchName: plan.branchName,
        worktreePath: plan.worktreePath,
        activeRunId: null,
      });
      throw error;
    }
  }

  private monitorSession(params: {
    project: ProjectConfig;
    issue: IssueMetadata;
    runId: number;
    sessionId: number;
    plan: LaunchPlan;
  }): void {
    const child = this.zmx.spawnWait(params.plan.sessionName, {
      cwd: params.plan.worktreePath,
    });

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
      const exitCode = code ?? 1;
      this.logger.info(
        {
          projectId: params.project.id,
          issueId: params.issue.id,
          sessionName: params.plan.sessionName,
          exitCode,
        },
        "Launch session exited",
      );
      this.db.finishSession(params.sessionId, exitCode);
      this.db.finishIssueRun({
        runId: params.runId,
        status: exitCode === 0 ? "completed" : "failed",
        ...(exitCode === 0 ? { resultJson: JSON.stringify({ exitCode }) } : { errorJson: JSON.stringify({ exitCode }) }),
      });
      this.db.updateIssueState(params.project.id, params.issue.id, exitCode === 0 ? "completed" : "failed", {
        branchName: params.plan.branchName,
        worktreePath: params.plan.worktreePath,
        activeRunId: null,
      });
    });
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
