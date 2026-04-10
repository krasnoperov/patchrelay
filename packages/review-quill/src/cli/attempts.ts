import { decorateAttempt } from "../attempt-state.ts";
import { loadConfig } from "../config.ts";
import { SqliteStore } from "../db/sqlite-store.ts";
import { getDefaultConfigPath } from "../runtime-paths.ts";
import { loadRepoConfigById } from "../cli-system.ts";
import type { Output } from "./shared.ts";
import { formatJson, writeOutput } from "./shared.ts";
import { parsePullRequestNumber, type ParsedArgs, UsageError } from "./args.ts";

export async function handleAttempts(parsed: ParsedArgs, stdout: Output): Promise<number> {
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
      .map((attempt) => decorateAttempt(attempt, {
        policy: {
          queuedAfterMs: config.reconciliation.staleQueuedAfterMs,
          runningAfterMs: config.reconciliation.staleRunningAfterMs,
        },
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
