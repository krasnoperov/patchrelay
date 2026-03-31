import { upsertRepoConfig } from "../../install.ts";
import type { ParsedArgs, Output, CommandRunner } from "../types.ts";
import { UsageError } from "../types.ts";
import { parseCsvFlag } from "../args.ts";
import { formatJson, writeOutput } from "../output.ts";
import { runSystemctl } from "../system.ts";
import { fetchServiceRepoDiscovery, listRepoConfigs } from "../system.ts";

function deriveRepoId(repoFullName: string): string {
  const repoName = repoFullName.split("/")[1]?.trim().toLowerCase() ?? "";
  const normalized = repoName
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "");
  if (!normalized) {
    throw new UsageError(`Could not derive a repo id from ${repoFullName}. Pass an explicit <id>.`, "repos");
  }
  return normalized;
}

function parseAttachTarget(parsed: ParsedArgs): { repoId: string; repoFullName: string } {
  const first = parsed.positionals[1];
  const second = parsed.positionals[2];
  if (!first) {
    throw new UsageError("merge-steward attach requires <owner/repo> or <id> <owner/repo>.", "repos");
  }
  if (second) {
    return { repoId: first, repoFullName: second };
  }
  if (!first.includes("/")) {
    throw new UsageError("merge-steward attach requires <owner/repo> or <id> <owner/repo>.", "repos");
  }

  const existing = listRepoConfigs().find((repo) => repo.repoFullName === first);
  if (existing) {
    return { repoId: existing.repoId, repoFullName: first };
  }

  const repoId = deriveRepoId(first);
  const conflict = listRepoConfigs().find((repo) => repo.repoId === repoId && repo.repoFullName !== first);
  if (conflict) {
    throw new UsageError(`Derived repo id '${repoId}' is already used by ${conflict.repoFullName}. Pass an explicit <id>.`, "repos");
  }
  return { repoId, repoFullName: first };
}

export async function handleAttach(parsed: ParsedArgs, stdout: Output, runCommand: CommandRunner): Promise<number> {
  const { repoId, repoFullName } = parseAttachTarget(parsed);
  const existing = listRepoConfigs().find((repo) => repo.repoId === repoId || repo.repoFullName === repoFullName);

  const explicitBaseBranch = typeof parsed.flags.get("base-branch") === "string" ? String(parsed.flags.get("base-branch")) : undefined;
  const explicitRequiredChecks = parseCsvFlag(parsed.flags.get("required-check"));
  const admissionLabel = typeof parsed.flags.get("label") === "string" ? String(parsed.flags.get("label")) : undefined;
  const mergeQueueCheckName = typeof parsed.flags.get("merge-queue-check-name") === "string"
    ? String(parsed.flags.get("merge-queue-check-name"))
    : undefined;
  const refresh = parsed.flags.get("refresh") === true;

  const shouldDiscoverBaseBranch = !explicitBaseBranch && (!existing || refresh);
  const shouldDiscoverRequiredChecks = explicitRequiredChecks.length === 0 && (!existing || refresh || !!explicitBaseBranch);
  const needsDiscovery = shouldDiscoverBaseBranch || shouldDiscoverRequiredChecks;

  let discovered:
    | {
      defaultBranch: string;
      branch: string;
      requiredChecks: string[];
      warnings: string[];
    }
    | undefined;
  const warnings: string[] = [];
  if (needsDiscovery) {
    try {
      const response = await fetchServiceRepoDiscovery(repoFullName, {
        ...(explicitBaseBranch
          ? { baseBranch: explicitBaseBranch }
          : existing?.baseBranch && !shouldDiscoverBaseBranch
            ? { baseBranch: existing.baseBranch }
            : {}),
      });
      discovered = response.discovery;
    } catch (error) {
      warnings.push(
        `Could not discover GitHub defaults from the local merge-steward service: ${error instanceof Error ? error.message : String(error)}. Using local defaults instead.`,
      );
    }
  }

  const baseBranch = explicitBaseBranch
    ?? (shouldDiscoverBaseBranch ? discovered?.branch : undefined);
  const requiredChecks = explicitRequiredChecks.length > 0
    ? explicitRequiredChecks
    : (shouldDiscoverRequiredChecks ? discovered?.requiredChecks : undefined);

  const result = await upsertRepoConfig({
    id: repoId,
    repoFullName,
    ...(baseBranch ? { baseBranch } : {}),
    ...(requiredChecks ? { requiredChecks } : {}),
    ...(admissionLabel ? { admissionLabel } : {}),
    ...(mergeQueueCheckName ? { mergeQueueCheckName } : {}),
  });

  // Restart the merge-steward service so it picks up the new repo config.
  const restartState = await runSystemctl(runCommand, ["reload-or-restart", "merge-steward.service"]);

  if (parsed.flags.get("json") === true) {
    writeOutput(stdout, formatJson({
      ...result,
      serviceRestarted: restartState.ok,
      ...(restartState.ok ? {} : { errors: [restartState.error] }),
    }));
    return restartState.ok ? 0 : 1;
  }

  writeOutput(
    stdout,
    [
      `Repo config: ${result.configPath}`,
      `${result.status === "created" ? "Attached" : result.status === "updated" ? "Updated" : "Verified"} repo ${result.repo.id} for ${result.repo.repoFullName}`,
      `Base branch: ${result.repo.baseBranch}`,
      `Admission label: ${result.repo.admissionLabel}`,
      `Queue eviction check: ${result.repo.mergeQueueCheckName}`,
      `Required checks: ${result.repo.requiredChecks.length > 0 ? result.repo.requiredChecks.join(", ") : "(any green check)"}`,
      ...warnings.map((warning) => `Warning: ${warning}`),
      ...(discovered?.warnings.map((warning) => `Warning: ${warning}`) ?? []),
      restartState.ok
        ? "Restarted merge-steward.service"
        : `Restart failed: ${restartState.error}`,
    ].join("\n") + "\n",
  );
  return restartState.ok ? 0 : 1;
}
