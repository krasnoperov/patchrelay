import pino from "pino";

import { loadConfig } from "./config.ts";
import { decorateAttempt } from "./attempt-state.ts";
import { SqliteStore } from "./db/sqlite-store.ts";
import { CodexAppServerClient } from "./codex-app-server.ts";
import {
  checkExecutable,
  checkPath,
  defaultRunCommand,
  fetchServiceAuthStatus,
  fetchServiceHealth,
  getHomeEnv,
  loadRepoConfigById,
  type CommandRunner,
} from "./cli-system.ts";
import {
  buildLocalDiffContext,
  defaultDiffRepoConfig,
  detectDefaultBranch,
  detectRepoFullNameFromCwd,
  estimateTokens,
  renderDiffContextLines,
} from "./diff-context/index.ts";
import { getDefaultConfigPath, getReviewQuillPathLayout } from "./runtime-paths.ts";
import { helpTextFor, writeUsageError } from "./cli/help.ts";
import type { Output } from "./cli/shared.ts";
import { formatJson, writeOutput } from "./cli/shared.ts";
import {
  hasHelpFlag,
  parseArgs,
  parseConfigPath,
  parseIntegerFlag,
  parsePullRequestNumber,
  rewriteParsedArgs,
  type HelpTopic,
  type ParsedArgs,
  UsageError,
  validateFlags,
} from "./cli/args.ts";
import { discoverRepoSettingsViaGhCli, queryReviewGateState } from "./cli/gh.ts";
import { handleAttach, handleInit, handleRepos } from "./cli/repo.ts";
import { handleService } from "./cli/service.ts";
import type { CodexThreadSummary, ReviewAttemptRecord, ReviewQuillConfig, ReviewQuillRepositoryConfig } from "./types.ts";

interface RunCliOptions {
  stdout?: Output;
  stderr?: Output;
  runCommand?: CommandRunner;
  readCodexThread?: (threadId: string) => Promise<CodexThreadSummary>;
}

interface DoctorCheck {
  status: "pass" | "warn" | "fail";
  scope: string;
  message: string;
}

function withAttemptState(attempt: ReviewAttemptRecord, config: ReviewQuillConfig): ReviewAttemptRecord {
  return decorateAttempt(attempt, {
    policy: {
      queuedAfterMs: config.reconciliation.staleQueuedAfterMs,
      runningAfterMs: config.reconciliation.staleRunningAfterMs,
    },
  });
}

function writeHelp(stream: Output, topic: HelpTopic): void {
  writeOutput(stream, `${helpTextFor(topic)}\n`);
}

function helpTopicForCommand(command: string | undefined, topicArg: string | undefined): HelpTopic {
  if (command === "help") {
    switch (topicArg) {
      case "repo":
      case "attach":
      case "repos":
        return "repo";
      case "service":
        return "service";
      case "root":
      case undefined:
      case "dashboard":
      case "watch":
        return "root";
      default:
        throw new UsageError(`Unknown help topic: ${topicArg}`);
    }
  }

  switch (command) {
    case "attach":
    case "repo":
    case "repos":
      return "repo";
    case "service":
      return "service";
    default:
      return "root";
  }
}

