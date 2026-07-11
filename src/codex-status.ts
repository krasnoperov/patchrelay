import { execFile } from "node:child_process";
import { promisify } from "node:util";

const CODEX_STATUS_TIMEOUT_MS = 15_000;
const execFileAsync = promisify(execFile);

export interface CodexStatusSnapshot {
  ok: boolean;
  exitCode: number;
  output: string;
  account?: string;
  error?: string;
}

function stripAnsiCodes(value: string): string {
  const escape = String.fromCharCode(27);
  return value.replace(new RegExp(`${escape}\\[[0-9;]*m`, "g"), "");
}

function parseAccountLine(output: string): string | undefined {
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const clean = stripAnsiCodes(line).trim();
    const match = clean.match(/^Account:\s*(.+)$/i);
    if (match) {
      return match[1]!.trim();
    }
  }
  return undefined;
}

export async function getCodexStatusSnapshot(bin = "codex"): Promise<CodexStatusSnapshot> {
  try {
    const result = await execFileAsync(bin, ["status"], {
      encoding: "utf8",
      timeout: CODEX_STATUS_TIMEOUT_MS,
      env: { ...process.env },
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd();
    const account = parseAccountLine(output);
    return {
      ok: true,
      exitCode: 0,
      output,
      ...(account ? { account } : {}),
    };
  } catch (error) {
    const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trimEnd();
    return {
      ok: false,
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      output,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
