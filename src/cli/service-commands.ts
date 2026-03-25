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
    { command: "sudo", args: ["systemctl", "daemon-reload"] },
    { command: "sudo", args: ["systemctl", "enable", "--now", "patchrelay.path"] },
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
