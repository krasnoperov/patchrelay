import { existsSync } from "node:fs";
import path from "node:path";
import { execCommand } from "./utils.ts";

export interface HookResult {
  ran: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

export interface HookEnv {
  PATCHRELAY_ISSUE_KEY: string;
  PATCHRELAY_BRANCH: string;
  PATCHRELAY_STAGE: string;
  PATCHRELAY_WORKTREE: string;
}

export async function runProjectHook(
  repoPath: string,
  hookName: string,
  options: {
    cwd: string;
    env?: HookEnv;
    timeoutMs?: number;
  },
): Promise<HookResult> {
  const hookPath = path.join(repoPath, ".patchrelay", "hooks", hookName);
  if (!existsSync(hookPath)) {
    return { ran: false };
  }

  const result = await execCommand(hookPath, [], {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    timeoutMs: options.timeoutMs ?? 120_000,
  });

  return {
    ran: true,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function buildHookEnv(
  issueKey: string,
  branchName: string,
  stage: string,
  worktreePath: string,
): HookEnv {
  return {
    PATCHRELAY_ISSUE_KEY: issueKey,
    PATCHRELAY_BRANCH: branchName,
    PATCHRELAY_STAGE: stage,
    PATCHRELAY_WORKTREE: worktreePath,
  };
}
