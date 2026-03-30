import { initializeMergeStewardHome, installServiceUnit } from "../../install.ts";
import type { ParsedArgs, Output, CommandRunner } from "../types.ts";
import { normalizePublicBaseUrl, formatJson, writeOutput } from "../output.ts";
import { runSystemctl } from "../system.ts";
import { UsageError } from "../types.ts";

export async function handleInit(parsed: ParsedArgs, stdout: Output, runCommand: CommandRunner): Promise<number> {
  const target = parsed.positionals[1];
  if (!target) {
    throw new UsageError("merge-steward init requires <public-base-url>.");
  }
  const publicBaseUrl = normalizePublicBaseUrl(target);
  const home = await initializeMergeStewardHome({
    publicBaseUrl,
    force: parsed.flags.get("force") === true,
  });
  const unit = await installServiceUnit({ force: parsed.flags.get("force") === true });
  const reloadState = await runSystemctl(runCommand, ["daemon-reload"]);
  const webhookUrl = `${publicBaseUrl.replace(/\/$/, "")}/webhooks/github`;

  const payload = {
    ...home,
    unitTemplatePath: unit.unitTemplatePath,
    serviceUnitStatus: unit.status,
    webhookUrl,
    serviceReloaded: reloadState.ok,
    ...(reloadState.ok ? {} : { serviceReloadError: reloadState.error }),
  };

  if (parsed.flags.get("json") === true) {
    writeOutput(stdout, formatJson(payload));
    return 0;
  }

  writeOutput(
    stdout,
    [
      `Config directory: ${home.configDir}`,
      `Runtime env: ${home.runtimeEnvPath} (${home.runtimeEnvStatus})`,
      `Service env: ${home.serviceEnvPath} (${home.serviceEnvStatus})`,
      `Home config: ${home.configPath} (${home.configStatus})`,
      `Repo configs: ${home.repoConfigDir}`,
      `State directory: ${home.stateDir}`,
      `Data directory: ${home.dataDir}`,
      `Systemd unit template: ${unit.unitTemplatePath} (${unit.status})`,
      "",
      "Public URLs:",
      `- Base URL: ${publicBaseUrl}`,
      `- Webhook URL: ${webhookUrl}`,
      "",
      reloadState.ok
        ? "systemd daemon-reload completed."
        : `systemd daemon-reload failed: ${reloadState.error}`,
      "",
      "Next steps:",
      `1. Put secrets into ${home.serviceEnvPath} for dev or systemd-creds for prod`,
      "2. Run `merge-steward attach <id> <owner/repo>`",
      "3. Configure your GitHub App webhook URL to the webhook URL above",
      "4. Run `merge-steward doctor --repo <id>`",
    ].join("\n") + "\n",
  );
  return 0;
}
