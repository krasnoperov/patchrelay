import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import type { Logger } from "pino";
import type { CodexAppServerConfig, CodexThreadItem, CodexThreadSummary } from "./types.ts";
import { sanitizeDiagnosticText } from "./utils.ts";

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

export interface SteerTurnOptions {
  threadId: string;
  turnId: string;
  input: string;
}

interface ForkThreadOverrides {
  cwd?: string | undefined;
  approvalPolicy?: CodexAppServerConfig["approvalPolicy"] | undefined;
  sandboxMode?: CodexAppServerConfig["sandboxMode"] | undefined;
  model?: string | null | undefined;
  modelProvider?: string | null | undefined;
  reasoningEffort?: CodexAppServerConfig["reasoningEffort"] | undefined;
  baseInstructions?: string | null | undefined;
  developerInstructions?: string | null | undefined;
}

const COMPLETION_CHECK_DEVELOPER_INSTRUCTIONS = [
  "You are PatchRelay's completion check.",
  "This is a read-only follow-up used only to decide what should happen after a task ended without a PR.",
  "Do not run commands, do not call tools, do not edit files, and do not inspect or modify the repository.",
  "Use only the prior thread context and the facts in the current prompt.",
  "Return only the requested JSON object.",
].join("\n");

const PUBLICATION_RECAP_DEVELOPER_INSTRUCTIONS = [
  "You are PatchRelay's publication recap helper.",
  "This is a read-only follow-up used only to produce one concise Linear-visible summary for a successful run.",
  "Keep reasoning light and concise.",
  "Do not run commands, do not call tools, do not edit files, and do not inspect or modify the repository.",
  "Use only the prior thread context and the facts in the current prompt.",
  "Return only the requested JSON object.",
].join("\n");

export function resolveCodexAppServerLaunch(config: CodexAppServerConfig): { command: string; args: string[] } {
  if (!config.sourceBashrc) {
    return {
      command: config.bin,
      args: config.args,
    };
  }

  return {
    command: config.shellBin ?? "bash",
    args: [
      "-lc",
      'source ~/.bashrc >/dev/null 2>&1 || true; exec "$0" "$@"',
      config.bin,
      ...config.args,
    ],
  };
}

export class CodexAppServerClient extends EventEmitter {
  private static readonly DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private stdoutBuffer = "";
  private started = false;
  private stopping = false;

  constructor(
    private config: CodexAppServerConfig,
    private readonly logger: Logger,
    private readonly spawnProcess: typeof spawn = spawn,
  ) {
    super();
  }

  /**
   * Update runtime codex settings used by future thread/thread-fork calls.
   * This allows service config changes to take effect without restarting.
   */
  setRuntimeConfig(config: CodexAppServerConfig): void {
    this.config = {
      ...this.config,
      ...config,
    };
  }

