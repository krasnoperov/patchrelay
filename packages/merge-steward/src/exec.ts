import { execFile } from "node:child_process";
import { resolveSecret } from "./resolve-secret.ts";

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
  const githubToken = command === "gh"
    ? resolveSecret("merge-steward-github-token", "MERGE_STEWARD_GITHUB_TOKEN")
      ?? process.env.GH_TOKEN
      ?? process.env.GITHUB_TOKEN
    : undefined;

  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options?.cwd,
        env: {
          ...process.env,
          ...(options?.env ?? {}),
          ...(githubToken ? { GH_TOKEN: githubToken, GITHUB_TOKEN: githubToken } : {}),
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
