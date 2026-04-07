import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import { CodexAppServerClient } from "./codex-app-server.ts";
import { extractFirstJsonObject, safeJsonParse } from "./utils.ts";
import type { GitHubClient } from "./github-client.ts";
import type { PullRequestSummary, ReviewQuillConfig, ReviewQuillRepositoryConfig, ReviewVerdict } from "./types.ts";

function isThreadMaterializationRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("not materialized yet") || message.includes("includeTurns is unavailable before first user message");
}

function collectAssistantMessages(thread: { turns: Array<{ items: Array<{ type: string; text?: string }> }> }): string[] {
  const messages: string[] = [];
  for (const turn of thread.turns) {
    for (const item of turn.items) {
      if (item.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
        messages.push(item.text.trim());
      }
    }
  }
  return messages;
}

function buildPrompt(params: {
  repo: ReviewQuillRepositoryConfig;
  pr: PullRequestSummary;
  files: Array<{ filename: string; patch?: string; additions: number; deletions: number; changes: number }>;
  docs: Array<{ path: string; text: string }>;
  priorReviews: Array<{ authorLogin?: string; state?: string; body?: string; commitId?: string }>;
}): string {
  const lines: string[] = [];
  lines.push(
    "You are Review Quill, a strict pull request reviewer.",
    "Review only the current PR head SHA described below.",
    "Return only one JSON object with this shape:",
    '{"verdict":"approve"|"request_changes","summary":"short summary","findings":[{"path":"optional","line":123,"severity":"blocking"|"nit","message":"text"}]}',
    "",
    "Approve only if the PR is ready to merge as-is.",
    "Nits alone should not block; mark them with severity nit.",
    "",
    `Repository: ${params.repo.repoFullName}`,
    `Base branch: ${params.pr.baseRefName}`,
    `Head branch: ${params.pr.headRefName}`,
    `PR: #${params.pr.number}`,
    `Head SHA: ${params.pr.headSha}`,
    `Title: ${params.pr.title}`,
    params.pr.body ? `Body:\n${params.pr.body}` : "Body: <empty>",
    "",
    "Changed files:",
  );

  for (const file of params.files) {
    lines.push(`- ${file.filename} (+${file.additions} -${file.deletions}, ${file.changes} changes)`);
    if (file.patch) {
      lines.push("```diff", file.patch.slice(0, 5000), "```");
    }
  }

  if (params.docs.length > 0) {
    lines.push("", "Repository guidance:");
    for (const doc of params.docs) {
      lines.push(`## ${doc.path}`, doc.text.slice(0, 8000), "");
    }
  }

  if (params.priorReviews.length > 0) {
    lines.push("", "Previous reviews:");
    for (const review of params.priorReviews.slice(-10)) {
      lines.push(`- ${review.authorLogin ?? "unknown"} [${review.state ?? "unknown"}] ${review.commitId ?? ""}`.trim());
      if (review.body) lines.push(review.body.slice(0, 2000));
    }
  }

  return lines.join("\n");
}

export class ReviewRunner {
  private readonly codex: CodexAppServerClient;

  constructor(
    private readonly config: ReviewQuillConfig,
    private readonly github: GitHubClient,
    private readonly logger: Logger,
  ) {
    this.codex = new CodexAppServerClient(config.codex, logger.child({ component: "codex" }));
  }

  async start(): Promise<void> {
    await this.codex.start();
  }

  async stop(): Promise<void> {
    await this.codex.stop();
  }

  async review(repo: ReviewQuillRepositoryConfig, pr: PullRequestSummary): Promise<{ verdict: ReviewVerdict; threadId: string; turnId: string }> {
    const files = await this.github.listPullRequestFiles(repo.repoFullName, pr.number);
    const docs = await Promise.all(repo.reviewDocs.map(async (docPath) => {
      const text = await this.github.readRepoFile(repo.repoFullName, docPath, pr.headSha);
      return text ? { path: docPath, text } : undefined;
    })).then((values) => values.filter((value): value is { path: string; text: string } => Boolean(value)));
    const priorReviews = await this.github.listPullRequestReviews(repo.repoFullName, pr.number);

    const cwd = await mkdtemp(path.join(tmpdir(), "review-quill-"));
    try {
      const thread = await this.codex.startThread({ cwd });
      const prompt = buildPrompt({ repo, pr, files, docs, priorReviews });
      const started = await this.codex.startTurn({ threadId: thread.id, cwd, input: prompt });
      const completedThread = await this.waitForTurnCompletion(thread.id, started.turnId);
      const latestMessage = collectAssistantMessages(completedThread).at(-1);
      if (!latestMessage) {
        throw new Error("Review run completed without an assistant message");
      }
      const jsonText = extractFirstJsonObject(latestMessage);
      const verdict = jsonText ? safeJsonParse<ReviewVerdict>(jsonText) : undefined;
      if (!verdict || (verdict.verdict !== "approve" && verdict.verdict !== "request_changes")) {
        throw new Error("Review run did not produce a valid structured verdict");
      }
      return { verdict, threadId: thread.id, turnId: started.turnId };
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  private async waitForTurnCompletion(threadId: string, turnId: string): Promise<Awaited<ReturnType<CodexAppServerClient["readThread"]>>> {
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      let thread: Awaited<ReturnType<CodexAppServerClient["readThread"]>>;
      try {
        thread = await this.codex.readThread(threadId);
      } catch (error) {
        if (isThreadMaterializationRace(error)) {
          await new Promise((resolve) => setTimeout(resolve, 750));
          continue;
        }
        throw error;
      }
      const turn = thread.turns.find((entry) => entry.id === turnId);
      if (!turn) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      if (turn.status === "completed") return thread;
      if (turn.status === "failed" || turn.status === "interrupted" || turn.status === "cancelled") {
        throw new Error(`Review turn ended with status ${turn.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    throw new Error("Timed out waiting for review turn completion");
  }
}