  isStarted(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.stopping = false;
    const launch = resolveCodexAppServerLaunch(this.config);
    this.logger.info({ command: launch.command, args: launch.args }, "Starting Codex app-server");
    this.child = this.spawnProcess(launch.command, launch.args, {
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.child.stdin.on("error", (error) => {
      this.logger.error({ error: sanitizeDiagnosticText(error.message) }, "Codex app-server stdin error");
    });
    this.child.stdout.on("error", (error) => {
      this.logger.error({ error: sanitizeDiagnosticText(error.message) }, "Codex app-server stdout error");
    });
    this.child.stderr.on("error", (error) => {
      this.logger.error({ error: sanitizeDiagnosticText(error.message) }, "Codex app-server stderr error");
    });

    this.child.stderr.on("data", (chunk) => {
      const line = chunk.toString().trim();
      if (line) {
        this.logger.warn({ output: sanitizeDiagnosticText(line) }, "Codex app-server stderr");
      }
    });

    this.child.on("error", (error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        {
          error: sanitizeDiagnosticText(err.message),
          pendingRequestCount: this.pending.size,
        },
        "Codex app-server process errored",
      );
      this.rejectAllPending(err);
    });

    this.child.on("close", (code, signal) => {
      this.started = false;
      const log = this.stopping ? this.logger.info.bind(this.logger) : this.logger.warn.bind(this.logger);
      log(
        {
          code: code ?? 1,
          signal: signal ?? null,
          pendingRequestCount: this.pending.size,
        },
        this.stopping ? "Codex app-server stopped" : "Codex app-server exited",
      );
      this.stopping = false;
      this.rejectAllPending(new Error(`Codex app-server exited with code ${code ?? 1}`));
    });

    this.child.stdout.on("data", (chunk) => {
      this.stdoutBuffer += chunk.toString("utf8");
      if (this.stdoutBuffer.length > 50 * 1024 * 1024) {
        this.logger.error({ bufferSize: this.stdoutBuffer.length }, "Codex app-server stdout buffer exceeded 50 MB — killing process");
        this.stdoutBuffer = "";
        this.rejectAllPending(new Error("Codex app-server stdout buffer overflow"));
        this.child?.kill("SIGTERM");
        return;
      }
      this.drainMessages();
    });

    const initializeResponse = await this.sendRequest("initialize", {
      clientInfo: {
        name: "patchrelay",
        title: "PatchRelay",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    const serverInfo =
      initializeResponse && typeof initializeResponse === "object" && "serverInfo" in (initializeResponse as Record<string, unknown>)
        ? ((initializeResponse as Record<string, unknown>).serverInfo as Record<string, unknown> | undefined)
        : undefined;
    this.logger.info(
      {
        serverName: typeof serverInfo?.name === "string" ? serverInfo.name : undefined,
        serverVersion: typeof serverInfo?.version === "string" ? serverInfo.version : undefined,
      },
      "Connected to Codex app-server",
    );
    this.sendNotification("initialized");
    this.started = true;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }

    this.logger.info("Stopping Codex app-server");
    this.stopping = true;
    this.started = false;

    const exited = new Promise<void>((resolve) => {
      child.on("close", () => resolve());
    });
    child.kill("SIGTERM");
    this.child = undefined;

    // Wait for the child to exit, but don't block shutdown forever.
    const timeout = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 10_000);
      timer.unref?.();
    });
    await Promise.race([exited, timeout]);
  }

