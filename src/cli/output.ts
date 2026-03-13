import type { runPreflight } from "../preflight.ts";
import type { Output } from "./command-types.ts";

export function writeOutput(stream: Output, text: string): void {
  stream.write(text);
}

export function formatDoctor(report: Awaited<ReturnType<typeof runPreflight>>): string {
  const lines = ["PatchRelay doctor", ""];

  for (const check of report.checks) {
    const marker = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
    lines.push(`${marker} [${check.scope}] ${check.message}`);
  }

  lines.push("");
  lines.push(report.ok ? "Doctor result: ready" : "Doctor result: not ready");
  return `${lines.join("\n")}\n`;
}
