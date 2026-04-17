import { loadConfig } from "../config.ts";
import { getDefaultConfigPath } from "../runtime-paths.ts";
import { buildDashboard } from "../watch/dashboard-model.ts";
import { fetchSnapshot } from "../watch/api.ts";
import type { ParsedArgs } from "./args.ts";
import type { Output } from "./shared.ts";
import { formatJson, writeOutput } from "./shared.ts";

function resolveBaseUrl(configPath: string): string {
  const config = loadConfig(configPath);
  const bind = config.server.bind === "0.0.0.0" ? "127.0.0.1"
    : config.server.bind === "::" ? "[::1]"
    : config.server.bind.includes(":") && !config.server.bind.startsWith("[") ? `[${config.server.bind}]`
    : config.server.bind;
  return `http://${bind}:${config.server.port}`;
}

export async function handleStatus(configPath: string | undefined, parsed: ParsedArgs, stdout: Output): Promise<number> {
  const resolvedConfigPath = configPath ?? getDefaultConfigPath();
  const baseUrl = resolveBaseUrl(resolvedConfigPath);
  const snapshot = await fetchSnapshot(baseUrl);
  if (parsed.flags.get("json") === true) {
    writeOutput(stdout, formatJson(snapshot));
    return 0;
  }

  const model = buildDashboard(snapshot);
  const lines: string[] = ["review-quill"];
  for (const repo of model.repos) {
    const strip = repo.tokens.map((token) => `#${token.prNumber} ${token.glyph}`).join("  ");
    lines.push(`  ${repo.repoFullName}  ${strip}`);
  }
  if (model.quietCount > 0) {
    lines.push(`  +${model.quietCount} quiet`);
  }
  writeOutput(stdout, `${lines.join("\n")}\n`);
  return 0;
}
