import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "pino";
import type { CodexAppServerConfig, CodexThreadItem, CodexThreadSummary } from "./types.js";

interface JsonRpcSuccess {
  jsonrpc?: string;
  id: number | string;
  result: unknown;
}

interface JsonRpcFailure {
  jsonrpc?: string;
  id: number | string;
  error: unknown;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc?: string;
  method: string;
  params?: unknown;
}

export interface CodexNotification {
  method: string;
  params: Record<string, unknown>;
}

export interface StartThreadOptions {
  cwd: string;
}

export interface StartTurnOptions {
  threadId: string;
  input: string;
  cwd: string;
}

export class CodexAppServerClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private stdoutBuffer = "";
  private started = false;

  constructor(private readonly config: CodexAppServerConfig, private readonly logger: Logger) {
    super();
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.child = spawn(this.config.bin, this.config.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stderr.on("data", (chunk) => {
      const line = chunk.toString().trim();
      if (line) {
        this.logger.warn({ output: line }, "Codex app-server stderr");
      }
    });

    this.child.on("error", (error) => {
      this.rejectAllPending(error instanceof Error ? error : new Error(String(error)));
    });

    this.child.on("close", (code) => {
      this.started = false;
      this.rejectAllPending(new Error(`Codex app-server exited with code ${code ?? 1}`));
    });

    this.child.stdout.on("data", (chunk) => {
      this.stdoutBuffer += chunk.toString("utf8");
      this.drainMessages();
    });

    const initializeResponse = await this.sendRequest("initialize", {
      clientInfo: {
        name: "patchrelay",
        title: "PatchRelay",
        version: "0.1.0",
      },
      capabilities: null,
    });
    this.logger.info({ initializeResponse }, "Connected to Codex app-server");
    this.sendNotification("initialized");
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.child) {
      return;
    }

    this.child.kill("SIGTERM");
    this.child = undefined;
    this.started = false;
  }

  async startThread(options: StartThreadOptions): Promise<CodexThreadSummary> {
    const params: Record<string, unknown> = {
      cwd: options.cwd,
      approvalPolicy: this.config.approvalPolicy,
      sandbox: this.config.sandboxMode,
      serviceName: this.config.serviceName ?? "patchrelay",
      model: this.config.model ?? null,
      modelProvider: this.config.modelProvider ?? null,
      baseInstructions: this.config.baseInstructions ?? null,
      developerInstructions: this.config.developerInstructions ?? null,
      experimentalRawEvents: false,
    };
    if (this.config.persistExtendedHistory) {
      this.logger.warn("persistExtendedHistory is requested but not enabled in the active app-server capability handshake; ignoring");
    }
    const response = (await this.sendRequest("thread/start", params)) as { thread: Record<string, unknown> };
    return this.mapThread(response.thread);
  }

  async resumeThread(threadId: string, cwd?: string): Promise<CodexThreadSummary> {
    const params: Record<string, unknown> = {
      threadId,
      cwd: cwd ?? null,
      approvalPolicy: this.config.approvalPolicy,
      sandbox: this.config.sandboxMode,
      model: this.config.model ?? null,
      modelProvider: this.config.modelProvider ?? null,
      baseInstructions: this.config.baseInstructions ?? null,
      developerInstructions: this.config.developerInstructions ?? null,
    };
    if (this.config.persistExtendedHistory) {
      this.logger.warn("persistExtendedHistory is requested but not enabled in the active app-server capability handshake; ignoring");
    }
    const response = (await this.sendRequest("thread/resume", params)) as { thread: Record<string, unknown> };
    return this.mapThread(response.thread);
  }

  async forkThread(threadId: string, cwd?: string): Promise<CodexThreadSummary> {
    const params: Record<string, unknown> = {
      threadId,
      cwd: cwd ?? null,
      approvalPolicy: this.config.approvalPolicy,
      sandbox: this.config.sandboxMode,
      model: this.config.model ?? null,
      modelProvider: this.config.modelProvider ?? null,
      baseInstructions: this.config.baseInstructions ?? null,
      developerInstructions: this.config.developerInstructions ?? null,
    };
    if (this.config.persistExtendedHistory) {
      this.logger.warn("persistExtendedHistory is requested but not enabled in the active app-server capability handshake; ignoring");
    }
    const response = (await this.sendRequest("thread/fork", params)) as { thread: Record<string, unknown> };
    return this.mapThread(response.thread);
  }

  async startTurn(options: StartTurnOptions): Promise<{ threadId: string; turnId: string; status: string }> {
    const response = (await this.sendRequest("turn/start", {
      threadId: options.threadId,
      cwd: options.cwd,
      input: [
        {
          type: "text",
          text: options.input,
          text_elements: [],
        },
      ],
    })) as { turn: Record<string, unknown> };
    return {
      threadId: options.threadId,
      turnId: String(response.turn.id),
      status: String(response.turn.status),
    };
  }

  async readThread(threadId: string, includeTurns = true): Promise<CodexThreadSummary> {
    const response = (await this.sendRequest("thread/read", {
      threadId,
      includeTurns,
    })) as { thread: Record<string, unknown> };
    return this.mapThread(response.thread);
  }

  async listThreads(): Promise<CodexThreadSummary[]> {
    const response = (await this.sendRequest("thread/list", {})) as { data: Record<string, unknown>[] };
    return response.data.map((thread) => this.mapThread(thread));
  }

  private sendNotification(method: string, params?: unknown): void {
    this.writeMessage({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  private async sendRequest(method: string, params: unknown): Promise<unknown> {
    if (!this.child?.stdin) {
      throw new Error("Codex app-server is not running");
    }

    const id = this.nextRequestId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.writeMessage({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    return promise;
  }

  private writeMessage(message: Record<string, unknown>): void {
    if (!this.child?.stdin) {
      throw new Error("Codex app-server stdin is unavailable");
    }

    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private drainMessages(): void {
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }

      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      this.handleMessage(JSON.parse(line) as JsonRpcSuccess | JsonRpcFailure | JsonRpcRequest | JsonRpcNotification);
    }
  }

  private handleMessage(message: JsonRpcSuccess | JsonRpcFailure | JsonRpcRequest | JsonRpcNotification): void {
    if ("method" in message && "id" in message) {
      void this.handleServerRequest(message);
      return;
    }

    if ("method" in message) {
      const notification: CodexNotification = {
        method: message.method,
        params: (message.params ?? {}) as Record<string, unknown>,
      };
      this.emit("notification", notification);
      return;
    }

    const id = Number(message.id);
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);

    if ("error" in message) {
      pending.reject(new Error(JSON.stringify(message.error)));
      return;
    }

    pending.resolve(message.result);
  }

  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
    const id = request.id;
    let result: unknown;

    switch (request.method) {
      case "item/commandExecution/requestApproval":
        result = { decision: "acceptForSession" };
        break;
      case "item/fileChange/requestApproval":
        result = { decision: "acceptForSession" };
        break;
      case "execCommandApproval":
        result = { decision: "accept" };
        break;
      case "applyPatchApproval":
        result = { decision: "accept" };
        break;
      default:
        result = null;
        break;
    }

    this.writeMessage({
      jsonrpc: "2.0",
      id,
      result,
    });
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private mapThread(thread: Record<string, unknown>): CodexThreadSummary {
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    return {
      id: String(thread.id),
      preview: String(thread.preview ?? ""),
      cwd: String(thread.cwd ?? ""),
      status: String(thread.status ?? "unknown"),
      ...(thread.path === null || thread.path === undefined ? {} : { path: String(thread.path) }),
      turns: turns.map((turn) => {
        const value = turn as Record<string, unknown>;
        return {
          id: String(value.id),
          status: String(value.status),
          ...(value.error && typeof value.error === "object"
            ? { error: { message: String((value.error as Record<string, unknown>).message ?? "Unknown error") } }
            : {}),
          items: Array.isArray(value.items) ? (value.items as CodexThreadItem[]) : [],
        };
      }),
    };
  }
}
