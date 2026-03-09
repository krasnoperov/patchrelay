import * as pty from "node-pty";
import { spawn } from "node:child_process";
import { execCommand } from "./utils.js";

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sanitizeZmxEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.ZMX_SESSION;
  delete next.ZMX_SESSION_PREFIX;
  return next;
}

export class ZmxSessionManager {
  constructor(private readonly zmxBin: string) {}

  attachCommandLine(
    sessionName: string,
    commandLine: string,
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      cols?: number;
      rows?: number;
    } = {},
  ): pty.IPty {
    const client = pty.spawn(this.zmxBin, ["attach", sessionName], {
      name: "xterm-256color",
      cwd: options.cwd ?? process.cwd(),
      env: sanitizeZmxEnv(options.env),
      cols: options.cols ?? 120,
      rows: options.rows ?? 40,
    });
    const finalCommand = `${commandLine}; exit $?`;
    setTimeout(() => {
      client.write(`${finalCommand}\n`);
    }, 250);
    return client;
  }

  attach(
    sessionName: string,
    shell: string,
    args: string[],
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      cols?: number;
      rows?: number;
    } = {},
  ): pty.IPty {
    const commandLine = [shell, ...args].map((part) => shellQuote(part)).join(" ");
    return this.attachCommandLine(sessionName, commandLine, options);
  }

  async runCommandLine(
    sessionName: string,
    commandLine: string,
    options: {
      cwd?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<void> {
    const finalCommand = `${commandLine}; exit $?`;
    const result = await execCommand(this.zmxBin, ["run", sessionName, finalCommand], {
      ...options,
      stdio: ["ignore", "ignore", "ignore"],
    });
    if (result.exitCode !== 0) {
      throw new Error(`zmx run failed for ${sessionName}: ${result.stderr || result.stdout}`);
    }
  }

  async run(
    sessionName: string,
    shell: string,
    args: string[],
    options: {
      cwd?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<void> {
    const commandLine = [shell, ...args].map((part) => shellQuote(part)).join(" ");
    await this.runCommandLine(sessionName, commandLine, options);
  }

  async wait(
    sessionName: string,
    options: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
    } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return execCommand(this.zmxBin, ["wait", sessionName], options);
  }

  spawnWait(
    sessionName: string,
    options: {
      cwd?: string;
    } = {},
  ) {
    return spawn(this.zmxBin, ["wait", sessionName], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  async listSessions(options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<string[]> {
    const result = await execCommand(this.zmxBin, ["list", "--short"], options);
    if (result.exitCode !== 0) {
      throw new Error(`zmx list failed: ${result.stderr || result.stdout}`);
    }

    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async history(
    sessionName: string,
    options: {
      timeoutMs?: number;
    } = {},
  ): Promise<string> {
    const result = await execCommand(this.zmxBin, ["history", sessionName], options);
    if (result.exitCode !== 0) {
      throw new Error(`zmx history failed for ${sessionName}: ${result.stderr || result.stdout}`);
    }
    return result.stdout;
  }

  async kill(
    sessionName: string,
    options: {
      timeoutMs?: number;
    } = {},
  ): Promise<void> {
    const result = await execCommand(this.zmxBin, ["kill", sessionName], options);
    if (result.exitCode !== 0 && !result.stderr.includes("not found")) {
      throw new Error(`zmx kill failed for ${sessionName}: ${result.stderr || result.stdout}`);
    }
  }
}
