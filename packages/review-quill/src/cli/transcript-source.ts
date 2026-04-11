import { decorateAttempt } from "../attempt-state.ts";
import { resolveCodexSessionSource } from "../codex-session-source.ts";
import { loadConfig } from "../config.ts";
import { SqliteStore } from "../db/sqlite-store.ts";
import { getDefaultConfigPath } from "../runtime-paths.ts";
import { loadRepoConfigById } from "../cli-system.ts";
import type { Output } from "./shared.ts";
import { formatJson, writeOutput } from "./shared.ts";
import { parsePullRequestNumber, type ParsedArgs, UsageError } from "./args.ts";
import { parseAttemptId, selectTranscriptAttempt } from "./attempt-selection.ts";
import type { ReviewAttemptRecord } from "../types.ts";
import type { CodexSessionSourceRecord } from "../codex-session-source.ts";

type ReviewAttemptWithSessionSource = ReviewAttemptRecord & {
  sessionSource?: CodexSessionSourceRecord;
};

function formatSessionSource(sessionSource: { exists: boolean; path?: string; error?: string } | undefined): string {
  if (!sessionSource) return "-";
  if (sessionSource.exists) return sessionSource.path ?? "-";
  return sessionSource.error ?? "not found";
}

export async function handleTranscriptSource(parsed: ParsedArgs, stdout: Output): Promise<number> {
  const repoRef = parsed.positionals[1];
  const prNumber = parsePullRequestNumber(parsed.positionals[2]);
  if (!repoRef) {
    throw new UsageError("review-quill transcript-source requires <repo> <pr-number>.");
  }

  const configPath = process.env.REVIEW_QUILL_CONFIG ?? getDefaultConfigPath();
  const config = loadConfig(configPath);
  const { repo } = loadRepoConfigById(repoRef);
  const attemptId = parseAttemptId(parsed.flags.get("attempt"));
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
    if (attempts.length === 0) {
      throw new UsageError("No recorded review attempts were found for that pull request.");
    }

    const selection = selectTranscriptAttempt(attempts, attemptId) as { attempt: ReviewAttemptWithSessionSource; notice?: string };
    const { attempt } = selection;
    const payload = {
      repoId: repo.repoId,
      repoFullName: repo.repoFullName,
      prNumber,
      attempt,
      ...(selection.notice ? { notice: selection.notice } : {}),
    };

    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson(payload));
      return 0;
    }

    const lines = [
      `Repo: ${repo.repoFullName}`,
      `PR: #${prNumber}`,
      `Attempt: #${attempt.id}`,
      `Status: ${attempt.status}${attempt.conclusion ? ` (${attempt.conclusion})` : ""}`,
      `Head SHA: ${attempt.headSha}`,
      attempt.threadId ? `Thread: ${attempt.threadId}` : undefined,
      attempt.turnId ? `Turn: ${attempt.turnId}` : undefined,
      `Session source: ${formatSessionSource(attempt.sessionSource)}`,
      attempt.sessionSource?.startedAt ? `Started: ${attempt.sessionSource.startedAt}` : undefined,
      attempt.sessionSource?.originator ? `Originator: ${attempt.sessionSource.originator}` : undefined,
      attempt.sessionSource?.cwd ? `Working directory: ${attempt.sessionSource.cwd}` : undefined,
      selection.notice,
      attempt.summary ? `Summary: ${attempt.summary}` : undefined,
    ].filter(Boolean);

    writeOutput(stdout, `${lines.join("\n")}\n`);
    return 0;
  } finally {
    store.close();
  }
}
