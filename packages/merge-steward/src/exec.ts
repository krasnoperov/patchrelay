import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import type { RuntimeGitHubAuthProvider } from "./github-auth.ts";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExecOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  timeoutMs?: number | undefined;
  /** If true, non-zero exit codes don't throw. */
  allowNonZero?: boolean | undefined;
  githubRepoFullName?: string | undefined;
}

let runtimeGitHubAuthProvider: RuntimeGitHubAuthProvider | undefined;

export function setRuntimeGitHubAuthProvider(provider?: RuntimeGitHubAuthProvider): void {
  runtimeGitHubAuthProvider = provider;
}

function applyGitConfigEntries(
  env: Record<string, string>,
  entries: Array<[key: string, value: string]>,
): Record<string, string> {
  const next = { ...env };
  const existingCountRaw = next.GIT_CONFIG_COUNT;
  const existingCount = existingCountRaw && /^\d+$/.test(existingCountRaw) ? Number(existingCountRaw) : 0;
  let index = existingCount;
  for (const [key, value] of entries) {
    next[`GIT_CONFIG_KEY_${index}`] = key;
    next[`GIT_CONFIG_VALUE_${index}`] = value;
    index += 1;
  }
  next.GIT_CONFIG_COUNT = String(index);
  return next;
}

export function resolveGitHubCommandEnv(
  command: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  options?: { githubRepoFullName?: string; runtimeAuthProvider?: RuntimeGitHubAuthProvider },
): Record<string, string> {
  if (command !== "gh" && command !== "git") {
    return {};
  }

  const runtimeToken = options?.runtimeAuthProvider?.currentTokenForRepo(options.githubRepoFullName);
  const token = runtimeToken;
  if (!token) {
    return {};
  }

  const authEnv: Record<string, string> = {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
  };

  if (command !== "git") {
    return authEnv;
  }

  const authHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  return applyGitConfigEntries(
    {
      ...(env.GIT_CONFIG_COUNT ? { GIT_CONFIG_COUNT: env.GIT_CONFIG_COUNT } : {}),
      ...authEnv,
      GIT_TERMINAL_PROMPT: "0",
    },
    [["http.https://github.com/.extraheader", authHeader]],
  );
}

/**
 * Run a command and return its output. Throws on non-zero exit unless
 * allowNonZero is set.
 */
export async function exec(
  command: string,
  args: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  const baseEnv = {
    ...process.env,
    ...(options?.env ?? {}),
  };
  const githubEnv = resolveGitHubCommandEnv(command, baseEnv, {
    ...(options?.githubRepoFullName ? { githubRepoFullName: options.githubRepoFullName } : {}),
    ...(runtimeGitHubAuthProvider ? { runtimeAuthProvider: runtimeGitHubAuthProvider } : {}),
  });

  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options?.cwd,
        env: {
          ...baseEnv,
          ...githubEnv,
        },
        timeout: options?.timeoutMs ?? 120_000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        // Timeouts always reject regardless of allowNonZero.
        // When execFile times out, error.killed is true and error.code is null.
        if (error && (error.killed || error.signal)) {
          reject(new Error(
            `Command timed out: ${command} ${args.join(" ")}\n` +
            `Signal: ${error.signal ?? "SIGTERM"}\n` +
            `stderr: ${stderr.slice(0, 500)}`,
          ));
          return;
        }

        const exitCode = error && typeof error.code === "number" ? error.code : 0;
        const result = { stdout, stderr, exitCode };

        if (error && !options?.allowNonZero) {
          reject(new Error(
            `Command failed: ${command} ${args.join(" ")}\n` +
            `Exit code: ${exitCode}\n` +
            `stderr: ${stderr.slice(0, 500)}`,
          ));
        } else {
          resolve(result);
        }
      },
    );
  });
}
