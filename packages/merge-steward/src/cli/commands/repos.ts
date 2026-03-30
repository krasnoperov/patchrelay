import type { ParsedArgs, Output } from "../types.ts";
import { formatJson, writeOutput } from "../output.ts";
import { listRepoConfigs, loadRepoConfigById, buildWebhookUrl } from "../system.ts";

export async function handleRepos(parsed: ParsedArgs, stdout: Output): Promise<number> {
  const repoId = parsed.positionals[1];
  if (!repoId) {
    const repos = listRepoConfigs();
    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson({ repos }));
      return 0;
    }
    if (repos.length === 0) {
      writeOutput(stdout, "No attached repositories yet. Run `merge-steward attach <id> <owner/repo>`.\n");
      return 0;
    }
    writeOutput(
      stdout,
      repos
        .map((repo) => `${repo.repoId}  ${repo.repoFullName}  base=${repo.baseBranch}`)
        .join("\n") + "\n",
    );
    return 0;
  }

  const { configPath, config } = loadRepoConfigById(repoId);
  const webhookUrl = buildWebhookUrl();
  const payload = {
    repoId: config.repoId,
    repoFullName: config.repoFullName,
    baseBranch: config.baseBranch,
    requiredChecks: config.requiredChecks,
    admissionLabel: config.admissionLabel,
    configPath,
    clonePath: config.clonePath,
    databasePath: config.database.path,
    ...(webhookUrl ? { webhookUrl } : {}),
  };
  if (parsed.flags.get("json") === true) {
    writeOutput(stdout, formatJson(payload));
    return 0;
  }
  writeOutput(
    stdout,
    [
      `Repo: ${config.repoId}`,
      `GitHub repo: ${config.repoFullName}`,
      `Config path: ${configPath}`,
      `Base branch: ${config.baseBranch}`,
      `Required checks: ${config.requiredChecks.length > 0 ? config.requiredChecks.join(", ") : "(any green check)"}`,
      `Admission label: ${config.admissionLabel}`,
      webhookUrl ? `Webhook URL: ${webhookUrl}` : undefined,
    ]
      .filter(Boolean)
      .join("\n") + "\n",
  );
  return 0;
}
