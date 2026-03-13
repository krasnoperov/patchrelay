import { spawn } from "node:child_process";
import type { AppConfig } from "../types.ts";

export function buildOpenCommand(config: AppConfig, worktreePath: string, resumeThreadId?: string): { command: string; args: string[] } {
  const args = ["--dangerously-bypass-approvals-and-sandbox"];
  if (resumeThreadId) {
    args.push("resume", "-C", worktreePath, resumeThreadId);
  } else {
    args.push("-C", worktreePath);
  }

  return {
    command: config.runner.codex.bin,
    args,
  };
}

export async function runInteractiveCommand(command: string, args: string[]): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

export async function openExternalUrl(url: string): Promise<boolean> {
  const candidates =
    process.platform === "darwin"
      ? [{ command: "open", args: [url] }]
      : process.platform === "win32"
        ? [{ command: "cmd", args: ["/c", "start", "", url] }]
        : [{ command: "xdg-open", args: [url] }];

  for (const candidate of candidates) {
    try {
      const exitCode = await runInteractiveCommand(candidate.command, candidate.args);
      if (exitCode === 0) {
        return true;
      }
    } catch {
      // Try the next opener.
    }
  }

  return false;
}