  async startThread(options: StartThreadOptions): Promise<CodexThreadSummary> {
    const params: Record<string, unknown> = {
      cwd: options.cwd,
      approvalPolicy: this.config.approvalPolicy,
      sandbox: this.config.sandboxMode,
      serviceName: this.config.serviceName ?? "patchrelay",
      model: this.config.model ?? null,
      modelProvider: this.config.modelProvider ?? null,
      reasoningEffort: this.config.reasoningEffort ?? null,
      baseInstructions: this.config.baseInstructions ?? null,
      developerInstructions: this.config.developerInstructions ?? null,
      experimentalRawEvents: this.config.experimentalRawEvents ?? false,
    };
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
      reasoningEffort: this.config.reasoningEffort ?? null,
      baseInstructions: this.config.baseInstructions ?? null,
      developerInstructions: this.config.developerInstructions ?? null,
    };
    if (this.config.persistExtendedHistory) {
      this.logger.warn("persistExtendedHistory is requested but not enabled in the active app-server capability handshake; ignoring");
    }
    const response = (await this.sendRequest("thread/resume", params)) as { thread: Record<string, unknown> };
    return this.mapThread(response.thread);
  }

  async forkThread(threadId: string, cwd?: string, overrides?: ForkThreadOverrides): Promise<CodexThreadSummary> {
    const params: Record<string, unknown> = {
      threadId,
      cwd: overrides?.cwd ?? cwd ?? null,
      approvalPolicy: overrides?.approvalPolicy ?? this.config.approvalPolicy,
      sandbox: overrides?.sandboxMode ?? this.config.sandboxMode,
      model: overrides?.model ?? this.config.model ?? null,
      modelProvider: overrides?.modelProvider ?? this.config.modelProvider ?? null,
      reasoningEffort: overrides?.reasoningEffort ?? this.config.reasoningEffort ?? null,
      baseInstructions: overrides?.baseInstructions ?? this.config.baseInstructions ?? null,
      developerInstructions: overrides?.developerInstructions ?? this.config.developerInstructions ?? null,
    };
    if (this.config.persistExtendedHistory) {
      this.logger.warn("persistExtendedHistory is requested but not enabled in the active app-server capability handshake; ignoring");
    }
    const response = (await this.sendRequest("thread/fork", params)) as { thread: Record<string, unknown> };
    return this.mapThread(response.thread);
  }

  async forkThreadForCompletionCheck(threadId: string): Promise<CodexThreadSummary> {
    return await this.forkThread(threadId, tmpdir(), {
      approvalPolicy: "never",
      sandboxMode: "read-only",
      developerInstructions: COMPLETION_CHECK_DEVELOPER_INSTRUCTIONS,
    });
  }

  async forkThreadForPublicationRecap(threadId: string): Promise<CodexThreadSummary> {
    return await this.forkThread(threadId, tmpdir(), {
      approvalPolicy: "never",
      sandboxMode: "read-only",
      reasoningEffort: "low",
      developerInstructions: PUBLICATION_RECAP_DEVELOPER_INSTRUCTIONS,
    });
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

  async steerTurn(options: SteerTurnOptions): Promise<void> {
    await this.sendRequest("turn/steer", {
      threadId: options.threadId,
      expectedTurnId: options.turnId,
      input: [
        {
          type: "text",
          text: options.input,
          text_elements: [],
        },
      ],
    });
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
    const requestTimeoutMs = this.config.requestTimeoutMs ?? CodexAppServerClient.DEFAULT_REQUEST_TIMEOUT_MS;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(id)) {
          return;
        }
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

    this.writeMessage({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });

    return promise.catch((error) => {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        {
          method,
          requestId: id,
          error: sanitizeDiagnosticText(err.message),
        },
        "Codex app-server request failed",
      );
      throw err;
    });
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

      try {
        this.handleMessage(JSON.parse(line) as JsonRpcSuccess | JsonRpcFailure | JsonRpcRequest | JsonRpcNotification);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.started = false;
        this.logger.error(
          {
            error: sanitizeDiagnosticText(err.message),
            output: sanitizeDiagnosticText(line),
          },
          "Failed to parse Codex app-server stdout message",
        );
        this.rejectAllPending(new Error(`Codex app-server emitted invalid JSON: ${err.message}`));
        this.child?.kill("SIGTERM");
        return;
      }
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
        result = { decision: this.resolveSessionApprovalDecision() };
        break;
      case "item/fileChange/requestApproval":
        result = { decision: this.resolveSessionApprovalDecision() };
        break;
      case "execCommandApproval":
        result = { decision: this.resolveOneShotApprovalDecision() };
        break;
      case "applyPatchApproval":
        result = { decision: this.resolveOneShotApprovalDecision() };
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

  private resolveSessionApprovalDecision(): "acceptForSession" | "rejectForSession" {
    return this.config.approvalPolicy === "never" ? "acceptForSession" : "rejectForSession";
  }

  private resolveOneShotApprovalDecision(): "accept" | "reject" {
    return this.config.approvalPolicy === "never" ? "accept" : "reject";
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private mapThread(thread: Record<string, unknown>): CodexThreadSummary {
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    const rawStatus = thread.status;
    const status =
      rawStatus && typeof rawStatus === "object" && "type" in (rawStatus as Record<string, unknown>)
        ? String((rawStatus as Record<string, unknown>).type)
        : String(rawStatus ?? "unknown");
    return {
      id: String(thread.id),
      preview: String(thread.preview ?? ""),
      cwd: String(thread.cwd ?? ""),
      status,
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
