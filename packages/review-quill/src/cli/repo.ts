import type { CommandRunner } from "../cli-system.ts";
import { listRepoConfigs, loadRepoConfigById } from "../cli-system.ts";
import { initializeReviewQuillHome, installServiceUnit, upsertRepoConfig } from "../install.ts";
import type { Output } from "./shared.ts";
import { formatJson, writeOutput } from "./shared.ts";
import type { ParsedArgs } from "./args.ts";
import { normalizePublicBaseUrl, parseAttachTarget, parseBooleanFlag, UsageError } from "./args.ts";
import { discoverRepoSettingsViaGhCli } from "./gh.ts";
import { runSystemctl } from "../cli-system.ts";

export async function handleInit(parsed: ParsedArgs, stdout: Output, runCommand: CommandRunner): Promise<number> {
  const target = parsed.positionals[1];
  if (!target) {
    throw new UsageError("review-quill init requires <public-base-url>.");
  }
  const publicBaseUrl = normalizePublicBaseUrl(target);
  const home = await initializeReviewQuillHome({
    publicBaseUrl,
    force: parsed.flags.get("force") === true,
  });
  const unit = await installServiceUnit({ force: parsed.flags.get("force") === true });
  const reloadState = await runSystemctl(runCommand, ["daemon-reload"]);
  const webhookUrl = `${publicBaseUrl}/webhooks/github`;

  const payload = {
    ...home,
    unitPath: unit.unitPath,
    serviceUnitStatus: unit.status,
    webhookUrl,
    serviceReloaded: reloadState.ok,
    ...(reloadState.ok ? {} : { serviceReloadError: reloadState.error }),
  };

  if (parsed.flags.get("json") === true) {
    writeOutput(stdout, formatJson(payload));
    return reloadState.ok ? 0 : 1;
  }

  writeOutput(
    stdout,
    [
      `Config directory: ${home.configDir}`,
      `Runtime env: ${home.runtimeEnvPath} (${home.runtimeEnvStatus})`,
      `Service env: ${home.serviceEnvPath} (${home.serviceEnvStatus})`,
      `Home config: ${home.configPath} (${home.configStatus})`,
      `State directory: ${home.stateDir}`,
      `Data directory: ${home.dataDir}`,
      `Systemd unit: ${unit.unitPath} (${unit.status})`,
      "",
      "Public URLs:",
      `- Base URL: ${publicBaseUrl}`,
      `- Webhook URL: ${webhookUrl}`,
      "",
      reloadState.ok ? "systemd daemon-reload completed." : `systemd daemon-reload failed: ${reloadState.error}`,
      "",
      "Next steps:",
      `1. Put REVIEW_QUILL_GITHUB_APP_ID into ${home.serviceEnvPath}`,
      "2. Install the webhook secret and GitHub App private key via systemd-creds",
      "3. Run `review-quill attach <owner/repo>`",
      "4. Configure your GitHub App webhook URL to the webhook URL above",
      "5. Run `review-quill doctor --repo <id>`",
    ].join("\n") + "\n",
  );
  return reloadState.ok ? 0 : 1;
}

