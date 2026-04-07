import type { Logger } from "pino";
import { CodexAppServerClient } from "./codex-app-server.ts";
import { extractFirstJsonObject, safeJsonParse } from "./utils.ts";
import type { ReviewContext, ReviewQuillConfig, ReviewVerdict } from "./types.ts";

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

export class ReviewRunner {
  private readonly codex: CodexAppServerClient;

  constructor(
    private readonly config: ReviewQuillConfig,
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

  async review(context: ReviewContext): Promise<{ verdict: ReviewVerdict; threadId: string; turnId: string }> {
    const cwd = context.workspace.worktreePath;
    const thread = await this.codex.startThread({ cwd });
    const started = await this.codex.startTurn({ threadId: thread.id, cwd, input: context.prompt });
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
