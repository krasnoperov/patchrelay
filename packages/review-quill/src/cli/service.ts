import pino from "pino";
import { installServiceUnit } from "../install.ts";
import { fetchServiceHealthStatus, formatCommandFailure, parseSystemctlShowOutput, runSystemctl, type CommandRunner } from "../cli-system.ts";
import type { Output } from "./shared.ts";
import { formatJson, writeOutput } from "./shared.ts";
import { parseIntegerFlag, UsageError } from "./args.ts";
import type { ParsedArgs } from "./args.ts";

export async function handleService(parsed: ParsedArgs, stdout: Output, runCommand: CommandRunner): Promise<number> {
  const subcommand = parsed.positionals[1];
  if (!subcommand) {
    throw new UsageError("review-quill service requires a subcommand.", "service");
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
        `Systemd unit: ${result.unitPath} (${result.status})`,
        reload.ok ? "systemd daemon-reload completed." : `systemd daemon-reload failed: ${reload.error}`,
      ].join("\n") + "\n",
    );
    return reload.ok ? 0 : 1;
  }

  if (subcommand === "restart") {
    const daemonReload = await runSystemctl(runCommand, ["daemon-reload"]);
    const restart = await runSystemctl(runCommand, ["reload-or-restart", "review-quill.service"]);
    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson({
        service: "review-quill",
        unit: "review-quill.service",
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
        restart.ok ? "Restarted review-quill.service" : `Restart failed: ${restart.error}`,
      ].join("\n") + "\n",
    );
    return daemonReload.ok && restart.ok ? 0 : 1;
  }

  if (subcommand === "status") {
    const status = await runSystemctl(runCommand, [
      "show",
      "review-quill.service",
      "--property=Id,LoadState,UnitFileState,ActiveState,SubState,FragmentPath,ExecMainPID",
    ]);
    if (!status.ok) {
      throw new Error(status.error);
    }
    const properties = parseSystemctlShowOutput(status.result.stdout);
    const health = await fetchServiceHealthStatus();

    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson({
        service: "review-quill",
        unit: "review-quill.service",
        systemd: properties,
        health,
      }));
      return 0;
    }

    writeOutput(
      stdout,
      [
        `Unit: ${properties.Id ?? "review-quill.service"}`,
        `Load state: ${properties.LoadState ?? "unknown"}`,
        `Enabled: ${properties.UnitFileState ?? "unknown"}`,
        `Active: ${properties.ActiveState ?? "unknown"}${properties.SubState ? ` (${properties.SubState})` : ""}`,
        properties.ExecMainPID ? `Main PID: ${properties.ExecMainPID}` : undefined,
        health.reachable
          ? `Health: ${health.ok ? "ok" : "unhealthy"} (HTTP ${health.status})`
          : `Health: not reachable (${health.error})`,
      ].filter(Boolean).join("\n") + "\n",
    );
    return 0;
  }

  if (subcommand === "logs") {
    const lines = parseIntegerFlag(parsed.flags.get("lines"), "--lines") ?? 50;
    const result = await runCommand("sudo", [
      "journalctl", "-u", "review-quill.service", "-n", String(lines), "--no-pager", "-o", "short-iso",
    ]);
    if (result.exitCode !== 0) {
      throw new Error(formatCommandFailure(result, "Unable to read logs for review-quill.service."));
    }
    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson({
        unit: "review-quill.service",
        lines,
        logs: result.stdout.split(/\r?\n/).filter(Boolean),
      }));
      return 0;
    }
    writeOutput(stdout, `${result.stdout}${result.stdout.endsWith("\n") || result.stdout.length === 0 ? "" : "\n"}`);
    return 0;
  }

  throw new UsageError(`Unknown service command: ${subcommand}`, "service");
}