function buildReviewGateChecks(repoId: string, repoFullName: string, appSlug: string | undefined): DoctorCheck[] {
  if (!appSlug) {
    return [{
      status: "warn",
      scope: `repo:${repoId}:github-review-gate`,
      message: "Could not determine the running review-quill app slug, so live GitHub review-gate validation was skipped.",
    }];
  }

  const payload = queryReviewGateState(repoFullName);
  const prs = payload.data?.repository?.pullRequests?.nodes ?? [];
  const reviewed = prs.flatMap((pr) => {
    const review = pr.latestReviews?.nodes?.find((entry) => entry.author?.login === appSlug);
    return review ? [{
      prNumber: pr.number ?? 0,
      reviewDecision: pr.reviewDecision ?? "unknown",
      state: review.state ?? "unknown",
      authorCanPushToRepository: review.authorCanPushToRepository ?? false,
      commitOid: review.commit?.oid,
      headSha: pr.headRefOid,
    }] : [];
  });

  if (reviewed.length === 0) {
    return [{
      status: "warn",
      scope: `repo:${repoId}:github-review-gate`,
      message: `No open PR currently has a latest ${appSlug} review, so GitHub gate counting could not be verified live.`,
    }];
  }

  const nonCounted = reviewed.filter((entry) => !entry.authorCanPushToRepository);
  if (nonCounted.length > 0) {
    return [{
      status: "warn",
      scope: `repo:${repoId}:github-review-gate`,
      message: `GitHub is not counting ${appSlug} on PR ${nonCounted.map((entry) => `#${entry.prNumber}`).join(", ")} because authorCanPushToRepository is false.`,
    }];
  }

  const mismatchedApprovals = reviewed.filter((entry) => entry.state === "APPROVED" && entry.reviewDecision !== "APPROVED");
  if (mismatchedApprovals.length > 0) {
    return [{
      status: "warn",
      scope: `repo:${repoId}:github-review-gate`,
      message: `GitHub still shows reviewDecision != APPROVED for ${appSlug} on PR ${mismatchedApprovals.map((entry) => `#${entry.prNumber}`).join(", ")}.`,
    }];
  }

  return [{
    status: "pass",
    scope: `repo:${repoId}:github-review-gate`,
    message: `GitHub is counting the latest ${appSlug} reviews on ${reviewed.map((entry) => `#${entry.prNumber}`).join(", ")}.`,
  }];
}

function safeListWatchedRepos(): ReviewQuillRepositoryConfig[] {
  try {
    const configPath = process.env.REVIEW_QUILL_CONFIG ?? getDefaultConfigPath();
    const config = loadConfig(configPath);
    return config.repositories;
  } catch {
    return [];
  }
}

async function resolveDiffRepoConfig(params: {
  cwd: string;
  explicitRepo?: string;
}): Promise<{ repo: ReviewQuillRepositoryConfig; source: "explicit" | "watched" | "defaults"; detectedRepoFullName?: string }> {
  if (params.explicitRepo) {
    return { repo: loadRepoConfigById(params.explicitRepo).repo as ReviewQuillRepositoryConfig, source: "explicit" };
  }
  const detected = await detectRepoFullNameFromCwd(params.cwd);
  if (detected) {
    const match = safeListWatchedRepos().find((entry) => entry.repoFullName.toLowerCase() === detected.toLowerCase());
    if (match) {
      return { repo: match, source: "watched", detectedRepoFullName: detected };
    }
  }
  const defaultBranch = await detectDefaultBranch(params.cwd);
  return {
    repo: defaultDiffRepoConfig(detected, defaultBranch),
    source: "defaults",
    ...(detected ? { detectedRepoFullName: detected } : {}),
  };
}

function applyDiffConfigOverrides(
  base: ReviewQuillRepositoryConfig,
  parsed: ParsedArgs,
): ReviewQuillRepositoryConfig {
  const next: ReviewQuillRepositoryConfig = { ...base };
  const ignore = parsed.flags.get("ignore");
  if (typeof ignore === "string") next.diffIgnore = ignore.split(",").map((entry) => entry.trim()).filter(Boolean);
  const summarize = parsed.flags.get("summarize-only");
  if (typeof summarize === "string") next.diffSummarizeOnly = summarize.split(",").map((entry) => entry.trim()).filter(Boolean);
  const budget = parseIntegerFlag(parsed.flags.get("budget"), "--budget");
  if (budget !== undefined) next.patchBodyBudgetTokens = budget;
  return next;
}

