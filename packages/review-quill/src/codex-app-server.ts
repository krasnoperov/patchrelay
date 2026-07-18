import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "pino";
import type { CodexAppServerConfig, CodexThreadItem, CodexThreadSummary } from "./types.ts";
import { sanitizeDiagnosticText } from "./utils.ts";

interface JsonRpcSuccess {
  id: number | string;
  result: unknown;
}

interface JsonRpcFailure {
  id: number | string;
  error: unknown;
}

interface JsonRpcErrorPayload {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}

export class CodexJsonRpcError extends Error {
  constructor(
    readonly code: number | undefined,
    message: string,
    readonly data: unknown,
  ) {
    super(message);
    this.name = "CodexJsonRpcError";
  }

  static fromPayload(payload: unknown): CodexJsonRpcError {
    const value = payload && typeof payload === "object" ? payload as JsonRpcErrorPayload : {};
    const code = typeof value.code === "number" ? value.code : undefined;
    const message = typeof value.message === "string" && value.message.trim()
      ? value.message
      : JSON.stringify(payload);
    return new CodexJsonRpcError(code, message, value.data);
  }
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface StartThreadOptions {
  cwd: string;
}

export interface StartTurnOptions {
  threadId: string;
  input: string;
  cwd: string;
  outputSchema?: Record<string, unknown>;
}

export interface InterruptTurnOptions {
  threadId: string;
  turnId: string;
}

export function resolveCodexAppServerLaunch(config: CodexAppServerConfig): { command: string; args: string[] } {
  if (!config.sourceBashrc) {
    return { command: config.bin, args: config.args };
  }
  return {
    command: config.shellBin ?? "bash",
    args: ["-lc", 'source ~/.bashrc >/dev/null 2>&1 || true; exec "$0" "$@"', config.bin, ...config.args],
  };
}

export class CodexAppServerClient extends EventEmitter {
  private static readonly DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private stdoutBuffer = "";

  constructor(
    private readonly config: CodexAppServerConfig,
    private readonly logger: Logger,
    private readonly spawnProcess: typeof spawn = spawn,
    /** Optional override for the child process env (used to strip frozen token vars). */
    private readonly childEnvProvider?: () => NodeJS.ProcessEnv,
  ) {
    super();
  }

  async start(): Promise<void> {
    if (this.child) return;
    const launch = resolveCodexAppServerLaunch(this.config);
    this.child = this.spawnProcess(launch.command, launch.args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(this.childEnvProvider ? { env: this.childEnvProvider() } : {}),
    }) as ChildProcessWithoutNullStreams;

    this.child.stderr.on("data", (chunk) => {
      const line = chunk.toString().trim();
      if (line) {
        this.logger.warn({ output: sanitizeDiagnosticText(line) }, "Codex app-server stderr");
      }
    });

    this.child.on("close", (code) => {
      this.rejectAllPending(new Error(`Codex app-server exited with code ${code ?? 1}`));
      this.child = undefined;
    });

    this.child.stdout.on("data", (chunk) => {
      this.stdoutBuffer += chunk.toString("utf8");
      this.drainMessages();
    });

    await this.sendRequest("initialize", {
      clientInfo: { name: "review-quill", title: "Review Quill", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.writeMessage({ jsonrpc: "2.0", method: "initialized" });
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    this.child.kill("SIGTERM");
    this.child = undefined;
  }

  async startThread(options: StartThreadOptions): Promise<CodexThreadSummary> {
    const response = (await this.sendRequest("thread/start", {
      cwd: options.cwd,
      approvalPolicy: this.config.approvalPolicy,
      sandbox: this.config.sandboxMode,
      serviceName: this.config.serviceName ?? "review-quill",
      model: this.config.model ?? null,
      modelProvider: this.config.modelProvider ?? null,
    })) as { thread: Record<string, unknown> };
    return this.mapThread(response.thread);
  }

  async startTurn(options: StartTurnOptions): Promise<{ turnId: string; status: string }> {
    const response = (await this.sendRequest("turn/start", {
      threadId: options.threadId,
      cwd: options.cwd,
      input: [{ type: "text", text: options.input, text_elements: [] }],
      ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
    })) as { turn: Record<string, unknown> };
    return {
      turnId: String(response.turn.id),
      status: String(response.turn.status),
    };
  }

  async interruptTurn(options: InterruptTurnOptions): Promise<void> {
    await this.sendRequest("turn/interrupt", {
      threadId: options.threadId,
      expectedTurnId: options.turnId,
    });
  }

  async readThread(threadId: string): Promise<CodexThreadSummary> {
    const response = (await this.sendRequest("thread/read", {
      threadId,
      includeTurns: true,
    })) as { thread: Record<string, unknown> };
    return this.mapThread(response.thread);
  }

  private async sendRequest(method: string, params: unknown): Promise<unknown> {
    if (!this.child?.stdin) throw new Error("Codex app-server is not running");
    const id = this.nextRequestId++;
    const requestTimeoutMs = this.config.requestTimeoutMs ?? CodexAppServerClient.DEFAULT_REQUEST_TIMEOUT_MS;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`Codex app-server request timed out after ${requestTimeoutMs}ms`));
      }, requestTimeoutMs);
      timeout.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });

    this.writeMessage({ jsonrpc: "2.0", id, method, params });
    return await promise;
  }

  private writeMessage(message: Record<string, unknown>): void {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private drainMessages(): void {
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;
      const message = JSON.parse(line) as JsonRpcSuccess | JsonRpcFailure | JsonRpcNotification;
      if ("method" in message) continue;
      const id = Number(message.id);
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      if ("error" in message) {
        pending.reject(CodexJsonRpcError.fromPayload(message.error));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private mapThread(thread: Record<string, unknown>): CodexThreadSummary {
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    return {
      id: String(thread.id),
      turns: turns.map((turn) => {
        const value = turn as Record<string, unknown>;
        // Preserve the turn-level error so callers can surface the REAL
        // failure (e.g. account usage-limit text) instead of a generic
        // "no assistant message" error. Turns can carry an error event
        // even when their status is "completed".
        const rawError = value.error as { message?: unknown } | null | undefined;
        const errorMessage = rawError && typeof rawError === "object" && typeof rawError.message === "string" && rawError.message.trim()
          ? rawError.message
          : undefined;
        return {
          id: String(value.id),
          status: String(value.status),
          items: Array.isArray(value.items) ? (value.items as CodexThreadItem[]) : [],
          ...(errorMessage ? { error: { message: errorMessage } } : {}),
        };
      }),
    };
  }
}
