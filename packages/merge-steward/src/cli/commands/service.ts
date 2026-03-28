import { installServiceUnit } from "../../install.ts";
import { getSystemdUnitTemplatePath } from "../../runtime-paths.ts";
import type { ParsedArgs, Output, CommandRunner } from "../types.ts";
import { UsageError } from "../types.ts";
import { parseIntegerFlag } from "../args.ts";
import { formatJson, writeOutput } from "../output.ts";
import { formatCommandFailure, parseSystemctlShowOutput, runSystemctl } from "../system.ts";

export async function handleService(parsed: ParsedArgs, stdout: Output, runCommand: CommandRunner): Promise<number> {
  const subcommand = parsed.positionals[1];
  if (!subcommand) {
    throw new UsageError("merge-steward service requires a subcommand.", "service");
  }

  if (subcommand === "install") {
    const result = await installServiceUnit({ force: parsed.flags.get("force") === true });
    const reload = await runSystemctl(runCommand, ["daemon-reload"]);
    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson({
        ...result,
        daemonReloaded: reload.ok,
        ...(reload.ok ? {} : { error: reload.error }),
      }));
      return reload.ok ? 0 : 1;
    }
    writeOutput(
      stdout,
      [
        `Systemd unit template: ${result.unitTemplatePath} (${result.status})`,
        reload.ok ? "systemd daemon-reload completed." : `systemd daemon-reload failed: ${reload.error}`,
      ].join("\n") + "\n",
    );
    return reload.ok ? 0 : 1;
  }

  const repoId = parsed.positionals[2];
  if (!repoId) {
    throw new UsageError(`merge-steward service ${subcommand} requires <id>.`, "service");
  }

  if (subcommand === "restart") {
    const daemonReload = await runSystemctl(runCommand, ["daemon-reload"]);
    const restart = await runSystemctl(runCommand, ["reload-or-restart", `merge-steward@${repoId}.service`]);
    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson({
        repoId,
        daemonReloaded: daemonReload.ok,
        restarted: restart.ok,
        errors: [
          ...(daemonReload.ok ? [] : [daemonReload.error]),
          ...(restart.ok ? [] : [restart.error]),
        ],
      }));
      return daemonReload.ok && restart.ok ? 0 : 1;
    }
    writeOutput(
      stdout,
      [
        daemonReload.ok ? "systemd daemon-reload completed." : `systemd daemon-reload failed: ${daemonReload.error}`,
        restart.ok ? `Restarted merge-steward@${repoId}.service` : `Restart failed: ${restart.error}`,
      ].join("\n") + "\n",
    );
    return daemonReload.ok && restart.ok ? 0 : 1;
  }

  if (subcommand === "status") {
    const status = await runSystemctl(runCommand, [
      "show",
      `merge-steward@${repoId}.service`,
      "--property=Id,LoadState,UnitFileState,ActiveState,SubState,FragmentPath,ExecMainPID",
    ]);
    if (!status.ok) {
      throw new Error(status.error);
    }
    const properties = parseSystemctlShowOutput(status.result.stdout);
    const payload = {
      repoId,
      unit: `merge-steward@${repoId}.service`,
      systemd: properties,
    };
    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson(payload));
      return 0;
    }
    writeOutput(
      stdout,
      [
        `Repo instance: ${repoId}`,
        `Unit: ${properties.Id ?? `merge-steward@${repoId}.service`}`,
        `Load state: ${properties.LoadState ?? "unknown"}`,
        `Enabled: ${properties.UnitFileState ?? "unknown"}`,
        `Active: ${properties.ActiveState ?? "unknown"}${properties.SubState ? ` (${properties.SubState})` : ""}`,
        `Unit path: ${properties.FragmentPath || getSystemdUnitTemplatePath()}`,
        properties.ExecMainPID ? `Main PID: ${properties.ExecMainPID}` : undefined,
      ]
        .filter(Boolean)
        .join("\n") + "\n",
    );
    return 0;
  }

  if (subcommand === "logs") {
    const lines = parseIntegerFlag(parsed.flags.get("lines"), "--lines") ?? 50;
    const result = await runCommand("sudo", [
      "journalctl",
      "-u",
      `merge-steward@${repoId}.service`,
      "-n",
      String(lines),
      "--no-pager",
      "-o",
      "short-iso",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(formatCommandFailure(result, `Unable to read logs for merge-steward@${repoId}.service.`));
    }
    const logs = result.stdout.split(/\r?\n/).filter(Boolean);
    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson({
        repoId,
        unit: `merge-steward@${repoId}.service`,
        lines,
        logs,
      }));
      return 0;
    }
    writeOutput(stdout, `${result.stdout}${result.stdout.endsWith("\n") || result.stdout.length === 0 ? "" : "\n"}`);
    return 0;
  }

  throw new UsageError(`Unknown service command: ${subcommand}`, "service");
}