export async function handleAttach(parsed: ParsedArgs, stdout: Output, runCommand: CommandRunner): Promise<number> {
  const { repoId, repoFullName } = parseAttachTarget(parsed);
  const existing = listRepoConfigs().find((repo) => repo.repoId === repoId || repo.repoFullName === repoFullName);
  const explicitBaseBranch = typeof parsed.flags.get("base-branch") === "string" ? String(parsed.flags.get("base-branch")) : undefined;
  const explicitWaitForGreenChecks = parseBooleanFlag(parsed.flags.get("wait-for-green-checks"), "--wait-for-green-checks");
  const explicitRequiredChecks = typeof parsed.flags.get("required-check") === "string"
    ? String(parsed.flags.get("required-check")).split(",").map((entry) => entry.trim()).filter(Boolean)
    : [];
  const explicitReviewDocs = typeof parsed.flags.get("review-doc") === "string"
    ? String(parsed.flags.get("review-doc")).split(",").map((entry) => entry.trim()).filter(Boolean)
    : [];
  const refresh = parsed.flags.get("refresh") === true;

  const shouldDiscoverBaseBranch = !explicitBaseBranch && (!existing || refresh);
  const shouldDiscoverRequiredChecks = explicitRequiredChecks.length === 0 && (!existing || refresh || !!explicitBaseBranch);
  const needsDiscovery = shouldDiscoverBaseBranch || shouldDiscoverRequiredChecks;
  const warnings: string[] = [];
  let discovered:
    | {
      defaultBranch: string;
      branch: string;
      requiredChecks: string[];
    }
    | undefined;

  if (needsDiscovery) {
    try {
      discovered = discoverRepoSettingsViaGhCli(repoFullName, explicitBaseBranch ?? existing?.baseBranch);
    } catch (error) {
      warnings.push(`Could not discover GitHub defaults via gh: ${error instanceof Error ? error.message : String(error)}. Using local defaults instead.`);
    }
  }

  const result = await upsertRepoConfig({
    id: repoId,
    repoFullName,
    ...((explicitBaseBranch ?? discovered?.branch) ? { baseBranch: explicitBaseBranch ?? discovered?.branch ?? "main" } : {}),
    ...(explicitWaitForGreenChecks !== undefined ? { waitForGreenChecks: explicitWaitForGreenChecks } : {}),
    ...(explicitRequiredChecks.length > 0 ? { requiredChecks: explicitRequiredChecks } : discovered ? { requiredChecks: discovered.requiredChecks } : {}),
    ...(explicitReviewDocs.length > 0 ? { reviewDocs: explicitReviewDocs } : {}),
  });

  const restartState = await runSystemctl(runCommand, ["reload-or-restart", "review-quill.service"]);

  if (parsed.flags.get("json") === true) {
    writeOutput(stdout, formatJson({
      ...result,
      serviceRestarted: restartState.ok,
      ...(restartState.ok ? {} : { errors: [restartState.error] }),
      ...(warnings.length > 0 ? { warnings } : {}),
    }));
    return restartState.ok ? 0 : 1;
  }

  writeOutput(
    stdout,
    [
      `Repo config: ${result.configPath}`,
      `${result.status === "created" ? "Attached" : result.status === "updated" ? "Updated" : "Verified"} repo ${result.repo.repoId} for ${result.repo.repoFullName}`,
      `Base branch: ${result.repo.baseBranch}`,
      `Review start: ${result.repo.waitForGreenChecks ? "after required checks are green" : "immediately after branch updates"}`,
      `Required checks: ${result.repo.requiredChecks.length > 0 ? result.repo.requiredChecks.join(", ") : "(GitHub-discovered when waiting is enabled)"}`,
      `Review docs: ${result.repo.reviewDocs.join(", ")}`,
      `Summarize-only diff patterns: ${result.repo.diffSummarizeOnly.join(", ") || "(none)"}`,
      `Ignored diff patterns: ${result.repo.diffIgnore.join(", ") || "(none)"}`,
      `Patch body budget: ${result.repo.patchBodyBudgetTokens} tokens`,
      ...warnings.map((warning) => `Warning: ${warning}`),
      restartState.ok ? "Restarted review-quill.service" : `Restart failed: ${restartState.error}`,
    ].join("\n") + "\n",
  );
  return restartState.ok ? 0 : 1;
}

export async function handleRepos(parsed: ParsedArgs, stdout: Output): Promise<number> {
  const repoId = parsed.positionals[1];
  if (!repoId) {
    const repos = listRepoConfigs();
    if (parsed.flags.get("json") === true) {
      writeOutput(stdout, formatJson({ repos }));
      return 0;
    }
    if (repos.length === 0) {
      writeOutput(stdout, "No watched repositories yet. Run `review-quill attach <owner/repo>`.\n");
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

  const { configPath, repo, publicBaseUrl } = loadRepoConfigById(repoId);
  const webhookUrl = publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, "")}/webhooks/github` : undefined;
  const payload = {
    repoId: repo.repoId,
    repoFullName: repo.repoFullName,
    baseBranch: repo.baseBranch,
    waitForGreenChecks: repo.waitForGreenChecks,
    requiredChecks: repo.requiredChecks,
    excludeBranches: repo.excludeBranches,
    reviewDocs: repo.reviewDocs,
    diffIgnore: repo.diffIgnore,
    diffSummarizeOnly: repo.diffSummarizeOnly,
    patchBodyBudgetTokens: repo.patchBodyBudgetTokens,
    configPath,
    ...(webhookUrl ? { webhookUrl } : {}),
  };

  if (parsed.flags.get("json") === true) {
    writeOutput(stdout, formatJson(payload));
    return 0;
  }

  writeOutput(
    stdout,
    [
      `Repo: ${repo.repoId}`,
      `GitHub repo: ${repo.repoFullName}`,
      `Config path: ${configPath}`,
      `Base branch: ${repo.baseBranch}`,
      `Review start: ${repo.waitForGreenChecks ? "after required checks are green" : "immediately after branch updates"}`,
      `Required checks: ${repo.requiredChecks.length > 0 ? repo.requiredChecks.join(", ") : "(GitHub-discovered when waiting is enabled)"}`,
      `Exclude branches: ${repo.excludeBranches.join(", ")}`,
      `Review docs: ${repo.reviewDocs.join(", ")}`,
      `Summarize-only diff patterns: ${repo.diffSummarizeOnly.join(", ") || "(none)"}`,
      `Ignored diff patterns: ${repo.diffIgnore.join(", ") || "(none)"}`,
      `Patch body budget: ${repo.patchBodyBudgetTokens} tokens`,
      webhookUrl ? `Webhook URL: ${webhookUrl}` : undefined,
    ].filter(Boolean).join("\n") + "\n",
  );
  return 0;
}
