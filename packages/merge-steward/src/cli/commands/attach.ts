import { installServiceUnit, upsertRepoConfig } from "../../install.ts";
import type { ParsedArgs, Output, CommandRunner } from "../types.ts";
import { UsageError } from "../types.ts";
import { parseCsvFlag } from "../args.ts";
import { formatJson, writeOutput } from "../output.ts";
import { readHomeConfig, runSystemctl } from "../system.ts";

export async function handleAttach(parsed: ParsedArgs, stdout: Output, runCommand: CommandRunner): Promise<number> {
  const repoId = parsed.positionals[1];
  const repoFullName = parsed.positionals[2];
  if (!repoId || !repoFullName) {
    throw new UsageError("merge-steward attach requires <id> and <owner/repo>.", "repos");
  }

  const baseBranch = typeof parsed.flags.get("base-branch") === "string" ? String(parsed.flags.get("base-branch")) : undefined;
  const admissionLabel = typeof parsed.flags.get("label") === "string" ? String(parsed.flags.get("label")) : undefined;

  const result = await upsertRepoConfig({
    id: repoId,
    repoFullName,
    ...(baseBranch ? { baseBranch } : {}),
    ...(parseCsvFlag(parsed.flags.get("required-check")).length > 0
      ? { requiredChecks: parseCsvFlag(parsed.flags.get("required-check")) }
      : {}),
    ...(admissionLabel ? { admissionLabel } : {}),
  });

  const unitInstall = await installServiceUnit();
  const daemonReload = await runSystemctl(runCommand, ["daemon-reload"]);
  const enableState = await runSystemctl(runCommand, ["enable", `merge-steward@${repoId}.service`]);
  const restartState = await runSystemctl(runCommand, ["reload-or-restart", `merge-steward@${repoId}.service`]);
  const { config: homeConfig } = readHomeConfig();
  const publicBaseUrl = homeConfig.server.public_base_url;
  const webhookUrl = publicBaseUrl ? new URL(result.repo.webhookPath, publicBaseUrl).toString() : undefined;

  const payload = {
    ...result,
    unitTemplatePath: unitInstall.unitTemplatePath,
    daemonReloaded: daemonReload.ok,
    serviceEnabled: enableState.ok,
    serviceRestarted: restartState.ok,
    ...(webhookUrl ? { webhookUrl } : {}),
    errors: [
      ...(daemonReload.ok ? [] : [daemonReload.error]),
      ...(enableState.ok ? [] : [enableState.error]),
      ...(restartState.ok ? [] : [restartState.error]),
    ],
  };

  if (parsed.flags.get("json") === true) {
    writeOutput(stdout, formatJson(payload));
    return daemonReload.ok && enableState.ok && restartState.ok ? 0 : 1;
  }

  writeOutput(
    stdout,
    [
      `Repo config: ${result.configPath}`,
      `${result.status === "created" ? "Attached" : result.status === "updated" ? "Updated" : "Verified"} repo ${result.repo.id} for ${result.repo.repoFullName}`,
      `Base branch: ${result.repo.baseBranch}`,
      `Admission label: ${result.repo.admissionLabel}`,
      `Required checks: ${result.repo.requiredChecks.length > 0 ? result.repo.requiredChecks.join(", ") : "(any green check)"}`,
      `Local port: ${result.repo.port}`,
      webhookUrl ? `Webhook URL: ${webhookUrl}` : "Webhook URL: set MERGE_STEWARD_PUBLIC_BASE_URL in runtime.env or merge-steward.json to print this",
      daemonReload.ok ? "systemd daemon-reload completed." : `systemd daemon-reload failed: ${daemonReload.error}`,
      enableState.ok ? `Enabled merge-steward@${repoId}.service` : `Enable failed: ${enableState.error}`,
      restartState.ok ? `Restarted merge-steward@${repoId}.service` : `Restart failed: ${restartState.error}`,
      "Next: merge-steward service status " + repoId,
    ].join("\n") + "\n",
  );
  return daemonReload.ok && enableState.ok && restartState.ok ? 0 : 1;
}
