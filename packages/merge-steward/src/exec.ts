import { execFile } from "node:child_process";

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
  return new Promise((resolve, reject) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options?.cwd,
        env: options?.env,
        timeout: options?.timeoutMs ?? 120_000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const exitCode = error && "code" in error ? (error.code as number) : 0;
        const result = { stdout, stderr, exitCode };

        if (error && !options?.allowNonZero) {
          const err = new Error(
            `Command failed: ${command} ${args.join(" ")}\n` +
            `Exit code: ${exitCode}\n` +
            `stderr: ${stderr.slice(0, 500)}`,
          );
          (err as unknown as { result: ExecResult }).result = result;
          reject(err);
        } else {
          resolve(result);
        }
      },
    );
  });
}
