import type { runPreflight } from "../preflight.ts";
import type { Output } from "./command-types.ts";
import type { CliUsageError } from "./errors.ts";
import { helpTextFor } from "./help.ts";

export function writeOutput(stream: Output, text: string): void {
  stream.write(text);
}

export function writeUsageError(stream: Output, error: CliUsageError): void {
  writeOutput(stream, `${helpTextFor(error.helpTopic)}\n\nError: ${error.message}\n`);
}

export function formatDoctor(report: Awaited<ReturnType<typeof runPreflight>>, cliVersion?: string, serviceVersion?: string): string {
  const lines = ["PatchRelay doctor", ""];

  if (cliVersion) {
    const versionLine = serviceVersion
      ? (cliVersion === serviceVersion ? `cli=${cliVersion}  service=${serviceVersion}` : `cli=${cliVersion}  service=${serviceVersion} (mismatch!)`)
      : `cli=${cliVersion}  service=not reachable`;
    lines.push(versionLine);
    lines.push("");
  }

  for (const check of report.checks) {
    const marker = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
    lines.push(`${marker} [${check.scope}] ${check.message}`);
  }

  lines.push("");
  lines.push(report.ok ? "Doctor result: ready" : "Doctor result: not ready");
  return `${lines.join("\n")}\n`;
}
