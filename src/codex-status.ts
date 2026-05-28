import { spawnSync } from "node:child_process";

const CODEX_STATUS_TIMEOUT_MS = 15_000;

export interface CodexStatusSnapshot {
  ok: boolean;
  exitCode: number;
  output: string;
  account?: string;
  error?: string;
}

function stripAnsiCodes(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
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

export function getCodexStatusSnapshot(bin = "codex"): CodexStatusSnapshot {
  try {
    const result = spawnSync(bin, ["status"], {
      encoding: "utf8",
      timeout: CODEX_STATUS_TIMEOUT_MS,
      env: { ...process.env },
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trimEnd();
    const account = parseAccountLine(output);
    return {
      ok: result.status === 0,
      exitCode: result.status ?? 1,
      output,
      ...(account ? { account } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      exitCode: 1,
      output: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
