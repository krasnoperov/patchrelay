import { setTimeout as delay } from "node:timers/promises";
import type { AppConfig } from "../types.ts";
import type { CliDataAccess } from "./data.ts";
import { formatJson } from "./formatters/json.ts";
import type { Output } from "./command-types.ts";
import { writeOutput } from "./output.ts";

export function parseTimeoutSeconds(value: string | boolean | undefined, command: string): number {
  const timeoutSeconds = typeof value === "string" ? Number(value) : 180;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error(`${command} --timeout must be a positive number of seconds.`);
  }
  return timeoutSeconds;
}

export async function runConnectFlow(params: {
  config: AppConfig;
  data: CliDataAccess;
  stdout: Output;
  openExternal?: (url: string) => Promise<boolean>;
  connectPollIntervalMs?: number;
  noOpen?: boolean;
  timeoutSeconds?: number;
  projectId?: string;
  json?: boolean;
}): Promise<number> {
  const result = await params.data.connect(params.projectId);
  if (params.json) {
    writeOutput(params.stdout, formatJson(result));
    return 0;
  }

  if ("completed" in result && result.completed) {
    const label = result.installation.workspaceName ?? result.installation.actorName ?? `installation #${result.installation.id}`;
    writeOutput(
      params.stdout,
      `Linked project ${result.projectId} to existing Linear installation ${result.installation.id} (${label}). No new OAuth approval was needed.\n`,
    );
    return 0;
  }
  if ("completed" in result) {
    throw new Error("Unexpected completed connect result.");
  }

  const opener = params.openExternal;
  const opened = params.noOpen || !opener ? false : await opener(result.authorizeUrl);
  writeOutput(
    params.stdout,
    `${result.projectId ? `Project: ${result.projectId}\n` : ""}${opened ? "Opened browser for Linear OAuth.\n" : "Open this URL in a browser:\n"}${opened ? result.authorizeUrl : `${result.authorizeUrl}\n`}Waiting for OAuth approval...\n`,
  );

  const deadline = Date.now() + (params.timeoutSeconds ?? 180) * 1000;
  const pollIntervalMs = params.connectPollIntervalMs ?? 1000;
  do {
    const status = await params.data.connectStatus(result.state);
    if (status.status === "completed") {
      const label = status.installation?.workspaceName ?? status.installation?.actorName ?? `installation #${status.installation?.id ?? "unknown"}`;
      writeOutput(
        params.stdout,
        [
          `Connected ${label}${status.projectId ? ` for project ${status.projectId}` : ""}.${status.installation?.id ? ` Installation ${status.installation.id}.` : ""}`,
          params.config.linear.oauth.actor === "app"
            ? "If your Linear OAuth app webhook settings are configured, Linear has now provisioned the workspace webhook automatically."
            : undefined,
        ]
          .filter(Boolean)
          .join("\n") + "\n",
      );
      return 0;
    }
    if (status.status === "failed") {
      throw new Error(status.errorMessage ?? "Linear OAuth failed.");
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for Linear OAuth after ${params.timeoutSeconds ?? 180} seconds.`);
    }
    await delay(pollIntervalMs);
  } while (true);
}
