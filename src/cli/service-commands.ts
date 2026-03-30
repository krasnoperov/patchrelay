import type { CommandRunner, CommandRunnerResult } from "./command-types.ts";

export type ServiceCommand = { command: string; args: string[] };
export interface ServiceCommandResult extends ServiceCommand, CommandRunnerResult {}

function summarizeCommandOutput(result: CommandRunnerResult): string {
  const parts = [result.stderr.trim(), result.stdout.trim()].filter(Boolean);
  return parts.length > 0 ? `\n${parts.join("\n")}` : "";
}

export async function runServiceCommands(
  runner: CommandRunner,
  commands: ServiceCommand[],
): Promise<ServiceCommandResult[]> {
  const results: ServiceCommandResult[] = [];
  for (const entry of commands) {
    const result = await runner(entry.command, entry.args);
    const commandResult: ServiceCommandResult = { ...entry, ...result };
    results.push(commandResult);
    if (result.exitCode !== 0) {
      throw new Error(
        `Command failed with exit code ${result.exitCode}: ${entry.command} ${entry.args.join(" ")}${summarizeCommandOutput(result)}`,
      );
    }
  }
  return results;
}

export async function tryManageService(
  runner: CommandRunner,
  commands: ServiceCommand[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await runServiceCommands(runner, commands);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function installServiceCommands(): ServiceCommand[] {
  return [
    { command: "sudo", args: ["systemctl", "daemon-reload"] },
    { command: "sudo", args: ["systemctl", "enable", "patchrelay.service"] },
    { command: "sudo", args: ["systemctl", "reload-or-restart", "patchrelay.service"] },
  ];
}

export function restartServiceCommands(): ServiceCommand[] {
  return [
    { command: "sudo", args: ["systemctl", "daemon-reload"] },
    { command: "sudo", args: ["systemctl", "reload-or-restart", "patchrelay.service"] },
  ];
}
