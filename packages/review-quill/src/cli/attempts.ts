import { decorateAttempt } from "../attempt-state.ts";
import { resolveCodexSessionSource } from "../codex-session-source.ts";
import { loadConfig } from "../config.ts";
import { SqliteStore } from "../db/sqlite-store.ts";
import { getDefaultConfigPath } from "../runtime-paths.ts";
import { loadRepoConfigById } from "../cli-system.ts";
import type { Output } from "./shared.ts";
import { formatJson, writeOutput } from "./shared.ts";
import { parsePullRequestNumber, type ParsedArgs } from "./args.ts";
import { resolvePrNumber, resolveRepo, type ResolveCommandRunner } from "./resolve.ts";

export async function handleAttempts(
  parsed: ParsedArgs,
  stdout: Output,
  resolveCommand?: ResolveCommandRunner,
): Promise<number> {
  const positionalRepo = parsed.positionals[1];
  const positionalPr = parsed.positionals[2];

  const repoRef = positionalRepo
    ?? (await resolveRepo({ parsed, runCommand: resolveCommand, helpTopic: "root" })).repoId;
  const prNumber = positionalPr
    ? parsePullRequestNumber(positionalPr)
    : (await resolvePrNumber({ parsed, runCommand: resolveCommand, helpTopic: "root" })).prNumber;

  const configPath = process.env.REVIEW_QUILL_CONFIG ?? getDefaultConfigPath();
  const config = loadConfig(configPath);
  const { repo } = loadRepoConfigById(repoRef);
  const store = new SqliteStore(config.database.path);
  try {
    const attempts = store.listAttemptsForPullRequest(repo.repoFullName, prNumber, 50)
      .map((attempt) => decorateAttempt(attempt, {
        policy: {
          queuedAfterMs: config.reconciliation.staleQueuedAfterMs,
          runningAfterMs: config.reconciliation.staleRunningAfterMs,
        },
      }))
      .map((attempt) => ({
        ...attempt,
        ...(attempt.threadId ? { sessionSource: resolveCodexSessionSource(attempt.threadId) } : {}),
      }));
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
        lines.push(`Session source: ${attempt.sessionSource?.exists ? attempt.sessionSource.path : attempt.sessionSource?.error ?? "not found"}`);
      }
      if (attempt.turnId) {
        lines.push(`Turn: ${attempt.turnId}`);
      }
      if (attempt.sessionSource?.startedAt) {
        lines.push(`Started: ${attempt.sessionSource.startedAt}`);
      }
      if (attempt.sessionSource?.originator) {
        lines.push(`Originator: ${attempt.sessionSource.originator}`);
      }
      if (attempt.sessionSource?.cwd) {
        lines.push(`Working directory: ${attempt.sessionSource.cwd}`);
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
