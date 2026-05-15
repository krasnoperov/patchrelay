import type { AppConfig } from "../../types.ts";
import type { CommandRunner, CommandRunnerResult } from "../command-types.ts";
import { type JsonObject, safeJsonParse } from "./shared.ts";
import type { ServiceProbeResult } from "./types.ts";

export async function probePatchRelayService(config: AppConfig): Promise<ServiceProbeResult> {
  const host = config.server.bind === "0.0.0.0" ? "127.0.0.1" : config.server.bind;
  const healthUrl = `http://${host}:${config.server.port}${config.server.healthPath}`;
  const readyUrl = `http://${host}:${config.server.port}${config.server.readinessPath}`;
  try {
    const [healthResponse, readyResponse] = await Promise.all([
      fetch(healthUrl, { signal: AbortSignal.timeout(2_000) }),
      fetch(readyUrl, { signal: AbortSignal.timeout(2_000) }),
    ]);
    const healthBody = await healthResponse.json() as { ok?: boolean; version?: string };
    const readyBody = await readyResponse.json() as { ready?: boolean; codexStarted?: boolean; linearConnected?: boolean };
    if (healthResponse.ok && readyResponse.ok && readyBody.ready) {
      return {
        status: "pass",
        message: `Healthy${healthBody.version ? ` (v${healthBody.version})` : ""}`,
      };
    }
    return {
      status: "fail",
      message: `Reachable but not ready${readyBody.codexStarted === false || readyBody.linearConnected === false
        ? ` (${[
          readyBody.codexStarted === false ? "codex not started" : undefined,
          readyBody.linearConnected === false ? "Linear not connected" : undefined,
        ].filter(Boolean).join(", ")})`
        : ""}`,
    };
  } catch (error) {
    return {
      status: "fail",
      message: `Unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export interface OptionalServiceProbeOptions {
  healthy: (payload: JsonObject) => boolean;
  summarize: (payload: JsonObject) => string;
}

export async function probeOptionalService(
  runCommand: CommandRunner,
  binary: string,
  options: OptionalServiceProbeOptions,
): Promise<ServiceProbeResult> {
  let result: CommandRunnerResult;
  try {
    result = await runCommand(binary, ["service", "status", "--json"]);
  } catch (error) {
    return {
      status: "warn",
      message: `Unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (result.exitCode !== 0) {
    const errorText = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join(" ");
    return {
      status: "warn",
      message: `Unavailable: ${errorText || `${binary} service status exited ${result.exitCode}`}`,
    };
  }

  const payload = safeJsonParse(result.stdout);
  if (!payload) {
    return {
      status: "warn",
      message: "Unavailable: unable to parse JSON status output",
    };
  }

  return {
    status: options.healthy(payload) ? "pass" : "fail",
    message: options.summarize(payload),
  };
}
