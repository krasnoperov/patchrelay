import type { InteractiveRunner } from "./command-types.ts";

export type ServiceCommand = { command: string; args: string[] };

export async function runServiceCommands(
  runner: InteractiveRunner,
  commands: ServiceCommand[],
): Promise<void> {
  for (const entry of commands) {
    const exitCode = await runner(entry.command, entry.args);
    if (exitCode !== 0) {
      throw new Error(`Command failed with exit code ${exitCode}: ${entry.command} ${entry.args.join(" ")}`);
    }
  }
}

export async function tryManageService(
  runner: InteractiveRunner,
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
    { command: "systemctl", args: ["--user", "daemon-reload"] },
    { command: "systemctl", args: ["--user", "enable", "--now", "patchrelay.path"] },
    { command: "systemctl", args: ["--user", "enable", "patchrelay.service"] },
    { command: "systemctl", args: ["--user", "reload-or-restart", "patchrelay.service"] },
  ];
}

export function restartServiceCommands(): ServiceCommand[] {
  return [
    { command: "systemctl", args: ["--user", "daemon-reload"] },
    { command: "systemctl", args: ["--user", "reload-or-restart", "patchrelay.service"] },
  ];
}
