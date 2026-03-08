import { spawn } from "node:child_process";
import { execCommand } from "./utils.js";

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class ZmxSessionManager {
  constructor(private readonly zmxBin: string) {}

  async runCommandLine(
    sessionName: string,
    commandLine: string,
    options: {
      cwd?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<void> {
    const finalCommand = `${commandLine}; exit $?`;
    const result = await execCommand(this.zmxBin, ["run", sessionName, finalCommand], options);
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

  async listSessions(options: { timeoutMs?: number } = {}): Promise<string[]> {
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