async function handleDoctor(parsed: ParsedArgs, stdout: Output, runCommand: CommandRunner): Promise<number> {
  const repoId = typeof parsed.flags.get("repo") === "string" ? String(parsed.flags.get("repo")) : undefined;
  const checks: DoctorCheck[] = [];
  const layout = getReviewQuillPathLayout();
  const env = getHomeEnv();
  let serviceAppSlug: string | undefined;

  const pathChecks = [
    ["home-config", layout.configPath, false],
    ["runtime-env", layout.runtimeEnvPath, false],
    ["service-env", layout.serviceEnvPath, false],
    ["state-dir", layout.stateDir, true],
    ["data-dir", layout.dataDir, true],
    ["systemd-unit", layout.systemdUnitPath, false],
  ] as const;
  for (const [scope, targetPath, writable] of pathChecks) {
    const result = checkPath(targetPath, writable);
    checks.push({ status: result.ok ? "pass" : "fail", scope, message: result.message });
  }

  for (const command of ["git", "gh", "codex"]) {
    const result = checkExecutable(command);
    checks.push({ status: result.ok ? "pass" : "fail", scope: command, message: result.message });
  }

  const appId = env.REVIEW_QUILL_GITHUB_APP_ID?.trim();
  checks.push({
    status: appId ? "pass" : "fail",
    scope: "github-app-id",
    message: appId ? `GitHub App id configured: ${appId}` : "GitHub App id is missing; set REVIEW_QUILL_GITHUB_APP_ID in service.env",
  });
  const githubAppKeyReady = await checkSecretReady(runCommand, "review-quill-github-app-pem", [
    "REVIEW_QUILL_GITHUB_APP_PRIVATE_KEY",
    "REVIEW_QUILL_GITHUB_APP_PRIVATE_KEY_FILE",
  ]);
  checks.push({
    status: githubAppKeyReady ? "pass" : "warn",
    scope: "github-app-key",
    message: githubAppKeyReady
      ? "GitHub App private key is configured"
      : "GitHub App private key is not configured via env/file or /etc/credstore.encrypted/review-quill-github-app-pem.cred",
  });
  const webhookSecretReady = await checkSecretReady(runCommand, "review-quill-webhook-secret", [
    "REVIEW_QUILL_WEBHOOK_SECRET",
    "REVIEW_QUILL_WEBHOOK_SECRET_FILE",
  ]);
  checks.push({
    status: webhookSecretReady ? "pass" : "warn",
    scope: "webhook-secret",
    message: webhookSecretReady
      ? "Webhook secret is configured"
      : "Webhook secret is not configured via env/file or /etc/credstore.encrypted/review-quill-webhook-secret.cred",
  });

  try {
    const config = loadConfig(layout.configPath);
    checks.push({
      status: "pass",
      scope: "config",
      message: `Config is valid with ${config.repositories.length} watched repos`,
    });
  } catch (error) {
    checks.push({
      status: "fail",
      scope: "config",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const health = await fetchServiceHealth();
    checks.push({
      status: "pass",
      scope: "service-health",
      message: `Local service is reachable with ${health.repos.length} repos`,
    });
  } catch (error) {
    checks.push({
      status: "warn",
      scope: "service-health",
      message: `Local service is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  try {
    const auth = await fetchServiceAuthStatus();
    serviceAppSlug = auth.appSlug;
    checks.push({
      status: auth.ready ? "pass" : "fail",
      scope: "service-auth",
      message: auth.ready
        ? auth.mode === "app" && auth.appId
          ? `Service GitHub auth is ready from App ${auth.appId}`
          : "Service GitHub auth is ready"
        : "Service GitHub auth is not ready",
    });
  } catch (error) {
    checks.push({
      status: "warn",
      scope: "service-auth",
      message: `Could not query running service auth: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  if (repoId) {
    try {
      const { repo } = loadRepoConfigById(repoId);
      checks.push({ status: "pass", scope: `repo:${repo.repoId}`, message: `Repo config is valid for ${repo.repoFullName}` });
      try {
        const discovered = discoverRepoSettingsViaGhCli(repo.repoFullName, repo.baseBranch);
        checks.push({
          status: discovered.defaultBranch === repo.baseBranch ? "pass" : "warn",
          scope: `repo:${repo.repoId}:github-default-branch`,
          message: discovered.defaultBranch === repo.baseBranch
            ? `Local base branch matches GitHub default branch (${discovered.defaultBranch})`
            : `Local base branch is ${repo.baseBranch}, but GitHub default branch is ${discovered.defaultBranch}`,
        });
        const localChecks = [...repo.requiredChecks].sort();
        const remoteChecks = [...discovered.requiredChecks].sort();
        const checksMatch = localChecks.length === remoteChecks.length && localChecks.every((value, index) => value === remoteChecks[index]);
        checks.push({
          status: checksMatch ? "pass" : "warn",
          scope: `repo:${repo.repoId}:github-required-checks`,
          message: checksMatch
            ? (localChecks.length > 0
                ? `Local required checks match GitHub for ${repo.baseBranch}`
                : `No required checks configured locally and GitHub does not require status checks for ${repo.baseBranch}`)
            : `Local required checks [${localChecks.join(", ") || "(none)"}] differ from GitHub [${remoteChecks.join(", ") || "(none)"}] for ${repo.baseBranch}`,
        });
        checks.push({
          status: "pass",
          scope: `repo:${repo.repoId}:review-protocol`,
          message: "review-quill uses its GitHub App identity for normal PR approvals or change requests.",
        });
        for (const check of buildReviewGateChecks(repo.repoId, repo.repoFullName, serviceAppSlug)) {
          checks.push(check);
        }
      } catch (error) {
        checks.push({
          status: "warn",
          scope: `repo:${repo.repoId}:github-discovery`,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } catch (error) {
      checks.push({
        status: "fail",
        scope: `repo:${repoId}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const ok = checks.every((check) => check.status !== "fail");
  if (parsed.flags.get("json") === true) {
    writeOutput(stdout, formatJson({ ok, checks }));
    return ok ? 0 : 1;
  }

  const lines = ["review-quill doctor", ""];
  for (const check of checks) {
    const marker = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
    lines.push(`${marker} [${check.scope}] ${check.message}`);
  }
  lines.push("");
  lines.push(ok ? "Doctor result: ready" : "Doctor result: not ready");
  writeOutput(stdout, `${lines.join("\n")}\n`);
  return ok ? 0 : 1;
}

async function checkSecretReady(
  runCommand: CommandRunner,
  credentialName: string,
  envKeys: string[],
): Promise<boolean> {
  const env = getHomeEnv();
  if (envKeys.some((key) => {
    const value = env[key];
    return typeof value === "string" && value.trim().length > 0;
  })) {
    return true;
  }

  const result = await runCommand("sudo", ["test", "-e", `/etc/credstore.encrypted/${credentialName}.cred`]);
  return result.exitCode === 0;
}

async function handleDiff(parsed: ParsedArgs, stdout: Output): Promise<number> {
  const explicitRepo = typeof parsed.flags.get("repo") === "string" ? String(parsed.flags.get("repo")) : undefined;
  const explicitBase = typeof parsed.flags.get("base") === "string" ? String(parsed.flags.get("base")) : undefined;
  const explicitCwd = typeof parsed.flags.get("cwd") === "string" ? String(parsed.flags.get("cwd")) : undefined;
  const json = parsed.flags.get("json") === true;
  const cwd = explicitCwd ?? process.cwd();

  const resolution = await resolveDiffRepoConfig({ cwd, ...(explicitRepo ? { explicitRepo } : {}) });
  const repo = applyDiffConfigOverrides(resolution.repo, parsed);

  const { workspace, diff } = await buildLocalDiffContext({
    repo,
    cwd,
    ...(explicitBase ? { baseRef: explicitBase } : {}),
  });

  const body = renderDiffContextLines(diff);

  if (json) {
    const diffSectionTokens = estimateTokens(body.join("\n"));
    const patchBodyTokens = diff.patches.reduce(
      (sum, entry) => sum + estimateTokens(entry.patch) + 23,
      0,
    );
    writeOutput(stdout, formatJson({
      configSource: resolution.source,
      ...(resolution.detectedRepoFullName ? { detectedRepoFullName: resolution.detectedRepoFullName } : {}),
      repo: {
        repoId: repo.repoId,
        repoFullName: repo.repoFullName,
        baseBranch: repo.baseBranch,
        diffIgnore: repo.diffIgnore,
        diffSummarizeOnly: repo.diffSummarizeOnly,
        patchBodyBudgetTokens: repo.patchBodyBudgetTokens,
      },
      workspace,
      estimatedTokens: {
        patchBody: patchBodyTokens,
        patchBodyBudget: repo.patchBodyBudgetTokens,
        fullDiffSection: diffSectionTokens,
      },
      diff,
    }));
    return 0;
  }

  writeOutput(stdout, `${body.join("\n")}\n`);
  return 0;
}

async function handleAttempts(parsed: ParsedArgs, stdout: Output): Promise<number> {
  const repoRef = parsed.positionals[1];
  const prNumber = parsePullRequestNumber(parsed.positionals[2]);
  if (!repoRef) {
    throw new UsageError("review-quill attempts requires <repo> <pr-number>.");
  }

  const configPath = process.env.REVIEW_QUILL_CONFIG ?? getDefaultConfigPath();
  const config = loadConfig(configPath);
  const { repo } = loadRepoConfigById(repoRef);
  const store = new SqliteStore(config.database.path);
  try {
    const attempts = store.listAttemptsForPullRequest(repo.repoFullName, prNumber, 50)
      .map((attempt) => withAttemptState(attempt, config));
    const payload = {
      repoId: repo.repoId,
      repoFullName: repo.repoFullName,
      prNumber,
      attempts,
    };

    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson(payload));
      return 0;
    }

    const lines = [
      `Repo: ${repo.repoFullName}`,
      `PR: #${prNumber}`,
      `Attempts: ${attempts.length}`,
    ];

    if (attempts.length === 0) {
      lines.push("");
      lines.push("No recorded review attempts.");
      writeOutput(stdout, `${lines.join("\n")}\n`);
      return 0;
    }

    lines.push("");
    lines.push("Review workspaces are disposable temp worktrees, so old attempts expose Codex thread ids rather than a stable reopen path.");

    for (const attempt of attempts) {
      lines.push("");
      lines.push(
        [
          `attempt #${attempt.id}`,
          attempt.stale ? "stale" : undefined,
          attempt.status,
          attempt.conclusion ?? undefined,
          attempt.completedAt ? `${attempt.createdAt} -> ${attempt.completedAt}` : `${attempt.createdAt} -> running`,
        ].filter(Boolean).join("  "),
      );
      lines.push(`Head SHA: ${attempt.headSha}`);
      if (attempt.threadId) {
        lines.push(`Thread: ${attempt.threadId}`);
        lines.push(`Catalog: search Codex old sessions for thread ${attempt.threadId}`);
      }
      if (attempt.turnId) {
        lines.push(`Turn: ${attempt.turnId}`);
      }
      if (attempt.externalCheckRunId !== undefined) {
        lines.push(`Check run: ${attempt.externalCheckRunId}`);
      }
      lines.push(`Updated: ${attempt.updatedAt}`);
      if (attempt.staleReason) {
        lines.push(`Stale: ${attempt.staleReason}`);
      }
      lines.push(`Summary: ${attempt.summary ?? "No summary captured."}`);
    }

    writeOutput(stdout, `${lines.join("\n")}\n`);
    return 0;
  } finally {
    store.close();
  }
}

function parseAttemptId(value: string | boolean | undefined): number | undefined {
  if (value === undefined || value === false) {
    return undefined;
  }
  if (value === true || typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    throw new UsageError(`Attempt id must be a positive integer. Received: ${String(value)}`);
  }
  return Number(value.trim());
}

function selectTranscriptAttempt(
  attempts: ReviewAttemptRecord[],
  attemptId?: number,
): { attempt: ReviewAttemptRecord; notice?: string } {
  if (attemptId !== undefined) {
    const match = attempts.find((attempt) => attempt.id === attemptId);
    if (!match) {
      throw new UsageError(`No recorded review attempt #${attemptId} for that pull request.`);
    }
    return { attempt: match };
  }

  const latest = attempts[0];
  const withThread = attempts.find((attempt) => attempt.threadId);
  if (withThread) {
    return {
      attempt: withThread,
      ...(latest && latest.id !== withThread.id && latest.stale && !latest.threadId
        ? {
            notice: `Newest attempt #${latest.id} is stale and has no stored Codex thread. Showing latest attempt with a stored thread instead (#${withThread.id}).`,
          }
        : {}),
    };
  }

  if (latest?.stale) {
    throw new UsageError(`Newest attempt #${latest.id} is stale and has no stored Codex thread. ${latest.staleReason ?? ""}`.trim());
  }

  throw new UsageError("No recorded review attempt with a stored Codex thread was found for that pull request.");
}

function formatTranscriptText(params: {
  repoFullName: string;
  prNumber: number;
  attempt: ReviewAttemptRecord;
  thread: CodexThreadSummary;
  notice?: string;
}): string {
  const formatUserMessage = (item: Record<string, unknown>): string | undefined => {
    const content = item.content;
    if (!Array.isArray(content)) {
      return undefined;
    }

    const textParts = content
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return undefined;
        }
        const value = (entry as Record<string, unknown>).text;
        return typeof value === "string" ? value : undefined;
      })
      .filter((value): value is string => Boolean(value));

    return textParts.length > 0 ? textParts.join("\n\n") : undefined;
  };

  const compactExtraFields = (item: Record<string, unknown>, ignored: string[]): string | undefined => {
    const filtered = Object.fromEntries(
      Object.entries(item).filter(([key, value]) => !ignored.includes(key) && value !== undefined),
    );
    return Object.keys(filtered).length > 0 ? JSON.stringify(filtered, null, 2) : undefined;
  };

  const lines = [
    `Repo: ${params.repoFullName}`,
    `PR: #${params.prNumber}`,
    `Attempt: #${params.attempt.id}`,
    `Status: ${params.attempt.status}${params.attempt.conclusion ? ` (${params.attempt.conclusion})` : ""}`,
    `Head SHA: ${params.attempt.headSha}`,
    `Thread: ${params.thread.id}`,
    params.attempt.turnId ? `Recorded turn: ${params.attempt.turnId}` : undefined,
    params.attempt.staleReason ? `Stale: ${params.attempt.staleReason}` : undefined,
    params.notice,
    "Visible thread items are shown below. Hidden model reasoning is not exposed by the app-server.",
    "",
  ].filter(Boolean) as string[];

  for (const [index, turn] of params.thread.turns.entries()) {
    lines.push(`Turn ${index + 1}: ${turn.id} [${turn.status}]`);
    for (const item of turn.items) {
      if (item.type === "userMessage") {
        lines.push(`user (${item.id}):`);
        const record = item as Record<string, unknown>;
        lines.push(formatUserMessage(record) ?? JSON.stringify(item, null, 2));
        const extra = compactExtraFields(record, ["type", "id", "content"]);
        if (extra) {
          lines.push("meta:");
          lines.push(extra);
        }
      } else if (item.type === "agentMessage" && typeof item.text === "string") {
        const record = item as Record<string, unknown>;
        const phaseValue = record.phase;
        const phase = typeof phaseValue === "string" ? ` [${phaseValue}]` : "";
        lines.push(`assistant (${item.id})${phase}:`);
        lines.push(item.text);
        const extra = compactExtraFields(record, ["type", "id", "text", "phase"]);
        if (extra) {
          lines.push("meta:");
          lines.push(extra);
        }
      } else {
        const record = item as Record<string, unknown>;
        const toolName = typeof record.toolName === "string"
          ? record.toolName
          : typeof record.name === "string"
            ? record.name
            : undefined;
        lines.push(`item ${item.type} (${item.id})${toolName ? ` [${toolName}]` : ""}:`);
        lines.push(JSON.stringify(item, null, 2));
      }
      lines.push("");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

async function handleTranscript(
  parsed: ParsedArgs,
  stdout: Output,
  readCodexThread?: (threadId: string) => Promise<CodexThreadSummary>,
): Promise<number> {
  const repoRef = parsed.positionals[1];
  const prNumber = parsePullRequestNumber(parsed.positionals[2]);
  if (!repoRef) {
    throw new UsageError("review-quill transcript requires <repo> <pr-number>.");
  }

  const configPath = process.env.REVIEW_QUILL_CONFIG ?? getDefaultConfigPath();
  const config = loadConfig(configPath);
  const { repo } = loadRepoConfigById(repoRef);
  const attemptId = parseAttemptId(parsed.flags.get("attempt"));
  const store = new SqliteStore(config.database.path);

  try {
    const attempts = store.listAttemptsForPullRequest(repo.repoFullName, prNumber, 50)
      .map((entry) => withAttemptState(entry, config));
    if (attempts.length === 0) {
      throw new UsageError("No recorded review attempts were found for that pull request.");
    }

    const selection = selectTranscriptAttempt(attempts, attemptId);
    const { attempt } = selection;
    if (!attempt.threadId) {
      throw new UsageError(
        `Review attempt #${attempt.id} does not have a stored Codex thread id.${attempt.staleReason ? ` ${attempt.staleReason}` : ""}`,
      );
    }

    const thread = readCodexThread
      ? await readCodexThread(attempt.threadId)
      : await (async () => {
          const client = new CodexAppServerClient(config.codex, pino({ level: "silent" }));
          await client.start();
          try {
            return await client.readThread(attempt.threadId!);
          } finally {
            await client.stop();
          }
        })();

    const payload = {
      repoId: repo.repoId,
      repoFullName: repo.repoFullName,
      prNumber,
      attempt,
      thread,
    };

    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson(payload));
      return 0;
    }

    writeOutput(stdout, formatTranscriptText({
      repoFullName: repo.repoFullName,
      prNumber,
      attempt,
      thread,
      ...(selection.notice ? { notice: selection.notice } : {}),
    }));
    return 0;
  } finally {
    store.close();
  }
}

function helpTopicFromParsedArgs(parsed: ParsedArgs): HelpTopic {
  return helpTopicForCommand(parsed.positionals[0], parsed.positionals[1]);
}

export async function runCli(args: string[], options?: RunCliOptions): Promise<number> {
  const stdout = options?.stdout ?? process.stdout;
  const stderr = options?.stderr ?? process.stderr;
  const runCommand = options?.runCommand ?? defaultRunCommand;

  try {
    const parsed = parseArgs(args);

    if (parsed.flags.get("version") === true || parsed.positionals[0] === "version") {
      const { version } = await import("../package.json", { with: { type: "json" } }).then((module) => module.default);
      writeOutput(stdout, `review-quill ${version}\n`);
      return 0;
    }

    validateFlags(parsed);
    const command = parsed.positionals[0] ?? "help";

    if (hasHelpFlag(parsed) || command === "help") {
      writeHelp(stdout, helpTopicFromParsedArgs(parsed));
      return 0;
    }

    switch (command) {
      case "serve": {
        const configPath = parseConfigPath(args.slice(1)) ?? process.env.REVIEW_QUILL_CONFIG ?? getDefaultConfigPath();
        const { startServer } = await import("./server.ts");
        await startServer(configPath);
        return 0;
      }
      case "watch":
      case "dashboard": {
        const configPath = parseConfigPath(args.slice(1)) ?? process.env.REVIEW_QUILL_CONFIG ?? getDefaultConfigPath();
        const { startWatch } = await import("./watch/index.tsx");
        await startWatch(configPath);
        return 0;
      }
      case "init":
        return await handleInit(parsed, stdout, runCommand);
      case "attach":
        return await handleAttach(parsed, stdout, runCommand);
      case "repos":
        return await handleRepos(parsed, stdout);
      case "repo": {
        const subcommand = parsed.positionals[1] ?? "list";
        if (subcommand === "attach") {
          return await handleAttach(rewriteParsedArgs(parsed, ["attach", ...parsed.positionals.slice(2)]), stdout, runCommand);
        }
        if (subcommand === "list") {
          return await handleRepos(rewriteParsedArgs(parsed, ["repos", ...parsed.positionals.slice(2)]), stdout);
        }
        if (subcommand === "show") {
          if (!parsed.positionals[2]) {
            throw new UsageError("review-quill repo show requires <id>.", "repo");
          }
          return await handleRepos(rewriteParsedArgs(parsed, ["repos", ...parsed.positionals.slice(2)]), stdout);
        }
        throw new UsageError(`Unknown repo command: ${subcommand}`, "repo");
      }
      case "doctor":
        return await handleDoctor(parsed, stdout, runCommand);
      case "attempts":
        return await handleAttempts(parsed, stdout);
      case "transcript":
        return await handleTranscript(parsed, stdout, options?.readCodexThread);
      case "diff":
        return await handleDiff(parsed, stdout);
      case "service":
        return await handleService(parsed, stdout, runCommand);
      default:
        throw new UsageError(`Unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      writeUsageError(stderr, error);
      return 1;
    }
    writeOutput(stderr, `${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
