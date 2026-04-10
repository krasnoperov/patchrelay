import pino from "pino";
import { decorateAttempt } from "../attempt-state.ts";
import { loadConfig } from "../config.ts";
import { CodexAppServerClient } from "../codex-app-server.ts";
import { SqliteStore } from "../db/sqlite-store.ts";
import { getDefaultConfigPath } from "../runtime-paths.ts";
import { loadRepoConfigById } from "../cli-system.ts";
import type { CodexThreadSummary, ReviewAttemptRecord } from "../types.ts";
import type { Output } from "./shared.ts";
import { formatJson, writeOutput } from "./shared.ts";
import { parsePullRequestNumber, type ParsedArgs, UsageError } from "./args.ts";

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

export async function handleTranscript(
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
      .map((attempt) => decorateAttempt(attempt, {
        policy: {
          queuedAfterMs: config.reconciliation.staleQueuedAfterMs,
          runningAfterMs: config.reconciliation.staleRunningAfterMs,
        },
      }));
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
    const threadId = attempt.threadId;

    const thread = readCodexThread
      ? await readCodexThread(threadId)
      : await (async () => {
          const client = new CodexAppServerClient(config.codex, pino({ level: "silent" }));
          await client.start();
          try {
            return await client.readThread(threadId);
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
